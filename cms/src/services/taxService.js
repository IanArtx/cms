// ============================================================
// TAX SERVICE (v1.70.0)
//
// Everything the company owes to — or has already paid to — the Uganda
// Revenue Authority (URA), kept so the figures always agree with the
// general ledger. See migration_v1.70.0.sql for the tables and
// glAdjustmentLines.js for the ledger entries each record produces.
//
// THE FOUR THINGS TRACKED
//
// 1. TAX DEDUCTED FROM THE COMPANY (tax_at_source)
//    Whoever pays the company (Bank of Uganda on a bond coupon or a
//    treasury bill, a bank on interest) may keep part of it as tax. The
//    gross income is recorded as income; the tax part is:
//      FINAL      -> 5700 Income Tax – Final WHT. The income is then left
//                    OUT of the corporate tax computation (already taxed).
//      CREDITABLE -> 1500 WHT Recoverable. A prepayment: subtracted from
//                    the corporate tax of that year when it is filed.
//
// 2. TAX THE COMPANY WITHHOLDS FROM OTHERS (wht_withholdings)
//    Dividends to shareholders, interest on members' savings, interest
//    to a lender outside Uganda — and, only once URA designates the
//    company as a withholding agent, 6% of payments above UGX 1,000,000
//    for goods and services. The person is paid the NET amount; the
//    tax stays in the company's account, owed to URA (2500), and must be
//    paid over by the 15th of the next month (wht_remittances).
//    While the company is NOT designated, the 6% is recorded as SHADOW
//    (is_shadow): visible in the register "as if designated", but no
//    money is held back and the books are untouched.
//
// 3. CORPORATE INCOME TAX (tax_years)
//    One row per year of income (1 July – 30 June; the first year starts
//    on the incorporation date). The computation starts from the
//    official (UGX) profit before tax and:
//      + adds back expenses that are not deductible (category / entry
//        tax setting NOT_DEDUCTIBLE or CAPITAL, tax penalties)
//      - takes out income already taxed at source as FINAL tax
//      +/- manual adjustments (e.g. capital allowances), and the FX
//        revaluation if the year is set to exclude it
//      = chargeable income; a loss is carried forward to the next year
//      x 30% = tax; less creditable WHT and provisional tax paid
//      = balance to pay (or refund).
//    The Treasurer PREPARES it, a Director (a different person) APPROVES
//    it — which books the tax (Dr 5710 / Cr 2510) — and it is then marked
//    FILED once the return is submitted on the URA portal.
//
// 4. PAYMENTS TO URA (wht_remittances, tax_payments)
//    Every payment is a real transaction from a UGX account (URA is paid
//    in shillings): WHT_REMITTANCE_OUT, PROVISIONAL_TAX_OUT,
//    INCOME_TAX_OUT, TAX_PENALTY_OUT; a refund is TAX_REFUND_IN.
//
// ROLES (checked against the database, not only the route)
//   see  : Treasurer, Assistant Treasurer, Director, Admin, Secretary
//   pay / prepare / record : Treasurer, Assistant Treasurer
//   approve the computation: Director (not the person who prepared it)
//   registration details   : Admin, Director, Treasurer
//   WHT agent switch       : Director, Treasurer
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord } = require('./referenceService');
const { getOrCreateCategory, getOrCreateChildCategory } = require('./categoryService');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const fxService = require('./fxService');

const { round2, toDateStr, todayStr } = fxService;

const TAX_MODULE_CODE = 'TAX';

const ROLES = {
    VIEW:     ['Treasurer', 'Assistant Treasurer', 'Director', 'Admin', 'Secretary'],
    PREPARE:  ['Treasurer', 'Assistant Treasurer'],
    APPROVE:  ['Director'],
    SETTINGS: ['Admin', 'Director', 'Treasurer'],
    AGENT:    ['Director', 'Treasurer'],
    REMIND:   ['Treasurer', 'Assistant Treasurer', 'Director'],
};

const TAX_GL = {
    WHT_RECOVERABLE: '1500',
    PROVISIONAL_PAID: '1510',
    WHT_PAYABLE: '2500',
    CIT_PAYABLE: '2510',
    FINAL_TAX: '5700',
    CIT_EXPENSE: '5710',
    PENALTY: '5720',
};

const PAYMENT_TYPE_LABELS = {
    DIVIDEND: 'Dividend',
    SAVINGS_INTEREST: 'Interest on savings',
    LOAN_INTEREST: 'Interest on a loan',
    SERVICE_FEE: 'Service fee',
    SUPPLIER: 'Payment to a supplier',
    NON_RESIDENT_SERVICE: 'Fee to a non-resident',
    OTHER: 'Other payment',
};

const SOURCE_TYPE_LABELS = {
    BOND_COUPON: 'Bond coupon',
    TREASURY_BILL: 'Treasury bill',
    INVESTMENT_RETURN: 'Investment return',
    INVESTMENT_TAX_ENTRY: 'Investment tax entry',
    BANK_INTEREST: 'Bank interest',
    MMF: 'Money market fund',
    DIVIDEND_RECEIVED: 'Dividend received',
    OTHER_INCOME: 'Other income',
    OTHER: 'Other',
};

const EXPENSE_TREATMENTS = ['DEDUCTIBLE', 'NOT_DEDUCTIBLE', 'CAPITAL'];

const num = (v) => (v === null || v === undefined || v === '' ? null : parseFloat(v));
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const q = (client) => (client ? client.query.bind(client) : query);

// Calendar helpers on 'YYYY-MM-DD' strings (no time zones involved).
const addDays = (dateStr, days) => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};
const endOfMonth = (y, m /* 1-12 */) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const addMonthsEnd = (dateStr, months) => {
    const [y, m] = dateStr.split('-').map(Number);
    const total = (y * 12 + (m - 1)) + months;
    return endOfMonth(Math.floor(total / 12), (total % 12) + 1);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const monthKey = (dateStr) => dateStr.slice(0, 7);

// ============================================================
// SET-UP CHECKS
// ============================================================
let migratedCache = null;
const isMigrated = async () => {
    if (migratedCache) return true;
    const r = await query(`SELECT to_regclass('tax_years') IS NOT NULL AS ok`);
    migratedCache = r.rows[0].ok || null;
    return !!migratedCache;
};
const assertMigrated = async () => {
    if (!(await isMigrated())) {
        throw createError.badRequest('The tax module is not installed on this database yet. Run: node run_migration.js migration_v1.70.0.sql');
    }
};

const getActiveRoleNames = async (client, userId) => {
    const r = await q(client)(`
        SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE  ur.user_id = $1 AND ur.revoked_at IS NULL AND r.is_active = TRUE
    `, [userId]);
    return r.rows.map(x => x.name);
};
const assertRole = async (client, userId, allowed, what) => {
    const roles = await getActiveRoleNames(client, userId);
    if (!roles.some(r => allowed.includes(r))) {
        throw createError.forbidden(`Only ${allowed.join(', ').replace(/, ([^,]*)$/, ' or $1')} can ${what}.`);
    }
    return roles;
};
const userName = async (client, userId) => {
    if (!userId) return null;
    const r = await q(client)(`SELECT first_name || ' ' || last_name AS name FROM users WHERE id = $1`, [userId]);
    return r.rows[0]?.name || null;
};

// People who get tax deadline reminders.
const getTaxStaff = async (roles = ROLES.REMIND) => {
    const r = await query(`
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r ON r.id = ur.role_id AND r.is_active = TRUE
        WHERE  u.is_active = TRUE AND r.name = ANY($1)
    `, [roles]);
    return r.rows;
};

// Categories for the transactions the tax module posts, under one
// top-level "Taxation" trail (e.g. FINANCE: TAX-WHTR).
const TAX_CATEGORY = { module: 'FINANCE', name: 'Taxation', abbreviation: 'TAX', description: 'Payments to and from the Uganda Revenue Authority, and tax deducted at source (v1.70.0).' };
const TAX_SUBCATEGORIES = {
    WHT_REMITTANCE: { name: 'Withholding Tax Remitted', abbreviation: 'WHTR', description: 'Tax withheld from payments, paid over to URA.' },
    PROVISIONAL:    { name: 'Provisional Tax', abbreviation: 'PROV', description: 'Provisional corporate tax instalments.' },
    INCOME_TAX:     { name: 'Corporate Income Tax', abbreviation: 'CIT', description: 'Balance of corporate income tax paid with the return.' },
    PENALTY:        { name: 'Tax Penalties and Interest', abbreviation: 'PEN', description: 'Late payment interest and penalties (not deductible).' },
    REFUND:         { name: 'Tax Refunds', abbreviation: 'REF', description: 'Tax refunded by URA.' },
    AT_SOURCE:      { name: 'Tax Deducted at Source', abbreviation: 'WHTS', description: 'Tax kept back by whoever paid the company.' },
};
const getTaxCategoryId = async (client, key, userId) => {
    const parentId = await getOrCreateCategory(client, { ...TAX_CATEGORY, createdBy: userId });
    return getOrCreateChildCategory(client, { parentId, module: 'FINANCE', ...TAX_SUBCATEGORIES[key], createdBy: userId });
};
const TAX_DOC_CATEGORY = { module: 'DOCUMENT', name: 'Tax Documents', abbreviation: 'TAXD', description: 'Withholding tax certificates, tax computations and notices of the company\'s tax status (auto-generated).' };

// ============================================================
// UGX VALUE OF AN AMOUNT (the functional currency)
// Real tax is owed in UGX, so a withholding / tax record needs its UGX
// value fixed on its own date. No rate on file = refused, never guessed.
// ============================================================
const getFunctional = async () => {
    const settings = await fxService.getAccountingSettings();
    if (!settings.functionalCurrency) {
        throw createError.badRequest('No functional currency is set (company_settings.functional_currency_id). Run migration_v1.66.0.sql first.');
    }
    return settings.functionalCurrency;
};
const toFunctional = async ({ amount, currencyId, date, knownRate = null }) => {
    const f = await getFunctional();
    let rate = knownRate;
    if (rate === null || rate === undefined) {
        if (currencyId === f.id) rate = 1;
        else {
            const table = await fxService.loadRateTable();
            rate = table.rateOn(currencyId, f.id, toDateStr(date));
        }
    }
    if (rate === null || rate === undefined) {
        const cur = await query(`SELECT code FROM currencies WHERE id = $1`, [currencyId]);
        throw createError.badRequest(
            `No exchange rate from ${cur.rows[0]?.code || 'this currency'} to ${f.code} is on file for ${toDateStr(date)}. ` +
            'Tax is owed in UGX, so add the rate (Settings > Currencies) and try again. Nothing was recorded.'
        );
    }
    return { rate: parseFloat(rate), value: round2(parseFloat(amount) * parseFloat(rate)), functionalCurrency: f };
};

// ============================================================
// 1. REGISTRATION DETAILS + WHT AGENT STATUS
// ============================================================
const getRegistration = async (client = null) => {
    await assertMigrated();
    const r = await q(client)(`
        SELECT cs.company_name, cs.tin, cs.registration_number, cs.incorporation_date::text AS incorporation_date,
               cs.tax_office, cs.wht_agent_designated, cs.wht_agent_effective_date::text AS wht_agent_effective_date,
               cs.tax_settings_updated_at, u.first_name || ' ' || u.last_name AS tax_settings_updated_by_name,
               cs.fiscal_year_start_month
        FROM   company_settings cs
        LEFT JOIN users u ON u.id = cs.tax_settings_updated_by
        WHERE  cs.id = 1
    `);
    const history = await q(client)(`
        SELECT h.id, h.designated, h.effective_date::text AS effective_date, h.notes, h.notice_document_id,
               h.changed_at, u.first_name || ' ' || u.last_name AS changed_by_name
        FROM   wht_agent_status_history h
        JOIN   users u ON u.id = h.changed_by
        ORDER  BY h.effective_date DESC, h.id DESC
    `);
    return { ...(r.rows[0] || {}), agentHistory: history.rows };
};

const saveRegistration = async (client, { tin, registrationNumber, incorporationDate, taxOffice, userId }) => {
    await assertMigrated();
    await assertRole(client, userId, ROLES.SETTINGS, 'change the company\'s registration and tax details');
    const cleanTin = tin ? String(tin).replace(/\s+/g, '') : null;
    if (cleanTin && !/^\d{10}$/.test(cleanTin)) {
        throw createError.badRequest('A Uganda TIN is 10 digits (e.g. 1000123456). Nothing was saved.');
    }
    const before = await getRegistration(client);
    if (incorporationDate && before.incorporation_date && incorporationDate !== before.incorporation_date) {
        const locked = await client.query(`SELECT label, status FROM tax_years WHERE is_first_year = TRUE AND status <> 'OPEN'`);
        if (locked.rows.length) {
            throw createError.badRequest(
                `The incorporation date can't be changed: the first tax year (${locked.rows[0].label}) is already ${locked.rows[0].status}. ` +
                'Send it back to OPEN first.'
            );
        }
    }
    await client.query(`
        UPDATE company_settings
        SET    tin = $1, registration_number = $2, incorporation_date = $3, tax_office = $4,
               tax_settings_updated_at = NOW(), tax_settings_updated_by = $5
        WHERE  id = 1
    `, [cleanTin || null, registrationNumber ? String(registrationNumber).trim() : null,
        incorporationDate || null, taxOffice ? String(taxOffice).trim() : null, userId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
        recordType: 'company_settings', recordId: 1,
        oldValues: { tin: before.tin, registration_number: before.registration_number, incorporation_date: before.incorporation_date, tax_office: before.tax_office },
        newValues: { tin: cleanTin, registration_number: registrationNumber, incorporation_date: incorporationDate, tax_office: taxOffice },
        description: 'Company registration / tax details updated (TIN, registration number, incorporation date)',
        client,
    });
    await ensureTaxYears(client);
    return getRegistration(client);
};

// Was the company a designated withholding agent on this date?
const agentDesignatedOn = async (client, date) => {
    const r = await q(client)(`
        SELECT designated FROM wht_agent_status_history
        WHERE  effective_date <= $1
        ORDER  BY effective_date DESC, id DESC LIMIT 1
    `, [toDateStr(date)]);
    return r.rows.length ? r.rows[0].designated : false;
};

// Turning the switch on or off never changes what has been recorded:
// withholdings keep their status; only NEW 6% withholdings dated on or
// after the effective date follow the new status. Every change writes a
// notice to all members (documents.audience = 'ALL_MEMBERS').
const setAgentStatus = async (client, { designated, effectiveDate, notes, userId }) => {
    await assertMigrated();
    const roles = await assertRole(client, userId, ROLES.AGENT, 'change the company\'s withholding agent status');
    const reg = await getRegistration(client);
    const designate = !!designated;
    if (!!reg.wht_agent_designated === designate) {
        throw createError.badRequest(`The company is already recorded as ${designate ? '' : 'NOT '}a designated withholding agent.`);
    }
    const effective = toDateStr(effectiveDate) || todayStr();
    const last = reg.agentHistory[0];
    if (last && effective < last.effective_date) {
        throw createError.badRequest(`The effective date can't be before the last change (${last.effective_date}).`);
    }
    if (designate && !reg.tin) {
        throw createError.badRequest('Enter the company TIN first (Tax > Settings) — a withholding agent files returns under it.');
    }

    const hist = await client.query(`
        INSERT INTO wht_agent_status_history (designated, effective_date, notes, changed_by)
        VALUES ($1, $2, $3, $4) RETURNING id
    `, [designate, effective, notes || null, userId]);
    await client.query(`
        UPDATE company_settings SET wht_agent_designated = $1, wht_agent_effective_date = $2 WHERE id = 1
    `, [designate, effective]);

    const categoryId = await getOrCreateCategory(client, { ...TAX_DOC_CATEGORY, createdBy: userId });
    const { referenceId, referenceCode } = await generateReference(client, 'DOC', 'TAXN', 'DOCUMENT', userId);
    const capacity = roles.includes('Director') ? 'Director' : 'Treasurer';
    const templateData = {
        notice_kind: 'WHT_AGENT_STATUS',
        reference: referenceCode,
        designated: designate,
        effective_date: effective,
        previous: { designated: !!reg.wht_agent_designated, effective_date: reg.wht_agent_effective_date },
        notes: notes || null,
        company: { name: reg.company_name, tin: reg.tin, registration_number: reg.registration_number },
        changed_by: { name: await userName(client, userId), capacity, at: new Date().toISOString() },
        history: [{ designated: designate, effective_date: effective }].concat(
            reg.agentHistory.map(h => ({ designated: h.designated, effective_date: h.effective_date }))),
        generated_date: new Date().toISOString(),
    };
    const doc = await client.query(`
        INSERT INTO documents (
            reference_id, category_id, title, document_type, source, template_data, version,
            related_record_type, related_record_id, status, created_by, approved_by, approved_at,
            fully_signed, fully_signed_at, audience
        ) VALUES ($1, $2, $3, 'OTHER', 'SYSTEM_GENERATED', $4, 1,
                  'wht_agent_status_history', $5, 'FINAL', $6, $6, NOW(), TRUE, NOW(), 'ALL_MEMBERS')
        RETURNING id
    `, [referenceId, categoryId,
        `Notice to Members — Withholding Tax Agent Status: ${designate ? 'DESIGNATED' : 'NOT DESIGNATED'} from ${effective}`,
        JSON.stringify(templateData), hist.rows[0].id, userId]);
    await linkReferenceToRecord(client, referenceId, doc.rows[0].id);
    await client.query(`UPDATE wht_agent_status_history SET notice_document_id = $1 WHERE id = $2`, [doc.rows[0].id, hist.rows[0].id]);

    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'wht_agent_status_history', recordId: hist.rows[0].id,
        oldValues: { designated: !!reg.wht_agent_designated }, newValues: { designated: designate, effective_date: effective },
        description: `Withholding agent status set to ${designate ? 'DESIGNATED' : 'NOT DESIGNATED'} from ${effective}; notice ${referenceCode} issued to all members`,
        client,
    });
    return { historyId: hist.rows[0].id, documentId: doc.rows[0].id, referenceCode, designated: designate, effectiveDate: effective };
};

