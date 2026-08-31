// ============================================================
// CAPITAL GOALS CONTROLLER (v1.29.0, Section 4.33)
//
// A Treasurer/Director sets a target amount of shareholder capital to
// raise over a date range (e.g. EUR 100,000 from Jan 2026 to Dec
// 2026). A goal never posts a transaction and never touches any
// account balance — it's purely a target measured against actual
// capital contributions (shareholder_contributions, status APPROVED),
// which is deliberately NOT the same thing as an account's
// current_balance: a goal tracks gross capital raised, not a balance
// that also nets in withdrawals/expenses/loans/whatever else moves
// through that account for reasons that have nothing to do with
// fundraising progress.
//
// Nothing about the month-by-month breakdown is stored anywhere —
// computeGoalProgress() derives it fresh every time from target_amount,
// start_date, end_date and a live SUM of contributions, so editing a
// goal's numbers or dates automatically recalculates everything
// downstream with no backfill ever required.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const { generateMonthlyCallsForGoal } = require('../services/capitalGoalCallService');

// ============================================================
// INTERNAL HELPER — compute the expected-vs-actual breakdown for one
// goal. `withMonths` controls whether the full month-by-month series
// (needed for the detail page's chart) is included, or just the
// summary totals (all that the list view needs — cheaper when
// listing many goals at once).
// ============================================================
const computeGoalProgress = async (goal, { withMonths = true } = {}) => {
    const target = parseFloat(goal.target_amount);
    const start = new Date(goal.start_date);
    const end = new Date(goal.end_date);
    const today = new Date();
    const isCallBased = goal.goal_type !== null && goal.goal_type !== undefined;

    // v1.43.0 — a call-based goal's actual collected amount must come
    // from capital_goal_payment_applications (always in the goal's own
    // currency, already correctly converted at time of approval) —
    // NOT raw shareholder_contributions filtered by currency_id, which
    // would silently miss any call paid in a different currency than
    // the goal itself (a call-based goal's pledges are explicitly
    // allowed to be in whatever currency the shareholder chooses).
    // Each month's own target is also the ALREADY-FIXED
    // capital_goal_monthly_calls.monthly_target, not a freshly
    // recomputed target/totalMonths split (they're mathematically the
    // same value, but reading the stored one keeps this in lockstep
    // with whatever the monthly call rows actually say).
    const monthly = isCallBased
        ? await query(`
            SELECT mc.period AS period_label, mc.monthly_target,
                   COALESCE(SUM(app.amount), 0) AS actual_amount
            FROM   capital_goal_monthly_calls mc
            LEFT JOIN capital_goal_payment_applications app ON app.monthly_call_id = mc.id
            WHERE  mc.capital_goal_id = $1
            GROUP  BY mc.id, mc.period, mc.monthly_target
            ORDER  BY mc.period
        `, [goal.id])
        : await query(`
            WITH months AS (
                SELECT generate_series(
                    date_trunc('month', $2::date),
                    date_trunc('month', $3::date),
                    interval '1 month'
                )::date AS month_start
            ),
            actual AS (
                SELECT date_trunc('month', contribution_date)::date AS month_start,
                       SUM(amount) AS actual_amount
                FROM   shareholder_contributions
                WHERE  status = 'APPROVED'
                AND    currency_id = $1
                AND    contribution_date BETWEEN $2 AND $3
                GROUP  BY 1
            )
            SELECT m.month_start, COALESCE(a.actual_amount, 0) AS actual_amount
            FROM   months m
            LEFT JOIN actual a ON a.month_start = m.month_start
            ORDER  BY m.month_start
        `, [goal.currency_id, goal.start_date, goal.end_date]);

    const totalMonths = monthly.rows.length;
    const expectedMonthly = totalMonths > 0 ? target / totalMonths : target;

    let expectedCumulative = 0;
    let actualCumulative = 0;
    const months = monthly.rows.map((row) => {
        const thisMonthExpected = isCallBased ? parseFloat(row.monthly_target) : expectedMonthly;
        expectedCumulative += thisMonthExpected;
        actualCumulative += parseFloat(row.actual_amount);
        return {
            month: isCallBased ? row.period_label : row.month_start.toISOString().slice(0, 7), // 'YYYY-MM'
            expected_monthly: Math.round(thisMonthExpected * 100) / 100,
            actual_monthly: parseFloat(row.actual_amount),
            expected_cumulative: Math.round(expectedCumulative * 100) / 100,
            actual_cumulative: Math.round(actualCumulative * 100) / 100,
        };
    });

    const totalCollected = months.length > 0
        ? months[months.length - 1].actual_cumulative
        : 0;

    // "On track" is judged continuously by elapsed TIME, not whole
    // months — a goal shouldn't look "behind" on day 2 of a 12-month
    // range just because the current month's bucket isn't full yet.
    // Clamped to [start_date, end_date] so a goal not yet started
    // reads as on-track-at-zero, and a goal past its end date is
    // judged against the full target.
    const clampedToday = today < start ? start : (today > end ? end : today);
    const totalDays = Math.max(1, (end - start) / 86400000);
    const elapsedDays = Math.max(0, (clampedToday - start) / 86400000);
    const elapsedFraction = Math.min(1, elapsedDays / totalDays);
    const expectedToDate = Math.round(target * elapsedFraction * 100) / 100;

    const targetReached = totalCollected >= target;
    const periodEnded = today > end;
    // Named progress_status (not "status") deliberately — the goal
    // row already has its own lifecycle `status` column (ACTIVE/
    // COMPLETED/CANCELLED); spreading both into one object under the
    // same key would silently clobber whichever was merged in last.
    let progressStatus;
    if (targetReached) {
        progressStatus = 'TARGET_REACHED';
    } else if (totalCollected >= expectedToDate) {
        progressStatus = 'ON_TRACK';
    } else {
        progressStatus = 'BEHIND';
    }

    return {
        total_months: totalMonths,
        expected_monthly: Math.round(expectedMonthly * 100) / 100,
        total_collected: totalCollected,
        percent_of_target: target > 0 ? Math.round((totalCollected / target) * 1000) / 10 : 0,
        expected_to_date: expectedToDate,
        target_reached: targetReached,
        period_ended: periodEnded,
        progress_status: progressStatus,
        ...(withMonths ? { months } : {}),
    };
};

