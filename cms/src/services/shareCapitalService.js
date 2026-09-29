// ============================================================
// SHARE CAPITAL SERVICE (v1.69.0)
//
// Share capital the way the Companies Act 2012 and IFRS for SMEs
// expect it, replacing the v1.33.0 "fractional units" model:
//
//   NOMINAL VALUE (par value) — the fixed legal value of one ordinary
//   share, registered with URSB, kept with its history in
//   share_nominal_history together with the number of shares
//   REGISTERED (authorised). Investabo: UGX 50,000 x 98 shares;
//   Zweck: UGX 100,000 x 600 shares.
//
//   ISSUE PRICE — what the company charges for one new share today
//   (share_price_history, the "share price" the rest of the system has
//   always used). Policy today: issue at nominal, with a suggested
//   price (the net asset value per share) shown alongside.
//
//   WHOLE SHARES — shares are allotted at every contribution, whole
//   shares only. Money that does not buy a whole share stays with the
//   member as SHARE CREDIT (member_capital_credit_entries) and is used
//   first at their next contribution. Credit can be refunded
//   (maker-checker: a different person approves).
//
//   ACCOUNTS — every contribution lands in 3020 Capital Pending
//   Allotment. At allotment, shares x nominal moves to 3000 Share
//   Capital and shares x (issue price - nominal) to 3010 Share
//   Premium (see glService.getShareAllotmentLines). So 3020 always
//   equals the members' total credit.
//
//   REGISTERED LIMIT — never blocks an allotment (the companies issue
//   monthly), but every allotment records how many shares went beyond
//   the registered number, so the increase to file is always known.
//   Each allotment also carries its return-of-allotment due date
//   (s.61: 60 days).
//
//   CHANGES — issue price, nominal value (a split or consolidation that
//   converts every holding by the ratio) and registered shares change
//   only through share_capital_change_requests: a FINAL board
//   resolution from Documents, and two different people — two
//   Directors, or a Director and the Treasurer. Admin alone never
//   approves. Approval generates a formal notice for all shareholders.
//
// Every write here takes the same transaction-scoped advisory lock, so
// two allotments can never interleave (the registered-limit count and
// each member's credit balance are read-then-written).
// ============================================================

const { query, pool } = require('../config/database');
const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('./referenceService');
const { getSharePriceOn, getExchangeRateOn } = require('./sharePricingService');
const { getOrCreateCategory } = require('./categoryService');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { toDateStr, todayStr } = require('./fxService');

// Reference module code for share capital records (allotments,
// change requests, credit refunds): SCP-ALLOT-202609-00001 etc.
MODULE_CODES.SHARE_CAPITAL = MODULE_CODES.SHARE_CAPITAL || 'SCP';
const SCP = MODULE_CODES.SHARE_CAPITAL;

const APPROVER_ROLES = ['Director', 'Treasurer'];
const REFUND_MAKER_ROLES = ['Treasurer', 'Assistant Treasurer'];
const REFUND_CHECKER_ROLES = ['Treasurer', 'Assistant Treasurer', 'Director'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (v === null || v === undefined ? null : parseFloat(v));
const EPS = 1e-9;

const lock = (client) => client.query(`SELECT pg_advisory_xact_lock(hashtext('cms_share_capital'))`);

const addDays = (dateStr, days) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return dt.toISOString().slice(0, 10);
};
const ymOf = (dateStr) => dateStr.slice(0, 4) + dateStr.slice(5, 7);

// ============================================================
// SETTINGS / LOOKUPS
// ============================================================
const getSettings = async (client) => {
    const runner = client || { query };
    // Code deployed before migration_v1.69.0.sql has run: behave as "not
    // converted" (the legacy share calculation keeps working) instead of
    // failing — checked with to_regclass so no error aborts a transaction.
    const exists = await runner.query(`SELECT to_regclass('share_capital_settings') IS NOT NULL AS ok`);
    if (!exists.rows[0].ok) return { allotment_return_days: 60, opening_converted_at: null, migrated: false };
    const r = await runner.query(`
        SELECT allotment_return_days, opening_converted_at, opening_converted_by, opening_summary
        FROM   share_capital_settings WHERE id = 1
    `);
    return r.rows[0] || { allotment_return_days: 60, opening_converted_at: null };
};

const isOpeningConverted = async (client) => !!(await getSettings(client)).opening_converted_at;

const assertOpeningConverted = async (client) => {
    const settings = await getSettings(client);
    if (settings.migrated === false) {
        throw createError.badRequest(
            'The database has not been upgraded to v1.69.0 yet. Run  node run_migration.js migration_v1.69.0.sql  ' +
            'and then the Opening Conversion on the Share Capital page. Nothing was recorded.'
        );
    }
    if (!settings.opening_converted_at) {
        throw createError.badRequest(
            'Share capital has not been converted to whole shares yet (v1.69.0). ' +
            'A Treasurer or Admin must first run the Opening Conversion on the Share Capital page ' +
            '(or run backfill_v1.69.0_share_allotments.js). Nothing was recorded.'
        );
    }
};

const NOMINAL_COLUMNS = `
    snh.id, snh.nominal_value, snh.currency_id, snh.registered_shares,
    snh.effective_from::text AS effective_from, snh.effective_to::text AS effective_to,
    snh.change_request_id, snh.notes, c.code AS currency_code, c.symbol AS currency_symbol`;

// The nominal value (and registered shares) in force on a date. Falls
// back to the earliest row for a date before all history (the seed row
// starts at the first contribution, so this is only a safety net).
const getNominalOn = async (client, date) => {
    const exact = await client.query(`
        SELECT ${NOMINAL_COLUMNS}
        FROM   share_nominal_history snh JOIN currencies c ON c.id = snh.currency_id
        WHERE  snh.effective_from <= $1 AND (snh.effective_to IS NULL OR snh.effective_to > $1)
        ORDER  BY snh.effective_from DESC, snh.id DESC LIMIT 1
    `, [date]);
    if (exact.rows.length) return exact.rows[0];
    const earliest = await client.query(`
        SELECT ${NOMINAL_COLUMNS}
        FROM   share_nominal_history snh JOIN currencies c ON c.id = snh.currency_id
        ORDER  BY snh.effective_from ASC, snh.id ASC LIMIT 1
    `);
    if (earliest.rows.length) return earliest.rows[0];
    throw createError.badRequest('No nominal value per share has been set yet. A Director or the Treasurer enters it on the Share Capital page (Overview > Registered values). Nothing was recorded.');
};

const getCurrentNominal = async (client) => {
    const r = await client.query(`
        SELECT ${NOMINAL_COLUMNS}
        FROM   share_nominal_history snh JOIN currencies c ON c.id = snh.currency_id
        WHERE  snh.effective_to IS NULL LIMIT 1
    `);
    return r.rows[0] || null;
};

const getCurrentIssuePrice = async (client) => {
    const r = await client.query(`
        SELECT sph.id, sph.price_per_share, sph.currency_id, sph.effective_from::text AS effective_from,
               c.code AS currency_code, c.symbol AS currency_symbol
        FROM   share_price_history sph JOIN currencies c ON c.id = sph.currency_id
        WHERE  sph.effective_from <= CURRENT_DATE AND (sph.effective_to IS NULL OR sph.effective_to > CURRENT_DATE)
        ORDER  BY sph.effective_from DESC LIMIT 1
    `);
    return r.rows[0] || null;
};

const getScheduledIssuePrices = async (client) => {
    const r = await client.query(`
        SELECT sph.id, sph.price_per_share, sph.currency_id, sph.effective_from::text AS effective_from
        FROM   share_price_history sph
        WHERE  sph.effective_from > CURRENT_DATE
        ORDER  BY sph.effective_from ASC
    `);
    return r.rows;
};