// ============================================================
// 2. RATES (dated)
// ============================================================
const listRates = async () => {
    await assertMigrated();
    const today = todayStr();
    const r = await query(`
        SELECT tr.*, tr.effective_from::text AS effective_from, tr.effective_to::text AS effective_to,
               u.first_name || ' ' || u.last_name AS created_by_name
        FROM   tax_rates tr
        LEFT JOIN users u ON u.id = tr.created_by
        ORDER  BY tr.code, tr.effective_from DESC
    `);
    return r.rows.map(x => ({
        ...x,
        rate: num(x.rate),
        threshold_amount: num(x.threshold_amount),
        is_current: x.effective_from <= today && (!x.effective_to || x.effective_to > today),
    }));
};

// The rate in force on a date (effective_to is exclusive). A date before
// the first row uses the first row (the seeded rates start in 2000).
const getRateOn = async (client, code, date) => {
    const d = toDateStr(date) || todayStr();
    const r = await q(client)(`
        SELECT code, name, rate, treatment, threshold_amount, effective_from::text AS effective_from
        FROM   tax_rates
        WHERE  code = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
        ORDER  BY effective_from DESC LIMIT 1
    `, [code, d]);
    if (r.rows.length) return { ...r.rows[0], rate: num(r.rows[0].rate), threshold_amount: num(r.rows[0].threshold_amount) };
    const first = await q(client)(`
        SELECT code, name, rate, treatment, threshold_amount, effective_from::text AS effective_from
        FROM   tax_rates WHERE code = $1 ORDER BY effective_from ASC LIMIT 1
    `, [code]);
    if (!first.rows.length) throw createError.badRequest(`No tax rate "${code}" is set up (Tax > Rates).`);
    return { ...first.rows[0], rate: num(first.rows[0].rate), threshold_amount: num(first.rows[0].threshold_amount) };
};

const addRate = async (client, { code, rate, treatment, thresholdAmount, effectiveFrom, legalReference, notes, userId }) => {
    await assertMigrated();
    await assertRole(client, userId, ROLES.PREPARE.concat(ROLES.APPROVE), 'change a tax rate');
    const latest = await client.query(`
        SELECT * , effective_from::text AS ef FROM tax_rates WHERE code = $1 ORDER BY effective_from DESC LIMIT 1 FOR UPDATE
    `, [code]);
    if (!latest.rows.length) throw createError.badRequest(`Unknown rate "${code}".`);
    const prev = latest.rows[0];
    const from = toDateStr(effectiveFrom);
    if (!from || from <= prev.ef) {
        throw createError.badRequest(`A new ${code} rate must start after the current one (${prev.ef}).`);
    }
    await client.query(`UPDATE tax_rates SET effective_to = $1 WHERE id = $2`, [from, prev.id]);
    const ins = await client.query(`
        INSERT INTO tax_rates (code, name, rate, treatment, threshold_amount, legal_reference, notes, effective_from, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
    `, [code, prev.name, rate,
        treatment === undefined ? prev.treatment : (treatment || null),
        thresholdAmount === undefined ? prev.threshold_amount : (thresholdAmount === '' ? null : thresholdAmount),
        legalReference || prev.legal_reference, notes || null, from, userId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_rates', recordId: ins.rows[0].id,
        oldValues: { rate: num(prev.rate), from: prev.ef }, newValues: { rate, from },
        description: `Tax rate ${code} changed from ${num(prev.rate)}% to ${rate}% with effect from ${from}`,
        client,
    });
    return { id: ins.rows[0].id };
};

// ============================================================
// 3. TAX THE COMPANY WITHHOLDS
// ============================================================

// Works out what (if anything) must be withheld from a payment.
// Returns { applies, rateCode, rate, tax, net, isShadow, shadowReason, note }.
const computeWithholding = async (client, { paymentType, residency = 'RESIDENT', gross, currencyId, date, rateCode = null }) => {
    const nonResident = residency === 'NON_RESIDENT';
    let code = rateCode;
    let isShadow = false;
    let shadowReason = null;
    let thresholdCheck = false;
    if (!code) {
        if (paymentType === 'DIVIDEND') code = nonResident ? 'WHT_DIVIDEND_PAID_NON_RESIDENT' : 'WHT_DIVIDEND_PAID_RESIDENT';
        else if (paymentType === 'SAVINGS_INTEREST' || paymentType === 'LOAN_INTEREST') code = nonResident ? 'WHT_INTEREST_PAID_NON_RESIDENT' : 'WHT_INTEREST_PAID_RESIDENT';
        else if (nonResident) code = 'WHT_NON_RESIDENT_SERVICES';
        else code = 'WHT_AGENT_PAYMENTS';
    }
    if (code === 'WHT_AGENT_PAYMENTS') {
        thresholdCheck = true;
        const designated = await agentDesignatedOn(client, date);
        if (!designated) {
            isShadow = true;
            shadowReason = 'The company is not a designated withholding agent on this date — recorded as if it were, no money held back.';
        }
    }
    const rateRow = await getRateOn(client, code, date);
    const grossNum = parseFloat(gross);
    if (thresholdCheck && rateRow.threshold_amount) {
        const { value } = await toFunctional({ amount: grossNum, currencyId, date });
        if (value <= rateRow.threshold_amount) {
            return { applies: false, rateCode: code, rate: rateRow.rate, tax: 0, net: grossNum, isShadow: false,
                note: `Not above the UGX ${fmt(rateRow.threshold_amount)} threshold — nothing to withhold.` };
        }
    }
    const tax = round2(grossNum * rateRow.rate / 100);
    if (!(tax > 0)) return { applies: false, rateCode: code, rate: rateRow.rate, tax: 0, net: grossNum, isShadow: false, note: 'Rate is 0%.' };
    return { applies: true, rateCode: code, rate: rateRow.rate, tax, net: round2(grossNum - tax), isShadow, shadowReason };
};

