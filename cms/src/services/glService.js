// ============================================================
// GENERAL LEDGER SERVICE (v1.55.0; currency-aware since v1.64.0;
// UGX-consolidated with FX revaluation since v1.66.0)
//
// The system's real ledger (`transactions`) is single-leg — every
// row only records the ONE account it hit, plus a fixed `inflow_type`
// describing its nature. It was never a formal double-entry book.
// This service DERIVES a proper double-entry view on demand, purely
// by reading existing tables — nothing here writes to `transactions`
// or changes how any other module posts money. It backs five
// read-only reports (Trial Balance, General Ledger, Balance Sheet,
// Income Statement, Cash Flow Statement), all computed on demand,
// matching this codebase's existing "reports have no dedicated
// table" philosophy (see reportsController.js's own header comment).
//
// THE DERIVATION RULE
// Every `transactions` row becomes two ledger lines:
//   - "Line A" is ALWAYS gl_accounts code '1000' (Cash and Bank),
//     attributed to that transaction's own `account_id` — every
//     transaction, by definition, moves money through exactly one of
//     the club's real bank/cash accounts.
//   - "Line B" is whichever `gl_accounts` row `gl_inflow_type_mapping`
//     says that transaction's `inflow_type` maps to — see
//     schema.sql's own header comment for the full chart of accounts
//     and why each inflow_type was classified the way it was.
// Line B is always the exact opposite side of Line A, which is what
// double-entry means — this is mechanical, not a judgment call: if
// cash increased (Line A = Debit Cash), Line B is a Credit; if cash
// decreased (Line A = Credit Cash), Line B is a Debit.
//
// v1.70.0 — A TRANSACTION MAY NAME ITS OWN ACCOUNT
// transactions.gl_override_account_code wins over everything below:
// tax deducted at source (5700 final / 1500 creditable) and the
// company's own capital coming back from an investment (PRINCIPAL,
// 1400). A REVERSAL always posts to the same account as the entry it
// reverses (it inherits the original's override, investment and side
// fund treatment).
//
// TWO HARDCODED OVERRIDES
// `gl_inflow_type_mapping` maps EXPENSE -> Operating Expenses (5000)
// by default, because EXPENSE is reused across the whole app for any
// generic outflow. Two modules reuse it for something that is NOT an
// operating expense of the company, and are redirected here, in
// code, because the editable mapping table has no way to express
// "except when this other record exists":
//   1. Investments — an EXPENSE-tagged transaction that carries a
//      non-null `investment_id` is capital deployed into a
//      project/bond (an Asset acquired), reclassified to 1400.
//      v1.80.0: unless it is marked as RUNNING (5150 Investment
//      Operating Costs) or MAINTENANCE (5160 Investment Maintenance
//      Costs) in transactions.investment_cost_type — see
//      investmentCostService.js.
//   2. Side Fund expenses (v1.66.0) — an EXPENSE-tagged transaction
//      recorded through the Side Fund module (it has a
//      side_fund_expenses row) is the MEMBERS' money being spent, so
//      it reduces Side Fund Payable (2400) instead of being a company
//      expense. Confirmed policy: the side fund is members' money,
//      not a company reserve.
//
// NON-CASH ADJUSTING ENTRIES (three since v1.69.0; more in v1.70.0 — item 4)
// Some events in the system change what's actually owed/earned
// without moving any cash, so they can never appear as a `transactions`
// row — they are computed here as synthetic ledger lines with no
// `account_id` (nothing to attribute them to) and are therefore only
// included in the company-wide view, never a single-account view:
//   1. Grant income recognition — see getGrantRecognitionLines()
//   2. Service fee advance recovery — see getAdvanceRecoveryLines()
//   3. Share allotments (v1.69.0) — see getShareAllotmentLines()
//   4. v1.70.0 — see glAdjustmentLines.js: tax withheld from payments
//      (Dr <where the gross was charged> / Cr 2500), tax deducted at
//      source inside another amount, corporate income tax of approved
//      years and its set-off at filing, members' savings interest
//      accrued, the interest part of loan repayments, money market fund
//      interest and fees, and investments closed (cost left in 1400
//      taken to investment income).
//
// INCOME STATEMENT (v1.70.0) — accounts with statement_section
// 'INCOME_TAX' (5700, 5710) are shown below profit before tax:
// profitBeforeTax, incomeTax[], netIncome = profit after tax.
//
// SHARE CAPITAL (v1.69.0) — a capital contribution (CONTRIBUTION) now
// lands in 3020 Capital Pending Allotment (members' share credit).
// When whole shares are allotted (share_allotments), a third non-cash
// adjusting entry moves their value out of 3020: shares x nominal to
// 3000 Share Capital and shares x (issue price - nominal) to 3010 Share
// Premium — see getShareAllotmentLines(). A share credit refund
// (CAPITAL_CREDIT_REFUND_OUT) is paid out of 3020. So in the official
// (FUNCTIONAL) books 3020 always equals the members' total credit.
// The CURRENCY basis has no allotment lines (allotments are valued in
// UGX, contributions in EUR), so there 3020 is shown as 3000 — "capital
// paid in", exactly as before v1.69.0.
//
// TWO BASES (v1.66.0) — every report takes a `basis`:
//
//   FUNCTIONAL (the default, and the OFFICIAL statements) — one set
//   of books in the company's functional currency (UGX), as IFRS for
//   SMEs requires:
//     - every line carries its transaction's UGX value, fixed on the
//       transaction's own date (transactions.functional_amount — set
//       by a database trigger, see migration_v1.66.0.sql);
//     - foreign-currency MONETARY balances (cash, savings owed,
//       loans, deposits, side fund) are revalued at each month end
//       to that month's closing rate, the difference booked as an FX
//       gain (4600) or loss (5600). Months already closed come from
//       fx_revaluation_runs (stored, never recomputed); anything
//       after the last closed month is revalued PROVISIONALLY to the
//       report's own end date, flagged as such, so today's balance
//       sheet is always at today's rate;
//     - a transaction with no UGX value yet (no rate on file for its
//       date) is left OUT and listed in `meta.unconverted` — it is
//       never guessed. The reports say so loudly.
//   Each line still carries its original amount/currency/rate
//   (originalDebit/originalCredit/originalCurrencyCode/fxRate) so the
//   General Ledger can show "EUR 1,000 @ 4,100".
//
//   CURRENCY — the v1.64.0 behaviour, kept as a supporting view: one
//   set per original currency, never converted or summed together.
//
// Every report returns `byCurrency: [...]` in both bases — in
// FUNCTIONAL basis that array simply has exactly one entry (UGX), so
// every report function below is shared by both bases.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const fxService = require('./fxService');
const adjustments = require('./glAdjustmentLines');

const { BASIS, round2, toDateStr, FX_GAIN_GL_CODE, FX_LOSS_GL_CODE } = fxService;

const CASH_GL_CODE = '1000';
const CLEARING_GL_CODE = '1050';
const INVESTMENT_OVERRIDE_GL_CODE = '1400';
const SIDE_FUND_OVERRIDE_GL_CODE = '2400';
const SHARE_CAPITAL_GL_CODE = '3000';
const SHARE_PREMIUM_GL_CODE = '3010';
const CAPITAL_PENDING_GL_CODE = '3020';

const normalizeBasis = (basis) => (basis === BASIS.CURRENCY ? BASIS.CURRENCY : BASIS.FUNCTIONAL);

// v1.70.0 columns may not exist yet on a database that hasn't run
// migration_v1.70.0.sql — the reports keep working without them.
let overrideColumnKnown = null;
// v1.80.0 — transactions.investment_cost_type (buying vs running an investment)
let costTypeColumnKnown = null;
const hasCostTypeColumn = async () => {
    if (costTypeColumnKnown === true) return true;
    costTypeColumnKnown = await adjustments.columnExists('transactions', 'investment_cost_type');
    return costTypeColumnKnown;
};

const hasOverrideColumn = async () => {
    if (overrideColumnKnown === true) return true;
    overrideColumnKnown = await adjustments.columnExists('transactions', 'gl_override_account_code');
    return overrideColumnKnown;
};