const getCreditBalance = async (client, userId) => {
    const r = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS balance FROM member_capital_credit_entries WHERE user_id = $1`,
        [userId]
    );
    return round2(parseFloat(r.rows[0].balance));
};

// Whole shares in issue (all members), optionally as of a date.
const getSharesInIssue = async (client, asOfDate = null) => {
    const r = asOfDate
        ? await client.query(`
            SELECT COALESCE(SUM(shares), 0) AS total FROM share_allotments
            WHERE  allotment_date <= $1 AND (status = 'ACTIVE' OR reversed_at > $1)
        `, [asOfDate])
        : await client.query(`SELECT COALESCE(SUM(shares), 0) AS total FROM share_allotments WHERE status = 'ACTIVE'`);
    return parseInt(r.rows[0].total, 10);
};

// Each member's whole shares as of a date (for certificates etc.):
// allotments dated on/before it that were not reversed by then.
const getHoldingsAsOf = async (date, client = null) => {
    const runner = client || { query };
    const r = await runner.query(`
        SELECT user_id, SUM(shares)::int AS shares
        FROM   share_allotments
        WHERE  allotment_date <= $1 AND (status = 'ACTIVE' OR reversed_at > $1)
        GROUP  BY user_id
        HAVING SUM(shares) <> 0
    `, [date]);
    const byUser = new Map(r.rows.map(x => [x.user_id, x.shares]));
    const total = r.rows.reduce((s, x) => s + x.shares, 0);
    return { byUser, total };
};

// Date of the latest applied nominal value change (split/consolidation).
// Nothing may be allotted with an earlier date afterwards — it would
// miss the conversion.
const getLastNominalChangeDate = async (client) => {
    const r = await client.query(`
        SELECT MAX(effective_date)::text AS d FROM share_capital_change_requests
        WHERE  change_type = 'NOMINAL_VALUE' AND status = 'APPLIED'
    `);
    return r.rows[0].d || null;
};

const getActiveRoleNames = async (client, userId) => {
    const r = await client.query(`
        SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE  ur.user_id = $1 AND ur.revoked_at IS NULL AND r.is_active = TRUE
    `, [userId]);
    return r.rows.map(x => x.name);
};

// The capacity a person signs a share value change in. Director wins
// when someone holds both roles. Admin is deliberately not listed.
const approverCapacity = (roles) => (roles.includes('Director') ? 'Director' : roles.includes('Treasurer') ? 'Treasurer' : null);

const userName = async (client, userId) => {
    const r = await client.query(`SELECT first_name || ' ' || last_name AS name FROM users WHERE id = $1`, [userId]);
    return r.rows[0]?.name || null;
};

// ============================================================
// VALUE OF A CONTRIBUTION IN THE SHARE CURRENCY (UGX)
// When the share currency is the functional currency (UGX) and the
// contribution's own transaction already carries its UGX value
// (transactions.functional_amount, fixed at the rate on its date —
// v1.66.0), that exact figure is used, so 3020 in the books and the
// members' credit always agree to the shilling. Otherwise the rate in
// force on the contribution date is used (sharePricingService).
// ============================================================
const valueInShareCurrency = async (client, { amount, currencyId, date, transactionId = null }) => {
    const price = await getSharePriceOn(client, date);
    const shareCurrencyId = price.currency_id;
    const amt = parseFloat(amount);
    if (currencyId === shareCurrencyId) {
        return { value: round2(amt), rate: 1, shareCurrencyId, source: 'SAME_CURRENCY' };
    }
    if (transactionId) {
        const t = await client.query(`
            SELECT t.functional_amount, t.functional_rate, cs.functional_currency_id
            FROM   transactions t CROSS JOIN company_settings cs
            WHERE  t.id = $1 AND cs.id = 1
        `, [transactionId]);
        const row = t.rows[0];
        if (row && row.functional_amount !== null && row.functional_currency_id === shareCurrencyId) {
            return {
                value: round2(parseFloat(row.functional_amount)),
                rate: num(row.functional_rate),
                shareCurrencyId,
                source: 'TRANSACTION_UGX_VALUE',
            };
        }
    }
    const rate = await getExchangeRateOn(client, currencyId, shareCurrencyId, date);
    return { value: round2(amt * rate), rate, shareCurrencyId, source: 'RATE_TABLE' };
};

const contributionTransactionId = async (client, contributionId) => {
    const r = await client.query(`
        SELECT id FROM transactions
        WHERE  contribution_id = $1 AND is_reversal = FALSE
        ORDER  BY id ASC LIMIT 1
    `, [contributionId]);
    return r.rows[0]?.id || null;
};

// ============================================================
// CREATE ONE ALLOTMENT ROW (with its reference and registered-limit
// snapshot). Amounts default to shares x nominal / premium.
// ============================================================
const createAllotment = async (client, {
    userId, contributionId = null, changeRequestId = null, source, date, shares,
    nominalValue, issuePrice, currencyId, createdBy,
    considerationAmount = null, capitalAmount = null, premiumAmount = null,
    notes = null, returnDays = 60,
}) => {
    const nominalRow = await getNominalOn(client, date);
    const registered = nominalRow.registered_shares !== null ? parseInt(nominalRow.registered_shares, 10) : null;
    const totalBefore = await getSharesInIssue(client);
    const totalAfter = totalBefore + shares;
    let beyond = 0;
    if (registered !== null && shares > 0) {
        beyond = Math.max(0, totalAfter - registered) - Math.max(0, totalBefore - registered);
    }

    const consideration = considerationAmount !== null ? considerationAmount : round2(shares * issuePrice);
    const capital = capitalAmount !== null ? capitalAmount : round2(shares * nominalValue);
    const premium = premiumAmount !== null ? premiumAmount : round2(shares * (issuePrice - nominalValue));

    const abbrev = { CONTRIBUTION: 'ALLOT', OPENING_CONVERSION: 'OPEN', SPLIT: 'SPLIT', CONSOLIDATION: 'CONSOL' }[source];
    const { referenceId, referenceCode } = await generateReference(client, SCP, abbrev, 'SHARE_ALLOTMENT', createdBy, ymOf(date));

    const needsReturn = source === 'CONTRIBUTION' || source === 'OPENING_CONVERSION';
    const r = await client.query(`
        INSERT INTO share_allotments (
            reference_id, user_id, contribution_id, change_request_id, source, allotment_date, shares,
            nominal_value, issue_price, currency_id,
            consideration_amount, share_capital_amount, share_premium_amount,
            registered_shares, total_shares_after, shares_beyond_registered,
            return_due_date, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING id
    `, [
        referenceId, userId, contributionId, changeRequestId, source, date, shares,
        nominalValue, issuePrice, currencyId,
        consideration, capital, premium,
        registered, totalAfter, beyond,
        needsReturn ? addDays(date, returnDays) : null, notes, createdBy,
    ]);
    await linkReferenceToRecord(client, referenceId, r.rows[0].id);
    return {
        allotmentId: r.rows[0].id, referenceCode, shares, totalBefore, totalAfter,
        registeredShares: registered, sharesBeyondRegistered: beyond,
        considerationAmount: consideration, shareCapitalAmount: capital, sharePremiumAmount: premium,
    };
};

const addCreditEntry = async (client, {
    userId, date, entryType, amount, currencyId, contributionId = null, allotmentId = null,
    refundId = null, changeRequestId = null, originalAmount = null, originalCurrencyId = null,
    rateUsed = null, notes = null, createdBy = null,
}) => {
    await client.query(`
        INSERT INTO member_capital_credit_entries (
            user_id, entry_date, entry_type, amount, currency_id, contribution_id, allotment_id,
            refund_id, change_request_id, original_amount, original_currency_id, rate_used, notes, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [userId, date, entryType, round2(amount), currencyId, contributionId, allotmentId,
        refundId, changeRequestId, originalAmount, originalCurrencyId, rateUsed, notes, createdBy]);
};

// ============================================================
// REGISTERED VALUES — SET IN THE SYSTEM (v1.69.0)
// The nominal value per share and the number of registered shares,
// with their history (share_nominal_history), are entered on the
// Share Capital page by a Director or the Treasurer — no code or
// migration values. While NO shares have been allotted yet they can be
// edited freely (the whole history is replaced by what is saved), so
// they can be checked before the opening conversion uses them. Once
// the first allotment exists they are LOCKED: from then on they only
// change through Share Capital > Changes (board resolution + two
// different approvers), so allotments already made always keep the
// values they were made under.
// ============================================================
const isRegisteredSetupLocked = async (client) => {
    const r = await client.query(`SELECT EXISTS (SELECT 1 FROM share_allotments) AS locked`);
    return r.rows[0].locked;
};

const getRegisteredSetup = async () => {
    const runner = { query };
    const [rows, locked, firstContribution, price, currencies] = await Promise.all([
        query(`
            SELECT snh.id, snh.nominal_value, snh.registered_shares, snh.currency_id, c.code AS currency_code,
                   snh.effective_from::text AS effective_from, snh.effective_to::text AS effective_to,
                   snh.change_request_id, snh.notes, snh.created_at,
                   u.first_name || ' ' || u.last_name AS set_by_name
            FROM   share_nominal_history snh
            JOIN   currencies c ON c.id = snh.currency_id
            LEFT JOIN users u ON u.id = snh.set_by
            ORDER  BY snh.effective_from ASC, snh.id ASC
        `),
        isRegisteredSetupLocked(runner),
        query(`SELECT MIN(contribution_date)::text AS d FROM shareholder_contributions WHERE status = 'APPROVED'`),
        getCurrentIssuePrice(runner),
        query(`SELECT id, code FROM currencies ORDER BY code`),
    ]);
    return {
        locked,
        history: rows.rows.map(r => ({
            ...r,
            nominal_value: parseFloat(r.nominal_value),
            registered_shares: r.registered_shares === null ? null : parseInt(r.registered_shares, 10),
        })),
        firstContributionDate: firstContribution.rows[0].d,
        issuePrice: price ? { value: parseFloat(price.price_per_share), currencyId: price.currency_id, currencyCode: price.currency_code } : null,
        currencies: currencies.rows,
    };
};

// rows: [{ effective_from, nominal_value, registered_shares (or null) }],
// all in one currency. Replaces the whole history (unlocked only).
const saveRegisteredSetup = async (client, { rows, currencyId, notes, userId }) => {
    await lock(client);
    const roles = await getActiveRoleNames(client, userId);
    if (!approverCapacity(roles)) {
        throw createError.forbidden('Only a Director or the Treasurer can set the registered values (the Admin role alone cannot).');
    }
    if (await isRegisteredSetupLocked(client)) {
        throw createError.conflict(
            'Shares have already been allotted, so the registered values are locked. Change the nominal value or the ' +
            'number of registered shares under Share Capital > Changes (board resolution + two approvers).'
        );
    }
    if (!Array.isArray(rows) || rows.length === 0) throw createError.badRequest('Enter at least one row (the values from the company\'s registration).');
    const cur = parseInt(currencyId, 10);
    const curOk = await client.query(`SELECT code FROM currencies WHERE id = $1`, [cur]);
    if (!curOk.rows.length) throw createError.badRequest('Choose the currency of the nominal value.');
    const price = await getCurrentIssuePrice(client);
    if (price && price.currency_id !== cur) {
        throw createError.badRequest(`The nominal value must be in the same currency as the share price (${price.currency_code}).`);
    }

    const clean = rows.map((r, i) => {
        const from = toDateStr(r.effective_from);
        const nominal = parseFloat(r.nominal_value);
        const regRaw = r.registered_shares;
        const reg = regRaw === null || regRaw === undefined || regRaw === '' ? null : Number(regRaw);
        if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw createError.badRequest(`Row ${i + 1}: enter the date the values applied from.`);
        if (!(nominal > 0)) throw createError.badRequest(`Row ${i + 1}: the nominal value must be a positive amount.`);
        if (reg !== null && !(Number.isInteger(reg) && reg > 0)) throw createError.badRequest(`Row ${i + 1}: registered shares must be a whole number above 0 (or left empty if unknown).`);
        return { from, nominal, reg };
    }).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    for (let i = 1; i < clean.length; i++) {
        if (clean[i].from === clean[i - 1].from) throw createError.badRequest(`Two rows start on the same date (${clean[i].from}).`);
    }

    const before = await client.query(`
        SELECT nominal_value, registered_shares, effective_from::text AS effective_from, effective_to::text AS effective_to
        FROM share_nominal_history ORDER BY effective_from, id
    `);
    // Detach any applied change request rows (only REGISTERED_SHARES can
    // exist before the first allotment) — the saved history replaces them.
    await client.query(`DELETE FROM share_nominal_history`);
    for (let i = 0; i < clean.length; i++) {
        const next = clean[i + 1];
        await client.query(`
            INSERT INTO share_nominal_history (nominal_value, currency_id, registered_shares, effective_from, effective_to, set_by, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [clean[i].nominal, cur, clean[i].reg, clean[i].from, next ? next.from : null, userId,
            notes || 'Entered on the Share Capital page (registered values set-up).']);
    }
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'share_nominal_history',
        oldValues: { history: before.rows },
        newValues: { history: clean, currencyId: cur },
        description: `Registered values set: ${clean.map(c => `${c.from}: nominal ${c.nominal}, registered ${c.reg ?? 'not set'}`).join('; ')}`,
        client,
    });
    return { rows: clean.length };
};

// ============================================================
// THE ALLOTMENT RULE (shared by live contributions and the opening
// conversion — so both can never disagree):
//   credit available = credit before + this contribution's value
//   whole shares     = floor(credit available / issue price on the date)
//   credit after     = credit available - whole shares x issue price
// ============================================================
const applyContributionToCredit = async (client, {
    userId, contributionId, date, amount, currencyId, transactionId, createdBy, source, returnDays,
}) => {
    const val = await valueInShareCurrency(client, { amount, currencyId, date, transactionId });
    const price = await getSharePriceOn(client, date);
    const issuePrice = parseFloat(price.price_per_share);
    const nominalRow = await getNominalOn(client, date);
    const nominalValue = parseFloat(nominalRow.nominal_value);
    if (nominalRow.currency_id !== price.currency_id) {
        throw createError.badRequest(
            'The share price and the nominal value are in different currencies. Both must be in the same currency (UGX) — fix this on the Share Capital page before recording contributions.'
        );
    }
    const shareCurrencyId = price.currency_id;

    const creditBefore = await getCreditBalance(client, userId);
    await addCreditEntry(client, {
        userId, date, entryType: 'CONTRIBUTION', amount: val.value, currencyId: shareCurrencyId,
        contributionId, originalAmount: parseFloat(amount), originalCurrencyId: currencyId,
        rateUsed: val.rate, notes: `Contribution value (${val.source})`, createdBy,
    });
    const available = round2(creditBefore + val.value);
    const shares = available > 0 ? Math.floor(available / issuePrice + EPS) : 0;

    let allotment = null;
    if (shares > 0) {
        allotment = await createAllotment(client, {
            userId, contributionId, source, date, shares, nominalValue, issuePrice,
            currencyId: shareCurrencyId, createdBy, returnDays,
        });
        await addCreditEntry(client, {
            userId, date, entryType: 'ALLOTMENT', amount: -allotment.considerationAmount, currencyId: shareCurrencyId,
            contributionId, allotmentId: allotment.allotmentId,
            notes: `${shares} whole share(s) at ${issuePrice.toLocaleString('en-US')}`, createdBy,
        });
    }
    const creditAfter = await getCreditBalance(client, userId);

    return {
        contributionValue: val.value,
        rateUsed: val.rate,
        rateSource: val.source,
        shareCurrencyId,
        issuePrice,
        nominalValue,
        creditBefore,
        creditAvailable: available,
        sharesAllotted: shares,
        creditUsed: allotment ? allotment.considerationAmount : 0,
        creditAfter,
        allotment,
    };
};

// ============================================================
// LIVE: ALLOT SHARES FOR ONE NEW CONTRIBUTION
// Called by transactionsController.creditShareholderContribution inside
// its transaction, right after the contribution and its transaction
// have been inserted.
// ============================================================
const allotForContribution = async (client, {
    userId, contributionId, contributionDate, amount, currencyId, transactionId, createdBy,
}) => {
    await lock(client);
    await assertOpeningConverted(client);
    const date = toDateStr(contributionDate);
    const lastNominalChange = await getLastNominalChangeDate(client);
    if (lastNominalChange && date < lastNominalChange) {
        throw createError.badRequest(
            `This contribution is dated ${date}, before the nominal value change applied on ${lastNominalChange}. ` +
            `Shares can no longer be allotted at the old nominal value — record it with a date on or after ${lastNominalChange}.`
        );
    }
    const settings = await getSettings(client);
    const result = await applyContributionToCredit(client, {
        userId, contributionId, date, amount, currencyId, transactionId, createdBy,
        source: 'CONTRIBUTION', returnDays: settings.allotment_return_days,
    });
    await recalculateShareholding(client, { recordedByUserId: createdBy });
    return result;
};

// ============================================================
// LIVE: REVERSE A CONTRIBUTION'S SHARES AND CREDIT
// Called by transactionsController.reverseTransaction. The shares
// allotted from that contribution are cancelled and its value is taken
// back out of the member's credit. The credit can go NEGATIVE (the
// member's other money already bought shares that this contribution
// had topped up) — the member's next contribution fills it first.
// ============================================================
const reverseContribution = async (client, { contributionId, reversalDate, reason, reversedBy }) => {
    await lock(client);
    if (!(await isOpeningConverted(client))) return null; // legacy data: nothing to reverse here
    const date = toDateStr(reversalDate) || todayStr();

    const allots = await client.query(`
        SELECT id, user_id, shares, allotment_date::text AS allotment_date, consideration_amount, currency_id
        FROM   share_allotments
        WHERE  contribution_id = $1 AND status = 'ACTIVE'
        ORDER  BY id
    `, [contributionId]);

    const lastNominalChange = await getLastNominalChangeDate(client);
    for (const a of allots.rows) {
        if (lastNominalChange && a.allotment_date < lastNominalChange) {
            throw createError.badRequest(
                `This contribution's shares were allotted on ${a.allotment_date}, before the nominal value change of ` +
                `${lastNominalChange} converted every holding. It can't be reversed automatically — ask the Treasurer ` +
                `to adjust this member's holding through a new share capital change.`
            );
        }
    }

    let sharesCancelled = 0;
    for (const a of allots.rows) {
        await client.query(`
            UPDATE share_allotments
            SET    status = 'REVERSED', reversed_at = $1, reversed_by = $2, reversal_reason = $3
            WHERE  id = $4
        `, [date, reversedBy, reason || null, a.id]);
        await addCreditEntry(client, {
            userId: a.user_id, date, entryType: 'ALLOTMENT_REVERSAL', amount: parseFloat(a.consideration_amount),
            currencyId: a.currency_id, contributionId, allotmentId: a.id,
            notes: `Allotment of ${a.shares} share(s) cancelled — contribution reversed`, createdBy: reversedBy,
        });
        sharesCancelled += a.shares;
    }

    const contribEntries = await client.query(`
        SELECT user_id, currency_id, COALESCE(SUM(amount), 0) AS total
        FROM   member_capital_credit_entries
        WHERE  contribution_id = $1 AND entry_type IN ('CONTRIBUTION', 'CONTRIBUTION_REVERSAL')
        GROUP  BY user_id, currency_id
    `, [contributionId]);
    for (const e of contribEntries.rows) {
        const total = parseFloat(e.total);
        if (Math.abs(total) < 0.005) continue;
        await addCreditEntry(client, {
            userId: e.user_id, date, entryType: 'CONTRIBUTION_REVERSAL', amount: -total, currencyId: e.currency_id,
            contributionId, notes: `Contribution reversed${reason ? `: ${reason}` : ''}`, createdBy: reversedBy,
        });
    }

    await recalculateShareholding(client, { recordedByUserId: reversedBy });
    return { sharesCancelled };
};