// Company details printed on certificates.
const companyTaxHeader = async (client) => {
    const r = await getRegistration(client);
    return { name: r.company_name, tin: r.tin, registration_number: r.registration_number, tax_office: r.tax_office };
};

// Inserts one withholding (and, for a real one, the payee's deduction
// certificate). Call inside the same database transaction as the
// payment itself.
const recordWithholding = async (client, {
    paymentType, payeeUserId = null, payeeName, payeeTin = null, payeeResidency = 'RESIDENT',
    rateCode, rate, gross, tax, currencyId, date, debitGlCode, sourceTransactionId = null,
    dividendDistributionId = null, savingsHandoutId = null, loanRepaymentId = null, servicePaymentId = null,
    isShadow = false, shadowReason = null, notes = null, userId, functionalRate = null,
}) => {
    await assertMigrated();
    const d = toDateStr(date);
    const grossN = round2(parseFloat(gross));
    const taxN = round2(parseFloat(tax));
    let fx = { rate: null, value: null };
    if (!isShadow) fx = await toFunctional({ amount: taxN, currencyId, date: d, knownRate: functionalRate });
    else {
        try { fx = await toFunctional({ amount: taxN, currencyId, date: d, knownRate: functionalRate }); } catch (e) { /* shadow: UGX value is informative only */ }
    }
    if (!payeeTin && payeeUserId) {
        const u = await client.query(`SELECT tin FROM users WHERE id = $1`, [payeeUserId]);
        payeeTin = u.rows[0]?.tin || null;
    }
    const { referenceId, referenceCode } = await generateReference(client, TAX_MODULE_CODE, isShadow ? 'WHTS' : 'WHT', 'WHT_WITHHOLDING', userId, d.slice(0, 4) + d.slice(5, 7));
    const ins = await client.query(`
        INSERT INTO wht_withholdings (
            reference_id, payment_type, payee_user_id, payee_name, payee_tin, payee_residency,
            tax_rate_code, rate, gross_amount, tax_amount, net_amount, currency_id, withholding_date,
            functional_rate, tax_functional, debit_gl_code, source_transaction_id,
            dividend_distribution_id, savings_handout_id, loan_repayment_id, service_fee_payment_id,
            is_shadow, shadow_reason, status, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        RETURNING id
    `, [referenceId, paymentType, payeeUserId, payeeName, payeeTin, payeeResidency,
        rateCode, rate, grossN, taxN, round2(grossN - (isShadow ? 0 : taxN)), currencyId, d,
        fx.rate, fx.value, isShadow ? (debitGlCode || null) : debitGlCode, sourceTransactionId,
        dividendDistributionId, savingsHandoutId, loanRepaymentId, servicePaymentId,
        isShadow, shadowReason, isShadow ? 'SHADOW' : 'PENDING', notes, userId]);
    const id = ins.rows[0].id;
    await linkReferenceToRecord(client, referenceId, id);

    let certificateDocumentId = null;
    if (!isShadow) {
        certificateDocumentId = await createWithholdingCertificate(client, id, userId);
    }
    return { id, referenceCode, certificateDocumentId, taxFunctional: fx.value, functionalRate: fx.rate };
};

const withholdingCertificateData = async (client, id) => {
    const r = await client.query(`
        SELECT w.*, w.withholding_date::text AS withholding_date, c.code AS currency_code, rr.reference_code,
               rem.prn, rem.paid_date::text AS remitted_on, remr.reference_code AS remittance_reference,
               tr.name AS rate_name
        FROM   wht_withholdings w
        JOIN   currencies c ON c.id = w.currency_id
        LEFT JOIN references_registry rr ON rr.id = w.reference_id
        LEFT JOIN wht_remittances rem ON rem.id = w.remittance_id
        LEFT JOIN references_registry remr ON remr.id = rem.reference_id
        LEFT JOIN LATERAL (SELECT name FROM tax_rates t WHERE t.code = w.tax_rate_code ORDER BY effective_from DESC LIMIT 1) tr ON TRUE
        WHERE  w.id = $1
    `, [id]);
    const w = r.rows[0];
    const f = await getFunctional();
    return {
        notice_kind: 'WHT_CERTIFICATE',
        reference: w.reference_code,
        company: await companyTaxHeader(client),
        payee: { name: w.payee_name, tin: w.payee_tin, residency: w.payee_residency },
        payment_type: w.payment_type,
        payment_label: PAYMENT_TYPE_LABELS[w.payment_type] || w.payment_type,
        rate_name: w.rate_name,
        date: w.withholding_date,
        currency_code: w.currency_code,
        gross: num(w.gross_amount),
        rate: num(w.rate),
        tax: num(w.tax_amount),
        net: num(w.net_amount),
        functional_currency_code: f.code,
        functional_rate: num(w.functional_rate),
        tax_functional: num(w.tax_functional),
        status: w.status,
        remittance: w.remittance_id ? { reference: w.remittance_reference, prn: w.prn, paid_date: w.remitted_on } : null,
        generated_date: new Date().toISOString(),
    };
};

const createWithholdingCertificate = async (client, withholdingId, userId) => {
    const data = await withholdingCertificateData(client, withholdingId);
    const categoryId = await getOrCreateCategory(client, { ...TAX_DOC_CATEGORY, createdBy: userId });
    const { referenceId } = await generateReference(client, 'DOC', 'WHTC', 'DOCUMENT', userId);
    const w = await client.query(`SELECT payee_user_id FROM wht_withholdings WHERE id = $1`, [withholdingId]);
    const doc = await client.query(`
        INSERT INTO documents (
            reference_id, category_id, title, document_type, source, template_data, version,
            related_record_type, related_record_id, status, created_by, approved_by, approved_at,
            fully_signed, fully_signed_at, owner_user_id
        ) VALUES ($1, $2, $3, 'OTHER', 'SYSTEM_GENERATED', $4, 1,
                  'wht_withholdings', $5, 'FINAL', $6, $6, NOW(), TRUE, NOW(), $7)
        RETURNING id
    `, [referenceId, categoryId,
        `Withholding Tax Deduction Certificate — ${data.payee.name} — ${data.payment_label} (${data.reference})`,
        JSON.stringify(data), withholdingId, userId, w.rows[0]?.payee_user_id || null]);
    await linkReferenceToRecord(client, referenceId, doc.rows[0].id);
    await client.query(`UPDATE wht_withholdings SET certificate_document_id = $1 WHERE id = $2`, [doc.rows[0].id, withholdingId]);
    return doc.rows[0].id;
};

const refreshCertificate = async (client, withholdingId) => {
    const w = await client.query(`SELECT certificate_document_id FROM wht_withholdings WHERE id = $1`, [withholdingId]);
    if (!w.rows[0]?.certificate_document_id) return;
    const data = await withholdingCertificateData(client, withholdingId);
    await client.query(`UPDATE documents SET template_data = $1 WHERE id = $2`, [JSON.stringify(data), w.rows[0].certificate_document_id]);
};

// Called by reverseTransaction for every reversed transaction. Tax
// already paid over to URA can't be reversed from here.
const reverseForTransaction = async (client, { transactionId, reversalDate, userId }) => {
    if (!(await isMigrated())) return { withholdings: 0, atSource: 0 };
    const d = toDateStr(reversalDate) || todayStr();
    const w = await client.query(`
        SELECT id, status, reference_id FROM wht_withholdings
        WHERE  source_transaction_id = $1 AND status <> 'REVERSED' FOR UPDATE
    `, [transactionId]);
    if (w.rows.some(x => x.status === 'REMITTED')) {
        throw createError.badRequest(
            'The withholding tax on this payment has already been paid over to URA, so the payment can\'t be reversed here. ' +
            'Record the correction with URA (a credit on the next WHT return) and ask the Treasurer to adjust it on the Tax page.'
        );
    }
    for (const row of w.rows) {
        await client.query(`UPDATE wht_withholdings SET status = 'REVERSED', reversal_date = $1 WHERE id = $2`, [d, row.id]);
        await refreshCertificate(client, row.id);
    }
    const s = await client.query(`
        SELECT s.id, s.credit_claimed_tax_year_id, ty.status AS year_status, ty.label
        FROM   tax_at_source s
        LEFT JOIN tax_years ty ON ty.id = s.credit_claimed_tax_year_id
        WHERE  (s.income_transaction_id = $1 OR s.tax_transaction_id = $1) AND s.status = 'ACTIVE' FOR UPDATE OF s
    `, [transactionId]);
    if (s.rows.some(x => x.year_status === 'FILED')) {
        throw createError.badRequest(`The tax deducted on this income was claimed in the filed return for ${s.rows.find(x => x.year_status === 'FILED').label}; it can't be reversed here.`);
    }
    for (const row of s.rows) {
        await client.query(`UPDATE tax_at_source SET status = 'REVERSED', reversed_at = $1 WHERE id = $2`, [d, row.id]);
    }
    if (w.rows.length || s.rows.length) {
        await logAction(userId || null, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            recordType: 'transactions', recordId: transactionId,
            description: `Transaction reversed: ${w.rows.length} withholding(s) and ${s.rows.length} tax-at-source record(s) marked REVERSED`,
            client,
        });
    }
    return { withholdings: w.rows.length, atSource: s.rows.length };
};

const listWithholdings = async ({ status = null, month = null, paymentType = null, payeeUserId = null, includeShadow = true } = {}) => {
    await assertMigrated();
    const cond = [];
    const params = [];
    if (status) { params.push(status); cond.push(`w.status = $${params.length}`); }
    if (month) { params.push(`${month}-01`); cond.push(`date_trunc('month', w.withholding_date) = $${params.length}::date`); }
    if (paymentType) { params.push(paymentType); cond.push(`w.payment_type = $${params.length}`); }
    if (payeeUserId) { params.push(payeeUserId); cond.push(`w.payee_user_id = $${params.length}`); }
    if (!includeShadow) cond.push(`w.is_shadow = FALSE`);
    const r = await query(`
        SELECT w.id, w.payment_type, w.payee_user_id, w.payee_name, w.payee_tin, w.payee_residency,
               w.tax_rate_code, w.rate, w.gross_amount, w.tax_amount, w.net_amount, w.withholding_date::text AS withholding_date,
               w.functional_rate, w.tax_functional, w.is_shadow, w.shadow_reason, w.status, w.reversal_date::text AS reversal_date,
               w.certificate_document_id, w.remittance_id, w.notes, c.code AS currency_code, rr.reference_code,
               remr.reference_code AS remittance_reference, rem.prn
        FROM   wht_withholdings w
        JOIN   currencies c ON c.id = w.currency_id
        LEFT JOIN references_registry rr ON rr.id = w.reference_id
        LEFT JOIN wht_remittances rem ON rem.id = w.remittance_id
        LEFT JOIN references_registry remr ON remr.id = rem.reference_id
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER  BY w.withholding_date DESC, w.id DESC
    `, params);
    return r.rows.map(x => ({ ...x, rate: num(x.rate), gross_amount: num(x.gross_amount), tax_amount: num(x.tax_amount),
        net_amount: num(x.net_amount), tax_functional: num(x.tax_functional), functional_rate: num(x.functional_rate),
        payment_label: PAYMENT_TYPE_LABELS[x.payment_type] || x.payment_type }));
};

