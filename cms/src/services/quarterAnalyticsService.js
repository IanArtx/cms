// ============================================================
// QUARTER ANALYTICS SERVICE (v1.50.0)
// Shared "bucket a set of dated, currency-tagged money rows into
// quarters and find the most/least" logic, used by both the
// Transactions and Transfers analytics endpoints. Deliberately
// generic (works over anything shaped like
// { date, currency, amount, direction }) rather than living inside
// either controller, since both needed the identical grouping rule.
//
// QUARTER SOURCE (per the clarifying answer this was built to):
// if the company has defined its own Fiscal Quarters (Settings ->
// Fiscal Quarters, Section 4.10 / fiscalService.js), a date that
// falls inside one of those custom ranges is labelled with that
// quarter's own label. Any date NOT covered by a configured fiscal
// quarter — including every date, if none have been configured at
// all — falls back to an ordinary calendar quarter (Q1 Jan-Mar ...
// Q4 Oct-Dec). This is a per-date decision, not an all-or-nothing
// switch, so a company that only defined fiscal quarters for its
// most recent financial year still gets sensible calendar-quarter
// grouping for older history instead of one giant undifferentiated
// bucket.
// ============================================================

const { query } = require('../config/database');
const { normalizeDateInput } = require('../utils/dateUtils');

// ------------------------------------------------------------
// Every configured fiscal quarter, loaded once per request rather
// than re-queried per row — a company has at most a handful of
// these, so holding them all in memory for one bucketing pass is
// cheap and avoids an O(rows) query fan-out.
// ------------------------------------------------------------
const loadFiscalQuarters = async () => {
    const result = await query(
        'SELECT id, label, start_date, end_date FROM fiscal_quarters ORDER BY start_date ASC'
    );
    return result.rows.map(q => ({
        id: q.id,
        label: q.label,
        start_date: normalizeDateInput(q.start_date),
        end_date: normalizeDateInput(q.end_date),
    }));
};

// ------------------------------------------------------------
// Calendar-quarter fallback for one date — key is stable/sortable
// ("2026-Q3"), label is what's actually displayed ("Q3 2026").
// ------------------------------------------------------------
const calendarQuarterFor = (dateStr) => {
    const normalized = normalizeDateInput(dateStr);
    const [year, month] = normalized.split('-').map(Number);
    const q = Math.floor((month - 1) / 3) + 1;
    return { key: `${year}-Q${q}`, label: `Q${q} ${year}` };
};

// ------------------------------------------------------------
// Resolve one date to its quarter — fiscal quarter if it falls
// inside a configured range (most recently-starting match wins on
// overlap, same tie-break as fiscalService.getQuarterForDate), else
// the calendar-quarter fallback.
// ------------------------------------------------------------
const quarterForDate = (dateStr, fiscalQuarters) => {
    const normalized = normalizeDateInput(dateStr);
    let bestMatch = null;
    for (const fq of fiscalQuarters) {
        if (fq.start_date <= normalized && fq.end_date >= normalized) {
            if (!bestMatch || fq.start_date > bestMatch.start_date) bestMatch = fq;
        }
    }
    if (bestMatch) return { key: `FQ-${bestMatch.id}`, label: bestMatch.label };
    return calendarQuarterFor(normalized);
};

// ------------------------------------------------------------
// BUCKET + SUMMARIZE — the main entry point.
//
// `rows` — [{ date, currency, amount, direction }], where
//   `direction` is 'IN' (counts toward income/inflow) or 'OUT'
//   (counts toward expense/outflow). Both amount classifications are
//   assumed already-positive magnitudes (the caller decides sign).
//
// Returns, per currency:
//   monthly:        [{ period: 'YYYY-MM', income, expense }], sorted
//   quarters:        [{ key, label, income, expense }], sorted by
//                    each quarter's own earliest-seen date
//   most_income_quarter / least_income_quarter / most_expense_quarter
//   / least_expense_quarter — { label, amount } or null if there's
//   nothing to compare (e.g. only one quarter of history, or zero
//   activity on that side).
// ------------------------------------------------------------
const bucketAndSummarize = (rows, fiscalQuarters) => {
    const byCurrency = {};

    for (const row of rows) {
        const currency = row.currency;
        if (!byCurrency[currency]) {
            byCurrency[currency] = { monthlyMap: {}, quarterMap: {} };
        }
        const bucket = byCurrency[currency];
        const dateStr = normalizeDateInput(row.date);
        const period = dateStr.slice(0, 7); // YYYY-MM
        const { key: qKey, label: qLabel } = quarterForDate(dateStr, fiscalQuarters);
        const amount = parseFloat(row.amount) || 0;

        if (!bucket.monthlyMap[period]) bucket.monthlyMap[period] = { period, income: 0, expense: 0 };
        if (!bucket.quarterMap[qKey]) bucket.quarterMap[qKey] = { key: qKey, label: qLabel, income: 0, expense: 0, earliestDate: dateStr };
        if (dateStr < bucket.quarterMap[qKey].earliestDate) bucket.quarterMap[qKey].earliestDate = dateStr;

        if (row.direction === 'IN') {
            bucket.monthlyMap[period].income += amount;
            bucket.quarterMap[qKey].income += amount;
        } else {
            bucket.monthlyMap[period].expense += amount;
            bucket.quarterMap[qKey].expense += amount;
        }
    }

    const result = {};
    for (const [currency, bucket] of Object.entries(byCurrency)) {
        const monthly = Object.values(bucket.monthlyMap).sort((a, b) => a.period.localeCompare(b.period));
        const quarters = Object.values(bucket.quarterMap)
            .sort((a, b) => a.earliestDate.localeCompare(b.earliestDate))
            .map(({ key, label, income, expense }) => ({ key, label, income, expense }));

        const pickExtreme = (field, comparator) => {
            const withActivity = quarters.filter(q => q[field] > 0);
            if (withActivity.length === 0) return null;
            const picked = withActivity.reduce((best, q) => comparator(q[field], best[field]) ? q : best);
            return { label: picked.label, amount: picked[field] };
        };

        result[currency] = {
            monthly,
            quarters,
            most_income_quarter:   pickExtreme('income',  (a, b) => a > b),
            least_income_quarter:  pickExtreme('income',  (a, b) => a < b),
            most_expense_quarter:  pickExtreme('expense', (a, b) => a > b),
            least_expense_quarter: pickExtreme('expense', (a, b) => a < b),
        };
    }
    return result;
};

module.exports = { loadFiscalQuarters, calendarQuarterFor, quarterForDate, bucketAndSummarize };
