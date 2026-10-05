// ============================================================
// CAPITAL GOAL INSIGHTS (v1.78.0)
//
// Requested directly: "make the capital goal system more optimized and
// quick to access on dashboards (company and individuals) and better
// navigation through the page … make the names of the pledgers shown
// and also have better informative statistics for all pages … very
// intuitive and easy to navigate since it is where the company gets
// its capital."
// Confirmed: every member sees pledgers' names AND amounts.
//
// Everything here is READ-ONLY and derived from the existing tables
// (pledges, pledge payments, payment applications, fines, monthly
// calls). Nothing is stored, so the figures can never drift from the
// books.
//
//   getOverview(user)        one call for the dashboards and the hub:
//                            every active goal, its open month, my
//                            pledge there, what I owe, approvals waiting
//   getPledgers(goalId)      every member by name: pledged, paid,
//                            outstanding, overdue, late payments,
//                            fines, share of the money raised, rank
//   getInsights(goalId)      the goal's statistics (participation,
//                            averages, overdue, pace, forecast, best month)
//   getActivity(goalId)      what happened, newest first
//   getCallMembers(callId)   one month, member by member, by name
//
// All amounts are in the GOAL's currency unless a field says otherwise
// (a pledge's own currency is kept beside it). Pledge payments carry
// their own frozen conversion (converted_amount_goal_currency); a
// pledge not yet paid is converted at the rate on the 1st of its month.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const { getExchangeRateOn } = require('./sharePricingService');
const callService = require('./capitalGoalCallService');
const capitalGoalFunds = require('./capitalGoalFundsService');