// Month-by-month: what is waiting to be paid to URA, and when.
const getRemittanceSummary = async () => {
    await assertMigrated();
    const today = todayStr();
    const pending = await query(`
        SELECT to_char(date_trunc('month', withholding_date), 'YYYY-MM') AS month,
               COUNT(*) AS items, SUM(tax_functional) AS total
        FROM   wht_withholdings
        WHERE  status = 'PENDING' AND is_shadow = FALSE
        GROUP  BY 1 ORDER BY 1
    `);
    const shadow = await query(`
        SELECT to_char(date_trunc('month', withholding_date), 'YYYY-MM') AS month,
               COUNT(*) AS items, SUM(COALESCE(tax_functional, 0)) AS total
        FROM   wht_withholdings WHERE status = 'SHADOW'
        GROUP  BY 1 ORDER BY 1
    `);
    const remittances = await query(`
        SELECT rem.id, to_char(rem.period_month, 'YYYY-MM') AS month, rem.due_date::text AS due_date,
               rem.paid_date::text AS paid_date, rem.total_tax_functional, rem.prn, rem.return_reference, rem.status,
               rr.reference_code, a.name AS account_name, t.id AS transaction_id,
               (SELECT COUNT(*) FROM wht_withholdings w WHERE w.remittance_id = rem.id) AS items,
               u.first_name || ' ' || u.last_name AS recorded_by
        FROM   wht_remittances rem
        LEFT JOIN references_registry rr ON rr.id = rem.reference_id
        JOIN   accounts a ON a.id = rem.account_id
        LEFT JOIN transactions t ON t.id = rem.transaction_id
        JOIN   users u ON u.id = rem.created_by
        ORDER  BY rem.period_month DESC, rem.id DESC
    `);
    const months = pending.rows.map(p => {
        const [y, m] = p.month.split('-').map(Number);
        const due = addDays(endOfMonth(y, m), 15);
        return { month: p.month, items: parseInt(p.items), total: num(p.total), dueDate: due,
            overdue: today > due, daysLeft: daysBetween(today, due) };
    });
    return {
        pending: months,
        totalPending: round2(months.reduce((s, m) => s + m.total, 0)),
        shadow: shadow.rows.map(s => ({ month: s.month, items: parseInt(s.items), total: num(s.total) })),
        remittances: remittances.rows.map(r => ({ ...r, total_tax_functional: num(r.total_tax_functional), items: parseInt(r.items),
            late: r.paid_date > r.due_date })),
    };
};

// Pay a month's withheld tax to URA — one real transaction from a UGX
// account, every pending withholding of that month marked REMITTED.
const remitMonth = async (client, { month, accountId, paidDate, prn, returnReference, notes, userId }) => {
    await assertMigrated();
    await assertRole(client, userId, ROLES.PREPARE, 'record a withholding tax payment to URA');
    if (!/^\d{4}-\d{2}$/.test(month || '')) throw createError.badRequest('Choose the month the tax was withheld in (YYYY-MM).');
    const f = await getFunctional();
    const account = await client.query(`SELECT id, name, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1 AND is_active = TRUE`, [accountId]);
    if (!account.rows.length) throw createError.notFound('Account not found');
    if (account.rows[0].currency_id !== f.id) {
        throw createError.badRequest(`URA is paid in ${f.code}. Choose a ${f.code} account (transfer money into one first if needed).`);
    }
    const rows = await client.query(`
        SELECT id, tax_functional FROM wht_withholdings
        WHERE  status = 'PENDING' AND is_shadow = FALSE AND date_trunc('month', withholding_date) = $1::date
        FOR UPDATE
    `, [`${month}-01`]);
    if (!rows.rows.length) throw createError.badRequest(`Nothing is waiting to be paid for ${month}.`);
    const total = round2(rows.rows.reduce((s, r) => s + parseFloat(r.tax_functional), 0));
    const [y, m] = month.split('-').map(Number);
    const due = addDays(endOfMonth(y, m), 15);
    const pd = toDateStr(paidDate) || todayStr();

    const { postTransaction } = require('../controllers/transactionsController');
    const { resolveModuleCode } = require('./referenceService');
    const categoryId = await getTaxCategoryId(client, 'WHT_REMITTANCE', userId);
    const { referenceId: txRefId, referenceCode: txRef } = await generateReference(client, resolveModuleCode(account.rows[0]), 'WHT-REM', 'TRANSACTION', userId);
    const posted = await postTransaction(client, {
        accountId, transactionType: 'DEBIT', inflowType: 'WHT_REMITTANCE_OUT', amount: total,
        currencyId: f.id, categoryId, valueDate: pd, createdBy: userId, referenceId: txRefId,
        description: `Withholding tax for ${month} paid to URA${prn ? ` — PRN ${prn}` : ''} (${rows.rows.length} deduction(s))`,
    });
    await linkReferenceToRecord(client, txRefId, posted.transactionId);

    const { referenceId, referenceCode } = await generateReference(client, TAX_MODULE_CODE, 'WHTREM', 'WHT_REMITTANCE', userId);
    const rem = await client.query(`
        INSERT INTO wht_remittances (reference_id, period_month, due_date, total_tax_functional, account_id, transaction_id,
                                     prn, return_reference, paid_date, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
    `, [referenceId, `${month}-01`, due, total, accountId, posted.transactionId, prn || null, returnReference || null, pd, notes || null, userId]);
    await linkReferenceToRecord(client, referenceId, rem.rows[0].id);
    await client.query(`UPDATE wht_withholdings SET status = 'REMITTED', remittance_id = $1 WHERE id = ANY($2)`,
        [rem.rows[0].id, rows.rows.map(r => r.id)]);
    for (const r of rows.rows) await refreshCertificate(client, r.id);

    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'wht_remittances', recordId: rem.rows[0].id,
        newValues: { month, total, prn, transaction: txRef },
        description: `Withholding tax for ${month} paid to URA: ${f.code} ${fmt(total)} (${referenceCode})${pd > due ? ' — LATE, due ' + due : ''}`,
        client,
    });
    return { id: rem.rows[0].id, referenceCode, transactionReference: txRef, total, dueDate: due, late: pd > due };
};

// ============================================================
// 4. TAX DEDUCTED FROM THE COMPANY
// ============================================================

// A tax leg as its own transaction (money kept back by the payer): a
// debit on the account that received the gross income, pointed at 5700
// (FINAL) or 1500 (CREDITABLE).
const postTaxLeg = async (client, { accountId, currencyId, amount, date, treatment, categoryId, description, investmentId = null, userId }) => {
    const { postTransaction } = require('../controllers/transactionsController');
    const { resolveModuleCode } = require('./referenceService');
    const acc = await client.query(`SELECT id, account_type, reference_prefix FROM accounts WHERE id = $1`, [accountId]);
    const { referenceId, referenceCode } = await generateReference(client, resolveModuleCode(acc.rows[0]), 'WHT-SRC', 'TRANSACTION', userId);
    const posted = await postTransaction(client, {
        accountId, transactionType: 'DEBIT', inflowType: 'EXPENSE', amount, currencyId,
        categoryId, description, valueDate: date, createdBy: userId, referenceId, investmentId,
        glOverrideAccountCode: treatment === 'FINAL' ? TAX_GL.FINAL_TAX : TAX_GL.WHT_RECOVERABLE,
    });
    await linkReferenceToRecord(client, referenceId, posted.transactionId);
    return { ...posted, referenceCode };
};

const recordTaxAtSource = async (client, {
    sourceType, payerName = null, payerTin = null, investmentId = null, bondCouponId = null,
    incomeTransactionId = null, taxTransactionId = null, cashLeg = true, contraGlCode = null,
    rateCode = null, rate = null, treatment, gross, tax, currencyId, date, notes = null, userId,
    certificateNumber = null,
}) => {
    await assertMigrated();
    if (!['FINAL', 'CREDITABLE'].includes(treatment)) throw createError.badRequest('Treatment must be FINAL or CREDITABLE.');
    const d = toDateStr(date);
    const taxN = round2(parseFloat(tax));
    const grossN = round2(parseFloat(gross));
    let knownRate = null;
    if (taxTransactionId) {
        const t = await client.query(`SELECT functional_rate FROM transactions WHERE id = $1`, [taxTransactionId]);
        knownRate = t.rows[0]?.functional_rate !== null && t.rows[0]?.functional_rate !== undefined ? parseFloat(t.rows[0].functional_rate) : null;
    }
    const fx = await toFunctional({ amount: taxN, currencyId, date: d, knownRate });
    const { referenceId, referenceCode } = await generateReference(client, TAX_MODULE_CODE, 'TAS', 'TAX_AT_SOURCE', userId, d.slice(0, 4) + d.slice(5, 7));
    const ins = await client.query(`
        INSERT INTO tax_at_source (
            reference_id, source_type, payer_name, payer_tin, investment_id, bond_coupon_id,
            income_transaction_id, tax_transaction_id, cash_leg, contra_gl_code, tax_rate_code, rate, treatment,
            gross_amount, tax_amount, net_amount, currency_id, deduction_date, functional_rate,
            gross_functional, tax_functional, certificate_number, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        RETURNING id
    `, [referenceId, sourceType, payerName, payerTin, investmentId, bondCouponId,
        incomeTransactionId, taxTransactionId, cashLeg, cashLeg ? null : contraGlCode, rateCode, rate, treatment,
        grossN, taxN, round2(grossN - taxN), currencyId, d, fx.rate,
        round2(grossN * fx.rate), fx.value, certificateNumber, notes, userId]);
    await linkReferenceToRecord(client, referenceId, ins.rows[0].id);
    return { id: ins.rows[0].id, referenceCode };
};

const listTaxAtSource = async ({ from = null, to = null, treatment = null } = {}) => {
    await assertMigrated();
    const cond = [];
    const params = [];
    if (from) { params.push(from); cond.push(`s.deduction_date >= $${params.length}`); }
    if (to) { params.push(to); cond.push(`s.deduction_date <= $${params.length}`); }
    if (treatment) { params.push(treatment); cond.push(`s.treatment = $${params.length}`); }
    const r = await query(`
        SELECT s.*, s.deduction_date::text AS deduction_date, s.certificate_received_at::text AS certificate_received_at,
               s.reversed_at::text AS reversed_at, c.code AS currency_code, rr.reference_code, i.name AS investment_name,
               ty.label AS claimed_in, ty.status AS claimed_year_status, bc.coupon_number
        FROM   tax_at_source s
        JOIN   currencies c ON c.id = s.currency_id
        LEFT JOIN references_registry rr ON rr.id = s.reference_id
        LEFT JOIN investments i ON i.id = s.investment_id
        LEFT JOIN tax_years ty ON ty.id = s.credit_claimed_tax_year_id
        LEFT JOIN bond_coupons bc ON bc.id = s.bond_coupon_id
        ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
        ORDER  BY s.deduction_date DESC, s.id DESC
    `, params);
    return r.rows.map(x => ({ ...x, gross_amount: num(x.gross_amount), tax_amount: num(x.tax_amount), net_amount: num(x.net_amount),
        rate: num(x.rate), gross_functional: num(x.gross_functional), tax_functional: num(x.tax_functional),
        functional_rate: num(x.functional_rate), source_label: SOURCE_TYPE_LABELS[x.source_type] || x.source_type }));
};

// Treatment (FINAL / CREDITABLE), certificate and payer details can be
// corrected until the credit has been claimed in a filed return.
const updateTaxAtSource = async (client, { id, treatment, certificateNumber, certificateReceivedAt, payerTin, payerName, notes, userId }) => {
    await assertMigrated();
    await assertRole(client, userId, ROLES.PREPARE, 'update the tax deducted at source');
    const r = await client.query(`
        SELECT s.*, ty.status AS year_status FROM tax_at_source s
        LEFT JOIN tax_years ty ON ty.id = s.credit_claimed_tax_year_id
        WHERE s.id = $1 FOR UPDATE OF s
    `, [id]);
    if (!r.rows.length) throw createError.notFound('Record not found');
    const s = r.rows[0];
    if (treatment && treatment !== s.treatment) {
        if (s.year_status === 'FILED' || s.year_status === 'APPROVED') {
            throw createError.badRequest('This deduction is part of an approved / filed tax computation; its treatment can\'t change now.');
        }
        const year = await client.query(`SELECT label, status FROM tax_years WHERE $1 BETWEEN start_date AND end_date AND status IN ('APPROVED','FILED')`, [s.deduction_date]);
        if (year.rows.length) {
            throw createError.badRequest(`The tax year ${year.rows[0].label} is already ${year.rows[0].status}; its figures can't change.`);
        }
        if (s.cash_leg && s.tax_transaction_id) {
            const code = treatment === 'FINAL' ? TAX_GL.FINAL_TAX : TAX_GL.WHT_RECOVERABLE;
            await client.query(`UPDATE transactions SET gl_override_account_code = $1 WHERE id = $2 OR reversal_of = $2`, [code, s.tax_transaction_id]);
        }
    }
    await client.query(`
        UPDATE tax_at_source
        SET    treatment = COALESCE($1, treatment), certificate_number = COALESCE($2, certificate_number),
               certificate_received_at = COALESCE($3, certificate_received_at), payer_tin = COALESCE($4, payer_tin),
               payer_name = COALESCE($5, payer_name), notes = COALESCE($6, notes)
        WHERE  id = $7
    `, [treatment || null, certificateNumber || null, certificateReceivedAt || null, payerTin || null, payerName || null, notes || null, id]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_at_source', recordId: id,
        oldValues: { treatment: s.treatment, certificate_number: s.certificate_number },
        newValues: { treatment, certificate_number: certificateNumber },
        description: `Tax deducted at source record updated${treatment && treatment !== s.treatment ? ` (treatment ${s.treatment} → ${treatment})` : ''}`,
        client,
    });
    return { id };
};

