// ============================================================
// TIME GROUPING FOR CHARTS (v1.88.0)
//
// Requested: "all graphs in the system be groupable to months, years,
// days and weeks".
//
// Every chart over time keeps its own raw points (one per transaction,
// rate, repayment, day …) and passes them through groupSeries() with the
// grouping the person picked in the small Days / Weeks / Months / Years
// switch (<GroupBy />). How a field is combined inside one period depends
// on what it is:
//   'sum'  — money that MOVES in the period (income, repayments, returns,
//            inflow/outflow): the amounts are added.
//   'last' — a LEVEL at a moment (a balance, a running total, a price):
//            the latest value in the period — what it stood at when the
//            period ended. Empty periods carry the previous value forward.
//   'avg'  — a RATE (exchange rate): the average over the period; the
//            tooltip still shows it to 4 decimals.
// Weeks start on Monday. A year is the calendar year (Jan–Dec).
//
//   const rows = groupSeries(points, { granularity: g, date: p => p.value_date,
//                                      fields: { balance: 'last' } });
//   → [{ period: '2026-11', label: 'Nov 2026', balance: 1234.5, count: 3 }, …]
// ============================================================

export const GRANULARITIES = [
    { key: 'day', label: 'Days', short: 'D' },
    { key: 'week', label: 'Weeks', short: 'W' },
    { key: 'month', label: 'Months', short: 'M' },
    { key: 'year', label: 'Years', short: 'Y' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' from a date string / Date (the calendar day as written,
// never shifted by the browser's time zone).
export const toYmd = (v) => {
    if (!v) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const s = String(v);
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3] || '01'}`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : toYmd(d);
};

const utc = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fromUtc = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

// The first day of the period a day belongs to.
export const periodStart = (ymd, g) => {
    if (g === 'year') return `${ymd.slice(0, 4)}-01-01`;
    if (g === 'month') return `${ymd.slice(0, 7)}-01`;
    if (g === 'week') {
        const dt = utc(ymd);
        const dow = (dt.getUTCDay() + 6) % 7; // Monday = 0
        dt.setUTCDate(dt.getUTCDate() - dow);
        return fromUtc(dt);
    }
    return ymd;
};

const nextStart = (start, g) => {
    const dt = utc(start);
    if (g === 'year') dt.setUTCFullYear(dt.getUTCFullYear() + 1);
    else if (g === 'month') dt.setUTCMonth(dt.getUTCMonth() + 1);
    else if (g === 'week') dt.setUTCDate(dt.getUTCDate() + 7);
    else dt.setUTCDate(dt.getUTCDate() + 1);
    return fromUtc(dt);
};

export const periodKey = (ymd, g) => {
    const s = periodStart(ymd, g);
    if (g === 'year') return s.slice(0, 4);
    if (g === 'month') return s.slice(0, 7);
    return s;
};

export const periodLabel = (start, g) => {
    const [y, m, d] = start.split('-').map(Number);
    if (g === 'year') return String(y);
    if (g === 'month') return `${MONTHS[m - 1]} ${y}`;
    if (g === 'week') return `Wk ${pad(d)} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
    return `${pad(d)} ${MONTHS[m - 1]} ${String(y).slice(2)}`;
};

// Longer form for tooltips: "Week of 10 Nov 2026", "13 Nov 2026" …
export const periodTitle = (start, g) => {
    const [y, m, d] = start.split('-').map(Number);
    if (g === 'year') return `Year ${y}`;
    if (g === 'month') return `${MONTHS[m - 1]} ${y}`;
    if (g === 'week') {
        const end = utc(start); end.setUTCDate(end.getUTCDate() + 6);
        return `Week ${pad(d)} ${MONTHS[m - 1]} – ${pad(end.getUTCDate())} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
    }
    return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
};

/**
 * Group points into periods.
 *  rows        — the raw points
 *  granularity — 'day' | 'week' | 'month' | 'year'
 *  date        — (row) => its date (string or Date); or the name of the field
 *  fields      — { fieldName: 'sum' | 'last' | 'avg' }
 *  fill        — true: include empty periods between the first and the last
 *                (sum → 0, last → carried forward, avg → left empty).
 *                Skipped automatically past 3,000 periods.
 *  keep        — extra fields copied from the period's latest point
 */
export const groupSeries = (rows, { granularity = 'month', date = 'date', fields = {}, fill = true, keep = [] } = {}) => {
    const g = granularity;
    const getDate = typeof date === 'function' ? date : (r) => r[date];
    const buckets = new Map();
    const points = [];
    for (const r of rows || []) {
        const ymd = toYmd(getDate(r));
        if (ymd) points.push({ ymd, r });
    }
    points.sort((a, b) => a.ymd.localeCompare(b.ymd)); // stable: same-day points keep their order
    for (const { ymd, r } of points) {
        const start = periodStart(ymd, g);
        let b = buckets.get(start);
        if (!b) { b = { start, count: 0, sums: {}, avgN: {}, last: {}, keep: {} }; buckets.set(start, b); }
        b.count += 1;
        for (const [f, how] of Object.entries(fields)) {
            const v = r[f] === null || r[f] === undefined || r[f] === '' ? null : Number(r[f]);
            if (v === null || Number.isNaN(v)) continue;
            if (how === 'sum') b.sums[f] = (b.sums[f] || 0) + v;
            else if (how === 'avg') { b.sums[f] = (b.sums[f] || 0) + v; b.avgN[f] = (b.avgN[f] || 0) + 1; }
            else b.last[f] = v;
        }
        for (const k of keep) b.keep[k] = r[k];
    }
    let starts = [...buckets.keys()].sort();
    if (fill && starts.length > 1) {
        const all = []; let s = starts[0]; const end = starts[starts.length - 1];
        for (let i = 0; i < 3000 && s <= end; i++) { all.push(s); s = nextStart(s, g); }
        if (all.length < 3000) starts = all;
    }
    const out = []; const carry = {};
    for (const start of starts) {
        const b = buckets.get(start);
        const row = { period: periodKey(start, g), start, label: periodLabel(start, g), title: periodTitle(start, g), count: b ? b.count : 0 };
        for (const [f, how] of Object.entries(fields)) {
            if (how === 'sum') row[f] = b && b.sums[f] !== undefined ? Math.round(b.sums[f] * 100) / 100 : 0;
            else if (how === 'avg') row[f] = b && b.avgN[f] ? b.sums[f] / b.avgN[f] : null;
            else {
                if (b && b.last[f] !== undefined) carry[f] = b.last[f];
                row[f] = carry[f] !== undefined ? carry[f] : null;
            }
        }
        Object.assign(row, b ? b.keep : {});
        out.push(row);
    }
    return out;
};

// Which groupings make sense for data that only exists per month (a
// month's fee, a month's contribution): Months and Years.
export const MONTHLY_ONLY = ['month', 'year'];
