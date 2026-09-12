// ============================================================
// GENERAL LEDGER SERVICE (v1.55.0)
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
// ONE HARDCODED OVERRIDE
// `gl_inflow_type_mapping` maps EXPENSE -> Operating Expenses (5000)
// by default, because EXPENSE is reused across the whole app for any
// generic outflow. But `investmentsController.js` also posts a real
// investment purchase (capital deployed into a project/bond) as
// inflow_type='EXPENSE' — that is an ASSET acquired, not money spent,
// and would badly distort the Income Statement if left as an expense.
// Investments is the only module that reuses a generic inflow_type
// this way (every other module — loans, grants, savings, etc. — has
// its own dedicated inflow_type), so the one targeted fix is: any
// EXPENSE-tagged transaction that also carries a non-null
// `investment_id` is reclassified to 1400 (Other Investments) here,
// in code, rather than in the editable mapping table (which has no
// way to express "except when this other column is set").
//
// TWO NON-CASH ADJUSTING ENTRIES
// Two events in the system change what's actually owed/earned
// without moving any cash, so they can never appear as a `transactions`
// row — they are computed here as synthetic ledger lines with no
// `account_id` (nothing to attribute them to) and are therefore only
// included in the company-wide view, never a single-account view:
//   1. Grant income recognition — see recognizeGrantTrancheLines()
//   2. Service fee advance recovery — see advanceRecoveryLines()
// ============================================================

const { query } = require('../config/database');

const CASH_GL_CODE = '1000';
const INVESTMENT_OVERRIDE_GL_CODE = '1400';

// Dates arrive from three different places in this file — raw pg
// driver values for DATE columns (JS Date objects), TIMESTAMPTZ
// columns (also JS Date objects), and query-string parameters from
// the controller (plain 'YYYY-MM-DD' strings). Comparing a Date
// object to a string with JS's `<`/`>` operators silently produces
// wrong answers (the string coerces to NaN, so the comparison is
// always false) — every date is normalized through this helper
// before it's stored on a line or compared against anything, so
// comparisons are always plain, reliable ISO-string comparisons.
const toDateStr = (d) => {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    return d.toISOString().split('T')[0];
};