// ============================================================
// 5. TAX YEARS
// ============================================================
const fyLabel = (start, end) => `FY${start.slice(0, 4)}/${end.slice(2, 4)}`;

// The year of income containing a date, for a year that starts in
// `startMonth` (7 = July).
const fiscalYearFor = (dateStr, startMonth = 7) => {
    const [y, m] = dateStr.split('-').map(Number);
    const startYear = m >= startMonth ? y : y - 1;
    const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
    const end = addDays(`${startYear + 1}-${String(startMonth).padStart(2, '0')}-01`, -1);
    return { start, end };
};

// Keeps one tax_years row per year of income, from the first year
// (starting on the incorporation date) to the current one.
const ensureTaxYears = async (client = null) => {
    const reg = await getRegistration(client);
    if (!reg.incorporation_date) return { created: 0, reason: 'NO_INCORPORATION_DATE' };
    const startMonth = reg.fiscal_year_start_month || 7;
    const inc = reg.incorporation_date;
    const first = fiscalYearFor(inc, startMonth);
    const today = todayStr();
    const run = q(client);

    // The first year (it may start part-way through a financial year).
    const existingFirst = await run(`SELECT id, start_date::text AS start_date, status FROM tax_years WHERE is_first_year = TRUE`);
    if (existingFirst.rows.length) {
        const ef = existingFirst.rows[0];
        if (ef.start_date !== inc && ef.status === 'OPEN') {
            await run(`DELETE FROM tax_years WHERE is_first_year = TRUE AND id = $1 AND NOT EXISTS (SELECT 1 FROM tax_payments p WHERE p.tax_year_id = $1)`, [ef.id]);
            const still = await run(`SELECT id FROM tax_years WHERE id = $1`, [ef.id]);
            if (still.rows.length) {
                await run(`UPDATE tax_years SET start_date = $1, end_date = $2, label = $3 WHERE id = $4`, [inc, first.end, fyLabel(first.start, first.end), ef.id]);
            }
        }
    }
    let created = 0;
    const ins = await run(`
        INSERT INTO tax_years (label, start_date, end_date, is_first_year)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (start_date) DO NOTHING RETURNING id
    `, [fyLabel(first.start, first.end), inc, first.end]);
    created += ins.rows.length;
    let next = addDays(first.end, 1);
    while (next <= today) {
        const fy = fiscalYearFor(next, startMonth);
        const r = await run(`
            INSERT INTO tax_years (label, start_date, end_date) VALUES ($1, $2, $3)
            ON CONFLICT (start_date) DO NOTHING RETURNING id
        `, [fyLabel(fy.start, fy.end), fy.start, fy.end]);
        created += r.rows.length;
        next = addDays(fy.end, 1);
    }
    // A year wrongly created before the (possibly corrected) incorporation date.
    await run(`DELETE FROM tax_years WHERE end_date < $1 AND status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM tax_payments p WHERE p.tax_year_id = tax_years.id)`, [inc]);
    return { created };
};

// Deadlines of one year of income (Income Tax Act s.112 and the Tax
// Procedures Code): provisional tax in two halves — by the end of the
// 6th month and of the 12th month of the year — and the return with the
// balance within 6 months after the year ends.
const yearDeadlines = (year, startMonth = 7) => {
    const fy = fiscalYearFor(year.start_date, startMonth);
    const p1 = addMonthsEnd(fy.start, 5);
    return {
        provisional1: p1 < year.start_date ? year.end_date : (p1 > year.end_date ? year.end_date : p1),
        provisional2: year.end_date,
        returnDue: addMonthsEnd(year.end_date, 6),
    };
};

const getTaxYear = async (client, id, lock = false) => {
    const r = await q(client)(`
        SELECT ty.*, ty.start_date::text AS start_date, ty.end_date::text AS end_date, ty.filing_date::text AS filing_date,
               pu.first_name || ' ' || pu.last_name AS prepared_by_name,
               au.first_name || ' ' || au.last_name AS approved_by_name,
               fu.first_name || ' ' || fu.last_name AS filed_by_name
        FROM   tax_years ty
        LEFT JOIN users pu ON pu.id = ty.prepared_by
        LEFT JOIN users au ON au.id = ty.approved_by
        LEFT JOIN users fu ON fu.id = ty.filed_by
        WHERE  ty.id = $1 ${lock ? 'FOR UPDATE OF ty' : ''}
    `, [id]);
    if (!r.rows.length) throw createError.notFound('Tax year not found');
    return r.rows[0];
};

const yearPayments = async (client, yearId) => {
    const r = await q(client)(`
        SELECT p.id, p.payment_kind, p.instalment_no, p.amount, p.paid_date::text AS paid_date, p.prn, p.status, p.notes,
               rr.reference_code, a.name AS account_name, u.first_name || ' ' || u.last_name AS recorded_by
        FROM   tax_payments p
        LEFT JOIN references_registry rr ON rr.id = p.reference_id
        JOIN   accounts a ON a.id = p.account_id
        JOIN   users u ON u.id = p.created_by
        WHERE  p.tax_year_id = $1
        ORDER  BY p.paid_date, p.id
    `, [yearId]);
    return r.rows.map(p => ({ ...p, amount: num(p.amount) }));
};

const listTaxYears = async () => {
    await assertMigrated();
    await ensureTaxYears(null);
    const reg = await getRegistration(null);
    const r = await query(`
        SELECT ty.id, ty.label, ty.start_date::text AS start_date, ty.end_date::text AS end_date, ty.is_first_year, ty.status,
               ty.provisional_estimate, ty.provisional_tax_estimate, ty.chargeable_income, ty.taxable_income,
               ty.gross_tax, ty.wht_credits, ty.provisional_paid, ty.balance_due, ty.loss_carried_forward,
               ty.filing_date::text AS filing_date, ty.return_reference,
               (SELECT COALESCE(SUM(amount), 0) FROM tax_payments p WHERE p.tax_year_id = ty.id AND p.status = 'PAID' AND p.payment_kind = 'PROVISIONAL') AS provisional_paid_live,
               (SELECT COALESCE(SUM(amount), 0) FROM tax_payments p WHERE p.tax_year_id = ty.id AND p.status = 'PAID' AND p.payment_kind = 'INCOME_TAX_BALANCE') AS balance_paid
        FROM   tax_years ty
        ORDER  BY ty.start_date DESC
    `);
    return {
        registration: { incorporation_date: reg.incorporation_date, tin: reg.tin },
        years: r.rows.map(y => ({
            ...y,
            provisional_estimate: num(y.provisional_estimate), provisional_tax_estimate: num(y.provisional_tax_estimate),
            chargeable_income: num(y.chargeable_income), taxable_income: num(y.taxable_income), gross_tax: num(y.gross_tax),
            wht_credits: num(y.wht_credits), provisional_paid: num(y.provisional_paid), balance_due: num(y.balance_due),
            loss_carried_forward: num(y.loss_carried_forward), provisional_paid_live: num(y.provisional_paid_live),
            balance_paid: num(y.balance_paid),
            deadlines: yearDeadlines(y, reg.fiscal_year_start_month || 7),
        })),
    };
};

// Effective tax treatment of every expense transaction: its own setting,
// else its category's, else the nearest parent category's, else DEDUCTIBLE.
const loadTreatmentResolver = async () => {
    const cats = await query(`SELECT id, parent_id, tax_treatment FROM categories`);
    const byId = new Map(cats.rows.map(c => [c.id, c]));
    const memo = new Map();
    const catTreatment = (id) => {
        if (!id) return 'DEDUCTIBLE';
        if (memo.has(id)) return memo.get(id);
        let cur = byId.get(id);
        let result = 'DEDUCTIBLE';
        const seen = new Set();
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            if (cur.tax_treatment) { result = cur.tax_treatment; break; }
            cur = cur.parent_id ? byId.get(cur.parent_id) : null;
        }
        memo.set(id, result);
        return result;
    };
    return catTreatment;
};

