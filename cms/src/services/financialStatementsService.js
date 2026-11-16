// ============================================================
// FINANCIAL STATEMENTS PACK (v1.88.0)
// "now i would like to finish the financial statements and books and i
//  would like to them be downlaodable with the notes" (13 Nov 2026).
// Confirmed contents: Statement of Changes in Equity; notes (accounting
// policies + a note behind each figure, wording editable); a comparative
// year with the current / non-current split; directors' report and an
// approval page; downloadable as PDF and Excel.
//
// WHERE THE FIGURES COME FROM — nowhere new. Every amount is taken from
// glService (the same Trial Balance, Balance Sheet, Income Statement and
// Cash Flow Statement shown on the General Ledger page), in the
// functional currency (UGX), so the pack can never disagree with them.
// Only the WORDING of the notes is stored (fs_notes), never a figure.
//
// ROUNDING — the pack is presented in whole shillings. Each line is
// rounded and every total is the sum of the rounded lines shown, so
// every column visibly adds up. Retained earnings on the Statement of
// Financial Position is the figure that makes it balance (it differs from
// the unrounded retained earnings by a few shillings at most — checked
// below and reported if it ever differs by more).
//
// The financial year comes from company_settings.fiscal_year_start_month
// (7 = 1 July – 30 June). A year is named by the year it ENDS in:
// 2026 = 1 Jul 2025 – 30 Jun 2026, shown as "2025/26".
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const glService = require('./glService');
const fxService = require('./fxService');

const { BASIS } = glService;

// Accounts not listed are CURRENT (due / realisable within 12 months).
const DEFAULT_CLASSIFICATION = {
    1400: 'NON_CURRENT', // Other investments (projects & bonds)
    2000: 'NON_CURRENT', // Loans payable (received)
    2200: 'NON_CURRENT', // Member deposits payable
};

// Who may edit the wording / settings, and who approves.
const EDITOR_ROLES = ['Admin', 'Treasurer', 'Assistant Treasurer'];
const APPROVER_ROLE = 'Director';

const r0 = (n) => Math.round(Number(n) || 0);
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
};
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

// ------------------------------------------------------------
// Financial years
// ------------------------------------------------------------
const getStartMonth = async () => {
    const r = await query('SELECT fiscal_year_start_month FROM company_settings WHERE id = 1');
    return (r.rows[0] && Number(r.rows[0].fiscal_year_start_month)) || 7;
};

const yearBounds = (endYear, startMonth) => {
    if (startMonth === 1) {
        return { endYear, start: `${endYear}-01-01`, end: `${endYear}-12-31`, label: String(endYear) };
    }
    const endMonth = startMonth - 1;
    return {
        endYear,
        start: `${endYear - 1}-${pad(startMonth)}-01`,
        end: `${endYear}-${pad(endMonth)}-${pad(lastDayOfMonth(endYear, endMonth))}`,
        label: `${endYear - 1}/${String(endYear).slice(2)}`,
    };
};

const endYearOf = (dateStr, startMonth) => {
    const [y, m] = dateStr.split('-').map(Number);
    return startMonth === 1 ? y : (m >= startMonth ? y + 1 : y);
};

// The years that have any transaction, plus the current one.
const listYears = async () => {
    const startMonth = await getStartMonth();
    const today = fxService.todayStr();
    const r = await query('SELECT MIN(value_date) AS first FROM transactions');
    const first = r.rows[0] && r.rows[0].first ? fxService.toDateStr(r.rows[0].first) : today;
    const firstYear = endYearOf(first, startMonth);
    const currentYear = endYearOf(today, startMonth);
    const years = [];
    for (let y = currentYear; y >= firstYear; y--) {
        const b = yearBounds(y, startMonth);
        years.push({ ...b, inProgress: b.end >= today });
    }
    const latestComplete = years.find(y => !y.inProgress);
    return { startMonth, years, defaultYear: (latestComplete || years[0]).endYear };
};

// ------------------------------------------------------------
// Settings and wording
// ------------------------------------------------------------
let tablesSeen = false;
const tablesReady = async () => {
    if (tablesSeen) return true;
    const r = await query("SELECT to_regclass('public.fs_notes') AS n, to_regclass('public.fs_approvals') AS a, to_regclass('public.fs_pack_settings') AS s");
    tablesSeen = !!(r.rows[0].n && r.rows[0].a && r.rows[0].s);
    return tablesSeen;
};

const getPackSettings = async () => {
    const base = { classification: { ...DEFAULT_CLASSIFICATION }, auditors: '', bankers: '', lawyers: '', approvals_required: 2 };
    if (!(await tablesReady())) return { ...base, ready: false };
    const r = await query('SELECT classification, auditors, bankers, lawyers, approvals_required, updated_at FROM fs_pack_settings WHERE id = 1');
    const row = r.rows[0] || {};
    return {
        ready: true,
        classification: { ...DEFAULT_CLASSIFICATION, ...(row.classification || {}) },
        auditors: row.auditors || '', bankers: row.bankers || '', lawyers: row.lawyers || '',
        approvals_required: row.approvals_required || 2,
        updated_at: row.updated_at || null,
    };
};