// ============================================================
// v1.70.0 — every non-cash adjusting entry added with the tax system
// (see glAdjustmentLines.js for each one). `allLinesForClosure` must
// hold every line up to the end date (for the investment closure).
// ============================================================
const getV170AdjustmentLines = async ({ fromDate, toDate, basis, ctx, glByCode, allLinesForClosure }) => {
    const [tax, savings, loans, mmf] = await Promise.all([
        adjustments.getTaxLines({ fromDate, toDate, basis, ctx, glByCode }),
        adjustments.getSavingsInterestAccrualLines({ fromDate, toDate, basis, ctx, glByCode }),
        adjustments.getLoanInterestLines({ fromDate, toDate, basis, ctx, glByCode }),
        adjustments.getMmfIncomeLines({ fromDate, toDate, basis, ctx, glByCode }),
    ]);
    // The closure needs the tax lines too (a treasury bill's tax taken
    // out of 1400 is part of what is left in it).
    const closure = await adjustments.getInvestmentClosureLines({
        fromDate, toDate, basis, ctx, glByCode,
        allLines: allLinesForClosure.concat(tax.lines.filter(l => l.investmentId)),
    });
    return {
        lines: [].concat(tax.lines, savings.lines, loans.lines, mmf.lines, closure.lines),
        unconverted: [].concat(tax.unconverted, savings.unconverted, loans.unconverted, mmf.unconverted, closure.unconverted),
    };
};

// ============================================================
// CHART OF ACCOUNTS — read helpers
// ============================================================
const getChartOfAccounts = async () => {
    const accountsResult = await query(`
        SELECT id, code, name, account_type, normal_balance, statement_section,
               cash_flow_category, description, display_order, is_active, is_monetary
        FROM   gl_accounts
        ORDER  BY display_order ASC, code ASC
    `);
    const mappingResult = await query(`
        SELECT m.id, m.inflow_type, m.gl_account_id, m.notes, m.updated_at,
               u.first_name || ' ' || u.last_name AS updated_by_name,
               ga.code AS gl_account_code, ga.name AS gl_account_name
        FROM   gl_inflow_type_mapping m
        JOIN   gl_accounts ga ON ga.id = m.gl_account_id
        LEFT JOIN users u ON u.id = m.updated_by
        ORDER  BY m.inflow_type ASC
    `);
    return { accounts: accountsResult.rows, mappings: mappingResult.rows };
};

const updateInflowTypeMapping = async ({ inflowType, glAccountId, notes, updatedBy }) => {
    const result = await query(`
        UPDATE gl_inflow_type_mapping
        SET    gl_account_id = $1, notes = $2, updated_at = NOW(), updated_by = $3
        WHERE  inflow_type = $4
        RETURNING id, inflow_type, gl_account_id
    `, [glAccountId, notes || null, updatedBy, inflowType]);
    return result.rows[0] || null;
};

// ============================================================
// FUNCTIONAL CONTEXT — everything the FUNCTIONAL basis needs, loaded
// once per report: settings, the rate table, the chart of accounts
// indexed by code, and currency codes by id.
// ============================================================
const getFunctionalContext = async () => {
    const [settings, rateTable, chart, currencies] = await Promise.all([
        fxService.getAccountingSettings(),
        fxService.loadRateTable(),
        getChartOfAccounts(),
        query(`SELECT id, code, symbol FROM currencies`),
    ]);
    if (!settings.functionalCurrency) {
        throw createError.badRequest('No functional currency is configured (company_settings.functional_currency_id). Run migration_v1.66.0.sql, or view the reports "by original currency".');
    }
    return {
        settings,
        functionalCurrency: settings.functionalCurrency,
        rateOn: rateTable.rateOn,
        glByCode: new Map(chart.accounts.map(a => [a.code, a])),
        monetaryGlIds: new Set(chart.accounts.filter(a => a.is_monetary).map(a => a.id)),
        currencyCodeById: new Map(currencies.rows.map(c => [c.id, c.code])),
    };
};

// ============================================================
// GROUP LINES BY CURRENCY — shared by every report function below.
// Returns a Map keyed by currency code (or '—' for the rare line with
// no currency at all, which should never actually happen since every
// source table's currency_id is NOT NULL), each value holding the
// currency's own id/code/symbol plus its slice of the lines.
// ============================================================
const groupLinesByCurrency = (lines) => {
    const map = new Map();
    for (const line of lines) {
        const key = line.currencyCode || '—';
        if (!map.has(key)) {
            map.set(key, {
                currencyId:     line.currencyId || null,
                currencyCode:   line.currencyCode || null,
                currencySymbol: line.currencySymbol || null,
                lines:          [],
            });
        }
        map.get(key).lines.push(line);
    }
    return map;
};
const sortByCurrencyCode = (arr) => arr.sort((a, b) => (a.currencyCode || '').localeCompare(b.currencyCode || ''));

