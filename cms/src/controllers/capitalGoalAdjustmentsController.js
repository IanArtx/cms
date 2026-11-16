// ============================================================
// CAPITAL GOAL ADJUSTMENTS (v1.90.0)
//
// Requested directly (13 Nov):
//   • "pledges can be pardoned with and without penalties by the
//     Treasurer or a Director, with a reason";
//   • "if a person contributes outside pledges (did not pledge but
//     contributed), this section should show that instead of recording
//     them as pledged … each contribution belongs to one goal".
//
//   GET  /capital-goals/contributions/unassigned   approved contributions
//        that belong to no goal, each with the goals covering its date
//   GET  /capital-goals/:id/contributions          the goal's own
//        contributions (with how much went through a pledge)
//   PUT  /capital-goals/contributions/:id/goal     set (or clear) the goal
//        a contribution belongs to — Treasurer / Assistant Treasurer
//   POST /capital-goals/pledges/:id/pardon         pardon what is unpaid
//        on a pledge, with or without waiving its fines — Treasurer or
//        Director, with a reason
//
// Pardoning never touches the books: no money moves. The pledge simply
// stops being owed (status PARDONED, pardoned_amount = what was unpaid).
// The month's shortfall stays a shortfall — the money never came in.
// Waiving a fine marks it WAIVED (it no longer has to be paid); a fine
// already PAID is never undone.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { notify } = require('../services/notificationService');
const { assertActionAllowed } = require('../services/personalAccessService');
const callService = require('../services/capitalGoalCallService');

const num = (v) => (v === null || v === undefined || v === '' ? 0 : parseFloat(v));
const round = (n, dp = 2) => Math.round((Number(n) + Number.EPSILON) * 10 ** dp) / 10 ** dp;
const hasRole = (user, roles) => (user.roles || []).some(r => roles.includes(r));
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

const columnReady = async () => {
    if (!(await callService.goalColumnReady({ query }))) {
        throw createError.badRequest('Run the v1.90.0 database update first (npm run update-db).');
    }
};

// ------------------------------------------------------------
// Contributions that belong to no goal
// ------------------------------------------------------------
const listUnassigned = asyncHandler(async (req, res) => {
    await columnReady();
    const r = await query(`
        SELECT sc.id, sc.user_id, sc.amount, sc.contribution_date::text AS contribution_date,
               cur.code AS currency_code, rr.reference_code,
               u.first_name || ' ' || u.last_name AS member_name,
               COALESCE((SELECT json_agg(json_build_object('id', g.id, 'title', g.title, 'goal_type', g.goal_type, 'status', g.status)
                                         ORDER BY g.goal_type NULLS LAST, g.start_date)
                         FROM capital_goals g
                         WHERE g.status <> 'CANCELLED' AND g.start_date <= sc.contribution_date AND g.end_date >= sc.contribution_date), '[]') AS goals
        FROM   shareholder_contributions sc
        JOIN   users u ON u.id = sc.user_id
        LEFT JOIN currencies cur ON cur.id = sc.currency_id
        LEFT JOIN references_registry rr ON rr.id = sc.reference_id
        WHERE  sc.status = 'APPROVED' AND sc.capital_goal_id IS NULL
        ORDER  BY sc.contribution_date DESC, sc.id DESC
        LIMIT  500`);
    sendSuccess(res, r.rows.map(x => ({ ...x, amount: num(x.amount) })));
});

// ------------------------------------------------------------
// A goal's own contributions
// ------------------------------------------------------------
const listGoalContributions = asyncHandler(async (req, res) => {
    await columnReady();
    const goalId = parseInt(req.params.id, 10);
    const r = await query(`
        SELECT sc.id, sc.user_id, sc.amount, sc.contribution_date::text AS contribution_date,
               cur.code AS currency_code, rr.reference_code,
               u.first_name || ' ' || u.last_name AS member_name,
               COALESCE((SELECT SUM(pp.amount) FROM capital_goal_pledge_payments pp
                         JOIN capital_goal_pledges p ON p.id = pp.pledge_id
                         WHERE pp.shareholder_contribution_id = sc.id AND COALESCE(p.is_system_generated, FALSE) = FALSE), 0) AS through_pledges,
               sc.goal_assigned_at, ab.first_name || ' ' || ab.last_name AS goal_assigned_by_name
        FROM   shareholder_contributions sc
        JOIN   users u ON u.id = sc.user_id
        LEFT JOIN users ab ON ab.id = sc.goal_assigned_by
        LEFT JOIN currencies cur ON cur.id = sc.currency_id
        LEFT JOIN references_registry rr ON rr.id = sc.reference_id
        WHERE  sc.status = 'APPROVED' AND sc.capital_goal_id = $1
        ORDER  BY sc.contribution_date DESC, sc.id DESC`, [goalId]);
    sendSuccess(res, r.rows.map(x => {
        const amount = num(x.amount);
        const through = num(x.through_pledges);
        return { ...x, amount, through_pledges: round(through), without_pledge: round(Math.max(0, amount - through)) };
    }));
});