// ============================================================
// CREATE CAPITAL GOAL (v1.43.0 — Capital Goal Calls)
// POST /api/capital-goals
//
// Every new goal is now either the year's single PRIMARY goal or a
// SECONDARY goal alongside it — both always split into equal monthly
// calls (capitalGoalCallService.generateMonthlyCallsForGoal), pledged
// against by shareholders rather than funded through free-form
// contributions. goal_type/fiscal_year/call_deadline_day are all
// required; only pre-v1.43.0 goals (untouched, historical) have these
// NULL. Exactly one PRIMARY goal per fiscal_year is enforced by the
// database's own partial unique index — caught here and turned into a
// clear error rather than a raw constraint-violation message.
// ============================================================
const createGoal = asyncHandler(async (req, res) => {
    const {
        title, description, target_amount, currency_id, start_date, end_date,
        goal_type, fiscal_year, call_deadline_day,
    } = req.body;

    await withTransaction(async (client) => {
        const currency = await client.query(
            'SELECT id FROM currencies WHERE id = $1 AND is_active = TRUE', [currency_id]
        );
        if (currency.rows.length === 0) {
            throw createError.notFound('Currency not found');
        }

        if (goal_type === 'PRIMARY') {
            const existingPrimary = await client.query(
                "SELECT id, title FROM capital_goals WHERE fiscal_year = $1 AND goal_type = 'PRIMARY'",
                [fiscal_year]
            );
            if (existingPrimary.rows.length > 0) {
                throw createError.badRequest(
                    `${fiscal_year} already has a primary goal ("${existingPrimary.rows[0].title}") — only one is allowed per year.`
                );
            }
        }

        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.CAPITAL_GOAL, 'GOAL', 'CAPITAL_GOAL', req.user.id
        );

        const result = await client.query(`
            INSERT INTO capital_goals (
                reference_id, title, description, target_amount,
                currency_id, start_date, end_date, status, created_by,
                goal_type, fiscal_year, call_deadline_day
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10, $11)
            RETURNING id
        `, [
            referenceId, title.trim(), description || null, target_amount,
            currency_id, start_date, end_date, req.user.id,
            goal_type, fiscal_year, call_deadline_day,
        ]);

        const goalId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, goalId);

        const { totalMonths, monthlyTarget } = await generateMonthlyCallsForGoal(client, {
            capitalGoalId: goalId, startDate: start_date, endDate: end_date,
            targetAmount: target_amount, callDeadlineDay: call_deadline_day,
        });

        await logAction(req.user.id, ACTIONS.CAPITAL_GOAL_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'capital_goals',
            recordId:    goalId,
            newValues:   { referenceCode, title, target_amount, currency_id, start_date, end_date, goal_type, fiscal_year, call_deadline_day, totalMonths, monthlyTarget },
            description: `Capital goal created: ${referenceCode} — ${title} (${target_amount}, ${goal_type} for ${fiscal_year}, ${totalMonths} monthly call(s) of ${monthlyTarget} each)`,
            client,
        });

        sendCreated(res, { goal_id: goalId, reference: referenceCode, total_months: totalMonths, monthly_target: monthlyTarget },
            `Capital goal created with ${totalMonths} monthly call(s). Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT CAPITAL GOAL — only while ACTIVE
// PATCH /api/capital-goals/:id
// ============================================================
const updateGoal = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, description, target_amount, currency_id, start_date, end_date } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM capital_goals WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Capital goal not found');
        }
        const goal = existing.rows[0];

        if (goal.status !== 'ACTIVE') {
            throw createError.badRequest(
                `Only an active goal can be edited. Current status: ${goal.status}`
            );
        }

        // v1.43.0 — a call-based goal (goal_type set) has already had
        // its entire monthly call schedule generated and fixed at
        // creation time (capitalGoalCallService.generateMonthlyCallsForGoal),
        // possibly with real pledges/payments against it already.
        // Changing the target/currency/dates afterwards would desync
        // every monthly_calls row from numbers that no longer add up,
        // so only title/description remain editable for these — a
        // legacy (pre-v1.43.0) goal keeps the full original behavior.
        const isCallBased = goal.goal_type !== null;
        if (isCallBased && (target_amount || currency_id || start_date || end_date)) {
            throw createError.badRequest(
                'The target amount, currency, and dates of a capital goal call cannot be changed once its monthly ' +
                'schedule has been generated — only the title and description can still be edited.'
            );
        }

        if (currency_id) {
            const currency = await client.query(
                'SELECT id FROM currencies WHERE id = $1 AND is_active = TRUE', [currency_id]
            );
            if (currency.rows.length === 0) {
                throw createError.notFound('Currency not found');
            }
        }

        const updated = await client.query(`
            UPDATE capital_goals
            SET    title         = COALESCE($1, title),
                   description   = $2,
                   target_amount = COALESCE($3, target_amount),
                   currency_id   = COALESCE($4, currency_id),
                   start_date    = COALESCE($5, start_date),
                   end_date      = COALESCE($6, end_date),
                   updated_at    = NOW()
            WHERE  id = $7
            RETURNING *
        `, [
            title ? title.trim() : null,
            description !== undefined ? description : goal.description,
            target_amount || null, currency_id || null,
            start_date || null, end_date || null, id,
        ]);

        if (new Date(updated.rows[0].end_date) < new Date(updated.rows[0].start_date)) {
            throw createError.badRequest('End date cannot be before start date');
        }

        await logAction(req.user.id, ACTIONS.CAPITAL_GOAL_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'capital_goals',
            recordId:    parseInt(id),
            oldValues:   goal,
            newValues:   updated.rows[0],
            description: `Capital goal updated: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Capital goal updated');
    });
});

