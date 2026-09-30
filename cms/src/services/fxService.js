// ============================================================
// FX SERVICE (v1.66.0)
//
// Everything the books need to turn foreign-currency amounts into
// the company's FUNCTIONAL currency (UGX) — and nothing else. Used
// by glService.js (the financial statements) and
// fxRevaluationService.js (the month-end revaluation).
//
// THE RULES (IFRS for SMEs, Section 30 — see migration_v1.66.0.sql
// for the full reasoning):
//   1. Every transaction is valued in UGX at the rate on ITS OWN
//      date, and that value never changes. The database trigger
//      set_transaction_functional_amount() does this on every
//      insert; the values live in transactions.functional_amount.
//   2. At each month end, MONETARY balances held in a foreign
//      currency (cash, savings owed to members, loans, deposits,
//      the side fund) are revalued to that month end's closing
//      rate. The difference is an FX gain or loss.
//   3. Everything else (capital, investments at cost, income,
//      expenses) stays at its historical rate forever.
//
// RATE LOOKUP — rateOn() below is a JavaScript copy of the SQL
// function fx_rate_on(): the currency_exchange_rates row effective
// on the date, either direction, NO fallback to "the earliest rate
// on file". A missing rate is reported as missing, never guessed.
// (sharePricingService.js keeps its own, more forgiving lookup for
// share-unit calculations — that behaviour is unchanged.)
//
// DATES — every date handled here is a plain 'YYYY-MM-DD' string.
// SQL queries cast DATE columns to text so the pg driver never
// turns them into JS Date objects (which shift by a day when the
// server's timezone is ahead of UTC, e.g. a laptop in Germany).
// ============================================================

const { query } = require('../config/database');

const BASIS = Object.freeze({
    FUNCTIONAL: 'FUNCTIONAL',   // the official statements: one set, in UGX
    CURRENCY:   'CURRENCY',     // supporting view: one set per original currency (v1.64.0 behaviour)
});

const FX_GAIN_GL_CODE = '4600';
const FX_LOSS_GL_CODE = '5600';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const toDateStr = (d) => {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    // A JS Date from the driver — use its LOCAL calendar date, which is
    // what the driver built it from (not toISOString(), which is UTC).
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

const todayStr = () => toDateStr(new Date());

// Last calendar day of the month a date falls in.
const monthEndOf = (dateStr) => {
    const [y, m] = dateStr.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
};

// Month end of the month AFTER the one a date falls in.
const nextMonthEnd = (dateStr) => {
    const [y, m] = dateStr.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return monthEndOf(`${ny}-${String(nm).padStart(2, '0')}-01`);
};

// Latest month end on or before a date.
const lastMonthEndOnOrBefore = (dateStr) => {
    const me = monthEndOf(dateStr);
    if (me === dateStr) return dateStr;
    const [y, m] = dateStr.split('-').map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return monthEndOf(`${py}-${String(pm).padStart(2, '0')}-01`);
};

const dayBefore = (dateStr) => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
};