// The standard wording. {placeholders} are filled in from the figures
// (see fillPlaceholders). Each can be changed per year from the pack.
const TEXT_SECTIONS = [
    // Directors' report
    { key: 'dr_intro', group: 'Directors’ report', title: 'Opening paragraph',
        text: 'The directors submit their report together with the financial statements of {company} for the year ended {year_end}, which disclose the state of affairs of the company.' },
    { key: 'dr_activities', group: 'Directors’ report', title: 'Principal activities',
        text: 'The principal activity of the company is to pool capital contributed by its shareholders and to invest it in projects, government securities, money market funds and other opportunities for the benefit of its members.' },
    { key: 'dr_results', group: 'Directors’ report', title: 'Results',
        text: 'The results for the year are set out in the statement of profit or loss and other comprehensive income. The {profit_word} for the year of {currency} {profit} has been {profit_verb} retained earnings.' },
    { key: 'dr_dividends', group: 'Directors’ report', title: 'Dividends',
        text: 'The directors do not recommend the payment of a dividend for the year.' },
    { key: 'dr_auditors', group: 'Directors’ report', title: 'Auditors',
        text: '{auditors_sentence}' },
    { key: 'responsibilities', group: 'Directors’ responsibilities', title: 'Statement of directors’ responsibilities',
        text: 'The Companies Act, 2012 of Uganda requires the directors to prepare financial statements for each financial year that give a true and fair view of the state of affairs of the company as at the end of the financial year and of its profit or loss for that year. It also requires the directors to ensure that the company keeps proper books of account that disclose, with reasonable accuracy, the financial position of the company.\n\nThe directors are responsible for safeguarding the assets of the company and for preparing financial statements in accordance with the International Financial Reporting Standard for Small and Medium-sized Entities (IFRS for SMEs) and the requirements of the Companies Act, 2012. This includes designing, implementing and maintaining internal control relevant to the preparation of financial statements that are free from material misstatement, whether due to fraud or error, selecting appropriate accounting policies, and making accounting estimates that are reasonable in the circumstances.\n\nThe directors accept responsibility for the financial statements, which have been prepared using appropriate accounting policies supported by reasonable and prudent judgements and estimates. Nothing has come to the attention of the directors to indicate that the company will not remain a going concern for at least twelve months from the date of this statement.' },
    // Notes — general
    { key: 'general_info', group: 'Notes — general', title: '1. General information',
        text: '{company} is a private limited liability company incorporated and domiciled in Uganda under the Companies Act, 2012{registration_sentence}. Its registered office is {registered_office}.' },
    { key: 'basis_of_preparation', group: 'Notes — general', title: '2. Basis of preparation',
        text: 'These financial statements have been prepared in accordance with the International Financial Reporting Standard for Small and Medium-sized Entities (IFRS for SMEs) issued by the International Accounting Standards Board, under the historical cost convention. They are presented in Uganda Shillings ({currency}), the company’s functional currency, rounded to the nearest shilling. The comparative figures are for the year ended {prior_year_end}.' },
    { key: 'policy_revenue', group: 'Notes — accounting policies', title: 'Income',
        text: 'Interest and investment income are recognised as they are earned. Coupons on government bonds and the discount on treasury bills are recognised as investment income; tax withheld at source is shown under income tax. Grants are recognised as income when the conditions attached to them are met; until then they are shown as deferred grant income. Fines and side-fund dues are recognised when they are charged.' },
    { key: 'policy_fx', group: 'Notes — accounting policies', title: 'Foreign currencies',
        text: 'Transactions in foreign currencies (mainly Euro) are translated into Uganda Shillings at the rate on the day of the transaction, using the Bank of Uganda rate approved in the system. At each month end, cash and other monetary balances in foreign currencies are translated at the closing rate, and the resulting differences are recognised in profit or loss as unrealised exchange gains or losses. Gains or losses on converting money between currencies are recognised as realised exchange differences. Exchange differences are presented net.' },
    { key: 'policy_investments', group: 'Notes — accounting policies', title: 'Investments',
        text: 'Investments in projects, bonds and treasury bills are measured at cost, including the costs of buying or expanding them. Running and maintenance costs are expensed as they are incurred. Money market fund units are measured at the amounts invested plus income reinvested. A gain or loss is recognised when an investment is closed or disposed of.' },
    { key: 'policy_financial_instruments', group: 'Notes — accounting policies', title: 'Loans, receivables and payables',
        text: 'Loans given, service fee advances and other receivables are measured at the amounts outstanding less any amounts not expected to be recovered. Loans received, members’ savings and deposits and other payables are measured at the amounts owed. Interest is recognised when it is paid or received.' },
    { key: 'policy_income_tax', group: 'Notes — accounting policies', title: 'Income tax',
        text: 'Income tax comprises tax withheld at source that is final, and current corporate income tax payable on the taxable income for the year under the Income Tax Act. Provisional tax paid and withholding tax recoverable are shown as assets until they are set off against the tax due for the year.' },
    { key: 'policy_share_capital', group: 'Notes — accounting policies', title: 'Share capital',
        text: 'Ordinary shares are classified as equity. Amounts received above the nominal value of the shares issued are shown as share premium. Capital received from members for shares not yet allotted is shown in equity as capital pending allotment. Dividends are recognised when they are declared.' },
    { key: 'policy_cash', group: 'Notes — accounting policies', title: 'Cash and cash equivalents',
        text: 'Cash and cash equivalents comprise balances on the company’s bank and mobile money accounts and money in transit between them.' },
    { key: 'going_concern', group: 'Notes — accounting policies', title: 'Going concern',
        text: 'The directors have assessed the company’s ability to continue as a going concern and are satisfied that it has the resources to continue in business for the foreseeable future. The financial statements have therefore been prepared on the going concern basis.' },
    // Notes behind the figures (shown under each table)
    { key: 'note_revenue', group: 'Notes to the figures', title: 'Income', text: '' },
    { key: 'note_expenses', group: 'Notes to the figures', title: 'Expenses', text: '' },
    { key: 'note_fx', group: 'Notes to the figures', title: 'Net foreign exchange gain / (loss)', text: '' },
    { key: 'note_tax', group: 'Notes to the figures', title: 'Income tax', text: '' },
    { key: 'note_cash', group: 'Notes to the figures', title: 'Cash and cash equivalents', text: '' },
    { key: 'note_investments', group: 'Notes to the figures', title: 'Investments', text: '' },
    { key: 'note_receivables', group: 'Notes to the figures', title: 'Loans, advances and tax receivable', text: '' },
    { key: 'note_liabilities', group: 'Notes to the figures', title: 'Liabilities', text: '' },
    { key: 'note_share_capital', group: 'Notes to the figures', title: 'Share capital', text: '' },
    { key: 'note_retained', group: 'Notes to the figures', title: 'Retained earnings', text: '' },
    { key: 'related_parties', group: 'Notes — other', title: 'Related party transactions',
        text: 'The company’s related parties are its directors and shareholders. Transactions with them during the year comprised capital contributions, savings and deposits, service fees and dividends, all on the terms applying to every member, and are included in the figures above.' },
    { key: 'events_after', group: 'Notes — other', title: 'Events after the reporting period',
        text: 'There have been no events after the end of the reporting period that require adjustment of, or disclosure in, these financial statements.' },
    { key: 'approval_text', group: 'Approval', title: 'Approval of the financial statements',
        text: 'The financial statements on the preceding pages were approved by the board of directors and signed on its behalf by:' },
];
const TEXT_KEYS = new Set(TEXT_SECTIONS.map(s => s.key));