// THE COMPUTATION (worksheet). Read-only — nothing is saved here.
const computeWorksheet = async (yearOrId, depth = 0) => {
    await assertMigrated();
    const glService = require('./glService');
    const year = typeof yearOrId === 'object' ? yearOrId : await getTaxYear(null, yearOrId);
    const reg = await getRegistration(null);
    const f = await getFunctional();
    const warnings = [];

    const includePre = year.is_first_year && year.include_pre_incorporation;
    const fromDate = includePre ? null : year.start_date;
    const toDate = year.end_date;

    // (a) The official profit before tax, from the ledger (UGX).
    const is = await glService.computeIncomeStatement({ fromDate, toDate, basis: glService.BASIS.FUNCTIONAL });
    const statement = is.byCurrency[0] || { revenue: [], expenses: [], incomeTax: [], totalRevenue: 0, totalExpenses: 0, profitBeforeTax: 0 };
    const profitBeforeTax = round2(statement.profitBeforeTax !== undefined ? statement.profitBeforeTax : (statement.totalRevenue - statement.totalExpenses));
    if (is.meta.unconvertedCount > 0) {
        warnings.push(`${is.meta.unconvertedCount} transaction(s) in this period have no UGX value (no exchange rate on file for their date) and are NOT in these figures. Add the missing rates first.`);
    }
    if (is.meta.revaluation && is.meta.revaluation.provisionalAt) {
        warnings.push(`Foreign currency balances are revalued provisionally${is.meta.revaluation.lastPeriodEnd ? ` after ${is.meta.revaluation.lastPeriodEnd}` : ''} — run the month-end FX revaluation (General Ledger) for the months of this year before preparing it.`);
    }

    // (b) Before incorporation — shown separately (first year only).
    let preIncorporation = null;
    if (year.is_first_year) {
        const pre = await glService.computeIncomeStatement({ fromDate: null, toDate: addDays(year.start_date, -1), basis: glService.BASIS.FUNCTIONAL });
        const p = pre.byCurrency[0];
        if (p && (p.revenue.length || p.expenses.length)) {
            preIncorporation = {
                to: addDays(year.start_date, -1),
                totalRevenue: p.totalRevenue, totalExpenses: p.totalExpenses,
                profitBeforeTax: round2(p.totalRevenue - p.totalExpenses),
                included: includePre,
            };
        }
    }

    // (c) Expense lines by tax treatment.
    const ledger = await glService.getLedgerLines({ fromDate, toDate, basis: glService.BASIS.FUNCTIONAL });
    const { accounts } = await glService.getChartOfAccounts();
    const accById = new Map(accounts.map(a => [a.id, a]));
    const txIds = Array.from(new Set(ledger.lines.filter(l => l.sourceType === 'TRANSACTION').map(l => l.sourceId)));
    const treatmentOf = new Map();
    if (txIds.length) {
        const catTreatment = await loadTreatmentResolver();
        const tx = await query(`
            SELECT t.id, t.tax_treatment, t.category_id, o.tax_treatment AS orig_treatment, t.description,
                   t.value_date::text AS value_date, rr.reference_code
            FROM   transactions t
            LEFT JOIN transactions o ON o.id = t.reversal_of
            LEFT JOIN references_registry rr ON rr.id = t.reference_id
            WHERE  t.id = ANY($1)
        `, [txIds]);
        for (const t of tx.rows) {
            treatmentOf.set(t.id, { treatment: t.tax_treatment || t.orig_treatment || catTreatment(t.category_id), ref: t.reference_code, description: t.description, date: t.value_date });
        }
    }
    const byTreatment = { NOT_DEDUCTIBLE: new Map(), CAPITAL: new Map() };
    let penalties = 0;
    let fxGains = 0;
    let fxLosses = 0;
    for (const l of ledger.lines) {
        const acc = accById.get(l.glAccountId);
        if (!acc) continue;
        if (acc.code === '4600') fxGains += (l.credit - l.debit);
        if (acc.code === '5600') fxLosses += (l.debit - l.credit);
        if (acc.account_type !== 'EXPENSE' || acc.statement_section === 'INCOME_TAX') continue;
        if (acc.code === TAX_GL.PENALTY) { penalties += (l.debit - l.credit); continue; }
        if (l.sourceType !== 'TRANSACTION') continue;
        const info = treatmentOf.get(l.sourceId);
        if (!info || !byTreatment[info.treatment]) continue;
        const bucket = byTreatment[info.treatment];
        const cur = bucket.get(l.sourceId) || { reference: info.ref, description: info.description, date: info.date, account: `${acc.code} ${acc.name}`, amount: 0 };
        cur.amount += (l.debit - l.credit);
        bucket.set(l.sourceId, cur);
    }
    const detailOf = (m) => Array.from(m.values()).map(x => ({ ...x, amount: round2(x.amount) })).filter(x => Math.abs(x.amount) >= 0.01);
    const sumOf = (arr) => round2(arr.reduce((s, x) => s + x.amount, 0));

    const addBacks = [];
    const deductions = [];
    const nd = detailOf(byTreatment.NOT_DEDUCTIBLE);
    if (nd.length) addBacks.push({ key: 'NOT_DEDUCTIBLE', label: 'Expenses not deductible for tax', amount: sumOf(nd), auto: true, detail: nd });
    const cap = detailOf(byTreatment.CAPITAL);
    if (cap.length) addBacks.push({ key: 'CAPITAL', label: 'Capital expenditure charged as an expense (claim capital allowances separately)', amount: sumOf(cap), auto: true, detail: cap });
    if (Math.abs(penalties) >= 0.01) addBacks.push({ key: 'PENALTIES', label: 'Tax penalties and late payment interest', amount: round2(penalties), auto: true });
    const netFx = round2(fxGains - fxLosses);
    if (!year.fx_revaluation_taxable && Math.abs(netFx) >= 0.01) {
        if (netFx < 0) addBacks.push({ key: 'FX', label: 'Net foreign exchange loss (excluded from tax for this year)', amount: round2(-netFx), auto: true });
        else deductions.push({ key: 'FX', label: 'Net foreign exchange gain (excluded from tax for this year)', amount: netFx, auto: true });
    }

    // (d) Income already taxed at source as FINAL tax is not taxed again.
    const finalRows = await query(`
        SELECT s.id, s.source_type, s.payer_name, s.gross_functional, s.tax_functional, s.deduction_date::text AS deduction_date, rr.reference_code
        FROM   tax_at_source s LEFT JOIN references_registry rr ON rr.id = s.reference_id
        WHERE  s.treatment = 'FINAL' AND s.status = 'ACTIVE' AND s.deduction_date <= $2
        AND    ($1::date IS NULL OR s.deduction_date >= $1::date)
        ORDER  BY s.deduction_date
    `, [fromDate, toDate]);
    const finalDetail = finalRows.rows.map(r => ({ reference: r.reference_code, description: `${SOURCE_TYPE_LABELS[r.source_type] || r.source_type}${r.payer_name ? ' — ' + r.payer_name : ''}`,
        date: r.deduction_date, amount: num(r.gross_functional) || 0, tax: num(r.tax_functional) }));
    if (finalDetail.length) {
        deductions.push({ key: 'FINAL_TAX_INCOME', label: 'Income already taxed at source as final tax (gross)', amount: sumOf(finalDetail), auto: true, detail: finalDetail });
    }

    // (e) Manual adjustments (e.g. capital allowances, exempt income).
    const adj = await query(`
        SELECT a.id, a.kind, a.description, a.amount, a.legal_reference, a.created_at, u.first_name || ' ' || u.last_name AS created_by_name
        FROM   tax_year_adjustments a JOIN users u ON u.id = a.created_by
        WHERE  a.tax_year_id = $1 ORDER BY a.id
    `, [year.id]);
    for (const a of adj.rows) {
        const item = { key: `MANUAL_${a.id}`, id: a.id, label: a.description, amount: num(a.amount), auto: false, legalReference: a.legal_reference, createdBy: a.created_by_name };
        (a.kind === 'ADD_BACK' ? addBacks : deductions).push(item);
    }

    const totalAddBacks = sumOf(addBacks);
    const totalDeductions = sumOf(deductions);
    const chargeableIncome = round2(profitBeforeTax + totalAddBacks - totalDeductions);

    // (f) Losses brought forward from the previous year.
    let lossBroughtForward = 0;
    const prev = await query(`SELECT * , start_date::text AS start_date, end_date::text AS end_date FROM tax_years WHERE end_date = $1::date - 1`, [year.start_date]);
    if (prev.rows.length) {
        const p = prev.rows[0];
        if (['APPROVED', 'FILED'].includes(p.status) && p.loss_carried_forward !== null) {
            lossBroughtForward = num(p.loss_carried_forward) || 0;
        } else if (depth < 6) {
            const pw = await computeWorksheet(p, depth + 1);
            lossBroughtForward = pw.lossCarriedForward;
            if (lossBroughtForward > 0) warnings.push(`The loss brought forward comes from ${p.label}, which is not yet approved — it may still change.`);
        }
    }
    let taxableIncome = 0;
    let lossUtilised = 0;
    let lossCarriedForward = lossBroughtForward;
    if (chargeableIncome < 0) {
        lossCarriedForward = round2(lossBroughtForward - chargeableIncome);
    } else {
        lossUtilised = round2(Math.min(lossBroughtForward, chargeableIncome));
        taxableIncome = round2(chargeableIncome - lossUtilised);
        lossCarriedForward = round2(lossBroughtForward - lossUtilised);
    }

    const citRate = await getRateOn(null, 'CIT_RATE', year.end_date);
    const grossTax = round2(taxableIncome * citRate.rate / 100);

    // (g) Credits: creditable WHT deducted in the year, provisional paid.
    const credits = await query(`
        SELECT s.id, s.source_type, s.payer_name, s.tax_functional, s.deduction_date::text AS deduction_date,
               s.certificate_number, rr.reference_code
        FROM   tax_at_source s LEFT JOIN references_registry rr ON rr.id = s.reference_id
        WHERE  s.treatment = 'CREDITABLE' AND s.status = 'ACTIVE' AND s.deduction_date <= $2
        AND    ($1::date IS NULL OR s.deduction_date >= $1::date)
        AND    (s.credit_claimed_tax_year_id IS NULL OR s.credit_claimed_tax_year_id = $3)
        ORDER  BY s.deduction_date
    `, [fromDate, toDate, year.id]);
    const whtCredits = credits.rows.map(c => ({ id: c.id, reference: c.reference_code, date: c.deduction_date,
        description: `${SOURCE_TYPE_LABELS[c.source_type] || c.source_type}${c.payer_name ? ' — ' + c.payer_name : ''}`,
        certificate: c.certificate_number, amount: num(c.tax_functional) || 0 }));
    const missingCerts = whtCredits.filter(c => !c.certificate).length;
    if (missingCerts) warnings.push(`${missingCerts} creditable deduction(s) have no certificate number recorded — URA only allows a credit backed by a certificate.`);
    const totalWhtCredits = sumOf(whtCredits);

    const payments = await yearPayments(null, year.id);
    const paid = (kind) => round2(payments.filter(p => p.status === 'PAID' && p.payment_kind === kind).reduce((s, p) => s + p.amount, 0));
    const provisionalPaid = paid('PROVISIONAL');
    const balancePaid = paid('INCOME_TAX_BALANCE');
    const refundsReceived = paid('REFUND_RECEIVED');
    const balanceDue = round2(grossTax - totalWhtCredits - provisionalPaid);
    const outstanding = round2(balanceDue - balancePaid + refundsReceived);

    const deadlines = yearDeadlines(year, reg.fiscal_year_start_month || 7);
    if (!reg.tin) warnings.push('The company TIN is not set (Tax > Settings).');

    // Income statement lines, for the report.
    return {
        year: {
            id: year.id, label: year.label, startDate: year.start_date, endDate: year.end_date, isFirstYear: year.is_first_year,
            status: year.status, includePreIncorporation: year.include_pre_incorporation, fxRevaluationTaxable: year.fx_revaluation_taxable,
            provisionalEstimate: num(year.provisional_estimate), provisionalTaxEstimate: num(year.provisional_tax_estimate),
            preparedBy: year.prepared_by_name || null, preparedAt: year.prepared_at || null,
            approvedBy: year.approved_by_name || null, approvedAt: year.approved_at || null,
            filedBy: year.filed_by_name || null, filingDate: year.filing_date || null, returnReference: year.return_reference || null,
            returnedReason: year.returned_reason || null, notes: year.notes || null,
        },
        company: { name: reg.company_name, tin: reg.tin, registrationNumber: reg.registration_number, incorporationDate: reg.incorporation_date, taxOffice: reg.tax_office },
        currency: f.code,
        range: { from: fromDate, to: toDate },
        incomeStatement: {
            revenue: statement.revenue, expenses: statement.expenses, incomeTax: statement.incomeTax || [],
            totalRevenue: statement.totalRevenue, totalExpenses: statement.totalExpenses, fxDetail: statement.fxDetail || null,
        },
        preIncorporation,
        profitBeforeTax,
        addBacks, totalAddBacks,
        deductions, totalDeductions,
        chargeableIncome,
        lossBroughtForward: round2(lossBroughtForward), lossUtilised, taxableIncome, lossCarriedForward,
        taxRate: citRate.rate,
        grossTax,
        whtCredits, totalWhtCredits,
        provisionalPaid, balanceDue, balancePaid, refundsReceived, outstanding,
        payments,
        deadlines,
        warnings,
        computedAt: new Date().toISOString(),
    };
};

const assertYearStatus = (year, allowed, action) => {
    if (!allowed.includes(year.status)) {
        throw createError.badRequest(`${year.label} is ${year.status}; you can only ${action} while it is ${allowed.join(' or ')}.`);
    }
};

const updateYearOptions = async (client, { taxYearId, includePreIncorporation, fxRevaluationTaxable, notes, userId }) => {
    await assertRole(client, userId, ROLES.PREPARE, 'change a tax year\'s options');
    const year = await getTaxYear(client, taxYearId, true);
    assertYearStatus(year, ['OPEN'], 'change its options');
    if (includePreIncorporation && !year.is_first_year) throw createError.badRequest('Only the first tax year can include pre-incorporation transactions.');
    await client.query(`
        UPDATE tax_years SET include_pre_incorporation = COALESCE($1, include_pre_incorporation),
               fx_revaluation_taxable = COALESCE($2, fx_revaluation_taxable), notes = COALESCE($3, notes)
        WHERE id = $4
    `, [includePreIncorporation === undefined ? null : !!includePreIncorporation,
        fxRevaluationTaxable === undefined ? null : !!fxRevaluationTaxable, notes === undefined ? null : notes, taxYearId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_years', recordId: taxYearId,
        newValues: { includePreIncorporation, fxRevaluationTaxable },
        description: `Tax year ${year.label} options changed`, client,
    });
};