// ============================================================
// SHAREHOLDING REGISTRY = SUM OF ACTIVE ALLOTMENTS (whole shares).
// The only writer of shareholding_registry.shares_held/percentage once
// the opening conversion has run.
// ============================================================
const recalculateShareholding = async (client, { recordedByUserId }) => {
    const holdings = await client.query(`
        SELECT user_id, SUM(shares)::int AS shares, MIN(allotment_date)::text AS first_date
        FROM   share_allotments WHERE status = 'ACTIVE'
        GROUP  BY user_id
    `);
    const total = holdings.rows.reduce((s, h) => s + h.shares, 0);
    const holders = new Set();
    for (const h of holdings.rows) {
        holders.add(h.user_id);
        const pct = total > 0 ? ((h.shares / total) * 100).toFixed(4) : '0.0000';
        const upd = await client.query(`
            UPDATE shareholding_registry
            SET    shares_held = $1, percentage = $2, updated_by = $3,
                   notes = 'Whole shares from share_allotments (v1.69.0)'
            WHERE  user_id = $4 AND effective_to IS NULL
        `, [h.shares, pct, recordedByUserId, h.user_id]);
        if (upd.rowCount === 0) {
            await client.query(`
                INSERT INTO shareholding_registry (user_id, shares_held, percentage, effective_from, updated_by, notes)
                VALUES ($1, $2, $3, $4, $5, 'Whole shares from share_allotments (v1.69.0)')
            `, [h.user_id, h.shares, pct, h.first_date, recordedByUserId]);
        }
    }
    const ids = Array.from(holders);
    await client.query(`
        UPDATE shareholding_registry
        SET    shares_held = 0, percentage = 0, updated_by = $1,
               notes = 'Whole shares from share_allotments (v1.69.0)'
        WHERE  effective_to IS NULL
        AND    NOT (user_id = ANY($2::int[]))
        AND    (shares_held <> 0 OR percentage IS NULL OR percentage <> 0)
    `, [recordedByUserId, ids]);
    return { totalShares: total, holders: ids.length };
};

