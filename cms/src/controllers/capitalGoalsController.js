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
const {
    generateMonthlyCallsForGoal, catchUpMonthlyCalls, getFineSettings,
    isHistoricalPeriod, getHistoricalPeriodCollected,
    isCapitalGoalTrackingEnabled, getCapitalGoalSettings,
} = require('../services/capitalGoalCallService');

// ============================================================
// EFFECTIVE-DATE VALIDATION (v1.51.0) — shared by createGoal and
// activateCallSchedule. Must be the 1st of a month (matches the
// database's own CHECK constraint — validated here too so a bad value
// fails with a clear message instead of a raw constraint error) and,
// when supplied, fall within [start_date, end_date] — an effective
// date outside the goal's own range wouldn't correspond to any
// generated monthly call at all.
// ============================================================
const validateEffectiveFrom = (effectiveFrom, startDate, endDate) => {
    if (!effectiveFrom) return null;
    const d = new Date(effectiveFrom);
    if (isNaN(d.getTime())) {
        throw createError.badRequest('effective_from is not a valid date');
    }
    if (d.getUTCDate() !== 1) {
        throw createError.badRequest('effective_from must be the 1st day of a month');
    }
    if (new Date(effectiveFrom) < new Date(startDate) || new Date(effectiveFrom) > new Date(endDate)) {
        throw createError.badRequest('effective_from must fall within the goal\'s start and end dates');
    }
    return effectiveFrom;
};