// ============================================================
// CORE DERIVATION — every real transaction, as two ledger lines.
//
// CURRENCY basis: both lines carry the transaction's own amount and
// currency (v1.64.0 behaviour).
// FUNCTIONAL basis: both lines carry the transaction's UGX value
// (functional_amount); the original amount/currency/rate ride along
// for display. Transactions with no UGX value yet are returned in
// `unconverted` and produce no lines.
// ============================================================
const getTransactionLedgerLines = async ({ accountId, fromDate, toDate, basis = BASIS.CURRENCY, ctx = null }) => {
    const { accounts } = await getChartOfAccounts();
    const accountsByCode = new Map(accounts.map(a => [a.code, a]));
    const cashAccount = accountsByCode.get(CASH_GL_CODE);
    const investmentOverrideAccount = accountsByCode.get(INVESTMENT_OVERRIDE_GL_CODE);
    // v1.80.0 — running / maintaining an investment is an expense, not capital
    const investmentRunningAccounts = {
        OPERATING: accountsByCode.get('5150'),
        MAINTENANCE: accountsByCode.get('5160'),
    };
    const sideFundOverrideAccount = accountsByCode.get(SIDE_FUND_OVERRIDE_GL_CODE);
    const capitalPendingAccount = accountsByCode.get(CAPITAL_PENDING_GL_CODE);
    const shareCapitalAccount = accountsByCode.get(SHARE_CAPITAL_GL_CODE);

    const mappingResult = await query(`SELECT inflow_type, gl_account_id FROM gl_inflow_type_mapping`);
    const mappingByInflowType = new Map(mappingResult.rows.map(m => [m.inflow_type, m.gl_account_id]));
    const accountsById = new Map(accounts.map(a => [a.id, a]));

    const conditions = [`t.status = 'POSTED'`];
    const params = [];
    if (accountId) { params.push(accountId); conditions.push(`t.account_id = $${params.length}`); }
    if (fromDate)  { params.push(fromDate);  conditions.push(`t.value_date >= $${params.length}`); }
    if (toDate)    { params.push(toDate);    conditions.push(`t.value_date <= $${params.length}`); }
    const where = conditions.join(' AND ');

    // value_date is read as text ('YYYY-MM-DD') so the pg driver never
    // turns it into a JS Date — which, on a server whose timezone is
    // ahead of UTC, used to shift every date back by one day.
    // v1.70.0 — a transaction may name its own ledger account
    // (gl_override_account_code: tax legs, bond principal). A REVERSAL
    // always posts to the same account as the entry it reverses, so the
    // original's own attributes (override, investment, side fund) are
    // read too — before v1.70.0 a reversed investment funding or side
    // fund expense was wrongly booked back to operating expenses.
    const hasOverride = await hasOverrideColumn();
    const hasCostType = await hasCostTypeColumn();
    const result = await query(`
        SELECT t.id, t.account_id, t.value_date::text AS value_date, t.transaction_type, t.inflow_type,
               t.amount, t.description, t.investment_id, t.category_id,
               t.functional_amount, t.functional_rate, t.functional_rate_source,
               t.currency_id, cur.code AS currency_code, cur.symbol AS currency_symbol,
               r.reference_code, cp.full_path AS category_trail,
               (sfe.id IS NOT NULL) AS is_side_fund_expense,
               ${hasOverride ? 't.gl_override_account_code, o.gl_override_account_code AS orig_gl_override,' : 'NULL AS gl_override_account_code, NULL AS orig_gl_override,'}
               o.investment_id AS orig_investment_id,
               ${hasCostType ? 't.investment_cost_type, o.investment_cost_type AS orig_investment_cost_type,' : 'NULL AS investment_cost_type, NULL AS orig_investment_cost_type,'}
               (osfe.id IS NOT NULL) AS orig_is_side_fund_expense
        FROM   transactions t
        JOIN   currencies cur           ON cur.id = t.currency_id
        LEFT JOIN references_registry r ON r.id = t.reference_id
        LEFT JOIN category_paths cp     ON cp.category_id = t.category_id
        LEFT JOIN side_fund_expenses sfe ON sfe.transaction_id = t.id
        LEFT JOIN transactions o         ON o.id = t.reversal_of
        LEFT JOIN side_fund_expenses osfe ON osfe.transaction_id = o.id
        WHERE  ${where}
        ORDER  BY t.value_date ASC, t.id ASC
    `, params);

    const isCashIn = (txType) => txType === 'CREDIT' || txType === 'REVERSAL_CREDIT';
    const functional = basis === BASIS.FUNCTIONAL;

    const lines = [];
    const unconverted = [];
    for (const t of result.rows) {
        const cashIn = isCashIn(t.transaction_type);
        const originalAmount = parseFloat(t.amount);

        let amount = originalAmount;
        let currencyFields = {
            currencyId:     t.currency_id,
            currencyCode:   t.currency_code,
            currencySymbol: t.currency_symbol,
        };
        if (functional) {
            if (t.functional_amount === null || t.functional_amount === undefined) {
                unconverted.push({
                    transactionId: t.id, referenceCode: t.reference_code, date: t.value_date,
                    currencyCode: t.currency_code, amount: originalAmount, description: t.description,
                });
                continue;
            }
            amount = parseFloat(t.functional_amount);
            currencyFields = {
                currencyId:     ctx.functionalCurrency.id,
                currencyCode:   ctx.functionalCurrency.code,
                currencySymbol: ctx.functionalCurrency.symbol,
            };
        }
        const investmentId = t.investment_id || t.orig_investment_id || null;
        const originalFields = {
            originalCurrencyId:   t.currency_id,
            originalCurrencyCode: t.currency_code,
            fxRate:               t.functional_rate !== null ? parseFloat(t.functional_rate) : null,
            fxRateSource:         t.functional_rate_source,
        };

        // Line A — always Cash and Bank, attributed to this transaction's
        // own account.
        lines.push({
            date:          toDateStr(t.value_date),
            glAccountId:   cashAccount.id,
            accountId:     t.account_id,
            debit:         cashIn ? amount : 0,
            credit:        cashIn ? 0 : amount,
            originalDebit:  cashIn ? originalAmount : 0,
            originalCredit: cashIn ? 0 : originalAmount,
            description:   t.description,
            referenceCode: t.reference_code,
            categoryTrail: t.category_trail,
            sourceType:    'TRANSACTION',
            sourceId:      t.id,
            investmentId,
            lineRole:      'A',
            ...currencyFields,
            ...originalFields,
        });

        // Line B — the other side, from the mapping table, with the
        // overrides described in this file's header. A reversal takes
        // its original's attributes (see the query above).
        const overrideCode = t.gl_override_account_code || t.orig_gl_override || null;
        const isSideFundExpense = t.is_side_fund_expense || t.orig_is_side_fund_expense;
        let lineBGlAccountId = mappingByInflowType.get(t.inflow_type);
        if (overrideCode && accountsByCode.has(overrideCode)) {
            lineBGlAccountId = accountsByCode.get(overrideCode).id;
        } else if (t.inflow_type === 'EXPENSE' && investmentId) {
            // v1.80.0 — what the money was for: running / maintenance costs
            // are expenses (5150 / 5160); buying / expanding — and every
            // entry recorded before v1.80 that is not classified yet — is
            // capital (1400). A reversal follows the entry it reverses.
            const costType = t.investment_cost_type || t.orig_investment_cost_type;
            const running = costType && investmentRunningAccounts[costType];
            lineBGlAccountId = running ? running.id : investmentOverrideAccount.id;
        } else if (t.inflow_type === 'EXPENSE' && isSideFundExpense && sideFundOverrideAccount) {
            lineBGlAccountId = sideFundOverrideAccount.id;
        }
        // v1.69.0 — the CURRENCY basis has no allotment lines, so capital
        // pending allotment is shown as capital paid in (3000) there.
        if (!functional && capitalPendingAccount && shareCapitalAccount && lineBGlAccountId === capitalPendingAccount.id) {
            lineBGlAccountId = shareCapitalAccount.id;
        }
        if (!lineBGlAccountId) {
            // An inflow_type with no mapping row is a data/config problem
            // (see the seed migration's own warning), not something to
            // silently drop from the books — surface it loudly.
            throw new Error(`No gl_inflow_type_mapping row for inflow_type '${t.inflow_type}' (transaction #${t.id}) — the chart of accounts is out of sync with transactions.inflow_type's own CHECK constraint.`);
        }
        lines.push({
            date:          toDateStr(t.value_date),
            glAccountId:   lineBGlAccountId,
            accountId:     t.account_id,
            debit:         cashIn ? 0 : amount,
            credit:        cashIn ? amount : 0,
            originalDebit:  cashIn ? 0 : originalAmount,
            originalCredit: cashIn ? originalAmount : 0,
            description:   t.description,
            referenceCode: t.reference_code,
            categoryTrail: t.category_trail,
            sourceType:    'TRANSACTION',
            sourceId:      t.id,
            investmentId,
            lineRole:      'B',
            ...currencyFields,
            ...originalFields,
        });
    }
    return { lines, accountsById, unconverted };
};

// Converts one synthetic (non-cash) adjusting entry's amount into the
// requested basis. Returns null in FUNCTIONAL basis when no rate is
// available (the caller records it as unconverted).
const toBasisAmount = ({ amount, currencyId, date, basis, ctx, knownRate = null }) => {
    if (basis !== BASIS.FUNCTIONAL) return { amount, rate: null };
    const rate = knownRate !== null ? knownRate : ctx.rateOn(currencyId, ctx.functionalCurrency.id, date);
    if (rate === null || rate === undefined) return null;
    return { amount: round2(amount * rate), rate };
};