// ------------------------------------------------------------
// Set or clear the goal of one contribution
// ------------------------------------------------------------
const setContributionGoal = asyncHandler(async (req, res) => {
    if (!hasRole(req.user, ['Treasurer', 'Assistant Treasurer'])) {
        throw createError.forbidden('The goal of a contribution is set by the Treasurer or the Assistant Treasurer.');
    }
    await columnReady();
    const contributionId = parseInt(req.params.id, 10);
    const raw = req.body.capital_goal_id;
    const goalId = raw === null || raw === '' || raw === undefined || raw === 'none' ? null : parseInt(raw, 10);
    const reason = String(req.body.reason || '').trim();

    const out = await withTransaction(async (client) => {
        const c = await client.query(`
            SELECT sc.*, sc.contribution_date::text AS d, u.first_name || ' ' || u.last_name AS member_name,
                   cur.code AS currency_code, g.title AS old_goal_title
            FROM   shareholder_contributions sc
            JOIN   users u ON u.id = sc.user_id
            LEFT JOIN currencies cur ON cur.id = sc.currency_id
            LEFT JOIN capital_goals g ON g.id = sc.capital_goal_id
            WHERE  sc.id = $1 FOR UPDATE OF sc`, [contributionId]);
        if (!c.rows.length) throw createError.notFound('Contribution not found');
        const contribution = c.rows[0];
        if (contribution.status !== 'APPROVED') throw createError.badRequest('Only an approved contribution belongs to a goal.');
        if ((contribution.capital_goal_id || null) === goalId) {
            throw createError.badRequest(goalId ? `It already belongs to "${contribution.old_goal_title}".` : 'It already belongs to no goal.');
        }
        // Money that went into a pledge stays with that pledge's goal:
        // moving it would leave the pledge paid by money of another goal.
        const pays = await client.query(`
            SELECT g.title, rr.reference_code
            FROM   capital_goal_pledge_payments pp
            JOIN   capital_goal_pledges p ON p.id = pp.pledge_id
            JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
            JOIN   capital_goals g ON g.id = mc.capital_goal_id
            JOIN   references_registry rr ON rr.id = p.reference_id
            WHERE  pp.shareholder_contribution_id = $1
            LIMIT  1`, [contributionId]);
        if (pays.rows.length) {
            throw createError.badRequest(
                `This contribution paid pledge ${pays.rows[0].reference_code} of "${pays.rows[0].title}", so it stays with that goal. ` +
                'To move it, the pledge payment would first have to be reversed.');
        }
        let goal = null;
        if (goalId) {
            const g = await client.query(`SELECT id, title, status, start_date::text AS s, end_date::text AS e FROM capital_goals WHERE id = $1`, [goalId]);
            if (!g.rows.length || g.rows[0].status === 'CANCELLED') throw createError.badRequest('The capital goal chosen does not exist or was cancelled.');
            goal = g.rows[0];
            if (contribution.d < goal.s || contribution.d > goal.e) {
                throw createError.badRequest(`"${goal.title}" runs from ${goal.s} to ${goal.e}; this contribution is dated ${contribution.d}.`);
            }
        } else if (reason.length < 5) {
            throw createError.badRequest('Say why this contribution belongs to no goal (at least 5 characters).');
        }
        await client.query(
            `UPDATE shareholder_contributions SET capital_goal_id = $1, goal_assigned_by = $2, goal_assigned_at = NOW() WHERE id = $3`,
            [goalId, req.user.id, contributionId]);
        const text = `${contribution.member_name}'s contribution of ${contribution.currency_code || ''} ${fmt(num(contribution.amount))} (${contribution.d}) ` +
            (goal ? `now belongs to "${goal.title}"` : 'now belongs to no goal') +
            (contribution.old_goal_title ? ` (was "${contribution.old_goal_title}")` : '') + (reason ? ` — ${reason}` : '');
        await logAction(req.user.id, ACTIONS.CONTRIBUTION_GOAL_SET, MODULES.FINANCE, {
            ipAddress: req.ip, recordType: 'shareholder_contributions', recordId: contributionId,
            oldValues: { capital_goal_id: contribution.capital_goal_id }, newValues: { capital_goal_id: goalId, reason: reason || null },
            description: text, client,
        });
        return { id: contributionId, capital_goal_id: goalId, text };
    });
    sendSuccess(res, out, out.text);
});