// ============================================================
// CHART OF ACCOUNTS — read helpers
// ============================================================
const getChartOfAccounts = async () => {
    const accountsResult = await query(`
        SELECT id, code, name, account_type, normal_balance, statement_section,
               cash_flow_category, description, display_order, is_active
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
// CORE DERIVATION — every real transaction, as two ledger lines
// ============================================================
const getTransactionLedgerLines = async ({ accountId, fromDate, toDate }) => {
    const { accounts } = await getChartOfAccounts();
    const accountsByCode = new Map(accounts.map(a => [a.code, a]));
    const cashAccount = accountsByCode.get(CASH_GL_CODE);
    const investmentOverrideAccount = accountsByCode.get(INVESTMENT_OVERRIDE_GL_CODE);

    const mappingResult = await query(`SELECT inflow_type, gl_account_id FROM gl_inflow_type_mapping`);
    const mappingByInflowType = new Map(mappingResult.rows.map(m => [m.inflow_type, m.gl_account_id]));
    const accountsById = new Map(accounts.map(a => [a.id, a]));

    const conditions = [`t.status = 'POSTED'`];
    const params = [];
    if (accountId) { params.push(accountId); conditions.push(`t.account_id = $${params.length}`); }
    if (fromDate)  { params.push(fromDate);  conditions.push(`t.value_date >= $${params.length}`); }
    if (toDate)    { params.push(toDate);    conditions.push(`t.value_date <= $${params.length}`); }
    const where = conditions.join(' AND ');

    const result = await query(`
        SELECT t.id, t.account_id, t.value_date, t.transaction_type, t.inflow_type,
               t.amount, t.description, t.investment_id, t.category_id,
               r.reference_code, cp.full_path AS category_trail
        FROM   transactions t
        LEFT JOIN references_registry r ON r.id = t.reference_id
        LEFT JOIN category_paths cp     ON cp.category_id = t.category_id
        WHERE  ${where}
        ORDER  BY t.value_date ASC, t.id ASC
    `, params);

    const isCashIn = (txType) => txType === 'CREDIT' || txType === 'REVERSAL_CREDIT';

    const lines = [];
    for (const t of result.rows) {
        const cashIn = isCashIn(t.transaction_type);
        const amount = parseFloat(t.amount);

        // Line A — always Cash and Bank, attributed to this transaction's
        // own account.
        lines.push({
            date:          toDateStr(t.value_date),
            glAccountId:   cashAccount.id,
            accountId:     t.account_id,
            debit:         cashIn ? amount : 0,
            credit:        cashIn ? 0 : amount,
            description:   t.description,
            referenceCode: t.reference_code,
            categoryTrail: t.category_trail,
            sourceType:    'TRANSACTION',
            sourceId:      t.id,
        });

        // Line B — the other side, from the mapping table, with the
        // one investment_id override described in this file's header.
        let lineBGlAccountId = mappingByInflowType.get(t.inflow_type);
        if (t.inflow_type === 'EXPENSE' && t.investment_id) {
            lineBGlAccountId = investmentOverrideAccount.id;
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
            description:   t.description,
            referenceCode: t.reference_code,
            categoryTrail: t.category_trail,
            sourceType:    'TRANSACTION',
            sourceId:      t.id,
        });
    }
    return { lines, accountsById };
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
// ============================================================
const getGrantRecognitionLines = async ({ fromDate, toDate }) => {
    const { accounts } = await getChartOfAccounts();
    const deferredGl  = accounts.find(a => a.code === '2300');
    const recognizedGl = accounts.find(a => a.code === '4200');

    const grantsResult = await query(`
        SELECT g.id, g.title, g.is_conditional,
               (SELECT COUNT(*) FROM grant_conditions gc WHERE gc.grant_id = g.id) AS condition_count,
               (SELECT COUNT(*) FROM grant_conditions gc WHERE gc.grant_id = g.id
                   AND gc.status NOT IN ('MET', 'WAIVED')) AS unresolved_count,
               (SELECT MAX(COALESCE(gc.met_at, gc.waived_at::date)) FROM grant_conditions gc
                   WHERE gc.grant_id = g.id) AS resolution_date
        FROM   grants g
    `);

    const tranchesResult = await query(`
        SELECT gt.id, gt.grant_id, gt.tranche_number, gt.amount, gt.received_date
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

            const amount = parseFloat(tr.amount);
            const desc = `Grant income recognized: "${g.title}" tranche #${tr.tranche_number}`;
            lines.push({ date: recognitionDate, glAccountId: deferredGl.id, accountId: null, debit: amount, credit: 0, description: desc, referenceCode: null, categoryTrail: null, sourceType: 'GRANT_RECOGNITION', sourceId: tr.id });
            lines.push({ date: recognitionDate, glAccountId: recognizedGl.id, accountId: null, debit: 0, credit: amount, description: desc, referenceCode: null, categoryTrail: null, sourceType: 'GRANT_RECOGNITION', sourceId: tr.id });
        }
    }
    return lines;
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
// ============================================================
const getAdvanceRecoveryLines = async ({ fromDate, toDate }) => {
    const { accounts } = await getChartOfAccounts();
    const receivableGl = accounts.find(a => a.code === '1200');
    const expenseGl    = accounts.find(a => a.code === '5300');

    const conditions = [`r.applied_at IS NOT NULL`];
    const params = [];
    if (fromDate) { params.push(fromDate); conditions.push(`r.applied_at::date >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   conditions.push(`r.applied_at::date <= $${params.length}`); }

    const result = await query(`
        SELECT r.id, r.amount, r.applied_at, smp.period
        FROM   service_fee_advance_recoveries r
        JOIN   service_fee_monthly_periods smp ON smp.id = r.period_id
        WHERE  ${conditions.join(' AND ')}
        ORDER  BY r.applied_at ASC
    `, params);

    const lines = [];
    for (const rec of result.rows) {
        const amount = parseFloat(rec.amount);
        const date = toDateStr(rec.applied_at);
        const desc = `Service fee advance recovery applied to ${rec.period}`;
        lines.push({ date, glAccountId: expenseGl.id, accountId: null, debit: amount, credit: 0, description: desc, referenceCode: null, categoryTrail: null, sourceType: 'ADVANCE_RECOVERY', sourceId: rec.id });
        lines.push({ date, glAccountId: receivableGl.id, accountId: null, debit: 0, credit: amount, description: desc, referenceCode: null, categoryTrail: null, sourceType: 'ADVANCE_RECOVERY', sourceId: rec.id });
    }
    return lines;
};

// ============================================================
// getLedgerLines — the single entry point every report below builds
// on. Non-cash adjusting entries are only included company-wide
// (accountId not set) since neither is attributable to one specific
// bank account.
// ============================================================
const getLedgerLines = async ({ accountId = null, fromDate = null, toDate = null } = {}) => {
    const { lines: txLines, accountsById } = await getTransactionLedgerLines({ accountId, fromDate, toDate });
    let lines = txLines;
    if (!accountId) {
        const [grantLines, recoveryLines] = await Promise.all([
            getGrantRecognitionLines({ fromDate, toDate }),
            getAdvanceRecoveryLines({ fromDate, toDate }),
        ]);
        lines = lines.concat(grantLines, recoveryLines);
    }
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { lines, accountsById };
};

// ============================================================
// TRIAL BALANCE — cumulative since inception through asOfDate.
// ============================================================
const computeTrialBalance = async ({ accountId = null, asOfDate = null } = {}) => {
    const { accounts } = await getChartOfAccounts();
    const { lines } = await getLedgerLines({ accountId, toDate: asOfDate });

    const totalsByGl = new Map();
    for (const line of lines) {
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

    return { asOfDate, accountId, rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
};

// ============================================================
// GENERAL LEDGER — full line-by-line detail, optionally for one
// gl_account, with a running balance.
// ============================================================
const computeGeneralLedger = async ({ glAccountId = null, accountId = null, fromDate = null, toDate = null } = {}) => {
    const { accounts } = await getChartOfAccounts();
    const { lines } = await getLedgerLines({ accountId, fromDate, toDate });

    // glAccountId may arrive as a string from a query param — accounts[].id
    // is a plain JS number (from a SERIAL column), so this must be
    // coerced before the strict-equality filter below, or "?glAccountId=5"
    // would silently match nothing at all.
    const glAccountIdNum = glAccountId !== null ? parseInt(glAccountId) : null;
    const targetAccounts = glAccountIdNum ? accounts.filter(a => a.id === glAccountIdNum) : accounts;
    const sections = [];
    for (const acc of targetAccounts) {
        const accLines = lines.filter(l => l.glAccountId === acc.id);
        if (accLines.length === 0 && glAccountIdNum === null) continue; // skip untouched accounts in the "all accounts" view
        let running = 0;
        const detail = accLines.map(l => {
            running += acc.normal_balance === 'DEBIT' ? (l.debit - l.credit) : (l.credit - l.debit);
            return {
                date: l.date, description: l.description, referenceCode: l.referenceCode,
                categoryTrail: l.categoryTrail, sourceType: l.sourceType,
                debit: round2(l.debit), credit: round2(l.credit), runningBalance: round2(running),
            };
        });
        sections.push({
            code: acc.code, name: acc.name, accountType: acc.account_type,
            lines: detail, endingBalance: round2(running),
        });
    }
    return { glAccountId, accountId, fromDate, toDate, sections };
};

// ============================================================
// BALANCE SHEET — as of a single date, cumulative since inception.
// ============================================================
const computeBalanceSheet = async ({ accountId = null, asOfDate } = {}) => {
    const trialBalance = await computeTrialBalance({ accountId, asOfDate });
    const byType = { ASSET: [], LIABILITY: [], EQUITY: [], REVENUE: [], EXPENSE: [] };
    for (const row of trialBalance.rows) byType[row.accountType].push(row);

    const sum = (rows) => round2(rows.reduce((s, r) => s + r.balance, 0));
    const totalAssets = sum(byType.ASSET);
    const totalLiabilities = sum(byType.LIABILITY);
    const contributedEquity = sum(byType.EQUITY);
    const totalRevenue = sum(byType.REVENUE);
    const totalExpenses = sum(byType.EXPENSE);
    const netIncomeToDate = round2(totalRevenue - totalExpenses);
    const totalEquity = round2(contributedEquity + netIncomeToDate);
    const check = round2(totalAssets - (totalLiabilities + totalEquity));

    // Cross-check: the ledger-derived cash position (1000 + 1050)
    // should exactly match accounts.current_balance for the same
    // scope — a real, independent verification of this whole engine,
    // shown on the report itself rather than only in a test suite.
    const ledgerCash = round2(
        byType.ASSET.filter(r => r.code === '1000' || r.code === '1050').reduce((s, r) => s + r.balance, 0)
    );
    // current_balance is the account's LIVE balance, not "as of a past
    // date" — this cross-check is only meaningful when asOfDate is
    // today (or left blank), which reportsController defaults to.
    const accountFilter = accountId ? 'AND id = $1' : '';
    const accountsResult = await query(`
        SELECT COALESCE(SUM(current_balance), 0) AS total
        FROM   accounts
        WHERE  is_active = TRUE ${accountFilter}
    `, accountId ? [accountId] : []);
    const actualCash = round2(parseFloat(accountsResult.rows[0].total));

    return {
        asOfDate, accountId,
        assets: byType.ASSET, liabilities: byType.LIABILITY, equity: byType.EQUITY,
        totalAssets, totalLiabilities, contributedEquity, netIncomeToDate, totalEquity,
        balanced: Math.abs(check) < 0.01, difference: check,
        cashReconciliation: { ledgerCash, actualCash, matches: Math.abs(ledgerCash - actualCash) < 0.01 },
    };
};

// ============================================================
// INCOME STATEMENT (Profit & Loss) — for a date range.
// ============================================================
const computeIncomeStatement = async ({ accountId = null, fromDate, toDate } = {}) => {
    const { lines } = await getLedgerLines({ accountId, fromDate, toDate });
    const { accounts } = await getChartOfAccounts();
    const accountsById = new Map(accounts.map(a => [a.id, a]));

    const totalsByGl = new Map();
    for (const line of lines) {
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
    revenue.sort((a, b) => a.code.localeCompare(b.code));
    expenses.sort((a, b) => a.code.localeCompare(b.code));

    const totalRevenue = round2(revenue.reduce((s, r) => s + r.amount, 0));
    const totalExpenses = round2(expenses.reduce((s, r) => s + r.amount, 0));
    return { accountId, fromDate, toDate, revenue, expenses, totalRevenue, totalExpenses, netIncome: round2(totalRevenue - totalExpenses) };
};

// ============================================================
// CASH FLOW STATEMENT (Direct Method) — for a date range. Only real
// transactions ever move cash, so this deliberately does NOT include
// the two non-cash adjusting entries above.
// ============================================================
const computeCashFlowStatement = async ({ accountId = null, fromDate, toDate } = {}) => {
    const { lines: txLines } = await getTransactionLedgerLines({ accountId, fromDate, toDate });
    const { accounts } = await getChartOfAccounts();
    const accountsById = new Map(accounts.map(a => [a.id, a]));

    // Walk the lines two at a time (Line A, Line B) — Line A's net cash
    // impact is what actually moved; Line B's gl_account tells us which
    // cash flow category it belongs to.
    const byCategory = { OPERATING: 0, INVESTING: 0, FINANCING: 0 };
    let internalTransfersNet = 0;
    for (let i = 0; i < txLines.length; i += 2) {
        const lineA = txLines[i];
        const lineB = txLines[i + 1];
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

    // Cross-check against the ledger's own cash balances at the two
    // endpoints of the range.
    const [openingBS, closingBS] = await Promise.all([
        fromDate ? computeCashPositionBefore({ accountId, date: fromDate }) : Promise.resolve(0),
        computeCashPositionThrough({ accountId, date: toDate }),
    ]);
    const expectedChange = round2(closingBS - openingBS);

    return {
        accountId, fromDate, toDate,
        operatingNet, investingNet, financingNet, netChangeInCash,
        internalTransfersNet: round2(internalTransfersNet),
        openingCash: round2(openingBS), closingCash: round2(closingBS), expectedChange,
        reconciles: Math.abs(expectedChange - netChangeInCash) < 0.01,
    };
};

// Cash balance (1000 + 1050) as of a date, cumulative since inception
// — used only for the Cash Flow Statement's own cross-check above.
const computeCashPositionThrough = async ({ accountId, date }) => {
    const { lines } = await getLedgerLines({ accountId, toDate: date });
    const { accounts } = await getChartOfAccounts();
    const cashIds = new Set(accounts.filter(a => a.code === '1000' || a.code === '1050').map(a => a.id));
    return lines.filter(l => cashIds.has(l.glAccountId)).reduce((s, l) => s + (l.debit - l.credit), 0);
};
const computeCashPositionBefore = async ({ accountId, date }) => {
    // "Before fromDate" = cumulative through the day before it. Uses
    // UTC methods throughout — an ISO date-only string like
    // '2026-01-01' parses as UTC midnight, so subtracting a day with
    // LOCAL-time setDate()/getDate() can land on the wrong calendar
    // day depending on the server's timezone offset.
    const d = new Date(`${toDateStr(date)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const before = d.toISOString().split('T')[0];
    return computeCashPositionThrough({ accountId, date: before });
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

module.exports = {
    getChartOfAccounts,
    updateInflowTypeMapping,
    getLedgerLines,
    computeTrialBalance,
    computeGeneralLedger,
    computeBalanceSheet,
    computeIncomeStatement,
    computeCashFlowStatement,
};