// ============================================================
// OPENING CONVERSION (one-off)
// Replays every APPROVED contribution to date, oldest first, through
// the same allotment rule as live contributions, at the share price
// and nominal value in force on each contribution's own date. So a
// historical contribution keeps exactly the price it was made at —
// changing today's price never re-prices old holdings. Each member's
// old fractional holding becomes whole shares + share credit.
//
// `commit: false` runs everything inside a transaction that is rolled
// back — a true preview of what would be written.
// ============================================================
const runOpeningConversion = async (client, { userId }) => {
    await lock(client);
    const settings = await getSettings(client);
    if (settings.opening_converted_at) {
        throw createError.badRequest('The opening conversion has already been run.');
    }
    if (!(await getCurrentNominal(client))) {
        throw createError.badRequest('Enter the registered values first (Share Capital > Overview > Registered values): the nominal value per share and the number of registered shares.');
    }
    const existing = await client.query(`SELECT COUNT(*)::int AS n FROM share_allotments`);
    if (existing.rows[0].n > 0) {
        throw createError.badRequest('Share allotments already exist — the opening conversion can only run on an empty allotment register.');
    }
    await client.query(`DELETE FROM member_capital_credit_entries`);

    const before = await client.query(`
        SELECT sr.user_id, sr.shares_held, sr.percentage, u.first_name || ' ' || u.last_name AS name
        FROM   shareholding_registry sr JOIN users u ON u.id = sr.user_id
        WHERE  sr.effective_to IS NULL
    `);
    const beforeByUser = new Map(before.rows.map(r => [r.user_id, r]));

    const contributions = await client.query(`
        SELECT sc.id, sc.user_id, sc.amount, sc.currency_id, sc.contribution_date::text AS contribution_date,
               u.first_name || ' ' || u.last_name AS name
        FROM   shareholder_contributions sc JOIN users u ON u.id = sc.user_id
        WHERE  sc.status = 'APPROVED'
        ORDER  BY sc.contribution_date ASC, sc.id ASC
    `);

    const members = new Map();
    const belowNominal = [];
    for (const c of contributions.rows) {
        const txId = await contributionTransactionId(client, c.id);
        const res = await applyContributionToCredit(client, {
            userId: c.user_id, contributionId: c.id, date: c.contribution_date, amount: c.amount,
            currencyId: c.currency_id, transactionId: txId, createdBy: userId,
            source: 'OPENING_CONVERSION', returnDays: settings.allotment_return_days,
        });
        if (res.issuePrice < res.nominalValue - EPS && res.sharesAllotted > 0) {
            belowNominal.push({ contributionId: c.id, date: c.contribution_date, issuePrice: res.issuePrice, nominalValue: res.nominalValue });
        }
        if (!members.has(c.user_id)) {
            members.set(c.user_id, { userId: c.user_id, name: c.name, contributions: 0, paidIn: 0, shares: 0 });
        }
        const m = members.get(c.user_id);
        m.contributions += 1;
        m.paidIn = round2(m.paidIn + res.contributionValue);
        m.shares += res.sharesAllotted;
    }

    const rows = [];
    for (const m of members.values()) {
        const b = beforeByUser.get(m.userId);
        const credit = await getCreditBalance(client, m.userId);
        rows.push({
            ...m,
            oldSharesHeld: b ? parseFloat(b.shares_held) : 0,
            oldPercentage: b && b.percentage !== null ? parseFloat(b.percentage) : null,
            newWholeShares: m.shares,
            creditLeft: credit,
        });
    }
    for (const b of before.rows) {
        if (!members.has(b.user_id) && parseFloat(b.shares_held) !== 0) {
            rows.push({ userId: b.user_id, name: b.name, contributions: 0, paidIn: 0, shares: 0,
                oldSharesHeld: parseFloat(b.shares_held), oldPercentage: num(b.percentage), newWholeShares: 0, creditLeft: 0 });
        }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));

    const reg = await recalculateShareholding(client, { recordedByUserId: userId });
    const current = await getCurrentNominal(client);
    const totalCredit = round2(rows.reduce((s, r) => s + r.creditLeft, 0));
    for (const r of rows) {
        r.newPercentage = reg.totalShares > 0 ? parseFloat(((r.newWholeShares / reg.totalShares) * 100).toFixed(4)) : 0;
    }
    const summary = {
        contributions: contributions.rows.length,
        members: rows,
        totalShares: reg.totalShares,
        totalCredit,
        registeredShares: current && current.registered_shares !== null ? parseInt(current.registered_shares, 10) : null,
        sharesBeyondRegistered: current && current.registered_shares !== null
            ? Math.max(0, reg.totalShares - parseInt(current.registered_shares, 10)) : null,
        allottedBelowNominal: belowNominal,
    };

    await client.query(`
        UPDATE share_capital_settings
        SET    opening_converted_at = NOW(), opening_converted_by = $1, opening_summary = $2, updated_at = NOW()
        WHERE  id = 1
    `, [userId, JSON.stringify(summary)]);

    return summary;
};

// Runs fn(client) in a transaction that is ALWAYS rolled back.
const withRollback = async (fn) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        return await fn(client);
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
};

const previewOpeningConversion = ({ userId }) => withRollback(client => runOpeningConversion(client, { userId }));

// ============================================================
// SHARE CAPITAL CHANGE REQUESTS
// ============================================================
const REQUEST_COLUMNS = `
    r.id, r.change_type, r.currency_id, r.current_value, r.proposed_value,
    r.effective_date::text AS effective_date, r.resolution_document_id, r.reason, r.status,
    r.requested_by, r.requested_role, r.requested_at, r.approved_by, r.approved_role, r.approved_at,
    r.rejected_by, r.rejected_at, r.decision_note, r.applied_at, r.result_summary, r.notice_document_id,
    rr.reference_code, c.code AS currency_code,
    ru.first_name || ' ' || ru.last_name AS requested_by_name,
    au.first_name || ' ' || au.last_name AS approved_by_name,
    xu.first_name || ' ' || xu.last_name AS rejected_by_name,
    d.title AS resolution_title, drr.reference_code AS resolution_reference,
    ndr.reference_code AS notice_reference`;

const REQUEST_FROM = `
    FROM share_capital_change_requests r
    LEFT JOIN references_registry rr ON rr.id = r.reference_id
    JOIN currencies c ON c.id = r.currency_id
    JOIN users ru ON ru.id = r.requested_by
    LEFT JOIN users au ON au.id = r.approved_by
    LEFT JOIN users xu ON xu.id = r.rejected_by
    JOIN documents d ON d.id = r.resolution_document_id
    LEFT JOIN references_registry drr ON drr.id = d.reference_id
    LEFT JOIN documents nd ON nd.id = r.notice_document_id
    LEFT JOIN references_registry ndr ON ndr.id = nd.reference_id`;

const listChangeRequests = async () => {
    const r = await query(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} ORDER BY r.requested_at DESC LIMIT 200`);
    return r.rows;
};

const getChangeRequest = async (client, id, forUpdate = false) => {
    const r = await client.query(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE r.id = $1`, [id]);
    if (!r.rows.length) throw createError.notFound('Share capital change request not found');
    if (forUpdate) await client.query(`SELECT id FROM share_capital_change_requests WHERE id = $1 FOR UPDATE`, [id]);
    return r.rows[0];
};

const assertFinalResolution = async (client, documentId) => {
    const r = await client.query(`
        SELECT d.id, d.document_type, d.status, d.title, rr.reference_code
        FROM   documents d LEFT JOIN references_registry rr ON rr.id = d.reference_id
        WHERE  d.id = $1
    `, [documentId]);
    const doc = r.rows[0];
    if (!doc) throw createError.badRequest('The board resolution document was not found.');
    if (doc.document_type !== 'RESOLUTION') {
        throw createError.badRequest(`"${doc.title}" is not a Resolution document. Link the approved board resolution that authorises this change.`);
    }
    if (doc.status !== 'FINAL') {
        throw createError.badRequest(`The resolution "${doc.title}" is ${doc.status}, not FINAL. It must be approved (and fully signed) in Documents first.`);
    }
    return doc;
};

// FINAL board resolutions that can be linked to a change.
const listEligibleResolutions = async () => {
    const r = await query(`
        SELECT d.id, d.title, d.created_at, d.approved_at, rr.reference_code
        FROM   documents d LEFT JOIN references_registry rr ON rr.id = d.reference_id
        WHERE  d.document_type = 'RESOLUTION' AND d.status = 'FINAL'
        ORDER  BY COALESCE(d.approved_at, d.created_at) DESC
        LIMIT  200
    `);
    return r.rows;
};

const isExactRatio = (big, small) => {
    const ratio = big / small;
    return Math.abs(ratio - Math.round(ratio)) < 1e-9 && Math.round(ratio) >= 2;
};

const createChangeRequest = async (client, {
    changeType, proposedValue, effectiveDate, resolutionDocumentId, reason, userId,
}) => {
    await lock(client);
    const roles = await getActiveRoleNames(client, userId);
    const capacity = approverCapacity(roles);
    if (!capacity) {
        throw createError.forbidden('Only a Director or the Treasurer can propose a share capital change (the Admin role alone cannot).');
    }
    if (!reason || !String(reason).trim()) throw createError.badRequest('A reason is required.');
    const pending = await client.query(`
        SELECT rr.reference_code FROM share_capital_change_requests r
        LEFT JOIN references_registry rr ON rr.id = r.reference_id
        WHERE r.change_type = $1 AND r.status = 'PENDING' LIMIT 1
    `, [changeType]);
    if (pending.rows.length) {
        throw createError.conflict(`A change of this kind (${pending.rows[0].reference_code}) is already waiting for approval. Approve, reject or withdraw it first.`);
    }
    if ((changeType === 'NOMINAL_VALUE' || changeType === 'REGISTERED_SHARES') && !(await isRegisteredSetupLocked(client))) {
        throw createError.badRequest('No shares have been allotted yet, so the registered values are still edited directly: Share Capital > Overview > Registered values.');
    }
    await assertFinalResolution(client, resolutionDocumentId);

    const today = todayStr();
    const proposed = parseFloat(proposedValue);
    if (!(proposed > 0)) throw createError.badRequest('The proposed value must be a positive number.');

    const nominal = await getCurrentNominal(client);
    if (!nominal) throw createError.badRequest('No nominal value is recorded yet — enter the registered values on the Share Capital page (Overview > Registered values) first.');
    const nominalValue = parseFloat(nominal.nominal_value);

    let currentValue;
    let currencyId = nominal.currency_id;
    let eff = toDateStr(effectiveDate) || today;

    if (changeType === 'ISSUE_PRICE') {
        const price = await getCurrentIssuePrice(client);
        currentValue = price ? parseFloat(price.price_per_share) : null;
        if (price) currencyId = price.currency_id;
        if (eff < today) throw createError.badRequest('A new issue price can only take effect today or on a future date.');
        if (proposed < nominalValue - EPS) {
            throw createError.badRequest(
                `The issue price cannot be below the nominal value (${nominalValue}). Issuing shares at a discount needs a special resolution and the conditions of the Companies Act 2012 s.68 — it is not supported here.`
            );
        }
        if (currentValue !== null && Math.abs(proposed - currentValue) < EPS) throw createError.badRequest('The proposed issue price is the same as the current one.');
    } else if (changeType === 'NOMINAL_VALUE') {
        await assertOpeningConverted(client);
        currentValue = nominalValue;
        if (Math.abs(proposed - nominalValue) < EPS) throw createError.badRequest('The proposed nominal value is the same as the current one.');
        const ok = proposed < nominalValue ? isExactRatio(nominalValue, proposed) : isExactRatio(proposed, nominalValue);
        if (!ok) {
            throw createError.badRequest(
                `A nominal value change must be an exact split or consolidation: the old value (${nominalValue}) and the new value must divide into each other a whole number of times (for example ${nominalValue} → ${nominalValue / 2} is a 1-into-2 split, ${nominalValue} → ${nominalValue * 2} is a 2-into-1 consolidation).`
            );
        }
        eff = today; // applied on the day it is approved
    } else if (changeType === 'REGISTERED_SHARES') {
        currentValue = nominal.registered_shares !== null ? parseInt(nominal.registered_shares, 10) : null;
        if (!Number.isInteger(proposed)) throw createError.badRequest('The number of registered shares must be a whole number.');
        if (currentValue !== null && proposed === currentValue) throw createError.badRequest('The proposed number of registered shares is the same as the current one.');
        if (eff > today) throw createError.badRequest('Enter the date the change was registered with URSB (today or earlier).');
        if (eff < nominal.effective_from) throw createError.badRequest(`The date cannot be before the current record's start date (${nominal.effective_from}).`);
    } else {
        throw createError.badRequest('Unknown change type.');
    }

    const { referenceId, referenceCode } = await generateReference(client, SCP, 'CHG', 'SHARE_CAPITAL_CHANGE', userId);
    const ins = await client.query(`
        INSERT INTO share_capital_change_requests (
            reference_id, change_type, currency_id, current_value, proposed_value, effective_date,
            resolution_document_id, reason, requested_by, requested_role
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
    `, [referenceId, changeType, currencyId, currentValue, proposed, eff, resolutionDocumentId, reason, userId, capacity]);
    await linkReferenceToRecord(client, referenceId, ins.rows[0].id);

    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'share_capital_change_requests', recordId: ins.rows[0].id,
        newValues: { changeType, currentValue, proposed, effectiveDate: eff, resolutionDocumentId, capacity },
        description: `Share capital change proposed (${changeType}): ${currentValue} → ${proposed} — ${referenceCode}`,
        client,
    });
    return { id: ins.rows[0].id, referenceCode, capacity };
};

