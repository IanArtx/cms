// ============================================================
// MONTHS — CLOSING, REOPENING AND LOCKING (v1.90.0)
// "all months have to be closed and once the filling is done and the
//  certification or confirmation is uploaded and approved in the system
//  there cannot be any other alterations for those months" (13 Nov 2026).
// Confirmed: the Treasurer closes months; the Admin may reopen one, with
// a reason, only until a tax filing is approved; once a Director approves
// the uploaded URA confirmation nobody can change those months.
//
// A month is OPEN (default, no row), CLOSED or LOCKED (accounting_periods).
// The DATABASE refuses any change to the figures of a closed or locked
// month (triggers in migration_v1.90.0.sql) — on transactions, exchange
// rates, month-end FX revaluations, tax deducted from / withheld by the
// company — so no screen and no background job can alter it.
//
// Rules
//   • Months are closed in order, oldest first: a month can be closed only
//     once it has ended and every earlier month (since the books began) is
//     closed.
//   • Before closing, the checklist must be clear: no entry of the month
//     without a UGX value, the month-end FX revaluation done (when there
//     are foreign-currency accounts) and no money entry waiting for
//     approval that is dated in the month.
//   • Only the most recent closed month can be reopened (Admin, reason),
//     and never once the tax computation of its year is approved / filed;
//     reopening a month of a PREPARED year sends the computation back.
//   • Locking (taxService, on the Director's approval of the URA
//     confirmation) turns every month of that tax year to LOCKED for good.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES } = require('./auditService');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const monthStart = (d) => `${String(d).slice(0, 7)}-01`;
const monthEnd = (ms) => { const [y, m] = ms.split('-').map(Number); return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const nextMonth = (ms) => { const [y, m] = ms.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`; };
const labelOf = (ms) => { const [y, m] = ms.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const kampalaToday = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const dateStr = (d) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)) : null);
const parseMonth = (ym) => {
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) throw createError.badRequest('Month must be YYYY-MM.');
    return `${ym}-01`;
};

let ready = null;
const tableReady = async () => {
    if (ready) return true;
    const r = await query("SELECT to_regclass('public.accounting_periods') IS NOT NULL AS ok");
    ready = !!r.rows[0].ok;
    return ready;
};
const assertReady = async () => {
    if (!(await tableReady())) throw createError.conflict('Closing months needs the v1.90.0 database update — run update_live_database.js first.');
};

const hasRole = (user, roles) => (user.roles || []).some(r => roles.includes(r));

// The first month of the books: the earliest entry.
const firstMonth = async () => {
    const r = await query(`
        SELECT LEAST(
            (SELECT MIN(value_date) FROM transactions WHERE status = 'POSTED'),
            (SELECT MIN(deduction_date) FROM tax_at_source),
            (SELECT MIN(withholding_date) FROM wht_withholdings WHERE is_shadow = FALSE)
        )::text AS first`).catch(() => query(`SELECT MIN(value_date)::text AS first FROM transactions WHERE status = 'POSTED'`));
    return r.rows[0].first ? monthStart(r.rows[0].first) : null;
};

const periodRows = async () => {
    if (!(await tableReady())) return new Map();
    const r = await query(`
        SELECT p.*, p.period_month::text AS period_month,
               cu.first_name || ' ' || cu.last_name AS closed_by_name,
               lu.first_name || ' ' || lu.last_name AS locked_by_name,
               ty.label AS tax_year_label
        FROM   accounting_periods p
        LEFT JOIN users cu ON cu.id = p.closed_by LEFT JOIN users lu ON lu.id = p.locked_by
        LEFT JOIN tax_years ty ON ty.id = p.tax_year_id`);
    return new Map(r.rows.map(x => [x.period_month, x]));
};

const statusOf = (rows, ms) => (rows.get(ms) ? rows.get(ms).status : 'OPEN');

// The tax year containing a month (if the tax module is in use).
const taxYearOf = async (ms) => {
    const r = await query(`SELECT id, label, status, start_date::text AS start_date, end_date::text AS end_date
                           FROM tax_years WHERE $1::date BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1`, [monthEnd(ms)]).catch(() => ({ rows: [] }));
    return r.rows[0] || null;
};

// What must be in order before a month can be closed.
const checklist = async (ms, rows = null) => {
    rows = rows || await periodRows();
    const me = monthEnd(ms);
    const today = kampalaToday();
    const items = [];
    const first = await firstMonth();

    items.push({ key: 'ENDED', ok: me < today, label: 'The month has ended', detail: me < today ? null : `It ends on ${me}.` });

    let prevOpen = null;
    if (first && first < ms) {
        for (let m = first; m < ms; m = nextMonth(m)) {
            if (statusOf(rows, m) === 'OPEN') { prevOpen = m; break; }
        }
    }
    items.push({ key: 'ORDER', ok: !prevOpen, label: 'Every earlier month is closed', detail: prevOpen ? `Close ${labelOf(prevOpen)} first — months are closed oldest first.` : null });

    const unconv = await query(`SELECT COUNT(*)::int AS n FROM transactions WHERE status = 'POSTED' AND functional_amount IS NULL
                                AND value_date BETWEEN $1 AND $2`, [ms, me]);
    items.push({ key: 'UGX', ok: unconv.rows[0].n === 0, label: 'Every entry has its UGX value',
        detail: unconv.rows[0].n ? `${unconv.rows[0].n} entr${unconv.rows[0].n === 1 ? 'y has' : 'ies have'} no exchange rate for its date — add the rate (Accounts › Exchange rates) first.` : null });

    // Month-end FX revaluation — needed when the company has accounts in another currency.
    const foreign = await query(`
        SELECT COUNT(*)::int AS n FROM accounts a JOIN company_settings cs ON cs.id = 1
        WHERE a.currency_id IS DISTINCT FROM cs.functional_currency_id`);
    if (foreign.rows[0].n > 0) {
        const run = await query('SELECT 1 FROM fx_revaluation_runs WHERE period_end = $1', [me]);
        items.push({ key: 'FX', ok: run.rows.length > 0, label: 'Month-end FX revaluation done',
            detail: run.rows.length ? null : 'Run the month-end revaluation for this month (Reports › General Ledger › FX & Revaluation).' });
    }

    // Money entries waiting for approval, dated in this month.
    let held = 0;
    try {
        const h = await query(`SELECT body FROM held_money_entries WHERE status = 'PENDING'`);
        for (const row of h.rows) {
            const b = row.body || {};
            const dated = Object.keys(b).some(k => /date$/i.test(k) && typeof b[k] === 'string' && b[k].slice(0, 7) === ms.slice(0, 7));
            if (dated) held += 1;
        }
    } catch (_) { /* no held entries table */ }
    items.push({ key: 'HELD', ok: held === 0, label: 'No money entry dated in the month is waiting for approval',
        detail: held ? `${held} entr${held === 1 ? 'y' : 'ies'} in Money › Awaiting approval ${held === 1 ? 'is' : 'are'} dated in this month — approve or refuse ${held === 1 ? 'it' : 'them'} first.` : null });

    const pendingTransfers = await query(`SELECT COUNT(*)::int AS n FROM transfers WHERE status = 'PENDING' AND value_date BETWEEN $1 AND $2`, [ms, me])
        .catch(() => ({ rows: [{ n: 0 }] }));
    if (pendingTransfers.rows[0].n) {
        items.push({ key: 'TRANSFERS', ok: true, warning: true, label: 'Transfers waiting for approval',
            detail: `${pendingTransfers.rows[0].n} transfer(s) dated in this month wait for approval — once the month is closed they must be dated in an open month.` });
    }
    return { month: ms.slice(0, 7), label: labelOf(ms), items, canClose: items.every(i => i.ok) };
};

// The month's totals, stored when it is closed (for the history).
const monthFigures = async (ms) => {
    const me = monthEnd(ms);
    const r = await query(`
        SELECT COUNT(*)::int AS entries,
               COALESCE(SUM(CASE WHEN transaction_type = 'CREDIT' THEN functional_amount ELSE 0 END), 0)::float AS money_in_ugx,
               COALESCE(SUM(CASE WHEN transaction_type = 'DEBIT' THEN functional_amount ELSE 0 END), 0)::float AS money_out_ugx
        FROM transactions WHERE status = 'POSTED' AND value_date BETWEEN $1 AND $2`, [ms, me]);
    return r.rows[0];
};

const listMonths = async () => {
    const ready_ = await tableReady();
    const rows = await periodRows();
    const first = await firstMonth();
    const today = kampalaToday();
    const months = [];
    if (first) {
        for (let m = first; m <= monthStart(today); m = nextMonth(m)) {
            const p = rows.get(m);
            months.push({
                month: m.slice(0, 7), label: labelOf(m), status: p ? p.status : 'OPEN',
                ended: monthEnd(m) < today,
                closed_by: p ? p.closed_by_name : null, closed_at: p ? p.closed_at : null, close_note: p ? p.close_note : null,
                figures: p ? p.figures : null,
                locked_at: p ? p.locked_at : null, locked_by: p ? p.locked_by_name : null, tax_year: p ? p.tax_year_label : null,
            });
        }
    }
    // Next month to close, and the checklist for it.
    const nextToClose = months.find(m => m.status === 'OPEN' && m.ended) || null;
    const lastClosed = [...months].reverse().find(m => m.status === 'CLOSED') || null;
    const laterClosed = lastClosed ? months.some(m => m.month > lastClosed.month && m.status !== 'OPEN') : false;
    let events = [];
    if (ready_) {
        events = (await query(`
            SELECT e.id, to_char(e.period_month, 'YYYY-MM') AS month, e.action, e.at, e.reason, u.first_name || ' ' || u.last_name AS by_name
            FROM accounting_period_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.at DESC LIMIT 60`)).rows;
    }
    return {
        ready: ready_, months: months.reverse(),
        next_to_close: nextToClose ? await checklist(`${nextToClose.month}-01`, rows) : null,
        reopenable: lastClosed && !laterClosed ? lastClosed.month : null,
        events,
    };
};

const closeMonth = async (client, user, ym, note) => {
    await assertReady();
    if (!hasRole(user, ['Treasurer'])) throw createError.forbidden('Months are closed by the Treasurer.');
    const ms = parseMonth(ym);
    const rows = await periodRows();
    if (statusOf(rows, ms) !== 'OPEN') throw createError.conflict(`${labelOf(ms)} is already ${statusOf(rows, ms).toLowerCase()}.`);
    const check = await checklist(ms, rows);
    const failing = check.items.filter(i => !i.ok);
    if (failing.length) throw createError.conflict(`${labelOf(ms)} cannot be closed yet: ${failing.map(i => i.detail || i.label).join(' ')}`);
    const figures = await monthFigures(ms);
    await client.query(`
        INSERT INTO accounting_periods (period_month, status, closed_by, closed_at, close_note, figures, updated_at)
        VALUES ($1, 'CLOSED', $2, NOW(), $3, $4, NOW())
        ON CONFLICT (period_month) DO UPDATE SET status = 'CLOSED', closed_by = $2, closed_at = NOW(), close_note = $3, figures = $4, updated_at = NOW()`,
    [ms, user.id, note || null, JSON.stringify(figures)]);
    await client.query(`INSERT INTO accounting_period_events (period_month, action, user_id, reason, details) VALUES ($1, 'CLOSE', $2, $3, $4)`,
        [ms, user.id, note || null, JSON.stringify(figures)]);
    await logAction(user.id, ACTIONS.PERIOD_CLOSED, MODULES.FINANCE, {
        recordType: 'accounting_periods', recordId: null, newValues: { month: ym, figures }, description: `Closed ${labelOf(ms)}`, client,
    });
    return { month: ym, label: labelOf(ms), figures };
};

const reopenMonth = async (client, user, ym, reason) => {
    await assertReady();
    if (!hasRole(user, ['Admin'])) throw createError.forbidden('Only an Admin can reopen a month.');
    const why = String(reason || '').trim();
    if (why.length < 5) throw createError.badRequest('Give the reason for reopening (at least 5 characters).');
    const ms = parseMonth(ym);
    const rows = await periodRows();
    const st = statusOf(rows, ms);
    if (st === 'LOCKED') throw createError.conflict(`${labelOf(ms)} is locked for good — its tax return was filed and the URA confirmation approved. Record any correction in an open month.`);
    if (st !== 'CLOSED') throw createError.conflict(`${labelOf(ms)} is not closed.`);
    const later = Array.from(rows.values()).filter(r => r.period_month > ms && r.status !== 'OPEN').map(r => r.period_month).sort();
    if (later.length) throw createError.conflict(`Reopen ${labelOf(later[later.length - 1])} first — months are reopened newest first.`);
    const ty = await taxYearOf(ms);
    if (ty && ['APPROVED', 'FILED'].includes(ty.status)) {
        throw createError.conflict(`${labelOf(ms)} cannot be reopened: the tax computation for ${ty.label} is already ${ty.status.toLowerCase()}.`);
    }
    if (ty && ty.status === 'PREPARED') {
        await client.query(`UPDATE tax_years SET status = 'OPEN', returned_reason = $2 WHERE id = $1`,
            [ty.id, `Sent back because ${labelOf(ms)} was reopened: ${why}`]);
    }
    await client.query(`UPDATE accounting_periods SET status = 'OPEN', updated_at = NOW() WHERE period_month = $1`, [ms]);
    await client.query(`INSERT INTO accounting_period_events (period_month, action, user_id, reason) VALUES ($1, 'REOPEN', $2, $3)`, [ms, user.id, why]);
    await logAction(user.id, ACTIONS.PERIOD_REOPENED, MODULES.FINANCE, {
        recordType: 'accounting_periods', newValues: { month: ym, reason: why }, description: `Reopened ${labelOf(ms)}: ${why}`, client,
    });
    return { month: ym, label: labelOf(ms), taxYearSentBack: ty && ty.status === 'PREPARED' ? ty.label : null };
};

// Months of a date range that are not closed yet (for the tax computation).
const openMonthsBetween = async (from, to) => {
    if (!(await tableReady())) return [];
    const rows = await periodRows();
    const first = await firstMonth();
    const start = monthStart(from);
    const out = [];
    for (let m = start; m <= monthStart(to); m = nextMonth(m)) {
        if (first && m < first) continue; // no entries at all before the books began
        if (statusOf(rows, m) === 'OPEN') out.push(labelOf(m));
    }
    return out;
};

// Locks every month of a tax year for good (all must be closed).
const lockMonths = async (client, { from, to, taxYearId, userId, reason }) => {
    await assertReady();
    const open = await openMonthsBetween(from, to);
    if (open.length) throw createError.conflict(`These months are not closed: ${open.join(', ')}.`);
    const r = await client.query(`
        UPDATE accounting_periods SET status = 'LOCKED', locked_at = NOW(), locked_by = $3, tax_year_id = $4, updated_at = NOW()
        WHERE period_month BETWEEN date_trunc('month', $1::date) AND $2::date AND status = 'CLOSED'
        RETURNING period_month::text AS m`, [from, to, userId, taxYearId]);
    for (const row of r.rows) {
        await client.query(`INSERT INTO accounting_period_events (period_month, action, user_id, reason) VALUES ($1, 'LOCK', $2, $3)`, [row.m, userId, reason]);
    }
    return r.rows.map(x => labelOf(x.m));
};

module.exports = { tableReady, listMonths, checklist, closeMonth, reopenMonth, openMonthsBetween, lockMonths, labelOf, monthEnd, kampalaToday, dateStr };