// ------------------------------------------------------------
// Pardon a pledge
// ------------------------------------------------------------
const pardonPledge = asyncHandler(async (req, res) => {
    if (!hasRole(req.user, ['Treasurer', 'Director'])) {
        throw createError.forbidden('A pledge is pardoned by the Treasurer or a Director.');
    }
    await assertActionAllowed(req.user.id, 'PARDON_PLEDGES');
    const pledgeId = parseInt(req.params.id, 10);
    const reason = String(req.body.reason || '').trim();
    const waive = req.body.waive_penalties === true || req.body.waive_penalties === 'true';
    if (reason.length < 5) throw createError.badRequest('Give the reason for the pardon (at least 5 characters).');

    const out = await withTransaction(async (client) => {
        const r = await client.query(`
            SELECT p.*, cur.code AS currency_code, rr.reference_code, mc.period, mc.capital_goal_id,
                   g.title AS goal_title, u.first_name || ' ' || u.last_name AS member_name
            FROM   capital_goal_pledges p
            JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
            JOIN   capital_goals g ON g.id = mc.capital_goal_id
            JOIN   currencies cur ON cur.id = p.currency_id
            JOIN   references_registry rr ON rr.id = p.reference_id
            JOIN   users u ON u.id = p.user_id
            WHERE  p.id = $1 FOR UPDATE OF p`, [pledgeId]);
        if (!r.rows.length) throw createError.notFound('Pledge not found');
        const p = r.rows[0];
        if (p.user_id === req.user.id) throw createError.forbidden('You cannot pardon your own pledge — another Treasurer or Director must.');
        if (p.is_system_generated) throw createError.badRequest('This pledge was made up by the system from a direct contribution; there is nothing to pardon.');
        if (!['PENDING', 'PARTIAL'].includes(p.status)) {
            throw createError.badRequest(`Only a pledge still owed can be pardoned — this one is ${p.status.toLowerCase()}.`);
        }
        const unpaid = round(Math.max(0, num(p.pledged_amount) - num(p.amount_settled)), 4);
        if (unpaid <= 0.0001) throw createError.badRequest('Nothing is unpaid on this pledge.');

        let waived = [];
        if (waive) {
            const f = await client.query(`
                UPDATE fines SET status = 'WAIVED', waived_at = NOW(), waived_by = $2, waive_reason = $3
                WHERE  status = 'OUTSTANDING'
                AND    id IN (SELECT fine_id FROM capital_goal_pledge_payments WHERE pledge_id = $1 AND fine_id IS NOT NULL)
                RETURNING id, amount`, [pledgeId, req.user.id, `Pledge ${p.reference_code} pardoned: ${reason}`]);
            waived = f.rows;
            for (const fine of waived) {
                await logAction(req.user.id, ACTIONS.FINE_WAIVED, MODULES.FINANCE, {
                    ipAddress: req.ip, recordType: 'fines', recordId: fine.id,
                    description: `Fine of ${p.currency_code} ${fmt(num(fine.amount))} waived with the pardon of pledge ${p.reference_code} — ${reason}`,
                    client,
                });
            }
        }
        await client.query(`
            UPDATE capital_goal_pledges
            SET    status = 'PARDONED', pardoned_at = NOW(), pardoned_by = $2, pardon_reason = $3,
                   pardoned_amount = $4, pardon_waived_penalties = $5
            WHERE  id = $1`, [pledgeId, req.user.id, reason, unpaid, waive]);
        const text = `Pledge ${p.reference_code} of ${p.member_name} (${p.goal_title}, ${p.period}) pardoned: ` +
            `${p.currency_code} ${fmt(unpaid)} unpaid is no longer owed` +
            (waive ? (waived.length ? `; ${waived.length} fine(s) waived` : '; no unpaid fines to waive') : '; fines still stand');
        await logAction(req.user.id, ACTIONS.PLEDGE_PARDONED, MODULES.FINANCE, {
            ipAddress: req.ip, recordType: 'capital_goal_pledges', recordId: pledgeId,
            oldValues: { status: p.status, unpaid },
            newValues: { status: 'PARDONED', pardoned_amount: unpaid, waive_penalties: waive, fines_waived: waived.map(f => f.id) },
            description: `${text} — ${reason}`, client,
        });
        return { text, p, unpaid, waived };
    });
    // tell the member (outside the transaction)
    notify({
        userId: out.p.user_id, type: 'PLEDGE_PARDONED',
        title: `Your pledge for ${out.p.period} was pardoned`,
        body: `${out.p.currency_code} ${fmt(out.unpaid)} still unpaid on pledge ${out.p.reference_code} (${out.p.goal_title}) is no longer owed. ` +
            (waive ? (out.waived.length ? `${out.waived.length} fine(s) on it were waived too. ` : '') : 'Any fine on it still stands. ') +
            `Reason: ${reason}`,
        link: `/capital-goals/${out.p.capital_goal_id}`, module: 'FINANCE', recordType: 'capital_goal_pledges', recordId: pledgeId,
    }).catch(() => {});
    sendSuccess(res, { id: pledgeId, status: 'PARDONED', pardoned_amount: out.unpaid, fines_waived: out.waived.length }, out.text);
});

module.exports = { listUnassigned, listGoalContributions, setContributionGoal, pardonPledge };