const db = { query };
const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v));
const round = (n, dp = 2) => Math.round((Number(n) + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const todayStr = () => new Date().toISOString().slice(0, 10);
const thisPeriod = () => todayStr().slice(0, 7);
const dateStr = (d) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)) : null);
const addDays = (date, days) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};
const addMonths = (period, n) => {
    const [y, m] = period.split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const monthsBetween = (a, b) => { // whole months from period a to period b
    const [ya, ma] = a.split('-').map(Number);
    const [yb, mb] = b.split('-').map(Number);
    return (yb * 12 + mb) - (ya * 12 + ma);
};

// Lazy: capitalGoalsController requires this file's callers.
const progressOf = (goal, opts) => require('../controllers/capitalGoalsController').computeGoalProgress(goal, opts);

const loadGoal = async (goalId) => {
    const r = await query(`
        SELECT g.*, rr.reference_code, rr.public_id, c.code AS currency_code, c.symbol AS currency_symbol
        FROM   capital_goals g
        JOIN   references_registry rr ON rr.id = g.reference_id
        JOIN   currencies c ON c.id = g.currency_id
        WHERE  g.id = $1
    `, [goalId]);
    if (!r.rows.length) throw createError.notFound('Capital goal not found');
    return r.rows[0];
};

const activeShareholders = async () => (await query(`
    SELECT DISTINCT u.id, u.first_name || ' ' || u.last_name AS name
    FROM   users u
    JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
    JOIN   roles r       ON r.id = ur.role_id AND r.name = 'Shareholder' AND r.is_active = TRUE
    WHERE  u.is_active = TRUE
`)).rows;

const rateCache = new Map();
const rateToGoal = async (fromId, goalCurrencyId, date) => {
    if (fromId === goalCurrencyId) return 1;
    const key = `${fromId}>${goalCurrencyId}@${date}`;
    if (rateCache.has(key)) return rateCache.get(key);
    let rate = null;
    try { rate = await getExchangeRateOn(db, fromId, goalCurrencyId, date); } catch (_) { rate = null; }
    rateCache.set(key, rate);
    if (rateCache.size > 500) rateCache.clear();
    return rate;
};

// Every pledge of a goal with its payments, in the goal's currency.
const loadPledges = async (goal, { callId = null } = {}) => {
    const params = [goal.id];
    let extra = '';
    if (callId) { params.push(callId); extra = 'AND mc.id = $2'; }
    const r = await query(`
        SELECT p.id, p.user_id, p.iteration, p.status, p.pledged_amount, p.amount_settled, p.currency_id,
               p.submitted_at, p.reviewed_at, p.review_notes,
               cur.code AS currency_code, rr.reference_code,
               mc.id AS monthly_call_id, mc.period, mc.iteration1_deadline::text AS iteration1_deadline,
               mc.iteration2_deadline::text AS iteration2_deadline, mc.status AS call_status,
               u.first_name || ' ' || u.last_name AS member_name,
               COALESCE(SUM(pp.amount), 0) AS paid_own,
               COALESCE(SUM(pp.converted_amount_goal_currency), 0) AS paid_goal,
               COUNT(pp.id)::int AS payments,
               COUNT(pp.id) FILTER (WHERE pp.is_late)::int AS late_payments,
               COALESCE(SUM(f.amount), 0) AS fines_own,
               COUNT(f.id)::int AS fines_count,
               MAX(pp.approved_at) AS last_paid_at
        FROM   capital_goal_pledges p
        JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
        JOIN   currencies cur               ON cur.id = p.currency_id
        JOIN   references_registry rr       ON rr.id = p.reference_id
        JOIN   users u                      ON u.id = p.user_id
        LEFT JOIN capital_goal_pledge_payments pp ON pp.pledge_id = p.id
        LEFT JOIN fines f                         ON f.id = pp.fine_id
        WHERE  mc.capital_goal_id = $1 ${extra}
        GROUP  BY p.id, cur.code, rr.reference_code, mc.id, u.first_name, u.last_name
        ORDER  BY mc.period, p.iteration, p.submitted_at
    `, params);

    const today = todayStr();
    const out = [];
    for (const p of r.rows) {
        const paidOwn = num(p.paid_own);
        const paidGoal = num(p.paid_goal);
        let rate = paidOwn > 0 ? paidGoal / paidOwn : await rateToGoal(p.currency_id, goal.currency_id, `${p.period}-01`);
        if (rate === null) rate = 1; // no rate known: show as-is (rare; pledges are normally in the goal's currency)
        const pledgedGoal = round(num(p.pledged_amount) * rate);
        const rejected = p.status === 'REJECTED';
        const outstandingOwn = rejected || p.status === 'FULFILLED' ? 0 : Math.max(0, num(p.pledged_amount) - num(p.amount_settled));
        const outstandingGoal = round(outstandingOwn * rate);
        const deadline = p.iteration === 2 ? p.iteration2_deadline : p.iteration1_deadline;
        const overdue = outstandingGoal > 0 && deadline && deadline < today;
        out.push({
            ...p,
            pledged_amount: num(p.pledged_amount), amount_settled: num(p.amount_settled),
            paid_own: round(paidOwn), paid_goal: round(paidGoal),
            pledged_goal: rejected ? 0 : pledgedGoal,
            outstanding_own: round(outstandingOwn), outstanding_goal: outstandingGoal,
            fines_goal: round(num(p.fines_own) * rate),
            deadline, overdue,
        });
    }
    return out;
};

// Contributions before a goal's effective month (only when the goal was
// adopted part-way through: from its start date up to effective_from),
// per member, in the goal's currency — whole calendar months, the same
// months the goal itself shows as "Historical" (start month up to, not
// including, the effective month).
const historicalByUser = async (goal) => {
    if (!goal.effective_from) return {};
    const r = await query(`
        SELECT user_id, amount, currency_id, contribution_date::text AS d
        FROM   shareholder_contributions
        WHERE  status = 'APPROVED'
        AND    to_char(contribution_date, 'YYYY-MM') >= $1 AND to_char(contribution_date, 'YYYY-MM') < $2
    `, [dateStr(goal.start_date).slice(0, 7), dateStr(goal.effective_from).slice(0, 7)]);
    const byUser = {};
    for (const row of r.rows) {
        const rate = await rateToGoal(row.currency_id, goal.currency_id, row.d);
        if (rate === null) continue;
        byUser[row.user_id] = (byUser[row.user_id] || 0) + num(row.amount) * rate;
    }
    return byUser;
};

// ------------------------------------------------------------
// PLEDGERS — every member by name
// ------------------------------------------------------------
const getPledgers = async (goalId, { goal: preloaded = null, pledges: preloadedPledges = null } = {}) => {
    const goal = preloaded || await loadGoal(goalId);
    const pledges = preloadedPledges || await loadPledges(goal);
    const historical = await historicalByUser(goal);
    const members = new Map();
    const member = (id, name) => {
        if (!members.has(id)) {
            members.set(id, {
                user_id: id, name, is_shareholder: false,
                pledged: 0, paid: 0, historical: 0, outstanding: 0, overdue: 0,
                pledges: 0, months_pledged: new Set(), months_paid_in_full: 0,
                payments: 0, late_payments: 0, fines: 0, fines_count: 0, rejected: 0,
                last_paid_at: null,
            });
        }
        return members.get(id);
    };
    for (const s of await activeShareholders()) member(s.id, s.name).is_shareholder = true;

    for (const p of pledges) {
        const m = member(p.user_id, p.member_name);
        if (p.status === 'REJECTED') { m.rejected++; continue; }
        m.pledges++;
        m.months_pledged.add(p.period);
        m.pledged += p.pledged_goal;
        m.paid += p.paid_goal;
        m.outstanding += p.outstanding_goal;
        if (p.overdue) m.overdue += p.outstanding_goal;
        if (p.status === 'FULFILLED') m.months_paid_in_full++;
        m.payments += p.payments;
        m.late_payments += p.late_payments;
        m.fines += p.fines_goal;
        m.fines_count += p.fines_count;
        if (p.last_paid_at && (!m.last_paid_at || p.last_paid_at > m.last_paid_at)) m.last_paid_at = p.last_paid_at;
    }
    for (const [userId, amount] of Object.entries(historical)) {
        const m = members.get(parseInt(userId, 10));
        if (m) m.historical += amount;
    }

    const rows = [...members.values()].map(m => {
        const contributed = m.paid + m.historical;
        let status = 'NO_PLEDGE';
        if (m.overdue > 0.004) status = 'OVERDUE';
        else if (m.outstanding > 0.004) status = 'OWES';
        else if (m.pledges > 0 || contributed > 0) status = 'UP_TO_DATE';
        return {
            ...m,
            months_pledged: m.months_pledged.size,
            pledged: round(m.pledged), paid: round(m.paid), historical: round(m.historical),
            contributed: round(contributed),
            outstanding: round(m.outstanding), overdue: round(m.overdue), fines: round(m.fines),
            fulfilment_pct: m.pledged > 0 ? round((m.paid / m.pledged) * 100, 1) : null,
            on_time_pct: m.payments > 0 ? round(((m.payments - m.late_payments) / m.payments) * 100, 1) : null,
            status,
        };
    });
    const totalContributed = rows.reduce((s, r) => s + r.contributed, 0);
    const target = num(goal.target_amount);
    rows.sort((a, b) => b.contributed - a.contributed || b.pledged - a.pledged || a.name.localeCompare(b.name));
    let rank = 0;
    let prev = null;
    rows.forEach((r, i) => {
        if (r.contributed !== prev) { rank = i + 1; prev = r.contributed; }
        r.rank = r.contributed > 0 ? rank : null;
        r.share_of_collected_pct = totalContributed > 0 ? round((r.contributed / totalContributed) * 100, 1) : 0;
        r.share_of_target_pct = target > 0 ? round((r.contributed / target) * 100, 1) : 0;
    });
    return {
        goal: { id: goal.id, title: goal.title, reference_code: goal.reference_code, currency_code: goal.currency_code, target_amount: target },
        members: rows,
        totals: {
            members: rows.filter(r => r.is_shareholder).length,
            pledgers: rows.filter(r => r.pledges > 0).length,
            contributors: rows.filter(r => r.contributed > 0).length,
            contributed: round(totalContributed),
            outstanding: round(rows.reduce((s, r) => s + r.outstanding, 0)),
            overdue: round(rows.reduce((s, r) => s + r.overdue, 0)),
        },
    };
};

// ------------------------------------------------------------
// INSIGHTS — the goal's statistics
// ------------------------------------------------------------
const getInsights = async (goalId) => {
    const goal = await loadGoal(goalId);
    const progress = await progressOf(goal, { withMonths: true });
    const pledges = await loadPledges(goal);
    const pledgers = await getPledgers(goalId, { goal, pledges });
    const live = pledges.filter(p => p.status !== 'REJECTED');
    const target = num(goal.target_amount);
    const collected = num(progress.total_collected);
    const now = thisPeriod();

    const months = progress.months || [];
    const pastOrCurrent = months.filter(m => m.month <= now);
    const closed = months.filter(m => m.call_status === 'CLOSED' || (!m.call_status && m.month < now));
    const metTarget = pastOrCurrent.filter(m => m.actual_monthly >= m.expected_monthly - 0.005 && m.expected_monthly > 0);
    const best = months.reduce((b, m) => (!b || m.actual_monthly > b.actual_monthly ? m : b), null);

    // Pace: average collected per month so far (months up to and
    // including the current one), and where that leads.
    const elapsed = Math.max(1, pastOrCurrent.length);
    const pace = collected / elapsed;
    const remaining = Math.max(0, target - collected);
    const monthsLeft = months.filter(m => m.month > now).length;
    const lastPeriod = months.length ? months[months.length - 1].month : null;
    let projectedFinish = null;
    if (remaining <= 0.004) projectedFinish = 'REACHED';
    else if (pace > 0) projectedFinish = addMonths(now, Math.ceil(remaining / pace));
    const projectedAtEnd = round(collected + pace * monthsLeft);

    const lateCount = live.reduce((s, p) => s + p.late_payments, 0);
    const paymentsCount = live.reduce((s, p) => s + p.payments, 0);
    const outstanding = live.reduce((s, p) => s + p.outstanding_goal, 0);
    const overdue = live.reduce((s, p) => s + (p.overdue ? p.outstanding_goal : 0), 0);
    const totalPledged = live.reduce((s, p) => s + p.pledged_goal, 0);
    const totalPaid = live.reduce((s, p) => s + p.paid_goal, 0);

    let funds = null;
    if (goal.investment_id) {
        try { funds = (await capitalGoalFunds.computeGoalFunds(db, goal.id)).totals; } catch (_) { funds = null; }
    }

    return {
        goal_id: goal.id,
        currency_code: goal.currency_code,
        target, collected,
        percent_of_target: num(progress.percent_of_target),
        expected_to_date: num(progress.expected_to_date),
        gap_to_expected: round(collected - num(progress.expected_to_date)),
        progress_status: progress.progress_status,
        participation: {
            members: pledgers.totals.members,
            pledgers: pledgers.totals.pledgers,
            contributors: pledgers.totals.contributors,
            participation_pct: pledgers.totals.members > 0 ? round((pledgers.totals.pledgers / pledgers.totals.members) * 100, 1) : 0,
            members_overdue: pledgers.members.filter(m => m.status === 'OVERDUE').length,
            members_without_pledge: pledgers.members.filter(m => m.is_shareholder && m.status === 'NO_PLEDGE').length,
        },
        pledges: {
            count: live.length,
            rejected: pledges.length - live.length,
            total_pledged: round(totalPledged),
            total_paid: round(totalPaid),
            fulfilment_pct: totalPledged > 0 ? round((totalPaid / totalPledged) * 100, 1) : null,
            average_pledge: live.length ? round(totalPledged / live.length) : 0,
            average_payment: paymentsCount ? round(totalPaid / paymentsCount) : 0,
            outstanding: round(outstanding),
            overdue: round(overdue),
            payments: paymentsCount,
            late_payments: lateCount,
            on_time_pct: paymentsCount ? round(((paymentsCount - lateCount) / paymentsCount) * 100, 1) : null,
            fines: round(live.reduce((s, p) => s + p.fines_goal, 0)),
            fines_count: live.reduce((s, p) => s + p.fines_count, 0),
        },
        months: {
            total: months.length,
            closed: closed.length,
            met_target: metTarget.length,
            elapsed: pastOrCurrent.length,
            remaining: monthsLeft,
            best: best && best.actual_monthly > 0 ? { month: best.month, amount: best.actual_monthly } : null,
            series: months,
        },
        pace: {
            per_month: round(pace),
            needed_per_month: monthsLeft > 0 ? round(remaining / monthsLeft) : round(remaining),
            remaining: round(remaining),
            projected_finish: projectedFinish,
            projected_total_at_end: projectedAtEnd,
            on_pace: projectedFinish === 'REACHED' || (lastPeriod !== null && projectedFinish !== null && projectedFinish <= lastPeriod),
            last_month: lastPeriod,
        },
        top_contributors: pledgers.members.filter(m => m.contributed > 0).slice(0, 5)
            .map(m => ({ user_id: m.user_id, name: m.name, contributed: m.contributed, share_of_collected_pct: m.share_of_collected_pct })),
        funds,
    };
};

// ------------------------------------------------------------
// ACTIVITY — newest first
// ------------------------------------------------------------
const getActivity = async (goalId, { limit = 80 } = {}) => {
    const goal = await loadGoal(goalId);
    const events = [];
    const pledgesR = await query(`
        SELECT p.id, p.iteration, p.status, p.pledged_amount, p.submitted_at, p.reviewed_at, p.review_notes,
               cur.code AS currency_code, mc.id AS monthly_call_id, mc.period, rr.reference_code,
               u.first_name || ' ' || u.last_name AS member_name,
               rv.first_name || ' ' || rv.last_name AS reviewer_name
        FROM   capital_goal_pledges p
        JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
        JOIN   currencies cur ON cur.id = p.currency_id
        JOIN   references_registry rr ON rr.id = p.reference_id
        JOIN   users u ON u.id = p.user_id
        LEFT JOIN users rv ON rv.id = p.reviewed_by
        WHERE  mc.capital_goal_id = $1
    `, [goal.id]);
    for (const p of pledgesR.rows) {
        events.push({
            at: p.submitted_at, type: 'PLEDGE', member_name: p.member_name, monthly_call_id: p.monthly_call_id, period: p.period,
            reference_code: p.reference_code, amount: num(p.pledged_amount), currency_code: p.currency_code,
            text: `${p.member_name} pledged ${p.currency_code} ${num(p.pledged_amount).toLocaleString('en-US')} for ${p.period}${p.iteration === 2 ? ' (round 2)' : ''}`,
        });
        if (p.status === 'REJECTED' && p.reviewed_at) {
            events.push({
                at: p.reviewed_at, type: 'PLEDGE_REJECTED', member_name: p.member_name, monthly_call_id: p.monthly_call_id, period: p.period,
                reference_code: p.reference_code,
                text: `${p.member_name}'s pledge for ${p.period} was rejected${p.reviewer_name ? ` by ${p.reviewer_name}` : ''}${p.review_notes ? ` — ${p.review_notes}` : ''}`,
            });
        }
    }
    const paysR = await query(`
        SELECT pp.id, pp.amount, pp.converted_amount_goal_currency, pp.approved_at, pp.is_late, pp.days_late,
               cur.code AS currency_code, mc.id AS monthly_call_id, mc.period, p.iteration,
               u.first_name || ' ' || u.last_name AS member_name,
               ap.first_name || ' ' || ap.last_name AS approver_name,
               f.amount AS fine_amount, trr.reference_code AS transaction_reference
        FROM   capital_goal_pledge_payments pp
        JOIN   capital_goal_pledges p ON p.id = pp.pledge_id
        JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
        JOIN   currencies cur ON cur.id = p.currency_id
        JOIN   users u ON u.id = p.user_id
        JOIN   users ap ON ap.id = pp.approved_by
        LEFT JOIN fines f ON f.id = pp.fine_id
        LEFT JOIN transactions t ON t.id = pp.transaction_id
        LEFT JOIN references_registry trr ON trr.id = t.reference_id
        WHERE  mc.capital_goal_id = $1
    `, [goal.id]);
    for (const x of paysR.rows) {
        events.push({
            at: x.approved_at, type: x.is_late ? 'PAYMENT_LATE' : 'PAYMENT', member_name: x.member_name,
            monthly_call_id: x.monthly_call_id, period: x.period, reference_code: x.transaction_reference,
            amount: num(x.amount), currency_code: x.currency_code, goal_amount: num(x.converted_amount_goal_currency),
            text: `${x.member_name} paid ${x.currency_code} ${num(x.amount).toLocaleString('en-US')} for ${x.period} — approved by ${x.approver_name}` +
                (x.is_late ? ` (${x.days_late} day(s) late${x.fine_amount ? `, fine ${x.currency_code} ${num(x.fine_amount).toLocaleString('en-US')}` : ''})` : ''),
        });
    }
    if (goal.investment_id) {
        try {
            const funds = await capitalGoalFunds.computeGoalFunds(db, goal.id);
            for (const t of funds.transfers) {
                events.push({
                    at: t.created_at, type: 'TRANSFER', reference_code: t.reference_code,
                    text: `${t.created_by_name} started moving ${t.currency_sent_code} ${num(t.amount_sent).toLocaleString('en-US')} from ${t.from_account_name} to ${t.to_account_name}` +
                        (t.currency_sent_id !== t.currency_received_id ? ` at ${num(t.exchange_rate).toLocaleString('en-US')} (${t.currency_received_code} ${num(t.amount_received).toLocaleString('en-US')})` : '') +
                        ` — ${t.status === 'POSTED' ? 'approved' : t.status.toLowerCase().replace('_', ' ')}`,
                });
            }
            for (const f of funds.fundings) {
                events.push({
                    at: f.created_at, type: f.is_reversed ? 'INVESTED_REVERSED' : 'INVESTED', reference_code: f.reference_code,
                    text: `${f.currency_code} ${num(f.amount).toLocaleString('en-US')} invested into ${f.investment_name}${f.is_reversed ? ' — later reversed' : ''}`,
                });
            }
        } catch (_) { /* migration not run yet — no money-flow events */ }
    }
    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    return events.slice(0, limit);
};

// ------------------------------------------------------------
// ONE MONTH, MEMBER BY MEMBER (by name)
// ------------------------------------------------------------
const getCallMembers = async (callId) => {
    const callR = await query(`
        SELECT mc.*, mc.iteration1_deadline::text AS iteration1_deadline, mc.iteration2_deadline::text AS iteration2_deadline
        FROM capital_goal_monthly_calls mc WHERE mc.id = $1`, [callId]);
    if (!callR.rows.length) throw createError.notFound('Monthly call not found');
    const call = callR.rows[0];
    const goal = await loadGoal(call.capital_goal_id);
    const pledges = await loadPledges(goal, { callId });
    const today = todayStr();
    const rows = new Map();
    for (const s of await activeShareholders()) {
        rows.set(s.id, { user_id: s.id, name: s.name, pledges: [], is_shareholder: true });
    }
    for (const p of pledges) {
        if (!rows.has(p.user_id)) rows.set(p.user_id, { user_id: p.user_id, name: p.member_name, pledges: [], is_shareholder: false });
        rows.get(p.user_id).pledges.push(p);
    }
    const members = [...rows.values()].map(r => {
        const live = r.pledges.filter(p => p.status !== 'REJECTED');
        const shown = live.find(p => p.iteration === 2) || live.find(p => p.iteration === 1) || null;
        let status = 'NOT_RESPONDED';
        if (shown) {
            if (shown.status === 'FULFILLED') status = 'PAID';
            else if (shown.status === 'PARTIAL') status = shown.deadline && shown.deadline < today ? 'PARTIAL_OVERDUE' : 'PARTIALLY_PAID';
            else status = shown.iteration === 1 && call.iteration1_deadline < today ? 'DEFAULTED' : 'PLEDGED';
        }
        return {
            user_id: r.user_id, name: r.name, is_shareholder: r.is_shareholder, status,
            pledged: round(live.reduce((s, p) => s + p.pledged_goal, 0)),
            paid: round(live.reduce((s, p) => s + p.paid_goal, 0)),
            outstanding: round(live.reduce((s, p) => s + p.outstanding_goal, 0)),
            late_payments: live.reduce((s, p) => s + p.late_payments, 0),
            pledges: r.pledges.map(p => ({
                id: p.id, reference_code: p.reference_code, iteration: p.iteration, status: p.status,
                pledged_amount: p.pledged_amount, amount_settled: p.amount_settled, currency_code: p.currency_code,
                pledged_goal: p.pledged_goal, paid_goal: p.paid_goal, submitted_at: p.submitted_at, deadline: p.deadline,
            })),
        };
    });
    const order = { PAID: 0, PARTIALLY_PAID: 1, PARTIAL_OVERDUE: 2, PLEDGED: 3, DEFAULTED: 4, NOT_RESPONDED: 5 };
    members.sort((a, b) => (order[a.status] - order[b.status]) || b.paid - a.paid || a.name.localeCompare(b.name));
    const settled = round(members.reduce((s, m) => s + m.paid, 0));
    const target = num(call.monthly_target);
    const counts = {};
    for (const m of members) counts[m.status] = (counts[m.status] || 0) + 1;
    return {
        call: { id: call.id, period: call.period, status: call.status, monthly_target: target,
                iteration1_deadline: call.iteration1_deadline, iteration2_deadline: call.iteration2_deadline },
        goal: { id: goal.id, title: goal.title, reference_code: goal.reference_code, currency_code: goal.currency_code, goal_type: goal.goal_type },
        members,
        summary: {
            members: members.filter(m => m.is_shareholder).length,
            pledged_members: members.filter(m => m.status !== 'NOT_RESPONDED').length,
            paid_in_full: counts.PAID || 0,
            counts,
            total_pledged: round(members.reduce((s, m) => s + m.pledged, 0)),
            settled, target,
            percent: target > 0 ? round((settled / target) * 100, 1) : 0,
            shortfall: round(Math.max(0, target - settled)),
        },
    };
};

// ------------------------------------------------------------
// OVERVIEW — one call for the dashboards and the hub
// ------------------------------------------------------------
const pickCurrentCall = (calls) => {
    const now = thisPeriod();
    const open = calls.filter(c => c.status === 'ITERATION_1' || c.status === 'ITERATION_2');
    return open.find(c => c.period === now) || open.filter(c => c.period < now).pop() || open[0] || null;
};

const getOverview = async (user) => {
    const tracking = await callService.isCapitalGoalTrackingEnabled(db).catch(() => true);
    const fineSettings = await callService.getFineSettings(db).catch(() => ({ grace_days: 7 }));
    const goalsR = await query(`
        SELECT g.*, rr.reference_code, rr.public_id, c.code AS currency_code, c.symbol AS currency_symbol,
               i.name AS investment_name, i.status AS investment_status, ir.reference_code AS investment_reference
        FROM   capital_goals g
        JOIN   references_registry rr ON rr.id = g.reference_id
        JOIN   currencies c ON c.id = g.currency_id
        LEFT JOIN investments i ON i.id = g.investment_id
        LEFT JOIN references_registry ir ON ir.id = i.reference_id
        WHERE  g.status = 'ACTIVE'
        ORDER  BY (g.goal_type = 'PRIMARY') DESC, g.end_date, g.id
    `).catch(async () => query(`
        SELECT g.*, rr.reference_code, rr.public_id, c.code AS currency_code, c.symbol AS currency_symbol
        FROM capital_goals g JOIN references_registry rr ON rr.id = g.reference_id JOIN currencies c ON c.id = g.currency_id
        WHERE g.status = 'ACTIVE' ORDER BY (g.goal_type = 'PRIMARY') DESC, g.end_date, g.id`));

    const shareholderCount = await callService.getActiveShareholderCount(db).catch(() => 0);
    // Monthly calls are made to shareholders: only they are offered "Pledge".
    const isShareholder = (user.roles || []).includes('Shareholder');
    const goals = [];
    const myOwed = [];
    for (const g of goalsR.rows) {
        const progress = await progressOf(g, { withMonths: false });
        const callsR = await query(`
            SELECT mc.id, mc.period, mc.monthly_target, mc.status, mc.capital_goal_id,
                   mc.iteration1_deadline::text AS iteration1_deadline, mc.iteration2_deadline::text AS iteration2_deadline,
                   COALESCE((SELECT SUM(a.amount) FROM capital_goal_payment_applications a WHERE a.monthly_call_id = mc.id), 0) AS settled
            FROM   capital_goal_monthly_calls mc WHERE mc.capital_goal_id = $1 ORDER BY mc.period
        `, [g.id]);
        const calls = callsR.rows;
        const current = pickCurrentCall(calls);
        let currentCall = null;
        if (current) {
            const iteration = current.status === 'ITERATION_2' ? 2 : 1;
            const pl = await query(`
                SELECT p.id, p.user_id, p.iteration, p.status, p.pledged_amount, p.amount_settled, cur.code AS currency_code
                FROM capital_goal_pledges p JOIN currencies cur ON cur.id = p.currency_id
                WHERE p.monthly_call_id = $1`, [current.id]);
            const live = pl.rows.filter(p => p.status !== 'REJECTED');
            const mine = live.filter(p => p.user_id === user.id);
            const mineNow = mine.find(p => p.iteration === iteration) || null;
            let eligible = true;
            let baseline = null;
            try {
                if (iteration === 1) baseline = await callService.computeIteration1Baseline(db, current);
                else eligible = (await callService.getIteration2EligibleUserIds(db, current.id)).includes(user.id);
            } catch (_) { /* informational only */ }
            const deadline = iteration === 2 ? current.iteration2_deadline : current.iteration1_deadline;
            currentCall = {
                id: current.id, period: current.period, status: current.status, iteration,
                monthly_target: num(current.monthly_target), settled: round(num(current.settled)),
                percent: num(current.monthly_target) > 0 ? round((num(current.settled) / num(current.monthly_target)) * 100, 1) : 0,
                shortfall: round(Math.max(0, num(current.monthly_target) - num(current.settled))),
                deadline,
                // Pay by the deadline to avoid any fine. In round 1 a late
                // payment is fined at the lower rate until higher_fine_from,
                // and at the higher rate after it. Round 2 is never fined.
                pay_by: deadline,
                higher_fine_from: deadline && iteration === 1 ? addDays(deadline, num(fineSettings.grace_days) + 1) : null,
                pledgers: new Set(live.filter(p => p.iteration === iteration).map(p => p.user_id)).size,
                paid_in_full: new Set(live.filter(p => p.status === 'FULFILLED').map(p => p.user_id)).size,
                members: shareholderCount,
                my_pledge: mineNow ? {
                    id: mineNow.id, status: mineNow.status, pledged_amount: num(mineNow.pledged_amount),
                    amount_settled: num(mineNow.amount_settled), currency_code: mineNow.currency_code,
                } : null,
                can_pledge: !mineNow && eligible && tracking && isShareholder,
                eligible, baseline,
            };
        }
        // What I still owe on this goal, and my total paid into it.
        const minePledges = await query(`
            SELECT p.id, p.iteration, p.status, p.pledged_amount, p.amount_settled, cur.code AS currency_code,
                   mc.id AS monthly_call_id, mc.period,
                   mc.iteration1_deadline::text AS iteration1_deadline, mc.iteration2_deadline::text AS iteration2_deadline,
                   COALESCE((SELECT SUM(pp.converted_amount_goal_currency) FROM capital_goal_pledge_payments pp WHERE pp.pledge_id = p.id), 0) AS paid_goal
            FROM capital_goal_pledges p
            JOIN capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
            JOIN currencies cur ON cur.id = p.currency_id
            WHERE mc.capital_goal_id = $1 AND p.user_id = $2 AND p.status <> 'REJECTED'
        `, [g.id, user.id]);
        let myPaid = 0;
        for (const p of minePledges.rows) {
            myPaid += num(p.paid_goal);
            const owed = Math.max(0, num(p.pledged_amount) - num(p.amount_settled));
            if (p.status === 'PENDING' || p.status === 'PARTIAL') {
                if (owed > 0.004) {
                    const deadline = p.iteration === 2 ? p.iteration2_deadline : p.iteration1_deadline;
                    myOwed.push({
                        goal_id: g.id, goal_title: g.title, goal_type: g.goal_type, pledge_id: p.id, monthly_call_id: p.monthly_call_id,
                        period: p.period, iteration: p.iteration, currency_code: p.currency_code, owed: round(owed),
                        deadline, pay_by: deadline,
                        higher_fine_from: deadline && p.iteration === 1 ? addDays(deadline, num(fineSettings.grace_days) + 1) : null,
                        overdue: !!deadline && deadline < todayStr(),
                    });
                }
            }
        }
        let funds = null;
        if (g.investment_id) {
            try { funds = (await capitalGoalFunds.computeGoalFunds(db, g.id)).totals; } catch (_) { funds = null; }
        }
        const monthsTotal = calls.length;
        const monthsClosed = calls.filter(c => c.status === 'CLOSED').length;
        goals.push({
            id: g.id, title: g.title, goal_type: g.goal_type, reference_code: g.reference_code,
            currency_code: g.currency_code, target_amount: num(g.target_amount),
            start_date: dateStr(g.start_date), end_date: dateStr(g.end_date), fiscal_year: g.fiscal_year,
            is_call_based: !!g.goal_type,
            ...progress,
            months_total: monthsTotal, months_closed: monthsClosed,
            current_call: currentCall,
            my_paid: round(myPaid),
            investment: g.investment_id ? {
                id: g.investment_id, name: g.investment_name, status: g.investment_status, reference_code: g.investment_reference, funds,
            } : null,
        });
    }

    let approvals = null;
    if ((user.permissions || []).includes('CAPITAL_GOAL_MANAGE')) {
        const r = await query(`
            SELECT p.id, p.status, p.iteration, p.pledged_amount, p.amount_settled, p.submitted_at,
                   cur.code AS currency_code, mc.id AS monthly_call_id, mc.period, g.id AS goal_id, g.title AS goal_title,
                   u.first_name || ' ' || u.last_name AS member_name
            FROM capital_goal_pledges p
            JOIN capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
            JOIN capital_goals g ON g.id = mc.capital_goal_id
            JOIN currencies cur ON cur.id = p.currency_id
            JOIN users u ON u.id = p.user_id
            WHERE p.status IN ('PENDING', 'PARTIAL')
            ORDER BY p.submitted_at
        `);
        approvals = { count: r.rows.length, oldest: r.rows.slice(0, 6).map(x => ({ ...x, pledged_amount: num(x.pledged_amount), amount_settled: num(x.amount_settled) })) };
    }

    myOwed.sort((a, b) => (a.pay_by || '9999') < (b.pay_by || '9999') ? -1 : 1);
    const owedByCurrency = {};
    for (const o of myOwed) owedByCurrency[o.currency_code] = round((owedByCurrency[o.currency_code] || 0) + o.owed);
    return {
        tracking_enabled: tracking,
        is_shareholder: isShareholder,
        grace_days: num(fineSettings.grace_days),
        fines: {
            within_grace_pct: num(fineSettings.fine_percentage_within_grace),
            after_grace_pct: num(fineSettings.fine_percentage_after_grace),
        },
        goals,
        me: {
            owed: myOwed,
            owed_by_currency: owedByCurrency,
            next_due: myOwed[0] || null,
            open_to_pledge: goals.filter(g => g.current_call && g.current_call.can_pledge).length,
        },
        approvals,
    };
};

// ------------------------------------------------------------
// TIE A SECONDARY GOAL TO AN INVESTMENT (existing, or a new proposal)
// Used by createGoal and PUT /capital-goals/:id/investment.
// ------------------------------------------------------------
const attachInvestment = async (client, { goal, investmentId = null, newInvestment = null, user, ipAddress = null }) => {
    const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('./referenceService');
    const { getOrCreateCategory } = require('./categoryService');
    const { logAction, ACTIONS, MODULES } = require('./auditService');
    if (goal.goal_type !== 'SECONDARY') {
        throw createError.badRequest('Only a secondary goal can be tied to an investment — the primary goal raises the year\'s general capital.');
    }
    const ready = await client.query(`
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'capital_goals' AND column_name = 'investment_id') AS ok`);
    if (!ready.rows[0].ok) {
        throw createError.badRequest('Tying a goal to an investment needs the v1.78.0 database update (migration_v1.78.0.sql) — ask the Admin to run it.');
    }
    const perms = user.permissions || [];
    let invId = investmentId ? parseInt(investmentId, 10) : null;

    if (!invId && newInvestment) {
        if (!perms.includes('INVESTMENT_CREATE')) throw createError.forbidden('Creating an investment proposal needs the INVESTMENT_CREATE permission.');
        const name = String(newInvestment.name || '').trim();
        const budget = num(newInvestment.planned_budget);
        if (!name) throw createError.badRequest('Give the proposed investment a name.');
        if (!(budget > 0)) throw createError.badRequest('Give the proposed investment a planned budget greater than zero.');
        const account = await client.query(`SELECT id, account_type, currency_id, name FROM accounts WHERE id = $1 AND is_active = TRUE`, [newInvestment.funding_account_id]);
        if (!account.rows.length) throw createError.notFound('Choose the operational account the investment will be paid from.');
        if (account.rows[0].account_type !== 'SECONDARY') throw createError.badRequest('Investments must be funded from a secondary operational account.');
        let categoryId = newInvestment.category_id ? parseInt(newInvestment.category_id, 10) : null;
        if (!categoryId) {
            categoryId = await getOrCreateCategory(client, {
                module: 'INVESTMENT', name: 'Capital Goal Investments', abbreviation: 'CGI',
                description: 'Investments proposed together with a secondary capital goal (v1.78.0)', createdBy: user.id,
            });
        }
        const { referenceId, referenceCode } = await generateReference(client, MODULE_CODES.INVESTMENT, 'INVEST', 'INVESTMENT', user.id);
        const ins = await client.query(`
            INSERT INTO investments (reference_id, name, description, category_id, funding_account_id, currency_id, planned_budget,
                                     actual_expenditure, returns_account_id, total_returns, status, start_date, expected_end_date,
                                     responsible_user_id, created_by, investment_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $5, 0, 'PENDING', $8, $9, $10, $11, 'STANDARD')
            RETURNING id
        `, [referenceId, name, newInvestment.description || `Proposed with capital goal ${goal.reference_code} — ${goal.title}`,
            categoryId, account.rows[0].id, account.rows[0].currency_id, budget,
            newInvestment.start_date || null, newInvestment.expected_end_date || null,
            newInvestment.responsible_user_id || null, user.id]);
        invId = ins.rows[0].id;
        await linkReferenceToRecord(client, referenceId, invId);
        await client.query(`
            INSERT INTO approval_workflows (workflow_type, record_type, record_id, required_approvals, initiated_by)
            VALUES ('INVESTMENT', 'investments', $1, 1, $2)`, [invId, user.id]);
        await logAction(user.id, ACTIONS.INVESTMENT_CREATED, MODULES.INVESTMENTS, {
            ipAddress, recordType: 'investments', recordId: invId,
            newValues: { referenceCode, name, planned_budget: budget, funding_account_id: account.rows[0].id, capital_goal: goal.reference_code },
            description: `Investment proposal created with capital goal ${goal.reference_code}: ${referenceCode} — ${name}`,
            client,
        });
    }

    if (invId) {
        const inv = await client.query(`
            SELECT i.id, i.name, i.status, rr.reference_code FROM investments i
            JOIN references_registry rr ON rr.id = i.reference_id WHERE i.id = $1`, [invId]);
        if (!inv.rows.length) throw createError.notFound('Investment not found');
        if (['CANCELLED', 'COMPLETED', 'TERMINATED', 'PENDING_TERMINATION'].includes(inv.rows[0].status)) {
            throw createError.badRequest(`${inv.rows[0].reference_code} is ${inv.rows[0].status.toLowerCase()} — choose a pending or active investment.`);
        }
        const other = await client.query(`
            SELECT g.id, rr.reference_code FROM capital_goals g JOIN references_registry rr ON rr.id = g.reference_id
            WHERE g.investment_id = $1 AND g.id <> $2 AND g.status <> 'CANCELLED'`, [invId, goal.id]);
        if (other.rows.length) throw createError.badRequest(`${inv.rows[0].reference_code} is already tied to goal ${other.rows[0].reference_code}.`);
        await client.query('UPDATE capital_goals SET investment_id = $1, updated_at = NOW() WHERE id = $2', [invId, goal.id]);
        await logAction(user.id, ACTIONS.CAPITAL_GOAL_UPDATED || ACTIONS.CAPITAL_GOAL_CREATED, MODULES.FINANCE, {
            ipAddress, recordType: 'capital_goals', recordId: goal.id,
            newValues: { investment_id: invId, investment: inv.rows[0].reference_code },
            description: `Capital goal ${goal.reference_code} tied to investment ${inv.rows[0].reference_code} — ${inv.rows[0].name}`,
            client,
        });
        return { investment_id: invId, reference_code: inv.rows[0].reference_code, name: inv.rows[0].name, status: inv.rows[0].status };
    }

    // Untie: only while none of the goal's money has been moved for it.
    const moved = await client.query(`
        SELECT (SELECT COUNT(*) FROM transfers WHERE capital_goal_id = $1 AND status NOT IN ('REJECTED', 'REVERSED'))
             + (SELECT COUNT(*) FROM investment_funding WHERE capital_goal_id = $1 AND NOT is_reversed) AS n`, [goal.id]);
    if (parseInt(moved.rows[0].n, 10) > 0) {
        throw createError.badRequest('Goal money has already been moved or invested for this investment — it can\'t be untied.');
    }
    await client.query('UPDATE capital_goals SET investment_id = NULL, updated_at = NOW() WHERE id = $1', [goal.id]);
    await logAction(user.id, ACTIONS.CAPITAL_GOAL_UPDATED || ACTIONS.CAPITAL_GOAL_CREATED, MODULES.FINANCE, {
        ipAddress, recordType: 'capital_goals', recordId: goal.id,
        description: `Capital goal ${goal.reference_code} no longer tied to an investment`, client,
    });
    return null;
};

module.exports = { getOverview, getPledgers, getInsights, getActivity, getCallMembers, attachInvestment, loadGoal };