const rejectChangeRequest = async (client, { requestId, userId, note, cancel = false }) => {
    const req = await getChangeRequest(client, requestId, true);
    if (req.status !== 'PENDING') throw createError.badRequest(`This request is already ${req.status}.`);
    if (cancel) {
        if (req.requested_by !== userId) throw createError.forbidden('Only the person who proposed it can withdraw it.');
    } else {
        const roles = await getActiveRoleNames(client, userId);
        if (!approverCapacity(roles)) throw createError.forbidden('Only a Director or the Treasurer can reject a share capital change.');
    }
    await client.query(`
        UPDATE share_capital_change_requests
        SET    status = $1, rejected_by = $2, rejected_at = NOW(), decision_note = $3
        WHERE  id = $4
    `, [cancel ? 'CANCELLED' : 'REJECTED', userId, note || null, requestId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'share_capital_change_requests', recordId: requestId,
        description: `Share capital change ${req.reference_code} ${cancel ? 'withdrawn' : 'rejected'}${note ? `: ${note}` : ''}`,
        client,
    });
    return { status: cancel ? 'CANCELLED' : 'REJECTED' };
};

// ---- apply: ISSUE PRICE -------------------------------------------------
const applyIssuePrice = async (client, req, approverId) => {
    const today = todayStr();
    const eff = req.effective_date < today ? today : req.effective_date;
    const later = await client.query(`SELECT effective_from::text AS d FROM share_price_history WHERE effective_from >= $1 ORDER BY effective_from LIMIT 1`, [eff]);
    if (later.rows.length) {
        throw createError.badRequest(`A share price already starts on ${later.rows[0].d}, on or after ${eff}. Withdraw this request and propose one dated after it.`);
    }
    const before = await getCurrentIssuePrice(client);
    await client.query(`UPDATE share_price_history SET effective_to = $1 WHERE effective_to IS NULL OR effective_to > $1`, [eff]);
    await client.query(`
        INSERT INTO share_price_history (price_per_share, currency_id, effective_from, set_by, notes)
        VALUES ($1, $2, $3, $4, $5)
    `, [req.proposed_value, req.currency_id, eff, approverId,
        `Approved share capital change ${req.reference_code} (resolution ${req.resolution_reference || req.resolution_document_id}). ${req.reason}`]);
    return {
        kind: 'ISSUE_PRICE',
        issuePriceBefore: before ? parseFloat(before.price_per_share) : null,
        issuePriceAfter: parseFloat(req.proposed_value),
        effectiveDate: eff,
    };
};

