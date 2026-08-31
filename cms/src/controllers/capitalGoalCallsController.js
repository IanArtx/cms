// ============================================================
// CAPITAL GOAL CALLS CONTROLLER (v1.43.0) — "call on shares"
// Everything about pledging into, and settling, a specific monthly
// call — see capitalGoalCallService.js for all the actual math/rules
// (baseline capping, carry-forward, fines, share issuance). This file
// is thin: validate the request shape, call the service, respond.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const capitalGoalCallService = require('../services/capitalGoalCallService');

// ============================================================
// SUBMIT A PLEDGE
// POST /api/capital-goals/monthly-calls/:monthlyCallId/pledges
// Any authenticated Shareholder. iteration defaults to 1 — a member
// only ever explicitly asks for iteration 2 once they're eligible and
// it's actually open (the service enforces both).
// ============================================================
const submitPledge = asyncHandler(async (req, res) => {
    const { monthlyCallId } = req.params;
    const { iteration, currency_id, pledged_amount } = req.body;

    await withTransaction(async (client) => {
        const { pledge, referenceCode, baseline } = await capitalGoalCallService.submitPledge(client, {
            monthlyCallId: parseInt(monthlyCallId),
            userId: req.user.id,
            iteration: iteration || 1,
            currencyId: currency_id,
            pledgedAmount: pledged_amount,
        });

        sendCreated(res, { pledge_id: pledge.id, reference: referenceCode, baseline },
            `Pledge submitted. Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT MY OWN PLEDGE — only while nothing's been settled against it
// PATCH /api/capital-goals/pledges/:id
// ============================================================
const editPledge = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { pledged_amount, currency_id } = req.body;

    await withTransaction(async (client) => {
        const pledge = await capitalGoalCallService.editPledge(client, {
            pledgeId: parseInt(id),
            userId: req.user.id,
            pledgedAmount: pledged_amount,
            currencyId: currency_id,
        });
        sendSuccess(res, pledge, 'Pledge updated');
    });
});

// ============================================================
// REJECT A PLEDGE — Treasurer, only while nothing's settled
// POST /api/capital-goals/pledges/:id/reject
// ============================================================
const rejectPledge = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { review_notes } = req.body;

    await withTransaction(async (client) => {
        const pledge = await capitalGoalCallService.rejectPledge(client, {
            pledgeId: parseInt(id),
            reviewedBy: req.user.id,
            reviewNotes: review_notes,
        });
        sendSuccess(res, pledge, 'Pledge rejected');
    });
});

// ============================================================
// APPROVE (= SETTLE) A PLEDGE PAYMENT — Treasurer. This is the money-
// moving action: records the payment, issues shares, and (iteration 1
// only, if late) auto-assigns a fine.
// POST /api/capital-goals/pledges/:id/approve
// ============================================================
const approvePledgePayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, account_id, paid_date, notes } = req.body;

    await withTransaction(async (client) => {
        const result = await capitalGoalCallService.approvePledgePayment(client, {
            pledgeId: parseInt(id),
            amount,
            accountId: account_id,
            approvedByUserId: req.user.id,
            paidDate: paid_date,
            notes,
        });

        sendSuccess(res, result,
            result.isLate
                ? `Payment recorded — settled ${result.daysLate} day(s) late, a ${result.fine.percentage}% fine (${result.fine.amount}) was assigned.`
                : 'Payment recorded and shares issued.'
        );
    });
});

// ============================================================
// MY PLEDGES — every pledge I've ever submitted, across every goal,
// plus which currently-open monthly calls I haven't pledged into yet.
// GET /api/capital-goals/my-calls
// ============================================================
const getMyPledges = asyncHandler(async (req, res) => {
    const pledges = await query(`
        SELECT p.*, rr.reference_code,
               mc.period, mc.monthly_target, mc.iteration1_deadline, mc.iteration2_deadline, mc.status AS call_status,
               g.title AS goal_title, g.goal_type, g.fiscal_year,
               cur.code AS currency_code, cur.symbol AS currency_symbol
        FROM   capital_goal_pledges p
        JOIN   references_registry rr        ON rr.id = p.reference_id
        JOIN   capital_goal_monthly_calls mc  ON mc.id = p.monthly_call_id
        JOIN   capital_goals g                ON g.id = mc.capital_goal_id
        JOIN   currencies cur                 ON cur.id = p.currency_id
        WHERE  p.user_id = $1
        ORDER  BY p.submitted_at DESC
    `, [req.user.id]);

    // Monthly calls currently open (either iteration) that this member
    // hasn't pledged into yet for that specific iteration — so the
    // frontend can show "you can still pledge here" prompts.
    const openCalls = await query(`
        SELECT mc.id, mc.period, mc.monthly_target, mc.status, mc.iteration1_deadline, mc.iteration2_deadline,
               g.id AS goal_id, g.title AS goal_title, g.goal_type, g.fiscal_year, g.currency_id,
               cur.code AS currency_code
        FROM   capital_goal_monthly_calls mc
        JOIN   capital_goals g   ON g.id = mc.capital_goal_id
        JOIN   currencies cur    ON cur.id = g.currency_id
        WHERE  mc.status IN ('ITERATION_1', 'ITERATION_2')
        AND    g.status = 'ACTIVE'
        ORDER  BY mc.period
    `);

    const withEligibility = await Promise.all(openCalls.rows.map(async (call) => {
        const iteration = call.status === 'ITERATION_1' ? 1 : 2;
        const already = await query(`
            SELECT id FROM capital_goal_pledges
            WHERE  monthly_call_id = $1 AND user_id = $2 AND iteration = $3
        `, [call.id, req.user.id, iteration]);

        // computeIteration1Baseline/getIteration2EligibleUserIds only
        // ever call `client.query(sql, params)` — a plain { query }
        // wrapper around the bare exported query() function satisfies
        // that shape outside of any transaction, which is fine here
        // since this is a read-only lookup.
        const readOnlyClient = { query };
        let eligible = true;
        let baseline = null;
        if (iteration === 1) {
            baseline = await capitalGoalCallService.computeIteration1Baseline(readOnlyClient, call);
        }
        if (iteration === 2) {
            const eligibleIds = await capitalGoalCallService.getIteration2EligibleUserIds(readOnlyClient, call.id);
            eligible = eligibleIds.includes(req.user.id);
        }

        return {
            ...call,
            iteration,
            already_pledged: already.rows.length > 0,
            eligible,
            baseline,
        };
    }));

    sendSuccess(res, { my_pledges: pledges.rows, open_calls: withEligibility });
});

// ============================================================
// GET PLEDGES FOR A MONTHLY CALL — Treasurer, for the approval queue.
// GET /api/capital-goals/monthly-calls/:id/pledges
// ============================================================
const getPledgesForMonthlyCall = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(`
        SELECT p.*, rr.reference_code,
               u.first_name || ' ' || u.last_name AS member_name,
               cur.code AS currency_code, cur.symbol AS currency_symbol
        FROM   capital_goal_pledges p
        JOIN   references_registry rr ON rr.id = p.reference_id
        JOIN   users u                ON u.id = p.user_id
        JOIN   currencies cur         ON cur.id = p.currency_id
        WHERE  p.monthly_call_id = $1
        ORDER  BY p.iteration, p.submitted_at
    `, [id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// ANONYMOUS STATUS PAGE — one colored cell per shareholder, no names,
// no amounts. Every active shareholder appears exactly once, even if
// they haven't pledged at all yet (status NOT_RESPONDED).
// GET /api/capital-goals/monthly-calls/:id/status
// ============================================================
const getMonthlyCallStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const callResult = await query('SELECT * FROM capital_goal_monthly_calls WHERE id = $1', [id]);
    if (callResult.rows.length === 0) throw createError.notFound('Monthly call not found');
    const monthlyCall = callResult.rows[0];

    const shareholders = await query(`
        SELECT u.id FROM users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id AND r.name = 'Shareholder' AND r.is_active = TRUE
        WHERE  u.is_active = TRUE
    `);

    const pledges = await query(`
        SELECT user_id, iteration, status, pledged_amount, amount_settled
        FROM   capital_goal_pledges
        WHERE  monthly_call_id = $1
    `, [id]);
    const pledgeByUser = {};
    for (const p of pledges.rows) {
        // Iteration 2 takes precedence for display if present.
        if (!pledgeByUser[p.user_id] || p.iteration === 2) pledgeByUser[p.user_id] = p;
    }

    const today = new Date().toISOString().slice(0, 10);
    const cells = shareholders.rows.map(({ id: userId }) => {
        const p = pledgeByUser[userId];
        if (!p) return { status: 'NOT_RESPONDED' };
        if (p.status === 'REJECTED') return { status: 'NOT_RESPONDED' };
        if (p.status === 'FULFILLED') {
            return { status: 'PAID' };
        }
        if (p.status === 'PARTIAL') {
            return { status: 'PARTIALLY_PAID' };
        }
        // PENDING — nothing settled yet. Late only matters for iteration 1.
        const isPastDeadline = p.iteration === 1 && monthlyCall.iteration1_deadline < today;
        return { status: isPastDeadline ? 'DEFAULTED' : 'PLEDGED' };
    });

    sendSuccess(res, { period: monthlyCall.period, status: monthlyCall.status, cells });
});

// ============================================================
// GOAL CONTRIBUTION STATS — personal totals + public top-contributor
// callout, against one specific goal (normally the current year's
// primary goal).
// GET /api/capital-goals/:id/stats
// ============================================================
const getGoalContributionStats = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { byUser, topContributor } = await capitalGoalCallService.computeGoalContributionStats({ query }, parseInt(id));

    sendSuccess(res, {
        my_stats: byUser[req.user.id] || { total: 0, percentage: 0, biggest: 0, smallest: 0, numPayments: 0 },
        top_contributor: topContributor,
    });
});

// ============================================================
// LIST MONTHLY CALLS FOR A GOAL — the goal detail page's own
// month-by-month table (deadlines, targets, status).
// GET /api/capital-goals/:id/monthly-calls
// ============================================================
const listMonthlyCallsForGoal = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(`
        SELECT mc.*, COALESCE(SUM(app.amount), 0) AS settled
        FROM   capital_goal_monthly_calls mc
        LEFT JOIN capital_goal_payment_applications app ON app.monthly_call_id = mc.id
        WHERE  mc.capital_goal_id = $1
        GROUP  BY mc.id
        ORDER  BY mc.period
    `, [id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ONE MONTHLY CALL — its own period/target/deadlines/status plus
// its parent goal's title/currency, so a call's own detail page (the
// anonymous status grid + approval queue) can render a header without
// the caller having to already know the goal it belongs to.
// GET /api/capital-goals/monthly-calls/:id
// ============================================================
const getMonthlyCallById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(`
        SELECT mc.*, COALESCE(SUM(app.amount), 0) AS settled,
               g.id AS goal_id, g.title AS goal_title, g.goal_type, g.fiscal_year,
               cur.code AS currency_code, cur.symbol AS currency_symbol
        FROM   capital_goal_monthly_calls mc
        JOIN   capital_goals g ON g.id = mc.capital_goal_id
        JOIN   currencies cur  ON cur.id = g.currency_id
        LEFT JOIN capital_goal_payment_applications app ON app.monthly_call_id = mc.id
        WHERE  mc.id = $1
        GROUP  BY mc.id, g.id, cur.id, cur.code, cur.symbol
    `, [id]);
    if (result.rows.length === 0) throw createError.notFound('Monthly call not found');
    sendSuccess(res, result.rows[0]);
});

module.exports = {
    submitPledge,
    editPledge,
    rejectPledge,
    approvePledgePayment,
    getMyPledges,
    getPledgesForMonthlyCall,
    getMonthlyCallStatus,
    getGoalContributionStats,
    listMonthlyCallsForGoal,
    getMonthlyCallById,
};