// Guard used by every write-endpoint below — capital goal tracking is
// not compulsory (per the feature request) and an Admin can pause the
// entire feature; existing data stays untouched and reads keep
// working, but nothing new can be written while paused.
const assertTrackingEnabled = async () => {
    if (!(await isCapitalGoalTrackingEnabled({ query }))) {
        throw createError.badRequest(
            'Capital Goal Tracking is currently turned off for this company. An Admin can re-enable it in Settings.'
        );
    }
};

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
            SELECT mc.id AS monthly_call_id, mc.period AS period_label, mc.monthly_target,
                   mc.status AS call_status, mc.iteration1_deadline, mc.iteration2_deadline,
                   COALESCE(SUM(app.amount), 0) AS actual_amount
            FROM   capital_goal_monthly_calls mc
            LEFT JOIN capital_goal_payment_applications app ON app.monthly_call_id = mc.id
            WHERE  mc.capital_goal_id = $1
            GROUP  BY mc.id, mc.period, mc.monthly_target, mc.status, mc.iteration1_deadline, mc.iteration2_deadline
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

    // v1.51.0 — a historical (pre-effective-date) monthly call was
    // generated already CLOSED with nothing ever written to
    // capital_goal_payment_applications (see capitalGoalCallService's
    // own getPeriodCollected) — so its raw actual_amount above is
    // always 0. Substitute the same read-only aggregate of real
    // shareholder_contributions that getPeriodCollected itself would
    // return, so the goal's own progress view isn't misleadingly blank
    // for every month before the goal formally started calling.
    if (isCallBased && goal.effective_from) {
        for (const row of monthly.rows) {
            if (isHistoricalPeriod(row.period_label, goal)) {
                row.actual_amount = await getHistoricalPeriodCollected({ query }, row.period_label, goal.currency_id);
            }
        }
    }

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
            // Only present for a call-based goal — lets the frontend
            // highlight whichever period is currently open for pledging
            // without a second round-trip to /capital-goals/my-calls.
            ...(isCallBased ? {
                monthly_call_id: row.monthly_call_id,
                call_status: row.call_status,
                iteration1_deadline: row.iteration1_deadline,
                iteration2_deadline: row.iteration2_deadline,
                // v1.51.0 — lets the frontend show this month read-only
                // (no pledge UI) with its aggregate figure, rather than
                // implying pledging is possible on a period that will
                // never receive one.
                is_historical: goal.effective_from ? isHistoricalPeriod(row.period_label, goal) : false,
            } : {}),
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
        goal_type, fiscal_year, call_deadline_day, effective_from,
    } = req.body;

    await assertTrackingEnabled();
    const validatedEffectiveFrom = validateEffectiveFrom(effective_from, start_date, end_date);

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
                goal_type, fiscal_year, call_deadline_day, effective_from
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10, $11, $12)
            RETURNING id
        `, [
            referenceId, title.trim(), description || null, target_amount,
            currency_id, start_date, end_date, req.user.id,
            goal_type, fiscal_year, call_deadline_day, validatedEffectiveFrom,
        ]);

        const goalId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, goalId);

        const { totalMonths, monthlyTarget } = await generateMonthlyCallsForGoal(client, {
            capitalGoalId: goalId, startDate: start_date, endDate: end_date,
            targetAmount: target_amount, callDeadlineDay: call_deadline_day,
            effectiveFrom: validatedEffectiveFrom,
        });

        await logAction(req.user.id, ACTIONS.CAPITAL_GOAL_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'capital_goals',
            recordId:    goalId,
            newValues:   { referenceCode, title, target_amount, currency_id, start_date, end_date, goal_type, fiscal_year, call_deadline_day, effective_from: validatedEffectiveFrom, totalMonths, monthlyTarget },
            description: `Capital goal created: ${referenceCode} — ${title} (${target_amount}, ${goal_type} for ${fiscal_year}, ${totalMonths} monthly call(s) of ${monthlyTarget} each${validatedEffectiveFrom ? `, effective from ${validatedEffectiveFrom}` : ''})`,
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

    await assertTrackingEnabled();

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

    await assertTrackingEnabled();

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

    await assertTrackingEnabled();

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
            g.status, g.created_at, g.goal_type, g.currency_id, g.effective_from,
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

// ============================================================
// ACTIVATE CALL SCHEDULE (v1.48.0)
// POST /api/capital-goals/:id/activate-call-schedule
//
// Requested directly: "the capital calling system isn't active yet
// as planned. There is no way for any shareholder to make a pledge
// for the monthly targets." Root cause — a capital goal created
// before v1.43.0 (or any goal whose monthly schedule never got
// generated for some other reason) has goal_type/fiscal_year/
// call_deadline_day all NULL and zero capital_goal_monthly_calls
// rows, by this system's own explicit design (see schema.sql's
// comment on capital_goals.goal_type) — a legacy goal is funded by
// ordinary shareholder_contributions and was never meant to grow a
// pledge schedule on its own. There is no automatic migration path
// for this (an existing goal's numbers/history shouldn't silently
// change shape) — this endpoint is the explicit, one-time, opt-in
// "turn this goal into a call-based one, starting now" action.
//
// Covers two cases:
//   1. A legacy goal (goal_type IS NULL) — goal_type/fiscal_year/
//      call_deadline_day are supplied in the request body and saved
//      onto the goal for the first time.
//   2. A goal that's already call-based but somehow has zero monthly
//      call rows (defensive — e.g. a partial failure during
//      creation) — regenerates from the goal's own already-set
//      fields, no body fields required.
// Either way: generateMonthlyCallsForGoal splits the goal's own
// target_amount/start_date/end_date into the full monthly schedule,
// then catchUpMonthlyCalls immediately runs the same deadline-sweep
// jobs/scheduler.js's daily cron does — so whichever period is
// genuinely current opens right away instead of waiting for the next
// 00:30 tick, with no backdated fines (fines only ever apply at the
// moment a payment actually settles late, never as a blanket penalty
// for an unmet closed period with nothing pledged against it).
// ============================================================
const activateCallSchedule = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { goal_type, fiscal_year, call_deadline_day, effective_from } = req.body;

    await assertTrackingEnabled();

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM capital_goals WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) throw createError.notFound('Capital goal not found');
        const goal = existing.rows[0];

        if (goal.status !== 'ACTIVE') {
            throw createError.badRequest(`Only an active goal can have its call schedule activated. Current status: ${goal.status}`);
        }

        const alreadyHasCalls = await client.query(
            'SELECT 1 FROM capital_goal_monthly_calls WHERE capital_goal_id = $1 LIMIT 1', [id]
        );
        if (alreadyHasCalls.rows.length > 0) {
            throw createError.badRequest('This goal already has a monthly call schedule — activation only runs once.');
        }

        let effectiveGoalType = goal.goal_type;
        let effectiveFiscalYear = goal.fiscal_year;
        let effectiveDeadlineDay = goal.call_deadline_day;

        if (!goal.goal_type) {
            // Legacy goal — turning it into a call-based one for the
            // first time, so all three fields must be supplied now.
            if (!['PRIMARY', 'SECONDARY'].includes(goal_type)) {
                throw createError.badRequest('goal_type must be PRIMARY or SECONDARY to activate a call schedule on a legacy goal.');
            }
            if (!fiscal_year || !Number.isInteger(parseInt(fiscal_year))) {
                throw createError.badRequest('A valid fiscal_year is required to activate a call schedule on a legacy goal.');
            }
            if (!call_deadline_day || call_deadline_day < 1 || call_deadline_day > 28) {
                throw createError.badRequest('call_deadline_day must be between 1 and 28.');
            }

            effectiveGoalType = goal_type;
            effectiveFiscalYear = parseInt(fiscal_year);
            effectiveDeadlineDay = parseInt(call_deadline_day);

            if (effectiveGoalType === 'PRIMARY') {
                const existingPrimary = await client.query(
                    "SELECT id, title FROM capital_goals WHERE fiscal_year = $1 AND goal_type = 'PRIMARY' AND id != $2",
                    [effectiveFiscalYear, id]
                );
                if (existingPrimary.rows.length > 0) {
                    throw createError.badRequest(
                        `${effectiveFiscalYear} already has a primary goal ("${existingPrimary.rows[0].title}") — only one is allowed per year.`
                    );
                }
            }

            await client.query(`
                UPDATE capital_goals
                SET    goal_type = $1, fiscal_year = $2, call_deadline_day = $3, updated_at = NOW()
                WHERE  id = $4
            `, [effectiveGoalType, effectiveFiscalYear, effectiveDeadlineDay, id]);
        }
        // Else: already call-based with zero rows (defensive case) —
        // reuse whatever goal_type/fiscal_year/call_deadline_day it
        // already has; nothing to update.

        const validatedEffectiveFrom = validateEffectiveFrom(effective_from, goal.start_date, goal.end_date);
        if (validatedEffectiveFrom) {
            await client.query('UPDATE capital_goals SET effective_from = $1 WHERE id = $2', [validatedEffectiveFrom, id]);
        }

        const { totalMonths, monthlyTarget } = await generateMonthlyCallsForGoal(client, {
            capitalGoalId: id, startDate: goal.start_date, endDate: goal.end_date,
            targetAmount: goal.target_amount, callDeadlineDay: effectiveDeadlineDay,
            effectiveFrom: validatedEffectiveFrom,
        });

        const { iteration1Processed, iteration2Processed } = await catchUpMonthlyCalls(client, id);

        const currentlyOpen = await client.query(`
            SELECT period, status FROM capital_goal_monthly_calls
            WHERE  capital_goal_id = $1 AND status IN ('ITERATION_1', 'ITERATION_2')
            ORDER  BY period
        `, [id]);

        await logAction(req.user.id, ACTIONS.CAPITAL_GOAL_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'capital_goals',
            recordId:    parseInt(id),
            newValues:   { goal_type: effectiveGoalType, fiscal_year: effectiveFiscalYear, call_deadline_day: effectiveDeadlineDay, totalMonths, monthlyTarget },
            description: `Call schedule activated for capital goal ID ${id} — ${totalMonths} monthly call(s) of ${monthlyTarget} each generated, ${iteration1Processed + iteration2Processed} already-past-due period(s) caught up, ${currentlyOpen.rows.length} now open`,
            client,
        });

        sendSuccess(res, {
            total_months: totalMonths,
            monthly_target: monthlyTarget,
            caught_up: iteration1Processed + iteration2Processed,
            open_periods: currentlyOpen.rows,
        }, currentlyOpen.rows.length > 0
            ? `Call schedule activated — ${currentlyOpen.rows.map(r => r.period).join(', ')} now open for pledges.`
            : 'Call schedule activated, but every period is already past its deadline window — nothing is open right now.');
    });
});

// ============================================================
// GET / UPDATE CAPITAL CALL FINE SETTINGS (v1.48.0)
// GET  /api/capital-goals/fine-settings — CAPITAL_GOAL_VIEW (any
//      Shareholder can see the rate that would apply to them if they
//      settle a capital call late — the same "transparency by
//      default" treatment already given to signature/stamp
//      requirements elsewhere in Settings).
// PATCH /api/capital-goals/fine-settings — CAPITAL_GOAL_MANAGE only.
// These replace the four previously hardcoded constants in
// capitalGoalCallService.js (ITERATION1_GRACE_DAYS,
// ITERATION2_WINDOW_DAYS, FINE_PERCENTAGE_WITHIN_GRACE,
// FINE_PERCENTAGE_AFTER_GRACE) with a single admin-editable row —
// see capital_call_fine_settings in schema.sql/migration_v1.48.0.sql.
// ============================================================
const getFineSettingsHandler = asyncHandler(async (req, res) => {
    // getFineSettings expects a client-shaped object (client.query(text, params))
    // so it can also be called from inside a withTransaction block in
    // capitalGoalCallService.js — outside a transaction, the plain
    // module-level `query` function is wrapped to look the same.
    const settings = await getFineSettings({ query });
    sendSuccess(res, settings);
});

const updateFineSettings = asyncHandler(async (req, res) => {
    const {
        grace_days, fine_percentage_within_grace,
        fine_percentage_after_grace, iteration2_window_days,
    } = req.body;

    if (grace_days !== undefined && (!Number.isInteger(grace_days) || grace_days < 0)) {
        throw createError.badRequest('grace_days must be a non-negative whole number of days');
    }
    if (iteration2_window_days !== undefined && (!Number.isInteger(iteration2_window_days) || iteration2_window_days < 1)) {
        throw createError.badRequest('iteration2_window_days must be a whole number of days, at least 1');
    }
    for (const [label, value] of [
        ['fine_percentage_within_grace', fine_percentage_within_grace],
        ['fine_percentage_after_grace', fine_percentage_after_grace],
    ]) {
        if (value !== undefined && (isNaN(parseFloat(value)) || parseFloat(value) < 0 || parseFloat(value) > 100)) {
            throw createError.badRequest(`${label} must be a percentage between 0 and 100`);
        }
    }

    const result = await query(`
        UPDATE capital_call_fine_settings
        SET    grace_days                   = COALESCE($1, grace_days),
               fine_percentage_within_grace = COALESCE($2, fine_percentage_within_grace),
               fine_percentage_after_grace   = COALESCE($3, fine_percentage_after_grace),
               iteration2_window_days       = COALESCE($4, iteration2_window_days),
               updated_by                   = $5,
               updated_at                   = NOW()
        WHERE  id = 1
        RETURNING *
    `, [
        grace_days ?? null,
        fine_percentage_within_grace ?? null,
        fine_percentage_after_grace ?? null,
        iteration2_window_days ?? null,
        req.user.id,
    ]);

    if (result.rows.length === 0) {
        throw createError.notFound('Capital call fine settings not found');
    }

    await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'capital_call_fine_settings',
        recordId:    1,
        newValues:   result.rows[0],
        description: `Capital call fine settings updated: ${result.rows[0].fine_percentage_within_grace}% within ${result.rows[0].grace_days} day(s) grace, ${result.rows[0].fine_percentage_after_grace}% after; iteration 2 window ${result.rows[0].iteration2_window_days} day(s)`,
    });

    sendSuccess(res, result.rows[0], 'Capital call fine settings updated');
});

// ============================================================
// GET / UPDATE CAPITAL GOAL TRACKING TOGGLE (v1.51.0)
// GET  /api/capital-goals/settings/tracking — CAPITAL_GOAL_VIEW (any
//      Shareholder can see whether the feature is currently on, same
//      transparency-by-default treatment as the fine settings above).
// PATCH /api/capital-goals/settings/tracking — CAPITAL_GOAL_MANAGE
//      only. Turning tracking off is a "full pause": the UI hides
//      itself, the daily cron sweep skips entirely, and every write
//      endpoint above rejects with a clear error — existing goals,
//      calls, pledges, and payments are left completely untouched and
//      reappear exactly as they were the moment it's switched back on.
// ============================================================
const getCapitalGoalTrackingSettingsHandler = asyncHandler(async (req, res) => {
    const settings = await getCapitalGoalSettings({ query });
    sendSuccess(res, settings);
});

const updateCapitalGoalTrackingSettings = asyncHandler(async (req, res) => {
    const { tracking_enabled } = req.body;
    if (typeof tracking_enabled !== 'boolean') {
        throw createError.badRequest('tracking_enabled must be true or false');
    }

    const result = await query(`
        INSERT INTO capital_goal_settings (id, tracking_enabled, updated_by, updated_at)
        VALUES (1, $1, $2, NOW())
        ON CONFLICT (id) DO UPDATE
        SET tracking_enabled = $1, updated_by = $2, updated_at = NOW()
        RETURNING *
    `, [tracking_enabled, req.user.id]);

    await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'capital_goal_settings',
        recordId:    1,
        newValues:   result.rows[0],
        description: `Capital Goal Tracking turned ${tracking_enabled ? 'ON' : 'OFF'}`,
    });

    sendSuccess(res, result.rows[0], `Capital Goal Tracking turned ${tracking_enabled ? 'on' : 'off'}`);
});

module.exports = {
    createGoal,
    updateGoal,
    cancelGoal,
    completeGoal,
    getAllGoals,
    getGoalById,
    activateCallSchedule,
    getFineSettingsHandler,
    updateFineSettings,
    getCapitalGoalTrackingSettingsHandler,
    updateCapitalGoalTrackingSettings,
};