// ---- apply: REGISTERED SHARES -------------------------------------------
const applyRegisteredShares = async (client, req, approverId) => {
    const current = await getCurrentNominal(client);
    const eff = req.effective_date;
    if (eff < current.effective_from) throw createError.badRequest(`The date cannot be before ${current.effective_from}.`);
    await client.query(`UPDATE share_nominal_history SET effective_to = $1 WHERE id = $2`, [eff, current.id]);
    await client.query(`
        INSERT INTO share_nominal_history (nominal_value, currency_id, registered_shares, effective_from, change_request_id, set_by, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [current.nominal_value, current.currency_id, parseInt(req.proposed_value, 10), eff, req.id, approverId,
        `Registered shares changed by ${req.reference_code}. ${req.reason}`]);
    const issued = await getSharesInIssue(client);
    return {
        kind: 'REGISTERED_SHARES',
        registeredBefore: current.registered_shares !== null ? parseInt(current.registered_shares, 10) : null,
        registeredAfter: parseInt(req.proposed_value, 10),
        sharesInIssue: issued,
        sharesBeyondRegistered: Math.max(0, issued - parseInt(req.proposed_value, 10)),
        effectiveDate: eff,
    };
};

// ---- apply: NOMINAL VALUE (split / consolidation) -------------------------
// SPLIT (e.g. 100,000 → 50,000, factor 2): every member's shares x 2.
//   Share capital is unchanged (twice the shares at half the value).
// CONSOLIDATION (e.g. 50,000 → 100,000, factor 2): every member's
//   shares ÷ 2, rounded DOWN to whole shares. A leftover old share
//   that cannot make a whole new share is cancelled and its nominal
//   value goes back to the member as share credit (Dr 3000 / Cr 3020),
//   to be used at their next contribution or refunded.
// The issue price and the registered number of shares are converted by
// the same ratio, so nobody's value changes.
const applyNominalValue = async (client, req, approverId) => {
    const today = todayStr();
    const current = await getCurrentNominal(client);
    const oldNominal = parseFloat(current.nominal_value);
    const newNominal = parseFloat(req.proposed_value);
    const isSplit = newNominal < oldNominal;
    const factor = Math.round(isSplit ? oldNominal / newNominal : newNominal / oldNominal);

    const future = await client.query(`SELECT effective_from::text AS d FROM share_price_history WHERE effective_from > $1 LIMIT 1`, [today]);
    if (future.rows.length) {
        throw createError.badRequest(`An issue price change is scheduled for ${future.rows[0].d}. It must take effect (or be replaced) before the nominal value can be changed.`);
    }
    const lastAllot = await client.query(`SELECT MAX(allotment_date)::text AS d FROM share_allotments`);
    if (lastAllot.rows[0].d && lastAllot.rows[0].d > today) {
        throw createError.badRequest(`There are allotments dated after today (${lastAllot.rows[0].d}); the nominal value can only change after them.`);
    }

    const holdings = await client.query(`
        SELECT sa.user_id, SUM(sa.shares)::int AS shares, u.first_name || ' ' || u.last_name AS name
        FROM   share_allotments sa JOIN users u ON u.id = sa.user_id
        WHERE  sa.status = 'ACTIVE'
        GROUP  BY sa.user_id, u.first_name, u.last_name
        HAVING SUM(sa.shares) > 0
        ORDER  BY name
    `);

    const price = await getCurrentIssuePrice(client);
    const oldIssue = price ? parseFloat(price.price_per_share) : oldNominal;
    const newIssue = round2(isSplit ? oldIssue / factor : oldIssue * factor);
    const oldRegistered = current.registered_shares !== null ? parseInt(current.registered_shares, 10) : null;
    const newRegistered = oldRegistered === null ? null : (isSplit ? oldRegistered * factor : Math.floor(oldRegistered / factor));

    // New nominal row first, so allotments below snapshot the new limit.
    await client.query(`UPDATE share_nominal_history SET effective_to = $1 WHERE id = $2`, [today, current.id]);
    await client.query(`
        INSERT INTO share_nominal_history (nominal_value, currency_id, registered_shares, effective_from, change_request_id, set_by, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [newNominal, current.currency_id, newRegistered, today, req.id, approverId,
        `${isSplit ? 'Split' : 'Consolidation'} ${isSplit ? `1 → ${factor}` : `${factor} → 1`} by ${req.reference_code}. ${req.reason}`]);

    // Issue price converted by the same ratio.
    if (price) {
        await client.query(`UPDATE share_price_history SET effective_to = $1 WHERE effective_to IS NULL OR effective_to > $1`, [today]);
        await client.query(`
            INSERT INTO share_price_history (price_per_share, currency_id, effective_from, set_by, notes)
            VALUES ($1, $2, $3, $4, $5)
        `, [newIssue, price.currency_id, today, approverId,
            `Converted by the ${isSplit ? 'split' : 'consolidation'} ${req.reference_code} (was ${oldIssue}).`]);
    }

    const members = [];
    let sharesBefore = 0;
    let sharesAfter = 0;
    for (const h of holdings.rows) {
        const before = h.shares;
        const after = isSplit ? before * factor : Math.floor(before / factor);
        const leftoverOld = isSplit ? 0 : before - after * factor;
        const creditAdded = round2(leftoverOld * oldNominal);
        sharesBefore += before;
        sharesAfter += after;
        const delta = after - before;
        let allotmentId = null;
        if (delta !== 0) {
            const a = await createAllotment(client, {
                userId: h.user_id, changeRequestId: req.id, source: isSplit ? 'SPLIT' : 'CONSOLIDATION',
                date: today, shares: delta, nominalValue: newNominal, issuePrice: newIssue,
                currencyId: current.currency_id, createdBy: approverId,
                considerationAmount: 0, capitalAmount: isSplit ? 0 : -creditAdded, premiumAmount: 0,
                notes: isSplit
                    ? `Split ${req.reference_code}: ${before} → ${after} shares`
                    : `Consolidation ${req.reference_code}: ${before} → ${after} shares${leftoverOld ? `, ${leftoverOld} old share(s) returned as credit` : ''}`,
            });
            allotmentId = a.allotmentId;
        }
        if (creditAdded > 0) {
            await addCreditEntry(client, {
                userId: h.user_id, date: today, entryType: 'CONSOLIDATION_LEFTOVER', amount: creditAdded,
                currencyId: current.currency_id, allotmentId, changeRequestId: req.id,
                notes: `${leftoverOld} old share(s) of ${oldNominal.toLocaleString('en-US')} could not make a whole new share`, createdBy: approverId,
            });
        }
        members.push({ userId: h.user_id, name: h.name, sharesBefore: before, sharesAfter: after, leftoverOldShares: leftoverOld, creditAdded });
    }
    await recalculateShareholding(client, { recordedByUserId: approverId });

    return {
        kind: isSplit ? 'SPLIT' : 'CONSOLIDATION',
        factor,
        ratioText: isSplit ? `1 old share → ${factor} new shares` : `${factor} old shares → 1 new share`,
        nominalBefore: oldNominal, nominalAfter: newNominal,
        issuePriceBefore: oldIssue, issuePriceAfter: newIssue,
        registeredBefore: oldRegistered, registeredAfter: newRegistered,
        registeredNotExact: oldRegistered !== null && !isSplit && oldRegistered % factor !== 0,
        sharesBefore, sharesAfter,
        members,
        effectiveDate: today,
    };
};

// ---- notice document ------------------------------------------------------
const NOTICE_CATEGORY = {
    module: 'DOCUMENT',
    name: 'Share Capital Notices',
    abbreviation: 'SHCN',
    description: 'Formal notices to all shareholders of approved changes to the share issue price, nominal value or registered shares (auto-generated).',
};

const CHANGE_TITLES = {
    ISSUE_PRICE: 'Change of Share Issue Price',
    NOMINAL_VALUE: 'Change of Nominal Value per Share',
    REGISTERED_SHARES: 'Change of Registered Share Capital',
};

const createNoticeDocument = async (client, req, summary, approverId) => {
    const priceHistory = await client.query(`
        SELECT price_per_share, effective_from::text AS effective_from, effective_to::text AS effective_to
        FROM   share_price_history ORDER BY effective_from ASC, id ASC
    `);
    const nominalHistory = await client.query(`
        SELECT nominal_value, registered_shares, effective_from::text AS effective_from, effective_to::text AS effective_to
        FROM   share_nominal_history ORDER BY effective_from ASC, id ASC
    `);
    const categoryId = await getOrCreateCategory(client, { ...NOTICE_CATEGORY, createdBy: approverId });
    const { referenceId, referenceCode } = await generateReference(client, MODULE_CODES.DOCUMENT, 'SCNOT', 'DOCUMENT', approverId);
    const approvedAt = new Date().toISOString();

    const publicSummary = { ...summary };
    delete publicSummary.members; // per-member figures stay private; each member sees their own on the Share Capital page
    if (summary.members) publicSummary.membersAffected = summary.members.length;

    const templateData = {
        notice_kind: 'SHARE_CAPITAL_CHANGE',
        reference: referenceCode,
        change_reference: req.reference_code,
        change_type: req.change_type,
        title: CHANGE_TITLES[req.change_type],
        currency_code: req.currency_code,
        current_value: num(req.current_value),
        proposed_value: num(req.proposed_value),
        effective_date: summary.effectiveDate || req.effective_date,
        reason: req.reason,
        resolution: { id: req.resolution_document_id, title: req.resolution_title, reference: req.resolution_reference },
        requested_by: { name: req.requested_by_name, capacity: req.requested_role, at: req.requested_at },
        approved_by: { name: await userName(client, approverId), capacity: summary.approverCapacity, at: approvedAt },
        summary: publicSummary,
        issue_price_history: priceHistory.rows.map(r => ({ ...r, price_per_share: num(r.price_per_share) })),
        nominal_history: nominalHistory.rows.map(r => ({ ...r, nominal_value: num(r.nominal_value) })),
        generated_date: approvedAt,
    };

    const doc = await client.query(`
        INSERT INTO documents (
            reference_id, category_id, title, document_type, source, template_data, version,
            related_record_type, related_record_id, status, created_by, approved_by, approved_at,
            fully_signed, fully_signed_at, audience
        ) VALUES ($1, $2, $3, 'OTHER', 'SYSTEM_GENERATED', $4, 1,
                  'share_capital_change_requests', $5, 'FINAL', $6, $6, NOW(), TRUE, NOW(), 'ALL_SHAREHOLDERS')
        RETURNING id
    `, [referenceId, categoryId, `Notice to Shareholders — ${CHANGE_TITLES[req.change_type]} (${req.reference_code})`,
        JSON.stringify(templateData), req.id, approverId]);
    await linkReferenceToRecord(client, referenceId, doc.rows[0].id);
    return { documentId: doc.rows[0].id, referenceCode };
};

// ---- approve (second person) → apply → notice -----------------------------
const approveChangeRequest = async (client, { requestId, userId, note }) => {
    await lock(client);
    const req = await getChangeRequest(client, requestId, true);
    if (req.status !== 'PENDING') throw createError.badRequest(`This request is already ${req.status}.`);
    if (req.requested_by === userId) {
        throw createError.forbidden('The person who proposed a change cannot also approve it — a second, different Director or the Treasurer must approve.');
    }
    const roles = await getActiveRoleNames(client, userId);
    const capacity = approverCapacity(roles);
    if (!capacity) {
        throw createError.forbidden('Only a Director or the Treasurer can approve a share capital change (the Admin role alone cannot).');
    }
    if (req.requested_role !== 'Director' && capacity !== 'Director') {
        throw createError.forbidden('This change was proposed by the Treasurer, so it must be approved by a Director (two Directors, or a Director and the Treasurer).');
    }
    await assertFinalResolution(client, req.resolution_document_id);

    let summary;
    if (req.change_type === 'ISSUE_PRICE') summary = await applyIssuePrice(client, req, userId);
    else if (req.change_type === 'NOMINAL_VALUE') summary = await applyNominalValue(client, req, userId);
    else summary = await applyRegisteredShares(client, req, userId);
    summary.approverCapacity = capacity;

    await client.query(`
        UPDATE share_capital_change_requests
        SET    status = 'APPLIED', approved_by = $1, approved_role = $2, approved_at = NOW(),
               applied_at = NOW(), decision_note = $3, result_summary = $4, effective_date = $5
        WHERE  id = $6
    `, [userId, capacity, note || null, JSON.stringify(summary), summary.effectiveDate, requestId]);

    const fresh = await getChangeRequest(client, requestId);
    const notice = await createNoticeDocument(client, fresh, summary, userId);
    await client.query(`UPDATE share_capital_change_requests SET notice_document_id = $1 WHERE id = $2`, [notice.documentId, requestId]);

    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'share_capital_change_requests', recordId: requestId,
        newValues: summary,
        description: `Share capital change ${req.reference_code} approved and applied (${req.change_type}); notice ${notice.referenceCode}`,
        client,
    });
    return { request: fresh, summary, notice };
};

// ============================================================
// SHARE CREDIT REFUNDS (maker-checker)
// ============================================================
const REFUND_CATEGORY = {
    module: 'FINANCE',
    name: 'Share Credit Refunds',
    abbreviation: 'SCR',
    description: "Members' unused share credit (capital paid in that did not buy a whole share) paid back to them.",
};

const pendingRefundTotal = async (client, userId, excludeId = null) => {
    const r = await client.query(`
        SELECT COALESCE(SUM(credit_amount), 0) AS t FROM capital_credit_refunds
        WHERE  user_id = $1 AND status = 'PENDING' AND ($2::int IS NULL OR id <> $2)
    `, [userId, excludeId]);
    return round2(parseFloat(r.rows[0].t));
};

const createRefund = async (client, { memberId, creditAmount, accountId, reason, requestedBy }) => {
    await lock(client);
    await assertOpeningConverted(client);
    const roles = await getActiveRoleNames(client, requestedBy);
    if (!roles.some(r => REFUND_MAKER_ROLES.includes(r))) {
        throw createError.forbidden('Only the Treasurer or Assistant Treasurer can request a share credit refund.');
    }
    const amount = round2(parseFloat(creditAmount));
    if (!(amount > 0)) throw createError.badRequest('The refund amount must be positive.');
    if (!reason || !String(reason).trim()) throw createError.badRequest('A reason is required.');
    const balance = await getCreditBalance(client, memberId);
    const pending = await pendingRefundTotal(client, memberId);
    if (amount > round2(balance - pending) + 0.001) {
        throw createError.badRequest(`The member's available share credit is ${round2(balance - pending)} (credit ${balance}, already requested ${pending}).`);
    }
    const acc = await client.query(`SELECT id, account_type FROM accounts WHERE id = $1 AND is_active = TRUE AND account_type <> 'SAVINGS'`, [accountId]);
    if (!acc.rows.length) throw createError.badRequest('Choose an active, non-savings account to pay the refund from.');
    const price = await getCurrentIssuePrice(client);
    const nominal = await getCurrentNominal(client);
    const creditCurrencyId = price ? price.currency_id : nominal.currency_id;

    const { referenceId, referenceCode } = await generateReference(client, SCP, 'CRREF', 'CAPITAL_CREDIT_REFUND', requestedBy);
    const ins = await client.query(`
        INSERT INTO capital_credit_refunds (reference_id, user_id, credit_amount, credit_currency_id, account_id, reason, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [referenceId, memberId, amount, creditCurrencyId, accountId, reason, requestedBy]);
    await linkReferenceToRecord(client, referenceId, ins.rows[0].id);
    await logAction(requestedBy, ACTIONS.TRANSACTION_CREATED, MODULES.FINANCE, {
        recordType: 'capital_credit_refunds', recordId: ins.rows[0].id,
        newValues: { memberId, amount, accountId },
        description: `Share credit refund requested for member #${memberId}: ${amount} — ${referenceCode}`,
        client,
    });
    return { id: ins.rows[0].id, referenceCode };
};