// ============================================================
// NON-CASH ADJUSTING ENTRY #1 — grant income recognition.
//
// Every grant tranche is received into Deferred Grant Income (2300)
// via the ordinary GRANT-tagged transaction above. It only becomes
// Grant Income (4200) once it's genuinely earned:
//   - An unconditional grant (grants.is_conditional = FALSE) is
//     recognized the moment each tranche lands — there's nothing to
//     wait for.
//   - A conditional grant is recognized only once EVERY one of its
//     grant_conditions rows is MET or WAIVED (none left PENDING or
//     FAILED) — recognition date is the later of that tranche's own
//     receipt or the date the last condition was resolved, so a
//     tranche received before conditions were met is held until they
//     are, while a tranche received after is recognized immediately.
//   - A conditional grant with any unresolved (PENDING/FAILED)
//     condition stays fully deferred — including any FAILED
//     condition, which is treated conservatively as "not yet
//     resolved" rather than assumed to trigger an automatic refund.
//
// Carries the grant's own currency_id (grants.currency_id) onto both
// lines — a grant is always denominated in one currency. In
// FUNCTIONAL basis the recognition uses the rate the tranche was
// RECEIVED at (Deferred Grant Income is not a monetary balance, so it
// stays at its historical rate) — otherwise 2300 would never clear to
// zero in UGX.
// ============================================================
const getGrantRecognitionLines = async ({ fromDate, toDate, basis = BASIS.CURRENCY, ctx = null }) => {
    const { accounts } = await getChartOfAccounts();
    const deferredGl  = accounts.find(a => a.code === '2300');
    const recognizedGl = accounts.find(a => a.code === '4200');

    const grantsResult = await query(`
        SELECT g.id, g.title, g.is_conditional,
               g.currency_id, cur.code AS currency_code, cur.symbol AS currency_symbol,
               (SELECT COUNT(*) FROM grant_conditions gc WHERE gc.grant_id = g.id) AS condition_count,
               (SELECT COUNT(*) FROM grant_conditions gc WHERE gc.grant_id = g.id
                   AND gc.status NOT IN ('MET', 'WAIVED')) AS unresolved_count,
               (SELECT MAX(COALESCE(gc.met_at, gc.waived_at::date))::text FROM grant_conditions gc
                   WHERE gc.grant_id = g.id) AS resolution_date
        FROM   grants g
        JOIN   currencies cur ON cur.id = g.currency_id
    `);

    const tranchesResult = await query(`
        SELECT gt.id, gt.grant_id, gt.tranche_number, gt.amount, gt.received_date::text AS received_date,
               (SELECT t.functional_rate FROM transactions t
                 WHERE t.grant_tranche_id = gt.id AND t.inflow_type = 'GRANT' AND t.status = 'POSTED'
                 ORDER BY t.id ASC LIMIT 1) AS receipt_functional_rate
        FROM   grant_tranches gt
        WHERE  gt.received_date IS NOT NULL
        ORDER  BY gt.received_date ASC, gt.id ASC
    `);
    const tranchesByGrant = new Map();
    for (const tr of tranchesResult.rows) {
        if (!tranchesByGrant.has(tr.grant_id)) tranchesByGrant.set(tr.grant_id, []);
        tranchesByGrant.get(tr.grant_id).push(tr);
    }

    const fromDateStr = toDateStr(fromDate);
    const toDateStrVal = toDateStr(toDate);

    const lines = [];
    const unconverted = [];
    for (const g of grantsResult.rows) {
        const tranches = tranchesByGrant.get(g.id) || [];
        const fullyResolved = g.is_conditional && Number(g.condition_count) > 0 && Number(g.unresolved_count) === 0;
        for (const tr of tranches) {
            const receivedDateStr = toDateStr(tr.received_date);
            let recognitionDate = null;
            if (!g.is_conditional) {
                recognitionDate = receivedDateStr;
            } else if (fullyResolved) {
                const resolutionDateStr = toDateStr(g.resolution_date);
                recognitionDate = (resolutionDateStr && resolutionDateStr > receivedDateStr) ? resolutionDateStr : receivedDateStr;
            }
            if (!recognitionDate) continue; // still deferred — no adjusting entry yet
            if (fromDateStr && recognitionDate < fromDateStr) continue;
            if (toDateStrVal && recognitionDate > toDateStrVal) continue;

            const originalAmount = parseFloat(tr.amount);
            const desc = `Grant income recognized: "${g.title}" tranche #${tr.tranche_number}`;
            const converted = toBasisAmount({
                amount: originalAmount, currencyId: g.currency_id, date: receivedDateStr, basis, ctx,
                knownRate: tr.receipt_functional_rate !== null && tr.receipt_functional_rate !== undefined
                    ? parseFloat(tr.receipt_functional_rate) : null,
            });
            if (!converted) {
                unconverted.push({ transactionId: null, referenceCode: null, date: recognitionDate, currencyCode: g.currency_code, amount: originalAmount, description: desc });
                continue;
            }
            const currencyFields = basis === BASIS.FUNCTIONAL
                ? { currencyId: ctx.functionalCurrency.id, currencyCode: ctx.functionalCurrency.code, currencySymbol: ctx.functionalCurrency.symbol }
                : { currencyId: g.currency_id, currencyCode: g.currency_code, currencySymbol: g.currency_symbol };
            const common = {
                date: recognitionDate, accountId: null, description: desc, referenceCode: null, categoryTrail: null,
                sourceType: 'GRANT_RECOGNITION', sourceId: tr.id,
                originalCurrencyId: g.currency_id, originalCurrencyCode: g.currency_code,
                fxRate: converted.rate, fxRateSource: basis === BASIS.FUNCTIONAL ? 'GRANT_RECEIPT' : null,
                ...currencyFields,
            };
            lines.push({ ...common, glAccountId: deferredGl.id,   debit: converted.amount, credit: 0, originalDebit: originalAmount, originalCredit: 0 });
            lines.push({ ...common, glAccountId: recognizedGl.id, debit: 0, credit: converted.amount, originalDebit: 0, originalCredit: originalAmount });
        }
    }
    return { lines, unconverted };
};