const setProvisionalEstimate = async (client, { taxYearId, estimate, userId }) => {
    await assertRole(client, userId, ROLES.PREPARE, 'set the provisional tax estimate');
    const year = await getTaxYear(client, taxYearId, true);
    assertYearStatus(year, ['OPEN', 'PREPARED'], 'set the provisional estimate');
    const est = Math.max(0, round2(parseFloat(estimate)));
    const rate = await getRateOn(client, 'CIT_RATE', year.end_date);
    const tax = round2(est * rate.rate / 100);
    await client.query(`
        UPDATE tax_years SET provisional_estimate = $1, provisional_tax_estimate = $2, provisional_set_by = $3, provisional_set_at = NOW()
        WHERE id = $4
    `, [est, tax, userId, taxYearId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_years', recordId: taxYearId, newValues: { estimate: est, tax },
        description: `Provisional estimate for ${year.label}: chargeable income ${fmt(est)} → tax ${fmt(tax)} (two instalments of ${fmt(tax / 2)})`,
        client,
    });
    return { estimate: est, tax, instalment: round2(tax / 2) };
};

const addAdjustment = async (client, { taxYearId, kind, description, amount, legalReference, userId }) => {
    await assertRole(client, userId, ROLES.PREPARE, 'add an adjustment to the tax computation');
    const year = await getTaxYear(client, taxYearId, true);
    assertYearStatus(year, ['OPEN'], 'add adjustments');
    if (!['ADD_BACK', 'DEDUCTION'].includes(kind)) throw createError.badRequest('Kind must be ADD_BACK or DEDUCTION');
    const r = await client.query(`
        INSERT INTO tax_year_adjustments (tax_year_id, kind, description, amount, legal_reference, created_by)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [taxYearId, kind, description.trim(), round2(parseFloat(amount)), legalReference || null, userId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_year_adjustments', recordId: r.rows[0].id,
        description: `Tax computation ${year.label}: ${kind === 'ADD_BACK' ? 'add-back' : 'deduction'} "${description}" ${fmt(amount)}`, client,
    });
    return { id: r.rows[0].id };
};

const removeAdjustment = async (client, { adjustmentId, userId }) => {
    await assertRole(client, userId, ROLES.PREPARE, 'remove an adjustment');
    const a = await client.query(`SELECT * FROM tax_year_adjustments WHERE id = $1`, [adjustmentId]);
    if (!a.rows.length) throw createError.notFound('Adjustment not found');
    const year = await getTaxYear(client, a.rows[0].tax_year_id, true);
    assertYearStatus(year, ['OPEN'], 'remove adjustments');
    await client.query(`DELETE FROM tax_year_adjustments WHERE id = $1`, [adjustmentId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_year_adjustments', recordId: adjustmentId, oldValues: a.rows[0],
        description: `Tax computation ${year.label}: adjustment "${a.rows[0].description}" removed`, client,
    });
};

const snapshotFields = (w) => ({
    profit_before_tax: w.profitBeforeTax, total_add_backs: w.totalAddBacks, total_deductions: w.totalDeductions,
    chargeable_income: w.chargeableIncome, loss_brought_forward: w.lossBroughtForward, loss_utilised: w.lossUtilised,
    taxable_income: w.taxableIncome, loss_carried_forward: w.lossCarriedForward, tax_rate: w.taxRate,
    gross_tax: w.grossTax, wht_credits: w.totalWhtCredits, provisional_paid: w.provisionalPaid, balance_due: w.balanceDue,
});

const prepareYear = async (client, { taxYearId, userId }) => {
    await assertRole(client, userId, ROLES.PREPARE, 'prepare the tax computation');
    const year = await getTaxYear(client, taxYearId, true);
    assertYearStatus(year, ['OPEN'], 'prepare it');
    if (year.end_date >= todayStr()) throw createError.badRequest(`${year.label} has not ended yet (it ends ${year.end_date}).`);
    const w = await computeWorksheet(year);
    const s = snapshotFields(w);
    await client.query(`
        UPDATE tax_years SET status = 'PREPARED', computation = $1, prepared_by = $2, prepared_at = NOW(), returned_reason = NULL,
               profit_before_tax = $3, total_add_backs = $4, total_deductions = $5, chargeable_income = $6,
               loss_brought_forward = $7, loss_utilised = $8, taxable_income = $9, loss_carried_forward = $10,
               tax_rate = $11, gross_tax = $12, wht_credits = $13, provisional_paid = $14, balance_due = $15
        WHERE id = $16
    `, [JSON.stringify(w), userId, s.profit_before_tax, s.total_add_backs, s.total_deductions, s.chargeable_income,
        s.loss_brought_forward, s.loss_utilised, s.taxable_income, s.loss_carried_forward, s.tax_rate, s.gross_tax,
        s.wht_credits, s.provisional_paid, s.balance_due, taxYearId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_years', recordId: taxYearId, newValues: s,
        description: `Tax computation ${year.label} PREPARED: chargeable income ${fmt(w.chargeableIncome)}, tax ${fmt(w.grossTax)}, balance ${fmt(w.balanceDue)}`,
        client,
    });
    return w;
};

const returnYear = async (client, { taxYearId, reason, userId }) => {
    await assertRole(client, userId, ROLES.APPROVE.concat(ROLES.PREPARE), 'send a tax computation back');
    const year = await getTaxYear(client, taxYearId, true);
    assertYearStatus(year, ['PREPARED'], 'send it back');
    await client.query(`UPDATE tax_years SET status = 'OPEN', returned_reason = $1 WHERE id = $2`, [reason || null, taxYearId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_years', recordId: taxYearId, description: `Tax computation ${year.label} sent back to OPEN: ${reason || ''}`, client,
    });
};

const COMPARE_KEYS = ['chargeable_income', 'gross_tax', 'wht_credits', 'provisional_paid'];

// Director approval: re-computes and refuses if anything moved since it
// was prepared (a late entry must go back to the Treasurer first).
const approveYear = async (client, { taxYearId, userId }) => {
    await assertRole(client, userId, ROLES.APPROVE, 'approve the tax computation');
    const year = await getTaxYear(client, taxYearId, true);
    assertYearStatus(year, ['PREPARED'], 'approve it');
    if (year.prepared_by === userId) throw createError.forbidden('The person who prepared the computation cannot also approve it.');
    const w = await computeWorksheet(year);
    const now = snapshotFields(w);
    const changed = COMPARE_KEYS.filter(k => Math.abs((num(year[k]) || 0) - (now[k] || 0)) >= 1);
    if (changed.length) {
        throw createError.badRequest(
            `The figures have changed since ${year.label} was prepared (${changed.join(', ').replace(/_/g, ' ')}). ` +
            'Send it back to the Treasurer to prepare it again.'
        );
    }
    const docId = await createComputationDocument(client, { year, worksheet: w, userId });
    await client.query(`
        UPDATE tax_years SET status = 'APPROVED', approved_by = $1, approved_at = NOW(), computation_document_id = $2 WHERE id = $3
    `, [userId, docId, taxYearId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_years', recordId: taxYearId, newValues: now,
        description: `Tax computation ${year.label} APPROVED: corporate tax ${fmt(w.grossTax)} booked (Dr 5710 / Cr 2510)`, client,
    });
    return w;
};

const createComputationDocument = async (client, { year, worksheet, userId }) => {
    const categoryId = await getOrCreateCategory(client, { ...TAX_DOC_CATEGORY, createdBy: userId });
    const { referenceId, referenceCode } = await generateReference(client, 'DOC', 'TAXC', 'DOCUMENT', userId);
    const data = {
        notice_kind: 'TAX_COMPUTATION',
        reference: referenceCode,
        worksheet,
        prepared_by: { name: year.prepared_by_name, at: year.prepared_at },
        approved_by: { name: await userName(client, userId), at: new Date().toISOString() },
        generated_date: new Date().toISOString(),
    };
    const doc = await client.query(`
        INSERT INTO documents (
            reference_id, category_id, title, document_type, source, template_data, version,
            related_record_type, related_record_id, status, created_by, approved_by, approved_at, fully_signed, fully_signed_at
        ) VALUES ($1, $2, $3, 'FINANCIAL_REPORT_GENERAL', 'SYSTEM_GENERATED', $4, 1,
                  'tax_years', $5, 'FINAL', $6, $6, NOW(), TRUE, NOW())
        RETURNING id
    `, [referenceId, categoryId, `Corporate Income Tax Computation — ${year.label} (${referenceCode})`, JSON.stringify(data), year.id, userId]);
    await linkReferenceToRecord(client, referenceId, doc.rows[0].id);
    return doc.rows[0].id;
};

const fileYear = async (client, { taxYearId, filingDate, returnReference, userId }) => {
    await assertRole(client, userId, ROLES.PREPARE.concat(ROLES.APPROVE), 'mark the return as filed');
    const year = await getTaxYear(client, taxYearId, true);
    assertYearStatus(year, ['APPROVED'], 'mark it filed');
    const fd = toDateStr(filingDate) || todayStr();
    if (fd <= year.end_date) throw createError.badRequest('The return can only be filed after the year has ended.');
    const snapshot = year.computation || {};
    const creditIds = (snapshot.whtCredits || []).map(c => c.id).filter(Boolean);
    if (creditIds.length) {
        await client.query(`UPDATE tax_at_source SET credit_claimed_tax_year_id = $1 WHERE id = ANY($2)`, [taxYearId, creditIds]);
    }
    await client.query(`
        UPDATE tax_years SET status = 'FILED', filed_by = $1, filed_at = NOW(), filing_date = $2, return_reference = $3 WHERE id = $4
    `, [userId, fd, returnReference || null, taxYearId]);
    const deadlines = yearDeadlines(year);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_years', recordId: taxYearId,
        description: `Tax return ${year.label} FILED on ${fd}${returnReference ? ` (${returnReference})` : ''}${fd > deadlines.returnDue ? ' — LATE, due ' + deadlines.returnDue : ''}`,
        client,
    });
    return { filingDate: fd, late: fd > deadlines.returnDue };
};

const PAYMENT_KINDS = {
    PROVISIONAL:        { inflow: 'PROVISIONAL_TAX_OUT', type: 'DEBIT',  cat: 'PROVISIONAL', abbr: 'PROV-TAX', label: 'Provisional tax' },
    INCOME_TAX_BALANCE: { inflow: 'INCOME_TAX_OUT',      type: 'DEBIT',  cat: 'INCOME_TAX',  abbr: 'CIT-PAY',  label: 'Corporate income tax' },
    LATE_INTEREST:      { inflow: 'TAX_PENALTY_OUT',     type: 'DEBIT',  cat: 'PENALTY',     abbr: 'TAX-PEN',  label: 'Late payment interest / penalty' },
    REFUND_RECEIVED:    { inflow: 'TAX_REFUND_IN',       type: 'CREDIT', cat: 'REFUND',      abbr: 'TAX-REF',  label: 'Tax refund from URA' },
};

const recordTaxPayment = async (client, { taxYearId = null, kind, instalmentNo = null, amount, accountId, paidDate, prn, notes, userId }) => {
    await assertMigrated();
    await assertRole(client, userId, ROLES.PREPARE, 'record a tax payment');
    const spec = PAYMENT_KINDS[kind];
    if (!spec) throw createError.badRequest('Unknown payment kind');
    let year = null;
    if (taxYearId) year = await getTaxYear(client, taxYearId, true);
    if (!year && kind !== 'LATE_INTEREST') throw createError.badRequest('Choose the tax year this payment is for.');
    if (kind === 'PROVISIONAL' && ![1, 2].includes(parseInt(instalmentNo))) throw createError.badRequest('Choose instalment 1 or 2.');
    const f = await getFunctional();
    const account = await client.query(`SELECT id, name, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1 AND is_active = TRUE`, [accountId]);
    if (!account.rows.length) throw createError.notFound('Account not found');
    if (account.rows[0].currency_id !== f.id) throw createError.badRequest(`URA is paid in ${f.code}. Choose a ${f.code} account.`);
    const amt = round2(parseFloat(amount));
    const pd = toDateStr(paidDate) || todayStr();

    const { postTransaction } = require('../controllers/transactionsController');
    const { resolveModuleCode } = require('./referenceService');
    const categoryId = await getTaxCategoryId(client, spec.cat, userId);
    const { referenceId: txRefId, referenceCode: txRef } = await generateReference(client, resolveModuleCode(account.rows[0]), spec.abbr, 'TRANSACTION', userId);
    const posted = await postTransaction(client, {
        accountId, transactionType: spec.type, inflowType: spec.inflow, amount: amt, currencyId: f.id, categoryId,
        valueDate: pd, createdBy: userId, referenceId: txRefId,
        description: `${spec.label}${year ? ` — ${year.label}` : ''}${kind === 'PROVISIONAL' ? ` (instalment ${instalmentNo})` : ''}${prn ? ` — PRN ${prn}` : ''}`,
    });
    await linkReferenceToRecord(client, txRefId, posted.transactionId);
    const { referenceId, referenceCode } = await generateReference(client, TAX_MODULE_CODE, 'TAXPAY', 'TAX_PAYMENT', userId);
    const ins = await client.query(`
        INSERT INTO tax_payments (reference_id, tax_year_id, payment_kind, instalment_no, amount, account_id, transaction_id, prn, paid_date, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
    `, [referenceId, taxYearId || null, kind, kind === 'PROVISIONAL' ? parseInt(instalmentNo) : null, amt, accountId,
        posted.transactionId, prn || null, pd, notes || null, userId]);
    await linkReferenceToRecord(client, referenceId, ins.rows[0].id);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'tax_payments', recordId: ins.rows[0].id,
        description: `${spec.label} ${f.code} ${fmt(amt)}${year ? ` for ${year.label}` : ''} recorded (${referenceCode}, ${txRef})`, client,
    });
    return { id: ins.rows[0].id, referenceCode, transactionReference: txRef };
};

// ============================================================
// 6. DEADLINES (calendar + reminders)
// ============================================================
const getCalendar = async () => {
    await assertMigrated();
    const today = todayStr();
    const reg = await getRegistration(null);
    const startMonth = reg.fiscal_year_start_month || 7;
    const items = [];

    // Monthly WHT returns: a month with tax withheld and not yet paid, or
    // (once designated) every month since designation — a nil return.
    const summary = await getRemittanceSummary();
    for (const m of summary.pending) {
        items.push({ key: `WHT:${m.month}`, kind: 'WHT_RETURN', title: `Withholding tax return and payment for ${m.month}`,
            dueDate: m.dueDate, amount: m.total, done: false, detail: `${m.items} deduction(s) waiting to be paid to URA` });
    }
    const remittedMonths = new Set(summary.remittances.map(r => r.month));
    const pendingMonths = new Set(summary.pending.map(m => m.month));
    if (reg.agentHistory.length) {
        const [ty, tm] = today.split('-').map(Number);
        for (let back = 1; back <= 3; back++) {
            const total = ty * 12 + (tm - 1) - back;
            const y = Math.floor(total / 12);
            const mo = (total % 12) + 1;
            const month = `${y}-${String(mo).padStart(2, '0')}`;
            if (pendingMonths.has(month) || remittedMonths.has(month)) continue;
            if (!(await agentDesignatedOn(null, endOfMonth(y, mo)))) continue;
            items.push({ key: `WHTNIL:${month}`, kind: 'WHT_RETURN', title: `Withholding tax return for ${month} (nil — nothing withheld)`,
                dueDate: addDays(endOfMonth(y, mo), 15), amount: 0, done: false, detail: 'A designated agent files a return every month, even with nothing to declare.' });
        }
    }

    // Corporate tax, per year of income.
    if (reg.incorporation_date) {
        await ensureTaxYears(null);
        const years = await query(`SELECT *, start_date::text AS start_date, end_date::text AS end_date FROM tax_years ORDER BY tax_years.start_date`);
        for (const y of years.rows) {
            const d = yearDeadlines(y, startMonth);
            const pays = await yearPayments(null, y.id);
            const inst = (n) => pays.filter(p => p.payment_kind === 'PROVISIONAL' && p.instalment_no === n && p.status === 'PAID');
            const est = num(y.provisional_tax_estimate);
            const half = est !== null ? round2(est / 2) : null;
            const provDone = (n) => inst(n).length > 0 || y.status === 'FILED' || est === 0;
            items.push({ key: `PROV1:${y.id}`, kind: 'PROVISIONAL', title: `Provisional tax — 1st instalment, ${y.label}`, dueDate: d.provisional1,
                amount: half, done: provDone(1), detail: est === null ? 'Set the provisional estimate on the Corporate tax tab.' : null });
            items.push({ key: `PROV2:${y.id}`, kind: 'PROVISIONAL', title: `Provisional tax — 2nd instalment, ${y.label}`, dueDate: d.provisional2,
                amount: half, done: provDone(2), detail: est === null ? 'Set the provisional estimate on the Corporate tax tab.' : null });
            const paidBalance = round2(pays.filter(p => p.status === 'PAID' && p.payment_kind === 'INCOME_TAX_BALANCE').reduce((sum, p) => sum + p.amount, 0));
            const stillToPay = y.balance_due !== null ? round2(num(y.balance_due) - paidBalance) : null;
            const filed = y.status === 'FILED';
            items.push({ key: `RETURN:${y.id}`, kind: 'RETURN', title: `Income tax return and balance of tax, ${y.label}`, dueDate: d.returnDue,
                amount: stillToPay, done: filed && (stillToPay === null || stillToPay <= 0),
                detail: filed ? (stillToPay > 0 ? `Filed — UGX ${fmt(stillToPay)} of tax still to pay.` : 'Filed and paid.') : `Status: ${y.status}` });
        }
    }
    for (const it of items) {
        it.daysLeft = daysBetween(today, it.dueDate);
        it.overdue = !it.done && it.dueDate < today;
    }
    items.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
    return items;
};

// Daily: 7 days before a deadline, on the day, and (while still open)
// every 7 days after it — each reminder once per day.
const runDeadlineReminders = async ({ notifyMany, wrapEmail = null, today = todayStr() } = {}) => {
    if (!(await isMigrated())) return { sent: 0 };
    const items = (await getCalendar()).filter(i => !i.done);
    const staff = await getTaxStaff();
    let sent = 0;
    for (const it of items) {
        const d = it.daysLeft;
        const due = d === 7 || d === 0 || (d < 0 && (-d) % 7 === 0);
        if (!due) continue;
        const ins = await query(`
            INSERT INTO tax_reminders_sent (reminder_key, sent_on) VALUES ($1, $2)
            ON CONFLICT (reminder_key, sent_on) DO NOTHING RETURNING id
        `, [it.key, today]);
        if (!ins.rows.length) continue;
        const when = d > 0 ? `due in ${d} days (${it.dueDate})` : d === 0 ? `due TODAY (${it.dueDate})` : `OVERDUE since ${it.dueDate}`;
        const body = `${it.title} is ${when}.${it.amount ? ` Amount: UGX ${fmt(it.amount)}.` : ''}${it.detail ? ' ' + it.detail : ''}`;
        const html = wrapEmail
            ? await wrapEmail(`<p>${body}</p><p>Open the Tax page in the system to record the payment or the filing.</p>`,
                { preheader: d < 0 ? 'A tax deadline has passed' : 'A tax deadline is coming up' })
            : null;
        await notifyMany(staff, 'TAX_DEADLINE', () => ({
            title: d < 0 ? `Overdue: ${it.title}` : `Tax deadline: ${it.title}`,
            body, link: '/tax', module: 'FINANCE', recordType: 'tax', recordId: null,
            email: html ? { subject: `${d < 0 ? 'OVERDUE — ' : 'Tax deadline — '}${it.title}`, html } : null,
        })).catch(() => {});
        sent++;
    }
    return { sent };
};

// ============================================================
// 7. OVERVIEW + MEMBERS' OWN VIEW
// ============================================================
const getOverview = async () => {
    await assertMigrated();
    const reg = await getRegistration(null);
    const today = todayStr();
    const summary = await getRemittanceSummary();
    const calendar = await getCalendar().catch(() => []);
    const fy = fiscalYearFor(today, reg.fiscal_year_start_month || 7);
    const deducted = await query(`
        SELECT treatment, COALESCE(SUM(tax_functional), 0) AS tax, COALESCE(SUM(gross_functional), 0) AS gross, COUNT(*) AS n
        FROM   tax_at_source WHERE status = 'ACTIVE' AND deduction_date BETWEEN $1 AND $2
        GROUP  BY treatment
    `, [fy.start, fy.end]);
    const withheld = await query(`
        SELECT is_shadow, COALESCE(SUM(tax_functional), 0) AS tax, COUNT(*) AS n
        FROM   wht_withholdings WHERE status <> 'REVERSED' AND withholding_date BETWEEN $1 AND $2
        GROUP  BY is_shadow
    `, [fy.start, fy.end]);
    const pick = (rows, k, v) => rows.find(r => r[k] === v) || {};
    let currentYear = null;
    if (reg.incorporation_date) {
        await ensureTaxYears(null);
        const cy = await query(`SELECT id FROM tax_years WHERE $1 BETWEEN start_date AND end_date`, [today]);
        if (cy.rows.length) {
            try {
                const w = await computeWorksheet(cy.rows[0].id);
                currentYear = { id: cy.rows[0].id, label: w.year.label, startDate: w.year.startDate, endDate: w.year.endDate,
                    profitBeforeTax: w.profitBeforeTax, chargeableIncome: w.chargeableIncome, grossTax: w.grossTax,
                    totalWhtCredits: w.totalWhtCredits, provisionalPaid: w.provisionalPaid, balanceDue: w.balanceDue,
                    provisionalTaxEstimate: w.year.provisionalTaxEstimate, warnings: w.warnings };
            } catch (e) {
                currentYear = { error: e.message };
            }
        }
    }
    return {
        registration: reg,
        setupComplete: !!(reg.tin && reg.registration_number && reg.incorporation_date),
        whtPayable: summary.totalPending,
        whtPendingMonths: summary.pending,
        financialYear: { start: fy.start, end: fy.end },
        deductedFromUs: {
            final: { tax: num(pick(deducted.rows, 'treatment', 'FINAL').tax) || 0, gross: num(pick(deducted.rows, 'treatment', 'FINAL').gross) || 0 },
            creditable: { tax: num(pick(deducted.rows, 'treatment', 'CREDITABLE').tax) || 0, gross: num(pick(deducted.rows, 'treatment', 'CREDITABLE').gross) || 0 },
        },
        withheldByUs: {
            real: num(pick(withheld.rows, 'is_shadow', false).tax) || 0,
            shadow: num(pick(withheld.rows, 'is_shadow', true).tax) || 0,
        },
        currentYear,
        upcoming: calendar.filter(i => !i.done).slice(0, 8),
    };
};

const getMyWithholdings = async (userId) => {
    await assertMigrated();
    return (await listWithholdings({ payeeUserId: userId, includeShadow: false })).filter(w => w.status !== 'REVERSED');
};

module.exports = {
    ROLES,
    TAX_GL,
    EXPENSE_TREATMENTS,
    PAYMENT_TYPE_LABELS,
    SOURCE_TYPE_LABELS,
    isMigrated,
    assertMigrated,
    getActiveRoleNames,
    getRegistration,
    saveRegistration,
    agentDesignatedOn,
    setAgentStatus,
    listRates,
    getRateOn,
    addRate,
    toFunctional,
    computeWithholding,
    recordWithholding,
    reverseForTransaction,
    listWithholdings,
    getRemittanceSummary,
    remitMonth,
    postTaxLeg,
    recordTaxAtSource,
    listTaxAtSource,
    updateTaxAtSource,
    fiscalYearFor,
    ensureTaxYears,
    listTaxYears,
    getTaxYear,
    computeWorksheet,
    updateYearOptions,
    setProvisionalEstimate,
    addAdjustment,
    removeAdjustment,
    prepareYear,
    returnYear,
    approveYear,
    fileYear,
    recordTaxPayment,
    getCalendar,
    runDeadlineReminders,
    getOverview,
    getMyWithholdings,
    getTaxStaff,
    getTaxCategoryId,
};