const decideRefund = async (client, { refundId, userId, approve, note, payoutDate = null, cancel = false }) => {
    await lock(client);
    const r = await client.query(`
        SELECT ccr.*, rr.reference_code, a.currency_id AS account_currency_id, a.account_type, a.reference_prefix,
               u.first_name || ' ' || u.last_name AS member_name
        FROM   capital_credit_refunds ccr
        JOIN   accounts a ON a.id = ccr.account_id
        JOIN   users u ON u.id = ccr.user_id
        LEFT JOIN references_registry rr ON rr.id = ccr.reference_id
        WHERE  ccr.id = $1 FOR UPDATE OF ccr
    `, [refundId]);
    const ref = r.rows[0];
    if (!ref) throw createError.notFound('Refund request not found');
    if (ref.status !== 'PENDING') throw createError.badRequest(`This refund is already ${ref.status}.`);

    if (cancel) {
        if (ref.requested_by !== userId) throw createError.forbidden('Only the person who requested it can withdraw it.');
        await client.query(`UPDATE capital_credit_refunds SET status = 'CANCELLED', decided_by = $1, decided_at = NOW(), decision_note = $2 WHERE id = $3`, [userId, note || null, refundId]);
        return { status: 'CANCELLED' };
    }
    if (ref.requested_by === userId) {
        throw createError.forbidden('The person who requested a refund cannot also approve it.');
    }
    const roles = await getActiveRoleNames(client, userId);
    if (!roles.some(x => REFUND_CHECKER_ROLES.includes(x))) {
        throw createError.forbidden('Only the Treasurer, Assistant Treasurer or a Director can approve a share credit refund.');
    }
    if (!approve) {
        await client.query(`UPDATE capital_credit_refunds SET status = 'REJECTED', decided_by = $1, decided_at = NOW(), decision_note = $2 WHERE id = $3`, [userId, note || null, refundId]);
        return { status: 'REJECTED' };
    }

    const balance = await getCreditBalance(client, ref.user_id);
    const otherPending = await pendingRefundTotal(client, ref.user_id, ref.id);
    const creditAmount = parseFloat(ref.credit_amount);
    if (creditAmount > round2(balance - otherPending) + 0.001) {
        throw createError.badRequest(`The member's share credit is now only ${round2(balance - otherPending)} — the refund can no longer be paid in full.`);
    }

    const date = toDateStr(payoutDate) || todayStr();
    let payout = creditAmount;
    let rate = 1;
    if (ref.account_currency_id !== ref.credit_currency_id) {
        rate = await getExchangeRateOn(client, ref.credit_currency_id, ref.account_currency_id, date);
        // Rounded DOWN to the cent, so the payout's value back in the
        // share currency never exceeds the credit being refunded.
        payout = Math.floor(creditAmount * rate * 100 + 1e-6) / 100;
        if (!(payout > 0)) throw createError.badRequest('The refund is too small to pay in the chosen account\'s currency.');
    }

    // Lazy require — transactionsController requires this file.
    const { postTransaction } = require('../controllers/transactionsController');
    const categoryId = await getOrCreateCategory(client, { ...REFUND_CATEGORY, createdBy: userId });
    const { referenceId, referenceCode } = await generateReference(client, resolveModuleCode(ref), 'CRREF', 'TRANSACTION', userId);
    const { transactionId } = await postTransaction(client, {
        accountId: ref.account_id, transactionType: 'DEBIT', inflowType: 'CAPITAL_CREDIT_REFUND_OUT',
        amount: payout, currencyId: ref.account_currency_id, categoryId,
        description: `Share credit refund — ${ref.member_name} (${ref.reference_code})`,
        valueDate: date, createdBy: userId, referenceId,
    });
    await linkReferenceToRecord(client, referenceId, transactionId);

    // The credit is reduced by the refund's value in the share currency.
    // When the share currency is the functional currency (UGX), the
    // transaction's own UGX value is used so the books (3020) and the
    // credit agree exactly.
    let creditUsed = creditAmount;
    if (ref.account_currency_id !== ref.credit_currency_id) {
        const t = await client.query(`
            SELECT t.functional_amount, cs.functional_currency_id
            FROM transactions t CROSS JOIN company_settings cs WHERE t.id = $1 AND cs.id = 1
        `, [transactionId]);
        if (t.rows[0] && t.rows[0].functional_amount !== null && t.rows[0].functional_currency_id === ref.credit_currency_id) {
            creditUsed = round2(parseFloat(t.rows[0].functional_amount));
        }
    }
    await addCreditEntry(client, {
        userId: ref.user_id, date, entryType: 'REFUND', amount: -creditUsed, currencyId: ref.credit_currency_id,
        refundId: ref.id, originalAmount: payout, originalCurrencyId: ref.account_currency_id, rateUsed: rate,
        notes: `Refund ${ref.reference_code} paid (${referenceCode})`, createdBy: userId,
    });
    await client.query(`
        UPDATE capital_credit_refunds
        SET    status = 'PAID', decided_by = $1, decided_at = NOW(), decision_note = $2,
               payout_amount = $3, payout_currency_id = $4, rate_used = $5, payout_date = $6, transaction_id = $7
        WHERE  id = $8
    `, [userId, note || null, payout, ref.account_currency_id, rate, date, transactionId, refundId]);
    await logAction(userId, ACTIONS.TRANSACTION_APPROVED, MODULES.FINANCE, {
        recordType: 'capital_credit_refunds', recordId: refundId,
        newValues: { payout, rate, transactionId, creditUsed },
        description: `Share credit refund ${ref.reference_code} approved and paid: ${payout} (${referenceCode})`,
        client,
    });
    return { status: 'PAID', transactionId, transactionReference: referenceCode, payout, creditUsed, memberId: ref.user_id };
};

const listRefunds = async ({ userId = null } = {}) => {
    const r = await query(`
        SELECT ccr.id, ccr.user_id, ccr.credit_amount, ccr.payout_amount, ccr.rate_used, ccr.reason, ccr.status,
               ccr.requested_at, ccr.decided_at, ccr.decision_note, ccr.payout_date::text AS payout_date,
               ccr.requested_by, ccr.transaction_id,
               rr.reference_code, a.name AS account_name,
               cc.code AS credit_currency_code, pc.code AS payout_currency_code,
               u.first_name || ' ' || u.last_name AS member_name,
               rq.first_name || ' ' || rq.last_name AS requested_by_name,
               dc.first_name || ' ' || dc.last_name AS decided_by_name
        FROM   capital_credit_refunds ccr
        LEFT JOIN references_registry rr ON rr.id = ccr.reference_id
        JOIN   accounts a ON a.id = ccr.account_id
        JOIN   currencies cc ON cc.id = ccr.credit_currency_id
        LEFT JOIN currencies pc ON pc.id = ccr.payout_currency_id
        JOIN   users u ON u.id = ccr.user_id
        JOIN   users rq ON rq.id = ccr.requested_by
        LEFT JOIN users dc ON dc.id = ccr.decided_by
        WHERE  ($1::int IS NULL OR ccr.user_id = $1)
        ORDER  BY ccr.requested_at DESC
        LIMIT  500
    `, [userId]);
    return r.rows;
};

// ============================================================
// ALLOTMENTS & RETURNS
// ============================================================
const listAllotments = async ({ month = null, userId = null, pendingReturnsOnly = false } = {}) => {
    const conds = [];
    const params = [];
    if (month) { params.push(month); conds.push(`to_char(sa.allotment_date, 'YYYY-MM') = $${params.length}`); }
    if (userId) { params.push(userId); conds.push(`sa.user_id = $${params.length}`); }
    if (pendingReturnsOnly) conds.push(`sa.status = 'ACTIVE' AND sa.return_due_date IS NOT NULL AND sa.return_filed_at IS NULL`);
    const r = await query(`
        SELECT sa.id, sa.user_id, sa.contribution_id, sa.change_request_id, sa.source,
               sa.allotment_date::text AS allotment_date, to_char(sa.allotment_date, 'YYYY-MM') AS month,
               sa.shares, sa.nominal_value, sa.issue_price, sa.consideration_amount,
               sa.share_capital_amount, sa.share_premium_amount,
               sa.registered_shares, sa.total_shares_after, sa.shares_beyond_registered,
               sa.return_due_date::text AS return_due_date, sa.return_filed_at::text AS return_filed_at,
               sa.return_reference, sa.status, sa.reversed_at::text AS reversed_at, sa.reversal_reason, sa.notes,
               rr.reference_code, c.code AS currency_code,
               u.first_name || ' ' || u.last_name AS member_name,
               (sa.status = 'ACTIVE' AND sa.return_due_date IS NOT NULL AND sa.return_filed_at IS NULL
                   AND sa.return_due_date < CURRENT_DATE) AS return_overdue
        FROM   share_allotments sa
        LEFT JOIN references_registry rr ON rr.id = sa.reference_id
        JOIN   currencies c ON c.id = sa.currency_id
        JOIN   users u ON u.id = sa.user_id
        ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
        ORDER  BY sa.allotment_date DESC, sa.id DESC
        LIMIT  2000
    `, params);
    return r.rows;
};

const markReturnsFiled = async (client, { allotmentIds, filedAt, returnReference, userId }) => {
    if (!Array.isArray(allotmentIds) || !allotmentIds.length) throw createError.badRequest('Select at least one allotment.');
    const date = toDateStr(filedAt) || todayStr();
    const r = await client.query(`
        UPDATE share_allotments
        SET    return_filed_at = $1, return_reference = $2, return_filed_by = $3
        WHERE  id = ANY($4::int[]) AND return_due_date IS NOT NULL AND status = 'ACTIVE'
        RETURNING id
    `, [date, returnReference || null, userId, allotmentIds.map(Number)]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        recordType: 'share_allotments', newValues: { ids: r.rows.map(x => x.id), filedAt: date, returnReference },
        description: `Return of allotments marked filed for ${r.rowCount} allotment(s)${returnReference ? ` (${returnReference})` : ''}`,
        client,
    });
    return { updated: r.rowCount };
};

// ============================================================
// MEMBER STATEMENT — one member's shares, credit and refunds
// ============================================================
const getMemberStatement = async (memberId) => {
    const [allots, credits, refunds, holding, user] = await Promise.all([
        listAllotments({ userId: memberId }),
        query(`
            SELECT e.id, e.entry_date::text AS entry_date, e.entry_type, e.amount, e.original_amount, e.rate_used,
                   e.notes, c.code AS currency_code, oc.code AS original_currency_code,
                   rr.reference_code AS contribution_reference
            FROM   member_capital_credit_entries e
            JOIN   currencies c ON c.id = e.currency_id
            LEFT JOIN currencies oc ON oc.id = e.original_currency_id
            LEFT JOIN shareholder_contributions sc ON sc.id = e.contribution_id
            LEFT JOIN references_registry rr ON rr.id = sc.reference_id
            WHERE  e.user_id = $1
            ORDER  BY e.entry_date ASC, e.id ASC
        `, [memberId]),
        listRefunds({ userId: memberId }),
        query(`SELECT shares_held, percentage FROM shareholding_registry WHERE user_id = $1 AND effective_to IS NULL`, [memberId]),
        query(`SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id = $1`, [memberId]),
    ]);
    let running = 0;
    const creditEntries = credits.rows.map(e => {
        running = round2(running + parseFloat(e.amount));
        return { ...e, amount: parseFloat(e.amount), balance: running };
    });
    return {
        member: user.rows[0] || null,
        sharesHeld: holding.rows[0] ? parseInt(parseFloat(holding.rows[0].shares_held), 10) : 0,
        percentage: holding.rows[0] ? num(holding.rows[0].percentage) : null,
        creditBalance: running,
        allotments: allots,
        creditEntries,
        refunds,
    };
};