// ============================================================
// NON-CASH ADJUSTING ENTRY #2 — service fee advance recovery.
//
// A Service Fee Advance is recovered from a future month internally
// (service_fee_advance_recoveries.applied_at set, that period's own
// amount_paid incremented directly — see serviceFeeService.js) with
// no new `transactions` row, since no new cash moves. But the
// receivable (1200) really has shrunk, and the club really has
// incurred that month's service fee expense (5300) exactly as if it
// had paid fresh cash for it — the advance is just what paid for it
// instead.
//
// Carries the underlying agreement's own currency_id
// (service_fee_agreements.currency_id) onto both lines. In FUNCTIONAL
// basis it is valued at the rate on the recovery date (the
// receivable is monetary, so it is revalued monthly anyway).
// ============================================================
const getAdvanceRecoveryLines = async ({ fromDate, toDate, basis = BASIS.CURRENCY, ctx = null }) => {
    const { accounts } = await getChartOfAccounts();
    const receivableGl = accounts.find(a => a.code === '1200');
    const expenseGl    = accounts.find(a => a.code === '5300');

    const conditions = [`r.applied_at IS NOT NULL`];
    const params = [];
    if (fromDate) { params.push(fromDate); conditions.push(`r.applied_at::date >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   conditions.push(`r.applied_at::date <= $${params.length}`); }

    const result = await query(`
        SELECT r.id, r.amount, r.applied_at::date::text AS applied_date, smp.period,
               sfa.currency_id, cur.code AS currency_code, cur.symbol AS currency_symbol
        FROM   service_fee_advance_recoveries r
        JOIN   service_fee_monthly_periods smp ON smp.id = r.period_id
        JOIN   service_fee_agreements sfa      ON sfa.id = smp.agreement_id
        JOIN   currencies cur                  ON cur.id = sfa.currency_id
        WHERE  ${conditions.join(' AND ')}
        ORDER  BY r.applied_at ASC
    `, params);

    const lines = [];
    const unconverted = [];
    for (const rec of result.rows) {
        const originalAmount = parseFloat(rec.amount);
        const date = rec.applied_date;
        const desc = `Service fee advance recovery applied to ${rec.period}`;
        const converted = toBasisAmount({ amount: originalAmount, currencyId: rec.currency_id, date, basis, ctx });
        if (!converted) {
            unconverted.push({ transactionId: null, referenceCode: null, date, currencyCode: rec.currency_code, amount: originalAmount, description: desc });
            continue;
        }
        const currencyFields = basis === BASIS.FUNCTIONAL
            ? { currencyId: ctx.functionalCurrency.id, currencyCode: ctx.functionalCurrency.code, currencySymbol: ctx.functionalCurrency.symbol }
            : { currencyId: rec.currency_id, currencyCode: rec.currency_code, currencySymbol: rec.currency_symbol };
        const common = {
            date, accountId: null, description: desc, referenceCode: null, categoryTrail: null,
            sourceType: 'ADVANCE_RECOVERY', sourceId: rec.id,
            originalCurrencyId: rec.currency_id, originalCurrencyCode: rec.currency_code,
            fxRate: converted.rate, fxRateSource: basis === BASIS.FUNCTIONAL ? 'RATE_TABLE' : null,
            ...currencyFields,
        };
        lines.push({ ...common, glAccountId: expenseGl.id,    debit: converted.amount, credit: 0, originalDebit: originalAmount, originalCredit: 0 });
        lines.push({ ...common, glAccountId: receivableGl.id, debit: 0, credit: converted.amount, originalDebit: 0, originalCredit: originalAmount });
    }
    return { lines, unconverted };
};

// ============================================================
// NON-CASH ADJUSTING ENTRY #3 (v1.69.0) — share allotments.
//
// Every contribution is credited to 3020 Capital Pending Allotment.
// When whole shares are allotted (share_allotments, written by
// shareCapitalService), their value moves out of 3020:
//     Dr 3020  shares x issue price
//         Cr 3000  shares x nominal value          (share capital)
//         Cr 3010  shares x (issue - nominal)      (share premium)
// A consolidation that cancels leftover old shares puts their nominal
// value back into the member's credit (Dr 3000 / Cr 3020). A split has
// no money effect. A reversed allotment gets the mirror entry on the
// date it was reversed. FUNCTIONAL basis only (allotments are valued
// in the share currency, UGX, which is the functional currency; any
// other share currency is converted at the rate on the allotment date).
// ============================================================
const getShareAllotmentLines = async ({ fromDate, toDate, basis, ctx }) => {
    if (basis !== BASIS.FUNCTIONAL) return { lines: [], unconverted: [] };
    const exists = await query(`SELECT to_regclass('share_allotments') IS NOT NULL AS ok`);
    if (!exists.rows[0].ok) return { lines: [], unconverted: [] };

    const pendingGl = ctx.glByCode.get(CAPITAL_PENDING_GL_CODE);
    const capitalGl = ctx.glByCode.get(SHARE_CAPITAL_GL_CODE);
    const premiumGl = ctx.glByCode.get(SHARE_PREMIUM_GL_CODE);
    if (!pendingGl || !capitalGl || !premiumGl) return { lines: [], unconverted: [] };

    const result = await query(`
        SELECT sa.id, sa.source, sa.shares, sa.allotment_date::text AS allotment_date, sa.status,
               sa.reversed_at::text AS reversed_at, sa.nominal_value, sa.issue_price,
               sa.consideration_amount, sa.share_capital_amount, sa.share_premium_amount,
               sa.currency_id, cur.code AS currency_code, rr.reference_code,
               u.first_name || ' ' || u.last_name AS member_name
        FROM   share_allotments sa
        JOIN   currencies cur ON cur.id = sa.currency_id
        JOIN   users u ON u.id = sa.user_id
        LEFT JOIN references_registry rr ON rr.id = sa.reference_id
        WHERE  sa.source <> 'SPLIT'
        ORDER  BY sa.allotment_date ASC, sa.id ASC
    `);

    const fromStr = toDateStr(fromDate);
    const toStr = toDateStr(toDate);
    const inRange = (d) => (!fromStr || d >= fromStr) && (!toStr || d <= toStr);
    const f = ctx.functionalCurrency;

    const lines = [];
    const unconverted = [];
    const push = (a, date, glAccountId, signedAmount, rate, description) => {
        if (Math.abs(signedAmount) < 0.005) return;
        const amount = round2(Math.abs(signedAmount));
        const isDebit = signedAmount > 0;
        const original = rate === 1 ? amount : round2(amount / rate);
        lines.push({
            date, glAccountId, accountId: null,
            debit: isDebit ? amount : 0, credit: isDebit ? 0 : amount,
            originalDebit: isDebit ? original : 0, originalCredit: isDebit ? 0 : original,
            description, referenceCode: a.reference_code, categoryTrail: null,
            sourceType: 'SHARE_ALLOTMENT', sourceId: a.id,
            currencyId: f.id, currencyCode: f.code, currencySymbol: f.symbol,
            originalCurrencyId: a.currency_id, originalCurrencyCode: a.currency_code,
            fxRate: rate, fxRateSource: rate === 1 ? 'SAME_CURRENCY' : 'RATE_TABLE',
        });
    };

    const emit = (a, date, sign, label) => {
        const rate = a.currency_id === f.id ? 1 : ctx.rateOn(a.currency_id, f.id, date);
        if (rate === null || rate === undefined) {
            unconverted.push({ transactionId: null, referenceCode: a.reference_code, date, currencyCode: a.currency_code,
                amount: parseFloat(a.consideration_amount), description: label });
            return;
        }
        const consideration = parseFloat(a.consideration_amount) * rate;
        const capital = parseFloat(a.share_capital_amount) * rate;
        const premium = parseFloat(a.share_premium_amount) * rate;
        if (a.source === 'CONSOLIDATION') {
            // capital is negative: leftover old shares' nominal back to credit.
            push(a, date, capitalGl.id, sign * -capital, rate, label);   // Dr 3000
            push(a, date, pendingGl.id, sign * capital, rate, label);    // Cr 3020
            return;
        }
        push(a, date, pendingGl.id, sign * consideration, rate, label);  // Dr 3020
        push(a, date, capitalGl.id, sign * -capital, rate, label);       // Cr 3000
        push(a, date, premiumGl.id, sign * -premium, rate, label);       // Cr 3010 (Dr if issued below nominal)
    };

    for (const a of result.rows) {
        const what = a.source === 'CONSOLIDATION'
            ? `Share consolidation — ${a.member_name}: ${a.shares} share(s); leftover returned to share credit`
            : `Shares allotted — ${a.member_name}: ${a.shares} x ${parseFloat(a.issue_price).toLocaleString('en-US')} (nominal ${parseFloat(a.nominal_value).toLocaleString('en-US')})`;
        if (inRange(a.allotment_date)) emit(a, a.allotment_date, 1, what);
        if (a.status === 'REVERSED' && a.reversed_at && inRange(a.reversed_at)) {
            emit(a, a.reversed_at, -1, `REVERSAL — ${what}`);
        }
    }
    return { lines, unconverted };
};

// ============================================================
// getLedgerLines — the single entry point every report below builds
// on. Non-cash adjusting entries are only included company-wide
// (accountId not set) since neither is attributable to one specific
// bank account.
//
// Returns { lines, accountsById, meta }. `meta` describes the basis:
//   { basis, functionalCurrency, presentation, unconverted,
//     revaluation: { lastPeriodEnd, provisionalAt, provisionalLines,
//                    missingRateCurrencies } }
//
// FUNCTIONAL basis always reads the ledger CUMULATIVELY (from the
// very first transaction) up to the end date, because a revaluation
// depends on the whole balance, not just this period's movements —
// lines before `fromDate` are only dropped at the very end.
// `includeProvisional: false` is used by the month-end revaluation
// run itself (it must not revalue on top of a provisional guess).
// ============================================================
const getLedgerLines = async ({ accountId = null, fromDate = null, toDate = null, basis = BASIS.CURRENCY, includeProvisional = true } = {}) => {
    basis = normalizeBasis(basis);

    if (basis === BASIS.CURRENCY) {
        const { lines: txLines, accountsById } = await getTransactionLedgerLines({ accountId, fromDate, toDate, basis });
        let lines = txLines;
        if (!accountId) {
            const [grant, recovery] = await Promise.all([
                getGrantRecognitionLines({ fromDate, toDate, basis }),
                getAdvanceRecoveryLines({ fromDate, toDate, basis }),
            ]);
            lines = lines.concat(grant.lines, recovery.lines);
            // v1.70.0 — the investment closure needs every line since
            // inception, not only this range's.
            const glByCode = new Map(Array.from(accountsById.values()).map(a => [a.code, a]));
            const allForClosure = fromDate
                ? (await getTransactionLedgerLines({ accountId: null, fromDate: null, toDate, basis })).lines
                : txLines;
            const v170 = await getV170AdjustmentLines({ fromDate, toDate, basis, ctx: null, glByCode, allLinesForClosure: allForClosure });
            lines = lines.concat(v170.lines);
        }
        lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        return { lines, accountsById, meta: { basis, unconverted: [] } };
    }

    const ctx = await getFunctionalContext();
    const endDate = toDateStr(toDate) || fxService.todayStr();

    const tx = await getTransactionLedgerLines({ accountId, fromDate: null, toDate: endDate, basis, ctx });
    let lines = tx.lines;
    let unconverted = tx.unconverted;
    if (!accountId) {
        const [grant, recovery, allotments] = await Promise.all([
            getGrantRecognitionLines({ fromDate: null, toDate: endDate, basis, ctx }),
            getAdvanceRecoveryLines({ fromDate: null, toDate: endDate, basis, ctx }),
            getShareAllotmentLines({ fromDate: null, toDate: endDate, basis, ctx }),
        ]);
        lines = lines.concat(grant.lines, recovery.lines, allotments.lines);
        unconverted = unconverted.concat(grant.unconverted, recovery.unconverted, allotments.unconverted);
        const v170 = await getV170AdjustmentLines({
            fromDate: null, toDate: endDate, basis, ctx, glByCode: ctx.glByCode, allLinesForClosure: lines,
        });
        lines = lines.concat(v170.lines);
        unconverted = unconverted.concat(v170.unconverted);
    }

    const stored = await fxService.getStoredRevaluationLines({
        throughDate: endDate, accountId,
        glByCode: ctx.glByCode, functionalCurrency: ctx.functionalCurrency, currencyCodeById: ctx.currencyCodeById,
    });
    lines = lines.concat(stored);

    const lastPeriodEndInRange = await fxService.getLastRevaluationPeriodEnd(endDate);

    let provisionalLines = [];
    let missingRateCurrencies = [];
    let provisionalAt = null;
    if (includeProvisional && (!lastPeriodEndInRange || lastPeriodEndInRange < endDate)) {
        const reval = fxService.computeRevaluation({
            lines, date: endDate, functionalCurrencyId: ctx.functionalCurrency.id,
            monetaryGlIds: ctx.monetaryGlIds, rateOn: ctx.rateOn,
        });
        provisionalAt = endDate;
        missingRateCurrencies = reval.missingCurrencyIds.map(id => ctx.currencyCodeById.get(id) || String(id));
        for (const adj of reval.adjustments) {
            provisionalLines.push(...fxService.revaluationToLines({
                adj, date: endDate, sourceType: 'FX_REVALUATION_PROVISIONAL', sourceId: null,
                glByCode: ctx.glByCode, functionalCurrency: ctx.functionalCurrency, currencyCodeById: ctx.currencyCodeById,
                description: `Provisional FX revaluation of ${ctx.currencyCodeById.get(adj.currencyId) || ''} balance at ${adj.closingRate} (${endDate}) — month not yet closed`,
            }));
        }
        lines = lines.concat(provisionalLines);
    }

    const fromDateStr = toDateStr(fromDate);
    if (fromDateStr) lines = lines.filter(l => l.date >= fromDateStr);
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const presentation = ctx.settings.presentationCurrency && ctx.settings.presentationCurrency.id !== ctx.functionalCurrency.id
        ? {
            currencyId: ctx.settings.presentationCurrency.id,
            currencyCode: ctx.settings.presentationCurrency.code,
            currencySymbol: ctx.settings.presentationCurrency.symbol,
            rateDate: endDate,
            // multiply a UGX figure by this to get the convenience-translated figure
            rate: ctx.rateOn(ctx.functionalCurrency.id, ctx.settings.presentationCurrency.id, endDate),
        }
        : null;

    return {
        lines,
        accountsById: tx.accountsById,
        meta: {
            basis,
            functionalCurrency: ctx.functionalCurrency,
            presentation,
            unconverted,
            revaluation: {
                lastPeriodEnd: lastPeriodEndInRange,
                provisionalAt,
                provisionalLines,
                missingRateCurrencies,
            },
        },
        ctx,
    };
};

// What every report returns alongside its own figures.
const publicMeta = (meta) => ({
    basis: meta.basis,
    functionalCurrency: meta.functionalCurrency || null,
    presentation: meta.presentation || null,
    unconvertedCount: (meta.unconverted || []).length,
    unconverted: (meta.unconverted || []).slice(0, 50),
    revaluation: meta.revaluation ? {
        lastPeriodEnd: meta.revaluation.lastPeriodEnd,
        provisionalAt: meta.revaluation.provisionalLines && meta.revaluation.provisionalLines.length ? meta.revaluation.provisionalAt : null,
        missingRateCurrencies: meta.revaluation.missingRateCurrencies,
    } : null,
});

// ============================================================
// TRIAL BALANCE — cumulative since inception through asOfDate.
// Broken down by currency — `byCurrency` holds one entry per
// currency actually present in the ledger lines (exactly one in
// FUNCTIONAL basis, or when accountId is given). Nothing here is
// ever summed across two different currencies.
// ============================================================
const computeTrialBalance = async ({ accountId = null, asOfDate = null, basis = BASIS.FUNCTIONAL } = {}) => {
    basis = normalizeBasis(basis);
    const { accounts } = await getChartOfAccounts();
    const { lines, meta } = await getLedgerLines({ accountId, toDate: asOfDate, basis });

    const byCurrencyMap = groupLinesByCurrency(lines);
    const byCurrency = sortByCurrencyCode(Array.from(byCurrencyMap.values()).map(group => {
        const totalsByGl = new Map();
        for (const line of group.lines) {
            if (!totalsByGl.has(line.glAccountId)) totalsByGl.set(line.glAccountId, { debit: 0, credit: 0 });
            const t = totalsByGl.get(line.glAccountId);
            t.debit += line.debit;
            t.credit += line.credit;
        }

        const rows = accounts
            .filter(a => totalsByGl.has(a.id))
            .map(a => {
                const t = totalsByGl.get(a.id);
                const balance = a.normal_balance === 'DEBIT' ? (t.debit - t.credit) : (t.credit - t.debit);
                return {
                    code: a.code, name: a.name, accountType: a.account_type,
                    totalDebit: round2(t.debit), totalCredit: round2(t.credit), balance: round2(balance),
                };
            })
            .sort((x, y) => x.code.localeCompare(y.code));

        const totalDebit = round2(rows.reduce((s, r) => s + r.totalDebit, 0));
        const totalCredit = round2(rows.reduce((s, r) => s + r.totalCredit, 0));

        return {
            currencyId: group.currencyId, currencyCode: group.currencyCode, currencySymbol: group.currencySymbol,
            rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01,
        };
    }));

    return { asOfDate, accountId, basis, meta: publicMeta(meta), byCurrency };
};

// ============================================================
// GENERAL LEDGER — full line-by-line detail, optionally for one
// gl_account, with a running balance. Each currency gets its own
// full set of account sections and its own running balances (in
// FUNCTIONAL basis there is just one, UGX). Running balances start
// from the account's balance brought forward at `fromDate`, so an
// ending balance here always agrees with the Trial Balance.
// ============================================================
const computeGeneralLedger = async ({ glAccountId = null, accountId = null, fromDate = null, toDate = null, basis = BASIS.FUNCTIONAL } = {}) => {
    basis = normalizeBasis(basis);
    const { accounts } = await getChartOfAccounts();
    const { lines: allLines, meta } = await getLedgerLines({ accountId, toDate, basis });
    const fromDateStr = toDateStr(fromDate);

    // glAccountId may arrive as a string from a query param — accounts[].id
    // is a plain JS number (from a SERIAL column), so this must be
    // coerced before the strict-equality filter below, or "?glAccountId=5"
    // would silently match nothing at all.
    const glAccountIdNum = glAccountId !== null ? parseInt(glAccountId) : null;
    const targetAccounts = glAccountIdNum ? accounts.filter(a => a.id === glAccountIdNum) : accounts;

    const byCurrencyMap = groupLinesByCurrency(allLines);
    const byCurrency = sortByCurrencyCode(Array.from(byCurrencyMap.values()).map(group => {
        const sections = [];
        for (const acc of targetAccounts) {
            const accAll = group.lines.filter(l => l.glAccountId === acc.id);
            const sign = (l) => (acc.normal_balance === 'DEBIT' ? (l.debit - l.credit) : (l.credit - l.debit));
            const before = fromDateStr ? accAll.filter(l => l.date < fromDateStr) : [];
            const inRange = fromDateStr ? accAll.filter(l => l.date >= fromDateStr) : accAll;
            const openingBalance = before.reduce((s, l) => s + sign(l), 0);
            if (inRange.length === 0 && Math.abs(openingBalance) < 0.005 && glAccountIdNum === null) continue; // skip untouched accounts in the "all accounts" view
            let running = openingBalance;
            const detail = inRange.map(l => {
                running += sign(l);
                const showOriginal = basis === BASIS.FUNCTIONAL && l.originalCurrencyCode && l.originalCurrencyCode !== l.currencyCode;
                const isRevaluation = l.sourceType === 'FX_REVALUATION' || l.sourceType === 'FX_REVALUATION_PROVISIONAL';
                return {
                    date: l.date, description: l.description, referenceCode: l.referenceCode,
                    categoryTrail: l.categoryTrail, sourceType: l.sourceType,
                    debit: round2(l.debit), credit: round2(l.credit), runningBalance: round2(running),
                    original: showOriginal ? {
                        currencyCode: l.originalCurrencyCode,
                        // A revaluation moves only the UGX value, never the
                        // foreign amount — so it has no original amount.
                        amount: isRevaluation ? null : round2((l.originalDebit || 0) + (l.originalCredit || 0)),
                        rate: l.fxRate,
                        rateSource: l.fxRateSource,
                    } : null,
                };
            });
            sections.push({
                code: acc.code, name: acc.name, accountType: acc.account_type,
                openingBalance: round2(openingBalance),
                lines: detail, endingBalance: round2(running),
            });
        }
        return { currencyId: group.currencyId, currencyCode: group.currencyCode, currencySymbol: group.currencySymbol, sections };
    }));

    return { glAccountId, accountId, fromDate, toDate, basis, meta: publicMeta(meta), byCurrency };
};

// ============================================================
// BALANCE SHEET — as of a single date, cumulative since inception.
// Built directly from Trial Balance above. The cash cross-check
// compares ledger cash with the live accounts.current_balance:
//   CURRENCY basis — per currency, as before.
//   FUNCTIONAL basis — every live balance converted to UGX at the
//   rate on asOfDate, compared with the ledger's (revalued) UGX cash.
// Live balances are "now", so the check is only meaningful when
// asOfDate is today (which reportsController defaults to).
// ============================================================
const computeBalanceSheet = async ({ accountId = null, asOfDate, basis = BASIS.FUNCTIONAL } = {}) => {
    basis = normalizeBasis(basis);
    const trialBalance = await computeTrialBalance({ accountId, asOfDate, basis });

    const accountFilter = accountId ? 'AND a.id = $1' : '';
    const liveBalancesResult = await query(`
        SELECT a.currency_id, cur.code AS currency_code, COALESCE(SUM(a.current_balance), 0) AS total
        FROM   accounts a
        JOIN   currencies cur ON cur.id = a.currency_id
        WHERE  a.is_active = TRUE ${accountFilter}
        GROUP  BY a.currency_id, cur.code
    `, accountId ? [accountId] : []);

    let liveBalanceByCurrency;
    if (basis === BASIS.FUNCTIONAL) {
        const ctx = await getFunctionalContext();
        const date = toDateStr(asOfDate) || fxService.todayStr();
        let total = 0;
        let missing = false;
        for (const r of liveBalancesResult.rows) {
            const rate = ctx.rateOn(r.currency_id, ctx.functionalCurrency.id, date);
            if (rate === null) { missing = true; continue; }
            total += parseFloat(r.total) * rate;
        }
        liveBalanceByCurrency = new Map([[ctx.functionalCurrency.code, missing ? null : round2(total)]]);
    } else {
        liveBalanceByCurrency = new Map(
            liveBalancesResult.rows.map(r => [r.currency_code, round2(parseFloat(r.total))])
        );
    }

    const byCurrency = trialBalance.byCurrency.map(tb => {
        const byType = { ASSET: [], LIABILITY: [], EQUITY: [], REVENUE: [], EXPENSE: [] };
        for (const row of tb.rows) byType[row.accountType].push(row);

        const sum = (rows) => round2(rows.reduce((s, r) => s + r.balance, 0));
        const totalAssets = sum(byType.ASSET);
        const totalLiabilities = sum(byType.LIABILITY);
        const contributedEquity = sum(byType.EQUITY);
        const totalRevenue = sum(byType.REVENUE);
        const totalExpenses = sum(byType.EXPENSE);
        const netIncomeToDate = round2(totalRevenue - totalExpenses);
        const totalEquity = round2(contributedEquity + netIncomeToDate);
        const check = round2(totalAssets - (totalLiabilities + totalEquity));

        const ledgerCash = round2(
            byType.ASSET.filter(r => r.code === CASH_GL_CODE || r.code === CLEARING_GL_CODE).reduce((s, r) => s + r.balance, 0)
        );
        const actualCash = liveBalanceByCurrency.has(tb.currencyCode) ? liveBalanceByCurrency.get(tb.currencyCode) : 0;

        return {
            currencyId: tb.currencyId, currencyCode: tb.currencyCode, currencySymbol: tb.currencySymbol,
            assets: byType.ASSET, liabilities: byType.LIABILITY, equity: byType.EQUITY,
            totalAssets, totalLiabilities, contributedEquity, netIncomeToDate, totalEquity,
            balanced: Math.abs(check) < 0.01, difference: check,
            cashReconciliation: {
                ledgerCash,
                actualCash,
                // null = a live balance couldn't be converted (no rate on file)
                matches: actualCash === null ? null : Math.abs(ledgerCash - actualCash) < 1,
            },
        };
    });

    return { asOfDate, accountId, basis, meta: trialBalance.meta, byCurrency };
};

// ============================================================
// INCOME STATEMENT (Profit & Loss) — for a date range. Broken down
// by currency — revenue and expenses in different currencies are
// never netted against each other into one "Net Income" figure. In
// FUNCTIONAL basis there is one statement, in UGX, including the
// period's FX gains and losses.
// ============================================================
const computeIncomeStatement = async ({ accountId = null, fromDate, toDate, basis = BASIS.FUNCTIONAL } = {}) => {
    basis = normalizeBasis(basis);
    const { lines, meta } = await getLedgerLines({ accountId, fromDate, toDate, basis });
    const { accounts } = await getChartOfAccounts();
    const accountsById = new Map(accounts.map(a => [a.id, a]));
    const incomeTaxCodes = new Set(accounts.filter(a => a.statement_section === 'INCOME_TAX').map(a => a.code));

    const byCurrencyMap = groupLinesByCurrency(lines);
    const byCurrency = sortByCurrencyCode(Array.from(byCurrencyMap.values()).map(group => {
        const totalsByGl = new Map();
        for (const line of group.lines) {
            const acc = accountsById.get(line.glAccountId);
            if (!acc || (acc.account_type !== 'REVENUE' && acc.account_type !== 'EXPENSE')) continue;
            if (!totalsByGl.has(acc.id)) totalsByGl.set(acc.id, { debit: 0, credit: 0 });
            const t = totalsByGl.get(acc.id);
            t.debit += line.debit;
            t.credit += line.credit;
        }

        const revenue = [];
        const expenses = [];
        for (const acc of accounts) {
            if (!totalsByGl.has(acc.id)) continue;
            const t = totalsByGl.get(acc.id);
            const amount = acc.account_type === 'REVENUE' ? round2(t.credit - t.debit) : round2(t.debit - t.credit);
            const row = { code: acc.code, name: acc.name, amount };
            if (acc.account_type === 'REVENUE') revenue.push(row); else expenses.push(row);
        }
        // v1.68.0 — FX gains (4600) and FX losses (5600) are presented as
        // ONE net line, "Net foreign exchange gain / (loss)" — shown under
        // Revenue when the net is a gain, under Expenses when it is a
        // loss (IFRS for SMEs allows exchange differences to be presented
        // net). Much of the gross is the two sides of the same event (e.g.
        // a EUR loan repaid after the rate rose: a loss on the loan and a
        // matching gain on the EUR cash used to repay it), so the gross
        // figures overstate what actually happened. They are kept in
        // `fxDetail` and shown beneath the line, and stay separate in the
        // Trial Balance and General Ledger, where accounts are listed
        // individually.
        const fxGainRow = revenue.find(r => r.code === FX_GAIN_GL_CODE);
        const fxLossRow = expenses.find(r => r.code === FX_LOSS_GL_CODE);
        let fxDetail = null;
        if (fxGainRow || fxLossRow) {
            const gains = fxGainRow ? fxGainRow.amount : 0;
            const losses = fxLossRow ? fxLossRow.amount : 0;
            const net = round2(gains - losses);
            fxDetail = { gains, losses, net };
            const keepRevenue = revenue.filter(r => r.code !== FX_GAIN_GL_CODE);
            const keepExpenses = expenses.filter(r => r.code !== FX_LOSS_GL_CODE);
            revenue.length = 0; revenue.push(...keepRevenue);
            expenses.length = 0; expenses.push(...keepExpenses);
            if (net > 0) {
                revenue.push({ code: FX_GAIN_GL_CODE, name: 'Net foreign exchange gain', amount: net, isNetFx: true });
            } else if (net < 0) {
                expenses.push({ code: FX_LOSS_GL_CODE, name: 'Net foreign exchange loss', amount: round2(-net), isNetFx: true });
            }
        }

        // v1.70.0 — income tax (statement_section 'INCOME_TAX': 5700
        // final tax deducted at source, 5710 corporate income tax) is not
        // an operating expense. It is shown below "Profit before tax":
        //   Revenue - Expenses = Profit before tax
        //   Profit before tax - Income tax = Profit after tax (netIncome)
        const incomeTax = expenses.filter(r => incomeTaxCodes.has(r.code));
        const operatingExpenses = expenses.filter(r => !incomeTaxCodes.has(r.code));
        expenses.length = 0; expenses.push(...operatingExpenses);

        revenue.sort((a, b) => a.code.localeCompare(b.code));
        expenses.sort((a, b) => a.code.localeCompare(b.code));
        incomeTax.sort((a, b) => a.code.localeCompare(b.code));

        const totalRevenue = round2(revenue.reduce((s, r) => s + r.amount, 0));
        const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));
        const profitBeforeTax = round2(totalRevenue - totalExpenses);
        const totalIncomeTax = round2(incomeTax.reduce((s, r) => s + r.amount, 0));
        return {
            currencyId: group.currencyId, currencyCode: group.currencyCode, currencySymbol: group.currencySymbol,
            revenue, expenses, totalRevenue, totalExpenses,
            profitBeforeTax, incomeTax, totalIncomeTax,
            netIncome: round2(profitBeforeTax - totalIncomeTax),
            fxDetail,
        };
    }));

    return { accountId, fromDate, toDate, basis, meta: publicMeta(meta), byCurrency };
};

// ============================================================
// CASH FLOW STATEMENT (Direct Method) — for a date range. Only real
// transactions ever move cash, so the non-cash adjusting entries are
// never cash flows. Line A/Line B pairs are grouped by currency
// before the operating/investing/financing split, and the
// opening/closing cash cross-check is computed per currency too.
//
// FUNCTIONAL basis adds one line IAS 7 requires: the "effect of
// exchange-rate changes on cash" — the revaluation of foreign-
// currency cash during the period. The check is then:
//   closing cash - opening cash = net cash flow + FX effect
// where the FX effect is counted independently (from the
// revaluation entries on cash), so the check is a real one.
// ============================================================
const computeCashFlowStatement = async ({ accountId = null, fromDate, toDate, basis = BASIS.FUNCTIONAL } = {}) => {
    basis = normalizeBasis(basis);
    const { accounts } = await getChartOfAccounts();
    const accountsById = new Map(accounts.map(a => [a.id, a]));
    const cashIds = new Set(accounts.filter(a => a.code === CASH_GL_CODE || a.code === CLEARING_GL_CODE).map(a => a.id));

    let txLines;
    let meta;
    let fxLinesInRange = [];
    if (basis === BASIS.FUNCTIONAL) {
        const ledger = await getLedgerLines({ accountId, fromDate, toDate, basis });
        meta = ledger.meta;
        txLines = ledger.lines.filter(l => l.sourceType === 'TRANSACTION');
        fxLinesInRange = ledger.lines.filter(l => (l.sourceType === 'FX_REVALUATION' || l.sourceType === 'FX_REVALUATION_PROVISIONAL') && cashIds.has(l.glAccountId));
    } else {
        const ledger = await getTransactionLedgerLines({ accountId, fromDate, toDate, basis });
        txLines = ledger.lines;
        meta = { basis, unconverted: [] };
    }

    // Pair Line A with Line B by their shared source transaction.
    const pairsBySource = new Map();
    for (const l of txLines) {
        if (!pairsBySource.has(l.sourceId)) pairsBySource.set(l.sourceId, {});
        pairsBySource.get(l.sourceId)[l.lineRole] = l;
    }

    const pairsByCurrency = new Map();
    for (const pair of pairsBySource.values()) {
        const lineA = pair.A;
        const lineB = pair.B;
        if (!lineA || !lineB) continue;
        const key = lineA.currencyCode || '—';
        if (!pairsByCurrency.has(key)) {
            pairsByCurrency.set(key, {
                currencyId: lineA.currencyId, currencyCode: lineA.currencyCode, currencySymbol: lineA.currencySymbol,
                pairs: [],
            });
        }
        pairsByCurrency.get(key).pairs.push([lineA, lineB]);
    }
    // In FUNCTIONAL basis a period with only FX movement still needs a block.
    if (basis === BASIS.FUNCTIONAL && pairsByCurrency.size === 0 && fxLinesInRange.length > 0) {
        const f = meta.functionalCurrency;
        pairsByCurrency.set(f.code, { currencyId: f.id, currencyCode: f.code, currencySymbol: f.symbol, pairs: [] });
    }

    const byCurrency = [];
    for (const group of pairsByCurrency.values()) {
        const byCategory = { OPERATING: 0, INVESTING: 0, FINANCING: 0 };
        let internalTransfersNet = 0;
        for (const [lineA, lineB] of group.pairs) {
            const netCash = lineA.debit - lineA.credit; // +ve = cash in, -ve = cash out
            const glB = accountsById.get(lineB.glAccountId);
            if (glB.cash_flow_category === 'EXCLUDED') {
                internalTransfersNet += netCash;
                continue;
            }
            byCategory[glB.cash_flow_category] += netCash;
        }

        const operatingNet = round2(byCategory.OPERATING);
        const investingNet = round2(byCategory.INVESTING);
        const financingNet = round2(byCategory.FINANCING);
        const netChangeInCash = round2(operatingNet + investingNet + financingNet);

        let openingCash;
        let closingCash;
        let fxEffectOnCash = 0;
        if (basis === BASIS.FUNCTIONAL) {
            const [opening, closing] = await Promise.all([
                fromDate ? computeCashPositionThrough({ accountId, date: fxService.dayBefore(toDateStr(fromDate)), basis })
                         : Promise.resolve({ cash: 0, provisionalCash: 0 }),
                computeCashPositionThrough({ accountId, date: toDate, basis }),
            ]);
            openingCash = opening.cash;
            closingCash = closing.cash;
            // Revaluation of cash recorded inside the range (stored runs +
            // the provisional one at the end date), minus the provisional
            // revaluation already counted in the opening balance.
            const fxInRange = fxLinesInRange.reduce((s, l) => s + (l.debit - l.credit), 0);
            fxEffectOnCash = round2(fxInRange - opening.provisionalCash);
        } else {
            const [opening, closing] = await Promise.all([
                fromDate
                    ? computeCashPositionThrough({ accountId, date: fxService.dayBefore(toDateStr(fromDate)), basis, currencyId: group.currencyId })
                    : Promise.resolve({ cash: 0 }),
                computeCashPositionThrough({ accountId, date: toDate, basis, currencyId: group.currencyId }),
            ]);
            openingCash = opening.cash;
            closingCash = closing.cash;
        }
        const expectedChange = round2(closingCash - openingCash);

        byCurrency.push({
            currencyId: group.currencyId, currencyCode: group.currencyCode, currencySymbol: group.currencySymbol,
            operatingNet, investingNet, financingNet, netChangeInCash,
            fxEffectOnCash: round2(fxEffectOnCash),
            internalTransfersNet: round2(internalTransfersNet),
            openingCash: round2(openingCash), closingCash: round2(closingCash), expectedChange,
            reconciles: Math.abs(expectedChange - (netChangeInCash + fxEffectOnCash)) < 1,
        });
    }
    sortByCurrencyCode(byCurrency);

    return { accountId, fromDate, toDate, basis, meta: publicMeta(meta), byCurrency };
};

// Cash balance (1000 + 1050) as of a date, cumulative since inception
// — used only for the Cash Flow Statement's own cross-check above.
// Returns { cash, provisionalCash } — provisionalCash is the part of
// `cash` that comes from a provisional (not yet closed) revaluation,
// FUNCTIONAL basis only.
const computeCashPositionThrough = async ({ accountId, date, currencyId = null, basis = BASIS.CURRENCY }) => {
    const { lines } = await getLedgerLines({ accountId, toDate: date, basis });
    const { accounts } = await getChartOfAccounts();
    const cashIds = new Set(accounts.filter(a => a.code === CASH_GL_CODE || a.code === CLEARING_GL_CODE).map(a => a.id));
    const cashLines = lines.filter(l => cashIds.has(l.glAccountId) && (currencyId === null || l.currencyId === currencyId));
    return {
        cash: cashLines.reduce((s, l) => s + (l.debit - l.credit), 0),
        provisionalCash: cashLines
            .filter(l => l.sourceType === 'FX_REVALUATION_PROVISIONAL')
            .reduce((s, l) => s + (l.debit - l.credit), 0),
    };
};

module.exports = {
    BASIS,
    getChartOfAccounts,
    updateInflowTypeMapping,
    getFunctionalContext,
    getLedgerLines,
    computeTrialBalance,
    computeGeneralLedger,
    computeBalanceSheet,
    computeIncomeStatement,
    computeCashFlowStatement,
};