const getTexts = async (endYear) => {
    if (!(await tablesReady())) return { saved: {}, updated_at: null, updated_by_name: null };
    const r = await query(`
        SELECT n.texts, n.updated_at, u.first_name || ' ' || u.last_name AS updated_by_name
        FROM   fs_notes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.fy_end_year = $1`, [endYear]);
    const row = r.rows[0];
    return { saved: (row && row.texts) || {}, updated_at: row ? row.updated_at : null, updated_by_name: row ? row.updated_by_name : null };
};

// ------------------------------------------------------------
// Building the figures
// ------------------------------------------------------------
const blockOf = (report) => (report && report.byCurrency && report.byCurrency[0]) || null;

// Balances of every GL code as at a date (functional currency).
const balancesAt = async (date) => {
    const bs = await glService.computeBalanceSheet({ asOfDate: date, basis: BASIS.FUNCTIONAL });
    const b = blockOf(bs);
    const byCode = new Map();
    if (b) for (const row of [...b.assets, ...b.liabilities, ...b.equity]) byCode.set(row.code, row.balance);
    return {
        byCode,
        netIncomeToDate: b ? b.netIncomeToDate : 0,
        totalAssets: b ? b.totalAssets : 0,
        totalLiabilities: b ? b.totalLiabilities : 0,
        totalEquity: b ? b.totalEquity : 0,
        balanced: b ? b.balanced : true,
        unconvertedCount: bs.meta ? bs.meta.unconvertedCount : 0,
    };
};

// Movements of each GL account within [from, to], from the ledger lines.
const movementsIn = (lines, from, to) => {
    const m = new Map();
    for (const l of lines) {
        if (l.date < from || l.date > to) continue;
        if (!m.has(l.glAccountId)) m.set(l.glAccountId, { debit: 0, credit: 0 });
        const t = m.get(l.glAccountId);
        t.debit += l.debit; t.credit += l.credit;
    }
    return m;
};

// Two-column (this year / last year) rows merged by code.
const mergeRows = (cur, prev) => {
    const map = new Map();
    for (const r of cur) map.set(r.code, { code: r.code, name: r.name, cur: r0(r.amount), prev: 0 });
    for (const r of prev) {
        if (!map.has(r.code)) map.set(r.code, { code: r.code, name: r.name, cur: 0, prev: 0 });
        map.get(r.code).prev = r0(r.amount);
    }
    return Array.from(map.values()).filter(r => r.cur !== 0 || r.prev !== 0).sort((a, b) => a.code.localeCompare(b.code));
};
const sumRows = (rows) => ({ cur: rows.reduce((s, r) => s + r.cur, 0), prev: rows.reduce((s, r) => s + r.prev, 0) });
const add = (...xs) => ({ cur: xs.reduce((s, x) => s + x.cur, 0), prev: xs.reduce((s, x) => s + x.prev, 0) });
const neg = (x) => ({ cur: -x.cur, prev: -x.prev });