// First day of the financial year a date falls in, given the month
// the year starts in (7 = July, for a 1 July – 30 June year).
const fiscalYearStartFor = (dateStr, startMonth = 7) => {
    const [y, m] = dateStr.split('-').map(Number);
    const startYear = m >= startMonth ? y : y - 1;
    return `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
};

// ============================================================
// ACCOUNTING SETTINGS — functional/presentation currency and the
// financial-year start month, from company_settings.
// ============================================================
const getAccountingSettings = async () => {
    const result = await query(`
        SELECT cs.functional_currency_id, fc.code AS functional_code, fc.symbol AS functional_symbol,
               cs.presentation_currency_id, pc.code AS presentation_code, pc.symbol AS presentation_symbol,
               cs.fiscal_year_start_month
        FROM   company_settings cs
        LEFT JOIN currencies fc ON fc.id = cs.functional_currency_id
        LEFT JOIN currencies pc ON pc.id = cs.presentation_currency_id
        WHERE  cs.id = 1
    `);
    const row = result.rows[0] || {};
    return {
        functionalCurrency: row.functional_currency_id ? {
            id: row.functional_currency_id, code: row.functional_code, symbol: row.functional_symbol,
        } : null,
        presentationCurrency: row.presentation_currency_id ? {
            id: row.presentation_currency_id, code: row.presentation_code, symbol: row.presentation_symbol,
        } : null,
        fiscalYearStartMonth: row.fiscal_year_start_month || 7,
    };
};

// ============================================================
// RATE TABLE — loaded once per report, then looked up in memory.
// Returns rateOn(fromCurrencyId, toCurrencyId, 'YYYY-MM-DD').
// ============================================================
const loadRateTable = async () => {
    const result = await query(`
        SELECT id, base_currency_id, target_currency_id, rate,
               effective_from::text AS effective_from,
               effective_to::text   AS effective_to
        FROM   currency_exchange_rates
    `);
    const rows = result.rows.map(r => ({
        id: r.id,
        base: r.base_currency_id,
        target: r.target_currency_id,
        rate: parseFloat(r.rate),
        from: r.effective_from,
        to: r.effective_to,
    }));

    const find = (base, target, date) => {
        let best = null;
        for (const r of rows) {
            if (r.base !== base || r.target !== target) continue;
            if (r.from > date) continue;
            if (r.to !== null && r.to <= date) continue;
            if (!best || r.from > best.from || (r.from === best.from && r.id > best.id)) best = r;
        }
        return best;
    };

    const rateOn = (fromId, toId, date) => {
        if (!fromId || !toId || !date) return null;
        if (fromId === toId) return 1;
        const d = toDateStr(date);
        const direct = find(fromId, toId, d);
        if (direct) return direct.rate;
        const inverse = find(toId, fromId, d);
        if (inverse) return 1 / inverse.rate;
        return null;
    };

    return { rateOn };
};

// ============================================================
// STORED REVALUATION — month-end runs already on file, turned into
// ledger lines (two per revalued balance: the balance itself, and
// the FX gain or loss on the other side).
// ============================================================
const getRevaluationRuns = async ({ throughDate = null } = {}) => {
    const params = [];
    let where = '';
    if (throughDate) { params.push(throughDate); where = 'WHERE r.period_end <= $1'; }
    const result = await query(`
        SELECT r.id, r.period_end::text AS period_end, r.rates_used, r.total_gain, r.total_loss,
               r.notes, r.run_at, u.first_name || ' ' || u.last_name AS run_by_name
        FROM   fx_revaluation_runs r
        LEFT JOIN users u ON u.id = r.run_by
        ${where}
        ORDER  BY r.period_end ASC
    `, params);
    return result.rows;
};

// Latest closed month end — optionally only among months on/before a date.
const getLastRevaluationPeriodEnd = async (onOrBefore = null) => {
    const result = onOrBefore
        ? await query(`SELECT MAX(period_end)::text AS last FROM fx_revaluation_runs WHERE period_end <= $1`, [onOrBefore])
        : await query(`SELECT MAX(period_end)::text AS last FROM fx_revaluation_runs`);
    return result.rows[0].last || null;
};

// Build the two ledger lines for one revaluation adjustment. `adj`
// is positive when the balance must be DEBITED to reach its revalued
// amount (an asset gained value, or a liability shrank) — that side
// is always an FX gain; negative is always an FX loss.
const revaluationToLines = ({ adj, date, sourceType, sourceId, glByCode, functionalCurrency, currencyCodeById, description }) => {
    const gainGl = glByCode.get(FX_GAIN_GL_CODE);
    const lossGl = glByCode.get(FX_LOSS_GL_CODE);
    const amount = Math.abs(adj.adjustment);
    const isGain = adj.adjustment > 0;
    const curCode = currencyCodeById.get(adj.currencyId) || '';
    const desc = description || `FX revaluation of ${curCode} balance at ${adj.closingRate} (${date})`;
    const common = {
        date,
        accountId: adj.accountId,
        description: desc,
        referenceCode: null,
        categoryTrail: null,
        sourceType,
        sourceId,
        currencyId: functionalCurrency.id,
        currencyCode: functionalCurrency.code,
        currencySymbol: functionalCurrency.symbol,
        originalDebit: 0,
        originalCredit: 0,
        fxRate: adj.closingRate,
        fxRateSource: 'REVALUATION',
    };
    return [
        {
            ...common,
            lineRole: 'REVALUED_BALANCE',
            glAccountId: adj.glAccountId,
            debit: isGain ? amount : 0,
            credit: isGain ? 0 : amount,
            // The revalued balance is still a balance IN the foreign
            // currency — only its UGX carrying value moved.
            originalCurrencyId: adj.currencyId,
            originalCurrencyCode: curCode,
        },
        {
            ...common,
            lineRole: 'FX_RESULT',
            glAccountId: isGain ? gainGl.id : lossGl.id,
            debit: isGain ? 0 : amount,
            credit: isGain ? amount : 0,
            originalCurrencyId: functionalCurrency.id,
            originalCurrencyCode: functionalCurrency.code,
        },
    ];
};

const getStoredRevaluationLines = async ({ throughDate, accountId = null, glByCode, functionalCurrency, currencyCodeById }) => {
    const params = [throughDate];
    let accountFilter = '';
    if (accountId) { params.push(accountId); accountFilter = `AND l.account_id = $${params.length}`; }
    const result = await query(`
        SELECT l.id, r.id AS run_id, r.period_end::text AS period_end,
               l.gl_account_id, l.account_id, l.currency_id,
               l.closing_rate, l.adjustment
        FROM   fx_revaluation_lines l
        JOIN   fx_revaluation_runs r ON r.id = l.run_id
        WHERE  r.period_end <= $1 ${accountFilter}
        ORDER  BY r.period_end ASC, l.id ASC
    `, params);

    const lines = [];
    for (const row of result.rows) {
        const adj = {
            glAccountId: row.gl_account_id,
            accountId: row.account_id,
            currencyId: row.currency_id,
            closingRate: parseFloat(row.closing_rate),
            adjustment: parseFloat(row.adjustment),
        };
        if (adj.adjustment === 0) continue;
        lines.push(...revaluationToLines({
            adj, date: row.period_end, sourceType: 'FX_REVALUATION', sourceId: row.run_id,
            glByCode, functionalCurrency, currencyCodeById,
        }));
    }
    return lines;
};

// ============================================================
// COMPUTE A REVALUATION AT ONE DATE (pure — no database writes).
//
// `lines` are FUNCTIONAL-basis ledger lines (each with debit/credit
// in UGX, plus originalCurrencyId and originalDebit/originalCredit
// in its own currency). Every MONETARY GL balance held in a foreign
// currency is grouped by (GL account, bank account, currency):
//   foreign balance  = sum of its original-currency debits - credits
//   carrying value   = sum of its UGX debits - credits so far
//   revalued value   = foreign balance x closing rate on `date`
//   adjustment       = revalued - carrying
// Returns { adjustments, ratesUsed, missingCurrencyIds }.
// ============================================================
const computeRevaluation = ({ lines, date, functionalCurrencyId, monetaryGlIds, rateOn }) => {
    const groups = new Map();
    for (const l of lines) {
        if (l.date > date) continue;
        if (!monetaryGlIds.has(l.glAccountId)) continue;
        const cur = l.originalCurrencyId;
        if (!cur || cur === functionalCurrencyId) continue;
        const key = `${l.glAccountId}|${l.accountId || ''}|${cur}`;
        if (!groups.has(key)) {
            groups.set(key, { glAccountId: l.glAccountId, accountId: l.accountId || null, currencyId: cur, foreign: 0, carrying: 0 });
        }
        const g = groups.get(key);
        g.foreign += (l.originalDebit || 0) - (l.originalCredit || 0);
        g.carrying += (l.debit || 0) - (l.credit || 0);
    }

    const adjustments = [];
    const ratesUsed = new Map();
    const missing = new Set();
    for (const g of groups.values()) {
        const rate = rateOn(g.currencyId, functionalCurrencyId, date);
        if (rate === null || rate === undefined) { missing.add(g.currencyId); continue; }
        ratesUsed.set(g.currencyId, rate);
        const foreignBalance = Math.round((g.foreign + Number.EPSILON) * 10000) / 10000;
        const carryingBefore = round2(g.carrying);
        const revaluedBalance = round2(foreignBalance * rate);
        const adjustment = round2(revaluedBalance - carryingBefore);
        if (Math.abs(adjustment) < 0.01) continue;
        adjustments.push({
            glAccountId: g.glAccountId, accountId: g.accountId, currencyId: g.currencyId,
            foreignBalance, closingRate: rate, carryingBefore, revaluedBalance, adjustment,
        });
    }
    return {
        adjustments,
        ratesUsed: Array.from(ratesUsed.entries()).map(([currencyId, rate]) => ({ currencyId, rate })),
        missingCurrencyIds: Array.from(missing),
    };
};

// ============================================================
// RECOMPUTE UGX VALUES — re-runs the database trigger for rows that
// may be affected by a newly entered exchange rate:
//   - every transaction still without a UGX value (anywhere), and
//   - every non-MANUAL transaction dated on/after `fromDate` that
//     is NOT inside a month already revalued (closed months keep the
//     values they were revalued with — that's what makes them final).
// Originals first, reversals second. Returns row counts.
// ============================================================
const recomputeFunctionalAmounts = async (client, { fromDate = null } = {}) => {
    const run = client ? (t, p) => client.query(t, p) : (t, p) => query(t, p);
    const lastRunResult = await run(`SELECT MAX(period_end)::text AS last FROM fx_revaluation_runs`);
    const lastRun = lastRunResult.rows[0].last;

    const params = [];
    const openConditions = [`functional_rate_source IS DISTINCT FROM 'MANUAL'`];
    if (fromDate) { params.push(fromDate); openConditions.push(`value_date >= $${params.length}`); }
    if (lastRun)  { params.push(lastRun);  openConditions.push(`value_date > $${params.length}`); }
    const where = `(functional_amount IS NULL OR (${openConditions.join(' AND ')}))`;

    const originals = await run(`
        UPDATE transactions SET functional_rate_source = functional_rate_source
        WHERE  reversal_of IS NULL AND ${where}
    `, params);
    const reversals = await run(`
        UPDATE transactions SET functional_rate_source = functional_rate_source
        WHERE  reversal_of IS NOT NULL AND ${where}
    `, params);

    const stillMissing = await run(`SELECT COUNT(*)::int AS n FROM transactions WHERE status = 'POSTED' AND functional_amount IS NULL`);
    let keptInClosedMonths = 0;
    if (fromDate && lastRun && fromDate <= lastRun) {
        const kept = await run(`
            SELECT COUNT(*)::int AS n FROM transactions
            WHERE  value_date >= $1 AND value_date <= $2 AND functional_amount IS NOT NULL
            AND    functional_rate_source = 'RATE_TABLE'
        `, [fromDate, lastRun]);
        keptInClosedMonths = kept.rows[0].n;
    }

    return {
        recalculated: (originals.rowCount || 0) + (reversals.rowCount || 0),
        stillMissing: stillMissing.rows[0].n,
        keptInClosedMonths,
        lastRevaluedPeriodEnd: lastRun,
    };
};


// ============================================================
// FIXED-RATE RULES (v1.76.0) — fx_fixed_rate_periods.
// A company decision that one currency pair is worth a set rate for
// every date BEFORE a cut-off (e.g. 1 EUR = 4,000 UGX before
// 20 Aug 2025). The rate table itself holds that rate for those dates
// (apply_fixed_rates_v1.76.0.js puts it there); these helpers let the
// places that WRITE rates refuse anything that would contradict it.
// Missing table (migration not run yet) = no rules, never an error.
// ============================================================
const listFixedRateRules = async (client = null) => {
    const run = client ? (t, p) => client.query(t, p) : (t, p) => query(t, p);
    try {
        const r = await run(`
            SELECT f.id, f.base_currency_id, f.target_currency_id, f.rate,
                   f.valid_before::text AS valid_before, f.reason, f.applied_at,
                   b.code AS base_code, t.code AS target_code
            FROM   fx_fixed_rate_periods f
            JOIN   currencies b ON b.id = f.base_currency_id
            JOIN   currencies t ON t.id = f.target_currency_id
            ORDER  BY f.valid_before, f.id
        `);
        return r.rows.map(x => ({ ...x, rate: parseFloat(x.rate) }));
    } catch (err) {
        if (err.code === '42P01') return [];
        throw err;
    }
};

// The rule covering (fromId -> toId) on `date`, in either direction,
// or null. `rate` is always expressed as 1 fromId = rate toId.
const fixedRateRuleFor = async (fromId, toId, date, client = null) => {
    if (!fromId || !toId || !date) return null;
    const d = toDateStr(date);
    const rules = await listFixedRateRules(client);
    for (const f of rules) {
        if (d >= f.valid_before) continue;
        if (f.base_currency_id === Number(fromId) && f.target_currency_id === Number(toId)) return { ...f, directRate: f.rate };
        if (f.base_currency_id === Number(toId) && f.target_currency_id === Number(fromId)) return { ...f, directRate: 1 / f.rate };
    }
    return null;
};

// "1 EUR = 4,000 UGX for every date before 20 Aug 2025" — for messages.
const describeFixedRule = (f) => {
    const [y, m, d] = f.valid_before.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `1 ${f.base_code} = ${f.rate.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${f.target_code} ` +
           `for every date before ${d} ${months[m - 1]} ${y}`;
};

// True when `rate` (1 fromId = rate toId) matches the rule, allowing
// for rounding of an inverse rate.
const matchesFixedRule = (f, fromId, rate) => {
    const direct = f.base_currency_id === Number(fromId) ? f.rate : 1 / f.rate;
    return Math.abs(parseFloat(rate) - direct) <= Math.max(1e-9, Math.abs(direct) * 1e-6);
};

module.exports = {
    BASIS,
    FX_GAIN_GL_CODE,
    FX_LOSS_GL_CODE,
    round2,
    toDateStr,
    todayStr,
    monthEndOf,
    nextMonthEnd,
    lastMonthEndOnOrBefore,
    dayBefore,
    fiscalYearStartFor,
    getAccountingSettings,
    loadRateTable,
    getRevaluationRuns,
    getLastRevaluationPeriodEnd,
    revaluationToLines,
    getStoredRevaluationLines,
    computeRevaluation,
    recomputeFunctionalAmounts,
    listFixedRateRules,
    fixedRateRuleFor,
    describeFixedRule,
    matchesFixedRule,
};