// ============================================================
// OVERVIEW — registered vs issued, credit, reconciliation, NAV
// ============================================================
const computeNav = async (asOfDate) => {
    // Lazy — glService is heavy and only needed here.
    const glService = require('./glService');
    const bs = await glService.computeBalanceSheet({ asOfDate, basis: glService.BASIS.FUNCTIONAL });
    const block = bs.byCurrency[0];
    if (!block) return null;
    const row = (code) => block.equity.find(e => e.code === code);
    const pending = row('3020') ? row('3020').balance : 0;
    const shares = await getSharesInIssue({ query }, asOfDate);
    const equityExclPending = Math.round((block.totalEquity - pending) * 100) / 100;
    return {
        asOfDate,
        currencyCode: block.currencyCode,
        totalEquity: block.totalEquity,
        capitalPendingAllotment: pending,
        equityForShares: equityExclPending,
        sharesInIssue: shares,
        navPerShare: shares > 0 ? Math.round((equityExclPending / shares) * 100) / 100 : null,
        shareCapital: row('3000') ? row('3000').balance : 0,
        sharePremium: row('3010') ? row('3010').balance : 0,
        provisional: !!(bs.meta && bs.meta.revaluation && bs.meta.revaluation.provisionalAt),
        unconvertedCount: bs.meta ? bs.meta.unconvertedCount : 0,
    };
};

const getOverview = async ({ includeMembers = true } = {}) => {
    const runner = { query };
    const [settings, nominal, price, scheduled, sharesInIssue] = await Promise.all([
        getSettings(runner), getCurrentNominal(runner), getCurrentIssuePrice(runner),
        getScheduledIssuePrices(runner), getSharesInIssue(runner),
    ]);
    const registered = nominal && nominal.registered_shares !== null ? parseInt(nominal.registered_shares, 10) : null;
    const excess = registered !== null ? Math.max(0, sharesInIssue - registered) : null;

    const totals = await query(`
        SELECT COALESCE(SUM(share_capital_amount) FILTER (WHERE status = 'ACTIVE'), 0) AS capital,
               COALESCE(SUM(share_premium_amount) FILTER (WHERE status = 'ACTIVE'), 0) AS premium,
               COUNT(*) FILTER (WHERE status = 'ACTIVE' AND return_due_date IS NOT NULL AND return_filed_at IS NULL) AS returns_pending,
               COUNT(*) FILTER (WHERE status = 'ACTIVE' AND return_due_date IS NOT NULL AND return_filed_at IS NULL AND return_due_date < CURRENT_DATE) AS returns_overdue,
               MIN(return_due_date) FILTER (WHERE status = 'ACTIVE' AND return_due_date IS NOT NULL AND return_filed_at IS NULL)::text AS next_return_due
        FROM   share_allotments
    `);
    const creditTotal = await query(`SELECT COALESCE(SUM(amount), 0) AS t FROM member_capital_credit_entries`);
    const pendingCounts = await query(`
        SELECT (SELECT COUNT(*) FROM share_capital_change_requests WHERE status = 'PENDING')::int AS change_requests,
               (SELECT COUNT(*) FROM capital_credit_refunds WHERE status = 'PENDING')::int AS refunds
    `);

    let members = [];
    if (includeMembers) {
        const m = await query(`
            WITH s AS (SELECT user_id, SUM(shares)::int AS shares FROM share_allotments WHERE status = 'ACTIVE' GROUP BY user_id),
                 c AS (SELECT user_id, SUM(amount) AS credit FROM member_capital_credit_entries GROUP BY user_id)
            SELECT u.id AS user_id, u.first_name || ' ' || u.last_name AS name,
                   COALESCE(s.shares, 0) AS shares, COALESCE(c.credit, 0) AS credit
            FROM   users u
            LEFT JOIN s ON s.user_id = u.id
            LEFT JOIN c ON c.user_id = u.id
            WHERE  s.user_id IS NOT NULL OR c.user_id IS NOT NULL
            ORDER  BY name
        `);
        members = m.rows.map(r => ({
            userId: r.user_id, name: r.name, shares: r.shares, credit: round2(parseFloat(r.credit)),
            percentage: sharesInIssue > 0 ? parseFloat(((r.shares / sharesInIssue) * 100).toFixed(4)) : 0,
        }));
    }

    const t = totals.rows[0];
    const shareCapitalFromAllotments = round2(parseFloat(t.capital));
    const nominalValue = nominal ? parseFloat(nominal.nominal_value) : null;

    let nav = null;
    let navError = null;
    if (settings.opening_converted_at) {
        try { nav = await computeNav(todayStr()); } catch (err) { navError = err.message; }
    }
    const creditSum = round2(parseFloat(creditTotal.rows[0].t));
    const issuePrice = price ? parseFloat(price.price_per_share) : null;

    // v1.69.2 — suggested issue price, rounded to the nearest 1,000, and
    // the reason text that goes with it (auto-filled on the proposal form).
    const ROUND_TO = 1000;
    let suggestedRounded = null;
    let suggestedReason = null;
    const curCode = nominal ? nominal.currency_code : (price ? price.currency_code : '');
    const fmt0 = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (nominalValue !== null) {
        if (nav && nav.navPerShare !== null) {
            const roundedNav = Math.round(nav.navPerShare / ROUND_TO) * ROUND_TO;
            suggestedRounded = Math.max(nominalValue, roundedNav);
            suggestedReason = suggestedRounded === nominalValue && roundedNav < nominalValue
                ? `Issue price kept at the nominal value of ${curCode} ${fmt0(nominalValue)}: the net asset value per share ` +
                  `(${curCode} ${fmt0(nav.navPerShare)} as at ${nav.asOfDate}) is below nominal, and shares may not be issued below nominal value (Companies Act 2012 s.68).`
                : `Issue price set to the net asset value (NAV) per share as at ${nav.asOfDate}, rounded to the nearest ${fmt0(ROUND_TO)}: ` +
                  `total equity ${curCode} ${fmt0(nav.totalEquity)} less capital pending allotment ${curCode} ${fmt0(nav.capitalPendingAllotment)} ` +
                  `= ${curCode} ${fmt0(nav.equityForShares)}, divided by ${fmt0(nav.sharesInIssue)} whole shares in issue = ` +
                  `${curCode} ${fmt0(nav.navPerShare)} per share, rounded to ${curCode} ${fmt0(suggestedRounded)}.` +
                  (issuePrice !== null && suggestedRounded > issuePrice
                      ? ' This keeps new shares from being issued below what existing shares are worth.'
                      : issuePrice !== null && suggestedRounded < issuePrice
                          ? ' The current issue price is above what each share is worth, so it is brought down to the NAV.'
                          : '');
        } else {
            suggestedRounded = nominalValue;
        }
    }

    const setupLocked = await isRegisteredSetupLocked(runner);
    return {
        openingConverted: !!settings.opening_converted_at,
        registeredSetupLocked: setupLocked,
        openingConvertedAt: settings.opening_converted_at,
        openingSummary: settings.opening_summary,
        allotmentReturnDays: settings.allotment_return_days,
        currencyCode: nominal ? nominal.currency_code : (price ? price.currency_code : null),
        nominal: nominal ? {
            value: nominalValue, effectiveFrom: nominal.effective_from, registeredShares: registered,
        } : null,
        issuePrice: price ? { value: issuePrice, effectiveFrom: price.effective_from } : null,
        scheduledIssuePrices: scheduled.map(s => ({ value: parseFloat(s.price_per_share), effectiveFrom: s.effective_from })),
        sharesInIssue,
        registeredShares: registered,
        sharesBeyondRegistered: excess,
        excessNominalValue: excess !== null && nominalValue !== null ? round2(excess * nominalValue) : null,
        registeredCapitalValue: registered !== null && nominalValue !== null ? round2(registered * nominalValue) : null,
        shareCapitalFromAllotments,
        sharePremiumFromAllotments: round2(parseFloat(t.premium)),
        sharesTimesNominal: nominalValue !== null ? round2(sharesInIssue * nominalValue) : null,
        totalMemberCredit: creditSum,
        returns: {
            pending: parseInt(t.returns_pending, 10),
            overdue: parseInt(t.returns_overdue, 10),
            nextDue: t.next_return_due,
        },
        pending: pendingCounts.rows[0],
        nav,
        navError,
        suggestedIssuePrice: nav && nav.navPerShare !== null && nominalValue !== null
            ? Math.max(nominalValue, nav.navPerShare) : nominalValue,
        // v1.69.2 — the figure offered when proposing a new issue price:
        // NAV per share rounded to the nearest 1,000, never below nominal.
        // The exact NAV is still shown alongside it.
        suggestedIssuePriceRounded: suggestedRounded,
        suggestedReason,
        reconciliation: nav ? {
            ledger3020: nav.capitalPendingAllotment,
            memberCredit: creditSum,
            difference: round2(nav.capitalPendingAllotment - creditSum),
            ledger3000: nav.shareCapital,
            allotments3000: shareCapitalFromAllotments,
            difference3000: round2(nav.shareCapital - shareCapitalFromAllotments),
        } : null,
        members,
    };
};

module.exports = {
    SCP,
    APPROVER_ROLES,
    getSettings,
    isOpeningConverted,
    assertOpeningConverted,
    getNominalOn,
    getCurrentNominal,
    getCurrentIssuePrice,
    getCreditBalance,
    getSharesInIssue,
    getHoldingsAsOf,
    getActiveRoleNames,
    approverCapacity,
    isRegisteredSetupLocked,
    getRegisteredSetup,
    saveRegisteredSetup,
    valueInShareCurrency,
    allotForContribution,
    reverseContribution,
    recalculateShareholding,
    runOpeningConversion,
    previewOpeningConversion,
    listChangeRequests,
    getChangeRequest,
    listEligibleResolutions,
    createChangeRequest,
    approveChangeRequest,
    rejectChangeRequest,
    createRefund,
    decideRefund,
    listRefunds,
    listAllotments,
    markReturnsFiled,
    getMemberStatement,
    computeNav,
    getOverview,
};