// ------------------------------------------------------------
// The whole pack for one financial year
// ------------------------------------------------------------
const buildPack = async (endYearInput) => {
    const { startMonth, years } = await listYears();
    const endYear = Number(endYearInput) || null;
    const today = fxService.todayStr();
    if (!endYear) throw createError.badRequest('Choose a financial year.');
    const cy = yearBounds(endYear, startMonth);
    const py = yearBounds(endYear - 1, startMonth);
    const inProgress = cy.end >= today;
    const cyTo = inProgress ? today : cy.end;   // a year not finished yet: figures to today
    const openingDate = fxService.dayBefore(py.start);

    const [
        { accounts }, settings, company, directors, secretaries,
        balCur, balPrev, balOpen,
        isCur, isPrev, cfCur, cfPrev, ledger,
    ] = await Promise.all([
        glService.getChartOfAccounts(),
        getPackSettings(),
        query(`SELECT cs.*, cur.code AS functional_code
               FROM company_settings cs LEFT JOIN currencies cur ON cur.id = cs.functional_currency_id WHERE cs.id = 1`).then(r => r.rows[0] || {}),
        query(`SELECT DISTINCT u.id, u.first_name || ' ' || u.last_name AS name
               FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
               JOIN roles ro ON ro.id = ur.role_id AND ro.name = 'Director'
               WHERE u.is_active = TRUE ORDER BY 2`).then(r => r.rows),
        query(`SELECT DISTINCT u.id, u.first_name || ' ' || u.last_name AS name
               FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
               JOIN roles ro ON ro.id = ur.role_id AND ro.name = 'Secretary'
               WHERE u.is_active = TRUE ORDER BY 2`).then(r => r.rows),
        balancesAt(cyTo), balancesAt(py.end), balancesAt(openingDate),
        glService.computeIncomeStatement({ fromDate: cy.start, toDate: cyTo, basis: BASIS.FUNCTIONAL }),
        glService.computeIncomeStatement({ fromDate: py.start, toDate: py.end, basis: BASIS.FUNCTIONAL }),
        glService.computeCashFlowStatement({ fromDate: cy.start, toDate: cyTo, basis: BASIS.FUNCTIONAL }),
        glService.computeCashFlowStatement({ fromDate: py.start, toDate: py.end, basis: BASIS.FUNCTIONAL }),
        glService.getLedgerLines({ toDate: cyTo, basis: BASIS.FUNCTIONAL }),
    ]);

    const currency = company.functional_code || 'UGX';
    const accByCode = new Map(accounts.map(a => [a.code, a]));
    const accById = new Map(accounts.map(a => [a.id, a]));
    const cls = settings.classification;
    const warnings = [];
    if (balCur.unconvertedCount > 0) warnings.push(`${balCur.unconvertedCount} entr${balCur.unconvertedCount === 1 ? 'y has' : 'ies have'} no exchange rate and could not be converted to ${currency} — the figures are incomplete until a rate is approved for those dates (Accounts › FX).`);
    if (!balCur.balanced || !balPrev.balanced) warnings.push('The books do not balance at one of the dates — check the Trial Balance before relying on this pack.');

    // ---- Statement of financial position ----
    const balRow = (code, which) => r0((which === 'cur' ? balCur : balPrev).byCode.get(code) || 0);
    const codesOf = (type) => accounts.filter(a => a.account_type === type).map(a => a.code)
        .filter(c => balCur.byCode.has(c) || balPrev.byCode.has(c));
    const lineFor = (code) => {
        const a = accByCode.get(code);
        return { code, name: a ? a.name : code, cur: balRow(code, 'cur'), prev: balRow(code, 'prev') };
    };
    const nonZero = (r) => r.cur !== 0 || r.prev !== 0;
    const assetCodes = codesOf('ASSET');
    const liabCodes = codesOf('LIABILITY');
    const nonCurrentAssets = assetCodes.filter(c => cls[c] === 'NON_CURRENT').map(lineFor).filter(nonZero);
    const currentAssets = assetCodes.filter(c => cls[c] !== 'NON_CURRENT').map(lineFor).filter(nonZero);
    const nonCurrentLiabilities = liabCodes.filter(c => cls[c] === 'NON_CURRENT').map(lineFor).filter(nonZero);
    const currentLiabilities = liabCodes.filter(c => cls[c] !== 'NON_CURRENT').map(lineFor).filter(nonZero);
    const tNCA = sumRows(nonCurrentAssets); const tCA = sumRows(currentAssets);
    const totalAssets = add(tNCA, tCA);
    const tNCL = sumRows(nonCurrentLiabilities); const tCL = sumRows(currentLiabilities);
    const totalLiabilities = add(tNCL, tCL);

    const EQUITY_NAMES = { 3000: 'Share capital', 3010: 'Share premium', 3020: 'Capital pending allotment' };
    const equityCodes = codesOf('EQUITY').filter(c => c !== '3100');
    const equityRows = equityCodes.map(c => ({ ...lineFor(c), name: EQUITY_NAMES[c] || lineFor(c).name })).filter(nonZero);
    const otherEquity = sumRows(equityRows);
    // Retained earnings = what makes the rounded statement balance.
    const reExact = {
        cur: (balCur.byCode.get('3100') || 0) + balCur.netIncomeToDate,
        prev: (balPrev.byCode.get('3100') || 0) + balPrev.netIncomeToDate,
    };
    const retained = { code: 'RE', name: 'Retained earnings', cur: totalAssets.cur - totalLiabilities.cur - otherEquity.cur, prev: totalAssets.prev - totalLiabilities.prev - otherEquity.prev };
    for (const k of ['cur', 'prev']) {
        if (Math.abs(retained[k] - reExact[k]) > 10) warnings.push(`Retained earnings differ from the books by ${Math.round(retained[k] - reExact[k])} ${currency} (${k === 'cur' ? 'this year' : 'last year'}) — more than rounding explains. Check that the Trial Balance balances.`);
    }
    const equityAll = [...equityRows, retained];
    const totalEquity = sumRows(equityAll);

    const sofp = {
        nonCurrentAssets, currentAssets, totalNonCurrentAssets: tNCA, totalCurrentAssets: tCA, totalAssets,
        equity: equityAll, totalEquity,
        nonCurrentLiabilities, currentLiabilities, totalNonCurrentLiabilities: tNCL, totalCurrentLiabilities: tCL,
        totalLiabilities, totalEquityAndLiabilities: add(totalEquity, totalLiabilities),
    };

    // ---- Profit or loss ----
    const ic = blockOf(isCur) || { revenue: [], expenses: [], incomeTax: [], fxDetail: null };
    const ip = blockOf(isPrev) || { revenue: [], expenses: [], incomeTax: [], fxDetail: null };
    const revenue = mergeRows(ic.revenue, ip.revenue);
    const expenses = mergeRows(ic.expenses, ip.expenses);
    const incomeTax = mergeRows(ic.incomeTax, ip.incomeTax);
    const totalRevenue = sumRows(revenue);
    const totalExpenses = sumRows(expenses);
    const profitBeforeTax = add(totalRevenue, neg(totalExpenses));
    const totalIncomeTax = sumRows(incomeTax);
    const profit = add(profitBeforeTax, neg(totalIncomeTax));
    const pl = { revenue, totalRevenue, expenses, totalExpenses, profitBeforeTax, incomeTax, totalIncomeTax, profit };

    // ---- Changes in equity (columns = the equity lines) ----
    const opening = { byCode: balOpen.byCode, re: (balOpen.byCode.get('3100') || 0) + balOpen.netIncomeToDate };
    const cols = [...equityCodes.filter(c => equityRows.some(r => r.code === c) || r0(opening.byCode.get(c) || 0) !== 0)
        .map(c => ({ key: c, name: EQUITY_NAMES[c] || (accByCode.get(c) || {}).name || c })), { key: 'RE', name: 'Retained earnings' }];
    const at = (which) => {
        const o = {};
        for (const c of cols) {
            if (c.key === 'RE') continue;
            o[c.key] = which === 'open' ? r0(opening.byCode.get(c.key) || 0) : (equityRows.find(r => r.code === c.key) || { cur: 0, prev: 0 })[which];
        }
        return o;
    };
    const openVals = at('open');
    // Opening retained earnings: rounded so that the opening position balances too.
    const openTotals = {
        assets: assetCodes.reduce((s, c) => s + r0(balOpen.byCode.get(c) || 0), 0),
        liabilities: liabCodes.reduce((s, c) => s + r0(balOpen.byCode.get(c) || 0), 0),
    };
    openVals.RE = openTotals.assets - openTotals.liabilities - Object.values(openVals).reduce((s, v) => s + v, 0);
    const prevVals = { ...at('prev'), RE: retained.prev };
    const curVals = { ...at('cur'), RE: retained.cur };
    const rowTotal = (o) => Object.values(o).reduce((s, v) => s + v, 0);
    const movement = (from, to, profitAmt) => {
        const issued = {}; const dividends = {}; const profitRow = {};
        for (const c of cols) {
            if (c.key === 'RE') {
                profitRow.RE = profitAmt; issued.RE = 0;
                dividends.RE = to.RE - from.RE - profitAmt;
            } else {
                profitRow[c.key] = 0; dividends[c.key] = 0;
                issued[c.key] = to[c.key] - from[c.key];
            }
        }
        return { profitRow, issued, dividends };
    };
    const mPrev = movement(openVals, prevVals, profit.prev);
    const mCur = movement(prevVals, curVals, profit.cur);
    const soceRow = (label, values, strong = false) => ({ label, values, total: rowTotal(values), strong });
    const soce = {
        columns: cols,
        rows: [
            soceRow(`Balance at ${longDate(openingDate)}`, openVals, true),
            soceRow('Profit / (loss) for the year', mPrev.profitRow),
            soceRow('Capital received and shares issued', mPrev.issued),
            soceRow('Dividends and other movements', mPrev.dividends),
            soceRow(`Balance at ${longDate(py.end)}`, prevVals, true),
            soceRow('Profit / (loss) for the year', mCur.profitRow),
            soceRow('Capital received and shares issued', mCur.issued),
            soceRow('Dividends and other movements', mCur.dividends),
            soceRow(`Balance at ${longDate(cyTo)}`, curVals, true),
        ],
    };

    // ---- Cash flows, with the detail behind each section ----
    const cf = (rep) => {
        const b = blockOf(rep);
        return b ? {
            operating: r0(b.operatingNet), investing: r0(b.investingNet), financing: r0(b.financingNet),
            fx: r0(b.fxEffectOnCash), opening: r0(b.openingCash), closing: r0(b.closingCash), reconciles: b.reconciles,
        } : { operating: 0, investing: 0, financing: 0, fx: 0, opening: 0, closing: 0, reconciles: true };
    };
    const cfc = cf(cfCur); const cfp = cf(cfPrev);
    const cashIds = new Set(accounts.filter(a => a.code === '1000' || a.code === '1050').map(a => a.id));
    const cfDetail = (from, to) => {
        // Line A (cash) paired with line B (the other side) per transaction,
        // grouped by line B's account — the same pairing glService uses.
        const pairs = new Map();
        for (const l of ledger.lines) {
            if (l.sourceType !== 'TRANSACTION' || l.date < from || l.date > to) continue;
            if (!pairs.has(l.sourceId)) pairs.set(l.sourceId, {});
            pairs.get(l.sourceId)[l.lineRole] = l;
        }
        const out = { OPERATING: new Map(), INVESTING: new Map(), FINANCING: new Map() };
        for (const p of pairs.values()) {
            if (!p.A || !p.B) continue;
            const gb = accById.get(p.B.glAccountId);
            if (!gb || !out[gb.cash_flow_category]) continue;
            const net = p.A.debit - p.A.credit;
            const key = `${gb.code}|${net >= 0 ? 'in' : 'out'}`;
            const m = out[gb.cash_flow_category];
            if (!m.has(key)) m.set(key, { code: gb.code, name: gb.name, dir: net >= 0 ? 'in' : 'out', amount: 0 });
            m.get(key).amount += net;
        }
        return out;
    };
    const dC = cfDetail(cy.start, cyTo); const dP = cfDetail(py.start, py.end);
    // Plain names for the usual lines (others: "Received / Paid — account").
    const CF_LABELS = {
        '3000|in': 'Capital contributed by shareholders', '3010|in': 'Share premium received', '3020|in': 'Capital contributed by shareholders',
        '3000|out': 'Capital refunded to shareholders', '3020|out': 'Capital refunded to shareholders', '3100|out': 'Dividends paid',
        '2000|in': 'Loans received', '2000|out': 'Loans repaid',
        '1100|out': 'Loans given', '1100|in': 'Repayments of loans given',
        '1300|out': 'Money placed in money market funds', '1300|in': 'Withdrawals from money market funds',
        '1400|out': 'Investments made (buying and expanding)', '1400|in': 'Money returned from investments',
        '4000|in': 'Interest received', '4100|in': 'Investment income received', '4200|in': 'Grants received',
        '5000|out': 'Operating expenses paid', '5100|out': 'Interest paid', '5300|out': 'Service fees paid',
    };
    const cfSection = (cat, totalCur, totalPrev) => {
        const keys = new Set([...dC[cat].keys(), ...dP[cat].keys()]);
        const rows = Array.from(keys).map(k => {
            const c = dC[cat].get(k); const p = dP[cat].get(k); const base = c || p;
            const label = CF_LABELS[k] || `${base.dir === 'in' ? 'Received' : 'Paid'} — ${base.name}`;
            return { code: base.code, name: label, cur: r0(c ? c.amount : 0), prev: r0(p ? p.amount : 0) };
        }).filter(nonZero).sort((a, b) => (a.code + a.name).localeCompare(b.code + b.name));
        // Rounding: the lines must add up to the section total shown.
        const s = sumRows(rows);
        const diff = { cur: totalCur - s.cur, prev: totalPrev - s.prev };
        if (diff.cur !== 0 || diff.prev !== 0) {
            if (Math.abs(diff.cur) <= rows.length + 1 && Math.abs(diff.prev) <= rows.length + 1 && rows.length) {
                rows[0].cur += diff.cur; rows[0].prev += diff.prev;
            } else if (rows.length || diff.cur || diff.prev) {
                rows.push({ code: '', name: 'Other', cur: diff.cur, prev: diff.prev });
            }
        }
        return { rows, total: { cur: totalCur, prev: totalPrev } };
    };
    const cashFlows = {
        operating: cfSection('OPERATING', cfc.operating, cfp.operating),
        investing: cfSection('INVESTING', cfc.investing, cfp.investing),
        financing: cfSection('FINANCING', cfc.financing, cfp.financing),
    };
    cashFlows.netChange = { cur: cfc.operating + cfc.investing + cfc.financing, prev: cfp.operating + cfp.investing + cfp.financing };
    cashFlows.fxEffect = { cur: cfc.fx, prev: cfp.fx };
    cashFlows.opening = { cur: cfc.opening, prev: cfp.opening };
    // Closing = opening + movements, so the column always adds up; it is
    // checked against the cash on the statement of financial position.
    cashFlows.closing = { cur: cfc.opening + cashFlows.netChange.cur + cfc.fx, prev: cfp.opening + cashFlows.netChange.prev + cfp.fx };
    const sofpCash = { cur: balRow('1000', 'cur') + balRow('1050', 'cur'), prev: balRow('1000', 'prev') + balRow('1050', 'prev') };
    for (const k of ['cur', 'prev']) {
        if (Math.abs(cashFlows.closing[k] - sofpCash[k]) > 5) {
            warnings.push(`The cash flow statement ends at ${cashFlows.closing[k]} but cash on the statement of financial position is ${sofpCash[k]} (${k === 'cur' ? 'this year' : 'last year'}). Check Accounts › FX for months not yet revalued.`);
        }
    }
    if (!cfc.reconciles || !cfp.reconciles) warnings.push('The cash flow statement does not reconcile to the cash balances for one of the years (see the Cash Flow tab).');

    // ---- Notes behind the figures ----
    const curMov = movementsIn(ledger.lines, cy.start, cyTo);
    const prevMov = movementsIn(ledger.lines, py.start, py.end);
    const recon = (code) => {
        const a = accByCode.get(code);
        if (!a) return null;
        const debitNormal = a.normal_balance === 'DEBIT';
        const mk = (mov, openBal, closeBal) => {
            const t = mov.get(a.id) || { debit: 0, credit: 0 };
            const inc = r0(debitNormal ? t.debit : t.credit);
            const dec = r0(debitNormal ? t.credit : t.debit);
            const o = r0(openBal); const c = r0(closeBal);
            // closing = opening + increases − decreases; rounding goes to decreases
            return { opening: o, increases: inc, decreases: o + inc - c, closing: c };
        };
        return {
            code, name: a.name,
            cur: mk(curMov, balPrev.byCode.get(code) || 0, balCur.byCode.get(code) || 0),
            prev: mk(prevMov, balOpen.byCode.get(code) || 0, balPrev.byCode.get(code) || 0),
        };
    };
    const reconFor = (codes) => codes.map(recon).filter(x => x && [x.cur, x.prev].some(y => y.opening || y.increases || y.decreases || y.closing));

    // Cash by account, balance at each year end (from the ledger lines).
    const companyAccounts = await query(`SELECT a.id, a.name, a.bank_name, cur.code AS currency_code FROM accounts a JOIN currencies cur ON cur.id = a.currency_id`);
    const accName = new Map(companyAccounts.rows.map(a => [a.id, `${a.name}${a.bank_name ? ` — ${a.bank_name}` : ''} (${a.currency_code})`]));
    const balanceBy = (filter, keyOf, to) => {
        const m = new Map();
        for (const l of ledger.lines) {
            if (l.date > to || !filter(l)) continue;
            const k = keyOf(l);
            m.set(k, (m.get(k) || 0) + (l.debit - l.credit));
        }
        return m;
    };
    const twoCols = (mc, mp, nameOf, totals) => {
        const keys = new Set([...mc.keys(), ...mp.keys()]);
        const rows = Array.from(keys).map(k => ({ name: nameOf(k), cur: r0(mc.get(k) || 0), prev: r0(mp.get(k) || 0) })).filter(nonZero)
            .sort((a, b) => a.name.localeCompare(b.name));
        // rounding into the largest line so the breakdown adds up to the statement
        const s = sumRows(rows);
        for (const k of ['cur', 'prev']) {
            const d = totals[k] - s[k];
            if (d !== 0 && rows.length) {
                const big = rows.reduce((x, y) => (Math.abs(y[k]) > Math.abs(x[k]) ? y : x));
                if (Math.abs(d) <= rows.length + 1) big[k] += d; else rows.push({ name: 'Other', cur: k === 'cur' ? d : 0, prev: k === 'prev' ? d : 0 });
            }
        }
        return rows;
    };
    const cashByAccount = twoCols(
        balanceBy(l => cashIds.has(l.glAccountId), l => l.accountId || 0, cyTo),
        balanceBy(l => cashIds.has(l.glAccountId), l => l.accountId || 0, py.end),
        k => (k ? (accName.get(k) || `Account #${k}`) : 'Money in transit between accounts'),
        sofpCash,
    );

    const invGl = new Set(accounts.filter(a => a.code === '1300' || a.code === '1400').map(a => a.id));
    const invNames = new Map((await query('SELECT id, name FROM investments')).rows.map(i => [i.id, i.name]));
    const invTotals = { cur: balRow('1300', 'cur') + balRow('1400', 'cur'), prev: balRow('1300', 'prev') + balRow('1400', 'prev') };
    const investmentsByName = twoCols(
        balanceBy(l => invGl.has(l.glAccountId), l => l.investmentId || 0, cyTo),
        balanceBy(l => invGl.has(l.glAccountId), l => l.investmentId || 0, py.end),
        k => (k ? (invNames.get(k) || `Investment #${k}`) : 'Not linked to a single investment'),
        invTotals,
    );

    // Expenses by category trail.
    const expenseIds = new Set(accounts.filter(a => a.account_type === 'EXPENSE' && a.statement_section !== 'INCOME_TAX' && !['5600', '5610'].includes(a.code)).map(a => a.id));
    const byTrail = (from, to) => {
        const m = new Map();
        for (const l of ledger.lines) {
            if (l.date < from || l.date > to || !expenseIds.has(l.glAccountId)) continue;
            const k = (l.categoryTrail || accById.get(l.glAccountId).name || 'Other').toString();
            m.set(k, (m.get(k) || 0) + (l.debit - l.credit));
        }
        return m;
    };
    const fxExpenseLine = expenses.find(r => r.code === '5600') || { cur: 0, prev: 0 };
    const expensesByCategory = twoCols(byTrail(cy.start, cyTo), byTrail(py.start, py.end), k => k,
        { cur: totalExpenses.cur - fxExpenseLine.cur, prev: totalExpenses.prev - fxExpenseLine.prev });

    let sharesInIssue = null;
    try {
        const reg = require('./registeredSharesService');
        const [c, p] = await Promise.all([reg.registeredAsOf(null, cyTo), reg.registeredAsOf(null, py.end)]);
        if (c.ready) sharesInIssue = { cur: c.total, prev: p.total };
    } catch (_) { sharesInIssue = null; }

    const fxOf = (b) => (b && b.fxDetail ? b.fxDetail : null);
    const fxD = { cur: fxOf(ic), prev: fxOf(ip) };
    const fxRows = [
        { name: 'Realised — money converted between currencies', cur: r0(fxD.cur ? fxD.cur.realised.net : 0), prev: r0(fxD.prev ? fxD.prev.realised.net : 0) },
        { name: 'Unrealised — balances held, revalued at month end', cur: r0(fxD.cur ? fxD.cur.unrealised.net : 0), prev: r0(fxD.prev ? fxD.prev.unrealised.net : 0) },
    ];
    const fxNet = {
        cur: (revenue.find(r => r.code === '4600') || { cur: 0 }).cur - fxExpenseLine.cur,
        prev: (revenue.find(r => r.code === '4600') || { prev: 0 }).prev - fxExpenseLine.prev,
    };
    for (const k of ['cur', 'prev']) { const d = fxNet[k] - fxRows[0][k] - fxRows[1][k]; fxRows[1][k] += d; }

    const notes = {
        revenue: { rows: revenue, total: totalRevenue },
        expenses: { rows: expenses, total: totalExpenses, byCategory: expensesByCategory },
        fx: { rows: fxRows, total: fxNet, any: !!(fxD.cur || fxD.prev) },
        tax: { rows: incomeTax, total: totalIncomeTax, reconciliation: reconFor(['1500', '1510', '2500', '2510']) },
        cash: { rows: cashByAccount, total: sofpCash },
        investments: { rows: investmentsByName, total: invTotals, reconciliation: reconFor(['1300', '1400']) },
        receivables: { reconciliation: reconFor(['1100', '1200']) },
        liabilities: { reconciliation: reconFor(liabCodes.filter(c => !['2500', '2510'].includes(c))) },
        shareCapital: { reconciliation: reconFor(equityCodes), sharesInIssue },
        retained: {
            rows: [
                { name: 'At the start of the year', cur: prevVals.RE, prev: openVals.RE },
                { name: 'Profit / (loss) for the year', cur: profit.cur, prev: profit.prev },
                { name: 'Dividends and other movements', cur: mCur.dividends.RE, prev: mPrev.dividends.RE },
            ],
            total: { cur: curVals.RE, prev: prevVals.RE },
        },
    };

    // ---- Wording, approvals, status ----
    const { saved, updated_at: textsUpdatedAt, updated_by_name: textsUpdatedBy } = await getTexts(endYear);
    const approvals = await getApprovals(endYear);
    const figures = keyFigures({ totalAssets, totalEquity, profit, totalLiabilities });
    const active = approvals.filter(a => !a.withdrawn_at);
    const changedSince = active.filter(a => !sameFigures(a.figures, figures));
    let status = 'DRAFT';
    if (inProgress) status = 'IN_PROGRESS';
    else if (active.length >= settings.approvals_required) status = changedSince.length ? 'CHANGED' : 'APPROVED';
    if (changedSince.length) warnings.unshift(`The books have changed since ${changedSince.map(a => a.name).join(' and ')} approved these statements — check the figures and ask the directors to approve them again.`);

    const ctx = {
        company: company.company_name || 'The company',
        registration_sentence: company.registration_number ? ` (registration number ${company.registration_number})` : '',
        registered_office: company.registered_office || company.company_address || 'in Uganda',
        currency,
        year_label: cy.label, year_start: longDate(cy.start), year_end: longDate(cyTo), prior_year_end: longDate(py.end),
        profit: Math.abs(profit.cur).toLocaleString('en-US'),
        profit_word: profit.cur >= 0 ? 'profit' : 'loss',
        profit_verb: profit.cur >= 0 ? 'added to' : 'charged against',
        total_assets: totalAssets.cur.toLocaleString('en-US'),
        net_assets: totalEquity.cur.toLocaleString('en-US'),
        auditors_sentence: settings.auditors
            ? `${settings.auditors} have expressed their willingness to continue in office.`
            : 'These financial statements have not been audited.',
    };
    const texts = TEXT_SECTIONS.map(s => {
        const raw = Object.prototype.hasOwnProperty.call(saved, s.key) ? saved[s.key] : s.text;
        return { key: s.key, group: s.group, title: s.title, raw, standard: s.text, changed: raw !== s.text, text: fillPlaceholders(raw, ctx) };
    });

    return {
        year: { ...cy, to: cyTo, inProgress }, prior: py, openingDate, startMonth,
        years: years.map(y => ({ endYear: y.endYear, label: y.label, inProgress: y.inProgress })),
        currency, status, warnings,
        company: {
            name: ctx.company, registration_number: company.registration_number || '', incorporation_date: company.incorporation_date ? fxService.toDateStr(company.incorporation_date) : '',
            tin: company.tin || '', registered_office: company.registered_office || company.company_address || '', postal_address: company.postal_address || '',
            email: company.company_email || '', phone: company.company_phone || '', logo_url: company.logo_url || '',
            primary_color: company.primary_color || '#1e3a5f',
            directors, secretaries, auditors: settings.auditors, bankers: settings.bankers, lawyers: settings.lawyers,
        },
        settings,
        sofp, pl, soce, cashFlows, notes,
        texts, textsUpdatedAt, textsUpdatedBy, placeholders: Object.keys(ctx),
        approvals, approvalsRequired: settings.approvals_required, figures,
    };
};

