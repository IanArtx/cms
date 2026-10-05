// ============================================================
// CAPITAL GOAL INSIGHTS CONTROLLER (v1.78.0)
// See services/capitalGoalInsightsService.js and
// services/capitalGoalFundsService.js.
//
//   GET /api/capital-goals/overview                  dashboards + hub (any member)
//   GET /api/capital-goals/:id/insights              statistics
//   GET /api/capital-goals/:id/pledgers              every member by name
//   GET /api/capital-goals/:id/activity              newest first
//   GET /api/capital-goals/:id/funds                 Collected → Moved → Invested → Available
//   PUT /api/capital-goals/:id/investment            { investment_id } | { new_investment } | { investment_id: null }
//   GET /api/capital-goals/monthly-calls/:id/members one month, member by member
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const insights = require('../services/capitalGoalInsightsService');
const funds = require('../services/capitalGoalFundsService');

const overview = asyncHandler(async (req, res) => {
    sendSuccess(res, await insights.getOverview(req.user));
});

const goalInsights = asyncHandler(async (req, res) => {
    sendSuccess(res, await insights.getInsights(parseInt(req.params.id, 10)));
});

const pledgers = asyncHandler(async (req, res) => {
    sendSuccess(res, await insights.getPledgers(parseInt(req.params.id, 10)));
});

const activity = asyncHandler(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
    sendSuccess(res, await insights.getActivity(parseInt(req.params.id, 10), { limit }));
});

const callMembers = asyncHandler(async (req, res) => {
    sendSuccess(res, await insights.getCallMembers(parseInt(req.params.id, 10)));
});

const goalFunds = asyncHandler(async (req, res) => {
    // Before migration_v1.78.0.sql: nothing can be tied yet — say so
    // instead of failing.
    if (!(await funds.columnsReady({ query }))) {
        return sendSuccess(res, { ready: false, tied: false, accounts: [], transfers: [], fundings: [], totals: null });
    }
    const out = await funds.computeGoalFunds({ query }, parseInt(req.params.id, 10));
    if (!out.goal.investment_id) {
        return sendSuccess(res, { ...out, tied: false });
    }
    // Accounts the money can be moved from / to (for the guided steps).
    // Names and currencies only — never balances: members who may see
    // the goal do not necessarily have access to company finances.
    const accounts = await query(`
        SELECT a.id, a.name, a.account_type, a.currency_id, c.code AS currency_code
        FROM accounts a JOIN currencies c ON c.id = a.currency_id
        WHERE a.is_active = TRUE AND a.account_type IN ('PRIMARY', 'SECONDARY')
        ORDER BY a.account_type, a.name`);
    sendSuccess(res, { ...out, tied: true, all_accounts: accounts.rows });
});

const setInvestment = asyncHandler(async (req, res) => {
    const goalId = parseInt(req.params.id, 10);
    const { investment_id, new_investment } = req.body;
    const out = await withTransaction(async (client) => {
        const g = await client.query(`
            SELECT g.id, g.goal_type, g.status, g.title, rr.reference_code
            FROM capital_goals g JOIN references_registry rr ON rr.id = g.reference_id
            WHERE g.id = $1 FOR UPDATE OF g`, [goalId]);
        if (!g.rows.length) throw createError.notFound('Capital goal not found');
        if (g.rows[0].status === 'CANCELLED') throw createError.badRequest('This goal is cancelled.');
        return insights.attachInvestment(client, {
            goal: g.rows[0], investmentId: investment_id || null, newInvestment: new_investment || null,
            user: req.user, ipAddress: req.ip,
        });
    });
    sendSuccess(res, out, out ? `Goal tied to investment ${out.reference_code} — ${out.name}.` : 'Goal no longer tied to an investment.');
});

module.exports = { overview, goalInsights, pledgers, activity, callMembers, goalFunds, setInvestment };