// ============================================================
// CANCEL CAPITAL GOAL
// POST /api/capital-goals/:id/cancel
// ============================================================
const cancelGoal = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await query(`
        UPDATE capital_goals
        SET    status = 'CANCELLED', updated_at = NOW()
        WHERE  id = $1 AND status = 'ACTIVE'
        RETURNING id, title
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Only an active goal can be cancelled, or goal not found');
    }

    await logAction(req.user.id, ACTIONS.CAPITAL_GOAL_CANCELLED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'capital_goals',
        recordId:    parseInt(id),
        description: `Capital goal cancelled: ID ${id} — ${result.rows[0].title}${reason ? ` — Reason: ${reason}` : ''}`,
    });

    sendSuccess(res, null, 'Capital goal cancelled');
});

// ============================================================
// MARK CAPITAL GOAL AS COMPLETED
// POST /api/capital-goals/:id/complete
// Manual, same reasoning as Events (Section 4.15) — no automatic
// "the end date has passed" job, since a Treasurer may want to close
// a goal early (target reached ahead of schedule) or keep it open
// past its end date while late contributions are still being chased.
// ============================================================
const completeGoal = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE capital_goals
        SET    status = 'COMPLETED', updated_at = NOW()
        WHERE  id = $1 AND status = 'ACTIVE'
        RETURNING id, title
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Only an active goal can be marked completed, or goal not found');
    }

    await logAction(req.user.id, ACTIONS.CAPITAL_GOAL_UPDATED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'capital_goals',
        recordId:    parseInt(id),
        description: `Capital goal marked completed: ID ${id} — ${result.rows[0].title}`,
    });

    sendSuccess(res, null, 'Capital goal marked as completed');
});

// ============================================================
// GET ALL CAPITAL GOALS (list view — summary progress only)
// GET /api/capital-goals?status=ACTIVE
// ============================================================
const getAllGoals = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`g.status = $${p}`);
        params.push(status.toUpperCase());
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM capital_goals g ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            g.id, g.title, g.description, g.target_amount, g.start_date, g.end_date,
            g.status, g.created_at,
            r.reference_code, r.public_id,
            c.code AS currency_code, c.symbol AS currency_symbol,
            u.first_name || ' ' || u.last_name AS created_by_name
        FROM  capital_goals g
        JOIN  references_registry r ON r.id = g.reference_id
        JOIN  currencies c          ON c.id = g.currency_id
        JOIN  users u                ON u.id = g.created_by
        ${where}
        ORDER BY g.status = 'ACTIVE' DESC, g.end_date ASC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    const rowsWithProgress = await Promise.all(result.rows.map(async (row) => {
        const progress = await computeGoalProgress(row, { withMonths: false });
        return { ...row, ...progress };
    }));

    sendPaginated(res, rowsWithProgress, total, page, limit);
});

// ============================================================
// GET SINGLE CAPITAL GOAL WITH FULL MONTH-BY-MONTH PROGRESS
// GET /api/capital-goals/:id
// ============================================================
const getGoalById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            g.*,
            r.reference_code, r.public_id,
            c.code AS currency_code, c.symbol AS currency_symbol,
            u.first_name || ' ' || u.last_name AS created_by_name
        FROM  capital_goals g
        JOIN  references_registry r ON r.id = g.reference_id
        JOIN  currencies c          ON c.id = g.currency_id
        JOIN  users u                ON u.id = g.created_by
        WHERE g.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Capital goal not found');
    }

    const goal = result.rows[0];
    const progress = await computeGoalProgress(goal, { withMonths: true });

    sendSuccess(res, { ...goal, ...progress });
});

module.exports = {
    createGoal,
    updateGoal,
    cancelGoal,
    completeGoal,
    getAllGoals,
    getGoalById,
};