const keyFigures = ({ totalAssets, totalEquity, profit, totalLiabilities }) => ({
    total_assets: totalAssets.cur, total_liabilities: totalLiabilities.cur, total_equity: totalEquity.cur, profit: profit.cur,
});
const sameFigures = (a, b) => !!a && ['total_assets', 'total_liabilities', 'total_equity', 'profit'].every(k => Math.abs((Number(a[k]) || 0) - (Number(b[k]) || 0)) < 1);

const fillPlaceholders = (text, ctx) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k]) : m));

// ------------------------------------------------------------
// Approvals
// ------------------------------------------------------------
const getApprovals = async (endYear) => {
    if (!(await tablesReady())) return [];
    const r = await query(`
        SELECT a.id, a.user_id, u.first_name || ' ' || u.last_name AS name, a.approved_at, a.signature_snapshot_path,
               a.figures, a.withdrawn_at, a.withdrawn_reason, w.first_name || ' ' || w.last_name AS withdrawn_by_name
        FROM   fs_approvals a JOIN users u ON u.id = a.user_id LEFT JOIN users w ON w.id = a.withdrawn_by
        WHERE  a.fy_end_year = $1 ORDER BY a.approved_at`, [endYear]);
    return r.rows;
};

module.exports = {
    DEFAULT_CLASSIFICATION, EDITOR_ROLES, APPROVER_ROLE, TEXT_SECTIONS, TEXT_KEYS,
    listYears, yearBounds, buildPack, getPackSettings, getTexts, getApprovals, tablesReady, keyFigures, sameFigures, longDate,
};
