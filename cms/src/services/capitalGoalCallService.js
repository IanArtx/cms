// ============================================================
// CAPITAL GOAL CALL SERVICE (v1.43.0) — "call on shares"
//
// A PRIMARY or SECONDARY capital_goals row is split, in full, at
// creation time, into one capital_goal_monthly_calls row per calendar
// month it covers. Shareholders pledge against a specific month, not
// the goal directly. See migration_v1.43.0.sql and docs/CMS_BIBLE.md
// (Capital Goal Calls section) for the full design.
//
// THE BASELINE-CAPPING RULE (the trickiest piece — read this before
// touching computeApprovableCap below): "if every shareholder pledges
// at or above the equal-split baseline, each one's actual call is
// capped to the baseline" only has a knowable answer once every
// eligible shareholder has actually submitted — anyone who hasn't
// pledged yet counts as an implicit "below baseline" (since they've
// committed nothing), so the condition can only ever become true once
// the very last straggler submits at-or-above their own baseline.
// Approvals can happen at any time relative to that, so the cap is
// evaluated FRESH at the moment of every single approval: capped if
// (and only if) every active shareholder currently has a non-rejected
// pledge >= their own baseline snapshot; otherwise uncapped. This is
// self-correcting and can never be "undone" retroactively — an early
// generous payer approved before the condition became true keeps
// their full approved amount; if the condition only becomes true
// later, only pledges not yet settled from that point on get capped.
// Any resulting overshoot is explicitly allowed (a goal can be met
// more than 100%).
// ============================================================

const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('./referenceService');
const { getExchangeRateOn } = require('./sharePricingService');
const { getOrCreateCategory } = require('./categoryService');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { notify } = require('./notificationService');
// Same "a service reaches into a controller for its shared core"
// pattern already used by finesService.js and depositService.js for
// postTransaction — creditShareholderContribution is the one place
// share issuance actually happens, and every capital call payment
// must go through the exact same path an ordinary contribution does.
const { creditShareholderContribution } = require('../controllers/transactionsController');

// MODULE_CODES.FINE isn't part of referenceService.js's own base
// object — finesController.js sets it as a require-time side effect
// (`MODULE_CODES.FINE = 'FINE';`), so it's only reliably present if
// that file has already been loaded somewhere else first. Since this
// service can legitimately run without finesController.js ever being
// required (e.g. under test, or if route-loading order ever changes),
// set it here too — same value, same idempotent pattern, just no
// longer an implicit cross-file dependency.
MODULE_CODES.FINE = 'FINE';
const {
    monthsBetweenInclusive, periodAtOffset, dateInPeriod, daysBetween, normalizeDateInput,
    addDaysUTC, toISODate,
} = require('../utils/dateUtils');

// v1.48.0 — these four used to be hardcoded module-level constants
// (ITERATION1_GRACE_DAYS=7, ITERATION2_WINDOW_DAYS=7,
// FINE_PERCENTAGE_WITHIN_GRACE=5, FINE_PERCENTAGE_AFTER_GRACE=10).
// They're now Admin-configurable via Settings > Capital Call Fines
// (capital_call_fine_settings, a single-row table — same convention
// as savings_settings). getFineSettings reads the live row on every
// call rather than caching, exactly like savingsController's own
// getSavingsSettings — this is a rarely-hit path (only on a late
// iteration-1 settlement, or the daily deadline-sweep cron), so
// there's no meaningful cost to always reading fresh, and it means
// an Admin's edit takes effect immediately with no cache to bust.
// The inline fallback object matches the exact prior hardcoded
// values, so a database that predates this table (or where the
// seeded row was somehow deleted) behaves identically to before.
const DEFAULT_FINE_SETTINGS = {
    grace_days: 7,
    fine_percentage_within_grace: 5,
    fine_percentage_after_grace: 10,
    iteration2_window_days: 7,
};

const getFineSettings = async (client) => {
    const result = await client.query('SELECT * FROM capital_call_fine_settings WHERE id = 1');
    if (result.rows.length === 0) return DEFAULT_FINE_SETTINGS;
    const row = result.rows[0];
    return {
        grace_days:                    parseInt(row.grace_days),
        fine_percentage_within_grace:  parseFloat(row.fine_percentage_within_grace),
        fine_percentage_after_grace:   parseFloat(row.fine_percentage_after_grace),
        iteration2_window_days:        parseInt(row.iteration2_window_days),
    };
};

// ============================================================
// CAPITAL GOAL TRACKING ON/OFF (v1.51.0) — company-wide toggle. A
// PRIMARY (or any) capital goal is not compulsory; an Admin can turn
// the entire feature off without losing any existing data. Read live
// (no caching), same reasoning as getFineSettings above.
// ============================================================
const DEFAULT_CAPITAL_GOAL_SETTINGS = { tracking_enabled: true };

const getCapitalGoalSettings = async (client) => {
    const result = await client.query('SELECT * FROM capital_goal_settings WHERE id = 1');
    if (result.rows.length === 0) return DEFAULT_CAPITAL_GOAL_SETTINGS;
    return { tracking_enabled: !!result.rows[0].tracking_enabled };
};

const isCapitalGoalTrackingEnabled = async (client) => {
    const settings = await getCapitalGoalSettings(client);
    return settings.tracking_enabled;
};

// ============================================================
// EFFECTIVE-DATE / HISTORICAL-PERIOD HELPERS (v1.51.0) — a goal
// adopted mid-year (an "effective date of adoption" not aligning with
// its own start_date) still has monthly call rows generated all the
// way back to start_date, exactly as before, but any period BEFORE
// effective_from's own period is "historical": generated already
// CLOSED (no pledging, no iteration, no fines — nothing to catch up),
// its "collected" figure a read-only aggregate of the real
// shareholder_contributions already recorded that month, converted
// into the goal's own currency the same way a live payment tranche
// already is. NULL effective_from means "same as start_date" — every
// period is live, zero behaviour change from before this version.
// ============================================================
const effectivePeriodOf = (goal) => {
    const effectiveFrom = goal.effective_from || goal.start_date;
    return normalizeDateInput(effectiveFrom).slice(0, 7);
};

const isHistoricalPeriod = (period, goal) => period < effectivePeriodOf(goal);

// Sums actual shareholder_contributions dated within one calendar
// period, converted into the goal's own currency at each
// contribution's own date — mirrors how a live pledge payment's
// converted_amount_goal_currency is computed. A currency with no
// configured exchange rate to the goal's currency is skipped rather
// than thrown on — this is a best-effort historical/informational
// figure, not a money-moving action, so one missing rate shouldn't
// break the whole goal's progress display.
const getHistoricalPeriodCollected = async (client, period, goalCurrencyId) => {
    const result = await client.query(`
        SELECT amount, currency_id, contribution_date
        FROM   shareholder_contributions
        WHERE  status = 'APPROVED'
        AND    to_char(contribution_date, 'YYYY-MM') = $1
    `, [period]);

    let total = 0;
    for (const row of result.rows) {
        if (row.currency_id === goalCurrencyId) {
            total += parseFloat(row.amount);
            continue;
        }
        try {
            const rate = await getExchangeRateOn(
                client, row.currency_id, goalCurrencyId, normalizeDateInput(row.contribution_date)
            );
            total += parseFloat(row.amount) * rate;
        } catch {
            // No exchange rate on record for this pair/date — skip this
            // row rather than fail the whole aggregate.
        }
    }
    return total;
};

// Per-shareholder breakdown of the same historical aggregate, for
// computeGoalContributionStats to merge alongside live pledge-payment
// totals — "in consideration of the contribution party" per the
// feature's own wording.
const getHistoricalContributionsByUser = async (client, goal) => {
    const effectivePeriod = effectivePeriodOf(goal);
    const result = await client.query(`
        SELECT user_id, amount, currency_id, contribution_date
        FROM   shareholder_contributions
        WHERE  status = 'APPROVED'
        AND    to_char(contribution_date, 'YYYY-MM') < $1
    `, [effectivePeriod]);

    const byUser = {};
    for (const row of result.rows) {
        let converted = parseFloat(row.amount);
        if (row.currency_id !== goal.currency_id) {
            try {
                const rate = await getExchangeRateOn(
                    client, row.currency_id, goal.currency_id, normalizeDateInput(row.contribution_date)
                );
                converted = parseFloat(row.amount) * rate;
            } catch {
                continue; // unconvertible — skip, same reasoning as above
            }
        }
        byUser[row.user_id] = (byUser[row.user_id] || 0) + converted;
    }
    return byUser;
};

// ============================================================
// GENERATE THE FULL MONTHLY SCHEDULE FOR A GOAL — called once, right
// after a capital_goals row (goal_type PRIMARY/SECONDARY) is created.
// Every month gets a fixed, equal share of the target and its own
// iteration-1 deadline (day `callDeadlineDay` of that same month).
// v1.51.0 — any period before `effectiveFrom`'s own period (defaults
// to startDate, i.e. every period live, when omitted) is generated
// already CLOSED — see the module comment above.
// ============================================================
const generateMonthlyCallsForGoal = async (client, {
    capitalGoalId, startDate, endDate, targetAmount, callDeadlineDay, effectiveFrom,
}) => {
    const totalMonths = monthsBetweenInclusive(startDate, endDate);
    const monthlyTarget = parseFloat((parseFloat(targetAmount) / totalMonths).toFixed(4));
    const effectivePeriod = normalizeDateInput(effectiveFrom || startDate).slice(0, 7);

    const created = [];
    for (let i = 0; i < totalMonths; i++) {
        const period = periodAtOffset(startDate, i);
        const iteration1Deadline = dateInPeriod(period, callDeadlineDay);
        const isHistorical = period < effectivePeriod;
        const result = await client.query(`
            INSERT INTO capital_goal_monthly_calls (
                capital_goal_id, period, monthly_target, iteration1_deadline, status
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING id, period, monthly_target, iteration1_deadline, status
        `, [capitalGoalId, period, monthlyTarget, iteration1Deadline, isHistorical ? 'CLOSED' : 'ITERATION_1']);
        created.push(result.rows[0]);
    }
    return { totalMonths, monthlyTarget, monthlyCalls: created };
};

// ============================================================
// ACTIVE SHAREHOLDER COUNT — same "holds the Shareholder role"
// eligibility rule GET /users/shareholders already uses (v1.27.3),
// not shareholding_registry.shares_held > 0, so a brand-new
// shareholder with zero shares so far is still counted (that's the
// whole point of a capital call).
// ============================================================
const getActiveShareholderCount = async (client) => {
    const result = await client.query(`
        SELECT COUNT(*) AS n
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id AND r.name = 'Shareholder' AND r.is_active = TRUE
        WHERE  u.is_active = TRUE
    `);
    return parseInt(result.rows[0].n);
};

// ============================================================
// PERIOD SETTLED — how much of a monthly call's own target has been
// paid via the live pledge/payment machinery, based purely on
// capital_goal_payment_applications (never on pledge amounts, which
// may not have been paid at all). Only ever meaningful for a LIVE
// (non-historical) period — a historical one is never written to
// capital_goal_payment_applications at all (see getPeriodCollected).
// ============================================================
const getPeriodSettled = async (client, monthlyCallId) => {
    const result = await client.query(`
        SELECT COALESCE(SUM(amount), 0) AS settled
        FROM   capital_goal_payment_applications
        WHERE  monthly_call_id = $1
    `, [monthlyCallId]);
    return parseFloat(result.rows[0].settled);
};

// ============================================================
// PERIOD COLLECTED (v1.51.0) — the one place that decides which data
// source a monthly call's "collected so far" figure comes from: the
// live pledge/payment machinery (capital_goal_payment_applications)
// for a normal period, or the read-only historical aggregate (actual
// shareholder_contributions that month, converted into the goal's own
// currency) for a period before the goal's effective_from. Fetches
// the parent goal itself since a bare monthly-call row doesn't carry
// effective_from/currency_id — a small extra query, but this is never
// a hot per-request path (approval, cron sweep, one goal's own detail
// page), so clarity wins over shaving one query.
// ============================================================
const getPeriodCollected = async (client, monthlyCall) => {
    const goalResult = await client.query(
        'SELECT id, currency_id, effective_from, start_date FROM capital_goals WHERE id = $1',
        [monthlyCall.capital_goal_id]
    );
    const goal = goalResult.rows[0];
    if (goal && isHistoricalPeriod(monthlyCall.period, goal)) {
        return getHistoricalPeriodCollected(client, monthlyCall.period, goal.currency_id);
    }
    return getPeriodSettled(client, monthlyCall.id);
};

const getPeriodShortfall = async (client, monthlyCall) => {
    const settled = await getPeriodCollected(client, monthlyCall);
    const target = parseFloat(monthlyCall.monthly_target);
    return { target, settled, shortfall: Math.max(0, target - settled) };
};

// ============================================================
// CARRY-FORWARD BACKLOG — the accumulated, still-uncovered shortfall
// of every EARLIER *live* month of the same goal, however much of it
// has already been chipped away by past iteration-2 payments (those
// are reflected automatically since this sums the SAME live per-
// period settled totals). Rolls forward indefinitely until fully
// covered. v1.51.0 — deliberately EXCLUDES any historical period
// (before the goal's effective_from): "no penalty system applies" to
// a historical month means its own shortfall (if the actual
// contributions that month came up short of its auto-calculated
// target) never becomes something live-period shareholders are asked
// to make up via iteration 2 — it's purely informational.
// ============================================================
const getCarryForwardBacklog = async (client, capitalGoalId, beforePeriod) => {
    const goalResult = await client.query(
        'SELECT effective_from, start_date FROM capital_goals WHERE id = $1', [capitalGoalId]
    );
    const effectivePeriod = effectivePeriodOf(goalResult.rows[0]);

    const result = await client.query(`
        SELECT COALESCE(SUM(GREATEST(mc.monthly_target - COALESCE(app.settled, 0), 0)), 0) AS backlog
        FROM   capital_goal_monthly_calls mc
        LEFT JOIN (
            SELECT monthly_call_id, SUM(amount) AS settled
            FROM   capital_goal_payment_applications
            GROUP  BY monthly_call_id
        ) app ON app.monthly_call_id = mc.id
        WHERE  mc.capital_goal_id = $1 AND mc.period < $2 AND mc.period >= $3
    `, [capitalGoalId, beforePeriod, effectivePeriod]);
    return parseFloat(result.rows[0].backlog);
};

// ============================================================
// BASELINE — iteration 1 is a simple equal split. Iteration 2 splits
// (this month's own remaining shortfall + the full carried-forward
// backlog) across only the shareholders who pledged ABOVE baseline in
// iteration 1 (their surplus willingness).
// ============================================================
const computeIteration1Baseline = async (client, monthlyCall) => {
    const shareholderCount = await getActiveShareholderCount(client);
    return parseFloat(monthlyCall.monthly_target) / Math.max(1, shareholderCount);
};

const getIteration2EligibleUserIds = async (client, monthlyCallId) => {
    const result = await client.query(`
        SELECT user_id FROM capital_goal_pledges
        WHERE  monthly_call_id = $1 AND iteration = 1 AND status != 'REJECTED'
        AND    pledged_amount > baseline_amount_snapshot
    `, [monthlyCallId]);
    return result.rows.map(r => r.user_id);
};

const computeIteration2Context = async (client, monthlyCall) => {
    const { shortfall: ownShortfall } = await getPeriodShortfall(client, monthlyCall);
    const backlog = await getCarryForwardBacklog(client, monthlyCall.capital_goal_id, monthlyCall.period);
    const combinedTarget = ownShortfall + backlog;
    const eligibleUserIds = await getIteration2EligibleUserIds(client, monthlyCall.id);
    const baseline = combinedTarget / Math.max(1, eligibleUserIds.length);
    return { ownShortfall, backlog, combinedTarget, eligibleUserIds, baseline };
};

// ============================================================
// SUBMIT A PLEDGE
// ============================================================
const submitPledge = async (client, {
    monthlyCallId, userId, iteration, currencyId, pledgedAmount,
}) => {
    const callResult = await client.query(
        'SELECT * FROM capital_goal_monthly_calls WHERE id = $1 FOR UPDATE', [monthlyCallId]
    );
    if (callResult.rows.length === 0) {
        throw createError.notFound('Monthly capital call not found');
    }
    const monthlyCall = callResult.rows[0];

    const expectedStatus = iteration === 1 ? 'ITERATION_1' : 'ITERATION_2';
    if (monthlyCall.status !== expectedStatus) {
        throw createError.badRequest(
            iteration === 1
                ? `This month's first-round pledging window is not open (current status: ${monthlyCall.status}).`
                : `This month is not currently in its second iteration (current status: ${monthlyCall.status}).`
        );
    }

    let baseline;
    if (iteration === 1) {
        baseline = await computeIteration1Baseline(client, monthlyCall);
    } else {
        const eligible = await getIteration2EligibleUserIds(client, monthlyCallId);
        if (!eligible.includes(userId)) {
            throw createError.forbidden(
                'Only shareholders who pledged above the baseline in iteration 1 can pledge in iteration 2.'
            );
        }
        const ctx = await computeIteration2Context(client, monthlyCall);
        baseline = ctx.baseline;
    }

    const { referenceId, referenceCode } = await generateReference(
        client, MODULE_CODES.CAPITAL_GOAL, 'CALL', 'capital_goal_pledges', userId
    );

    const result = await client.query(`
        INSERT INTO capital_goal_pledges (
            reference_id, monthly_call_id, user_id, iteration, currency_id,
            pledged_amount, baseline_amount_snapshot, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
        RETURNING *
    `, [referenceId, monthlyCallId, userId, iteration, currencyId, pledgedAmount, baseline]);

    const pledge = result.rows[0];
    await linkReferenceToRecord(client, referenceId, pledge.id);

    await logAction(userId, ACTIONS.CAPITAL_GOAL_CALL_PLEDGE_SUBMITTED, MODULES.FINANCE, {
        recordType: 'capital_goal_pledges',
        recordId:   pledge.id,
        newValues:  { monthlyCallId, iteration, pledgedAmount, baseline },
        description: `Capital goal call pledge submitted: ${referenceCode} (${pledgedAmount}, iteration ${iteration})`,
        client,
    });

    return { pledge, referenceCode, baseline };
};

// ============================================================
// EDIT A PLEDGE — only while nothing has been settled against it yet.
// ============================================================
const editPledge = async (client, { pledgeId, userId, pledgedAmount, currencyId }) => {
    const existing = await client.query(
        'SELECT * FROM capital_goal_pledges WHERE id = $1 FOR UPDATE', [pledgeId]
    );
    if (existing.rows.length === 0) throw createError.notFound('Pledge not found');
    const pledge = existing.rows[0];

    if (pledge.user_id !== userId) {
        throw createError.forbidden('You can only edit your own pledge');
    }
    if (parseFloat(pledge.amount_settled) > 0) {
        throw createError.badRequest('This pledge already has a payment settled against it and can no longer be edited');
    }
    if (pledge.status === 'REJECTED') {
        throw createError.badRequest('This pledge was rejected and can no longer be edited');
    }

    const updated = await client.query(`
        UPDATE capital_goal_pledges
        SET    pledged_amount = COALESCE($1, pledged_amount),
               currency_id    = COALESCE($2, currency_id)
        WHERE  id = $3
        RETURNING *
    `, [pledgedAmount ?? null, currencyId || null, pledgeId]);

    await logAction(userId, ACTIONS.CAPITAL_GOAL_CALL_PLEDGE_EDITED, MODULES.FINANCE, {
        recordType: 'capital_goal_pledges',
        recordId:   pledgeId,
        oldValues:  { pledged_amount: pledge.pledged_amount, currency_id: pledge.currency_id },
        newValues:  { pledged_amount: updated.rows[0].pledged_amount, currency_id: updated.rows[0].currency_id },
        description: `Capital goal call pledge edited: ID ${pledgeId}`,
        client,
    });

    return updated.rows[0];
};

// ============================================================
// REJECT A PLEDGE (Treasurer) — declines it outright, no money ever
// moves, no fine, nothing settled. Only while nothing's been settled.
// ============================================================
const rejectPledge = async (client, { pledgeId, reviewedBy, reviewNotes }) => {
    const existing = await client.query(
        'SELECT * FROM capital_goal_pledges WHERE id = $1 FOR UPDATE', [pledgeId]
    );
    if (existing.rows.length === 0) throw createError.notFound('Pledge not found');
    const pledge = existing.rows[0];

    if (parseFloat(pledge.amount_settled) > 0) {
        throw createError.badRequest('This pledge already has a payment settled against it and can no longer be rejected');
    }

    const updated = await client.query(`
        UPDATE capital_goal_pledges
        SET    status = 'REJECTED', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
        WHERE  id = $3
        RETURNING *
    `, [reviewedBy, reviewNotes || null, pledgeId]);

    await logAction(reviewedBy, ACTIONS.CAPITAL_GOAL_CALL_PLEDGE_REJECTED, MODULES.FINANCE, {
        recordType: 'capital_goal_pledges',
        recordId:   pledgeId,
        description: `Capital goal call pledge rejected: ID ${pledgeId}`,
        client,
    });

    notify({
        userId:     pledge.user_id,
        type:       'CAPITAL_GOAL_CALL_PLEDGE_REJECTED',
        title:      'Your capital call pledge was declined',
        body:       reviewNotes || 'Your pledge was declined by the Treasurer.',
        link:       '/capital-goals/my-calls',
        module:     'FINANCE',
        recordType: 'capital_goal_pledges',
        recordId:   pledgeId,
    });

    return updated.rows[0];
};

// ============================================================
// WHETHER AN ITERATION-1 SETTLEMENT SHOULD BE CAPPED TO BASELINE
// RIGHT NOW — see the module-level comment for the full reasoning.
// ============================================================
const shouldCapToBaseline = async (client, monthlyCallId) => {
    const shareholderCount = await getActiveShareholderCount(client);
    const result = await client.query(`
        SELECT COUNT(*) AS n FROM capital_goal_pledges
        WHERE  monthly_call_id = $1 AND iteration = 1 AND status != 'REJECTED'
        AND    pledged_amount >= baseline_amount_snapshot
    `, [monthlyCallId]);
    const atOrAboveBaselineCount = parseInt(result.rows[0].n);
    return shareholderCount > 0 && atOrAboveBaselineCount >= shareholderCount;
};

// ============================================================
// SETTLE AN ALREADY-RECORDED CONTRIBUTION AGAINST A PLEDGE (v1.51.0
// extraction) — every step of "money has landed, now do the capital-
// goal-call bookkeeping": lateness/fine (iteration 1 only), the
// capital_goal_pledge_payments row, period allocation, and the
// pledge's own running total/status. Deliberately does NOT create the
// underlying transaction/shareholder_contribution itself — the caller
// already has (or already created) those, via either a Treasurer's
// manual approval (approvePledgePayment below) or an ordinary
// contribution auto-settling the contributor's own open pledge
// (attributeDirectContributionToPrimaryGoal below). Both callers
// funnel through here so a late tranche is fined identically no
// matter which screen the money came in through.
//
// `skipBaselineCap` — the manual approval flow always enforces the
// baseline cap (a Treasurer approving a large iteration-1 pledge while
// everyone else has already pledged at/above baseline). The direct-
// contribution flow does NOT: that cap exists to keep PLEDGE amounts
// (promises) fair while other members haven't paid yet — it makes no
// sense to throttle how much of money ALREADY IN THE BANK gets
// recognized against the call, and doing so would risk failing an
// otherwise ordinary contribution over an unrelated pledge technicality.
// ============================================================
const settleApprovedContributionIntoPledge = async (client, {
    pledge, monthlyCall, capitalGoal, amount, transactionId, contributionId,
    accountId, effectiveDate, approvedByUserId, notes, skipBaselineCap,
}) => {
    const requestedAmount = parseFloat(amount);

    if (pledge.iteration === 1 && !skipBaselineCap) {
        const capped = await shouldCapToBaseline(client, pledge.monthly_call_id);
        if (capped) {
            const cap = parseFloat(pledge.baseline_amount_snapshot);
            const alreadySettled = parseFloat(pledge.amount_settled);
            const approvableMax = Math.max(0, cap - alreadySettled);
            if (requestedAmount > approvableMax + 0.0001) {
                throw createError.badRequest(
                    `Every shareholder pledged at or above the baseline for this month, so each call is capped to ` +
                    `the baseline amount (${cap}). Only ${approvableMax} more of this pledge can be settled in iteration 1.`
                );
            }
        }
    }

    // Lateness — only ever meaningful (and only ever fined) for
    // iteration 1, judged against that month's own deadline. Same rule
    // whether the payment arrived via manual approval or an ordinary
    // contribution that happened to settle this pledge automatically.
    let isLate = false;
    let daysLate = null;
    if (pledge.iteration === 1) {
        daysLate = daysBetween(monthlyCall.iteration1_deadline, effectiveDate);
        isLate = daysLate > 0;
    }

    const rate = await getExchangeRateOn(client, pledge.currency_id, capitalGoal.currency_id, effectiveDate);
    const convertedAmount = requestedAmount * rate;

    const paymentResult = await client.query(`
        INSERT INTO capital_goal_pledge_payments (
            pledge_id, amount, account_id, transaction_id, shareholder_contribution_id,
            converted_amount_goal_currency, exchange_rate_to_goal_currency,
            is_late, days_late, approved_by, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
    `, [
        pledge.id, requestedAmount, accountId, transactionId, contributionId,
        convertedAmount, rate, isLate, daysLate, approvedByUserId, notes || null,
    ]);
    const paymentId = paymentResult.rows[0].id;

    // --- Fine (iteration 1, late tranches only) ---
    let fine = null;
    if (isLate) {
        const fineSettings = await getFineSettings(client);
        const finePercentage = daysLate <= fineSettings.grace_days
            ? fineSettings.fine_percentage_within_grace
            : fineSettings.fine_percentage_after_grace;
        const fineAmount = parseFloat((requestedAmount * (finePercentage / 100)).toFixed(4));

        const { referenceId: fineRefId, referenceCode: fineRefCode } =
            await generateReference(client, MODULE_CODES.FINE, 'FINE', 'FINE', approvedByUserId);

        const fineResult = await client.query(`
            INSERT INTO fines (
                reference_id, user_id, reason, description, currency_id, amount,
                default_deadline, defaulted_amount, fine_percentage, assigned_by
            ) VALUES ($1, $2, 'CONTRIBUTION_FAILURE', $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [
            fineRefId, pledge.user_id,
            `Capital goal call for ${monthlyCall.period} settled ${daysLate} day(s) late`,
            pledge.currency_id, fineAmount,
            monthlyCall.iteration1_deadline, requestedAmount, finePercentage, approvedByUserId,
        ]);
        const fineId = fineResult.rows[0].id;
        await linkReferenceToRecord(client, fineRefId, fineId);

        await client.query('UPDATE capital_goal_pledge_payments SET fine_id = $1 WHERE id = $2', [fineId, paymentId]);

        await logAction(approvedByUserId, ACTIONS.CAPITAL_GOAL_CALL_FINE_ASSIGNED, MODULES.FINANCE, {
            recordType: 'fines',
            recordId:   fineId,
            description: `Fine auto-assigned for late capital goal call (${monthlyCall.period}): ${fineRefCode} — ${fineAmount} (${finePercentage}%)`,
            client,
        });

        notify({
            userId:     pledge.user_id,
            type:       'FINE_ASSIGNED',
            title:      'A fine was assigned for a late capital call payment',
            body:       `Your capital call for ${monthlyCall.period} was settled ${daysLate} day(s) after the deadline — a ${finePercentage}% fine (${fineAmount}) was assigned. Reference: ${fineRefCode}.`,
            link:       '/fines',
            module:     'FINANCE',
            recordType: 'fines',
            recordId:   fineId,
        });

        fine = { id: fineId, referenceCode: fineRefCode, amount: fineAmount, percentage: finePercentage };
    }

    // --- Period allocation ---
    if (pledge.iteration === 1) {
        await client.query(`
            INSERT INTO capital_goal_payment_applications (payment_id, monthly_call_id, amount)
            VALUES ($1, $2, $3)
        `, [paymentId, monthlyCall.id, convertedAmount]);
    } else {
        await allocateAcrossPeriodsOldestFirst(client, {
            paymentId, capitalGoalId: monthlyCall.capital_goal_id,
            uptoPeriod: monthlyCall.period, thisMonthlyCallId: monthlyCall.id,
            amount: convertedAmount, effectivePeriod: effectivePeriodOf(capitalGoal),
        });
    }

    // --- Update pledge running total/status ---
    const newSettled = parseFloat(pledge.amount_settled) + requestedAmount;
    const newStatus = newSettled >= parseFloat(pledge.pledged_amount) - 0.0001 ? 'FULFILLED' : 'PARTIAL';
    await client.query(
        'UPDATE capital_goal_pledges SET amount_settled = $1, status = $2 WHERE id = $3',
        [newSettled, newStatus, pledge.id]
    );

    await logAction(approvedByUserId, ACTIONS.CAPITAL_GOAL_CALL_PAYMENT_APPROVED, MODULES.FINANCE, {
        recordType: 'capital_goal_pledge_payments',
        recordId:   paymentId,
        description: `Capital goal call payment approved: pledge ${pledge.id}, ${requestedAmount} (${monthlyCall.period}, iteration ${pledge.iteration})${isLate ? ' — LATE' : ''}`,
        client,
    });

    notify({
        userId:     pledge.user_id,
        type:       'CAPITAL_GOAL_CALL_PAYMENT_APPROVED',
        title:      'Your capital call payment was recorded',
        body:       `${requestedAmount} was recorded for your ${monthlyCall.period} capital call, and your shares have been updated.`,
        link:       '/capital-goals/my-calls',
        module:     'FINANCE',
        recordType: 'capital_goal_pledge_payments',
        recordId:   paymentId,
    });

    return { paymentId, convertedAmount, rate, isLate, daysLate, fine, pledgeStatus: newStatus };
};

// ============================================================
// APPROVE (= SETTLE) A PLEDGE PAYMENT — the single Treasurer-facing,
// money-moving action. Currency of the receiving account must match
// the pledge's own currency (same hard-reject rule Fines already
// uses). Issues real shares via the ordinary shareholder_contributions
// core, then runs the shared settlement bookkeeping above.
// ============================================================
const approvePledgePayment = async (client, {
    pledgeId, amount, accountId, approvedByUserId, paidDate, notes,
}) => {
    const pledgeResult = await client.query(
        'SELECT * FROM capital_goal_pledges WHERE id = $1 FOR UPDATE', [pledgeId]
    );
    if (pledgeResult.rows.length === 0) throw createError.notFound('Pledge not found');
    const pledge = pledgeResult.rows[0];

    if (pledge.status === 'REJECTED') {
        throw createError.badRequest('This pledge was rejected and cannot be settled');
    }
    if (pledge.status === 'FULFILLED') {
        throw createError.badRequest('This pledge has already been fully settled');
    }

    const callResult = await client.query(
        'SELECT * FROM capital_goal_monthly_calls WHERE id = $1 FOR UPDATE', [pledge.monthly_call_id]
    );
    const monthlyCall = callResult.rows[0];

    const goalResult = await client.query('SELECT * FROM capital_goals WHERE id = $1', [monthlyCall.capital_goal_id]);
    const capitalGoal = goalResult.rows[0];

    const remainingOnPledge = parseFloat(pledge.pledged_amount) - parseFloat(pledge.amount_settled);
    const requestedAmount = parseFloat(amount);
    if (requestedAmount <= 0) {
        throw createError.badRequest('Amount must be greater than zero');
    }
    if (requestedAmount > remainingOnPledge + 0.0001) {
        throw createError.badRequest(
            `This would exceed what's left on the pledge (${remainingOnPledge} remaining).`
        );
    }

    // Account must exist, be active, and match the pledge's own currency.
    const accountResult = await client.query(
        'SELECT id, currency_id, account_type FROM accounts WHERE id = $1 AND is_active = TRUE',
        [accountId]
    );
    if (accountResult.rows.length === 0) {
        throw createError.notFound('Account not found or inactive');
    }
    const account = accountResult.rows[0];
    if (account.currency_id !== pledge.currency_id) {
        throw createError.badRequest(
            'The receiving account must be in the same currency the pledge was made in.'
        );
    }

    const effectiveDate = normalizeDateInput(paidDate) || new Date().toISOString().slice(0, 10);

    const categoryId = await getOrCreateCategory(client, {
        module: 'FINANCE',
        name: 'Capital Goal Calls',
        abbreviation: 'CGC',
        description: 'Auto-provisioned category for capital goal call (call on shares) pledge settlements',
        createdBy: approvedByUserId,
    });

    const contributionResult = await creditShareholderContribution(client, {
        contributorId:     pledge.user_id,
        amount:             requestedAmount,
        contributionDate:  effectiveDate,
        categoryId,
        notes:              notes || `Capital goal call — ${monthlyCall.period} (iteration ${pledge.iteration})`,
        recordedByUserId:  approvedByUserId,
        accountId,
        // This IS the capital-goal-call settlement itself — must not
        // re-trigger the ordinary-contribution auto-attribution path
        // (see creditShareholderContribution's own comment), or the
        // same money would be attributed twice.
        skipCapitalGoalAutoAttribution: true,
    });

    const settleResult = await settleApprovedContributionIntoPledge(client, {
        pledge, monthlyCall, capitalGoal, amount: requestedAmount,
        transactionId: contributionResult.transactionId,
        contributionId: contributionResult.contributionId,
        accountId, effectiveDate, approvedByUserId, notes,
        skipBaselineCap: false,
    });

    return {
        ...settleResult,
        transactionId: contributionResult.transactionId,
        referenceCode: contributionResult.referenceCode,
    };
};

// ============================================================
// ATTRIBUTE A DIRECT (NON-PLEDGE) CONTRIBUTION TO THE PRIMARY GOAL
// (v1.51.0) — "any capital contribution recorded outside the pledges
// also contributes to the capital goals (primary)". Called from
// creditShareholderContribution's own core, right after an ORDINARY
// contribution (Transactions -> Record Contribution, or a
// CONTRIBUTION_ACKNOWLEDGEMENT requisition being approved — anything
// that isn't itself a capital-call settlement) is recorded.
//
// If the contributor already has an open (non-rejected) iteration-1
// pledge for the PRIMARY goal's monthly call covering this
// contribution's own date, in the SAME currency the money actually
// arrived in, the contribution auto-settles it first — same lateness/
// fine rules as a manual Treasurer approval (no loophole for dodging a
// fine by paying the "normal" way instead of approving a pledge). Any
// amount beyond what that pledge needed (or the full amount, if there
// was no open pledge to begin with, or its currency didn't match) is
// recorded against a system-generated iteration-1 pledge sized to
// exactly what's being attributed, so the existing "who has actually
// paid" bookkeeping (capital_goal_pledge_payments / payment
// applications) stays the single source of truth no matter which
// screen the money came in through.
//
// Silently does nothing (returns null) when: tracking is disabled;
// there's no ACTIVE, call-based PRIMARY goal covering this date; or
// the date falls in a historical period (before the goal's own
// effective_from) — those are handled entirely by the read-only
// aggregate in getPeriodCollected, never by this pledge machinery.
// Never throws — a capital-goal bookkeeping hiccup must never fail an
// otherwise ordinary contribution (see creditShareholderContribution).
// ============================================================
const attributeDirectContributionToPrimaryGoal = async (client, {
    contributorId, amount, contributionDate, accountId, accountCurrencyId,
    transactionId, contributionId, approvedByUserId,
}) => {
    if (!(await isCapitalGoalTrackingEnabled(client))) return null;

    const normalizedDate = normalizeDateInput(contributionDate);
    const goalResult = await client.query(`
        SELECT * FROM capital_goals
        WHERE  goal_type = 'PRIMARY' AND status = 'ACTIVE'
        AND    start_date <= $1 AND end_date >= $1
        LIMIT  1
    `, [normalizedDate]);
    if (goalResult.rows.length === 0) return null;
    const capitalGoal = goalResult.rows[0];

    const period = normalizedDate.slice(0, 7);
    if (isHistoricalPeriod(period, capitalGoal)) return null;

    const callResult = await client.query(
        'SELECT * FROM capital_goal_monthly_calls WHERE capital_goal_id = $1 AND period = $2 FOR UPDATE',
        [capitalGoal.id, period]
    );
    if (callResult.rows.length === 0) return null; // no monthly call generated for this period — nothing to attach to
    const monthlyCall = callResult.rows[0];

    const requestedAmount = parseFloat(amount);
    let remaining = requestedAmount;
    const settlements = [];

    // Prefer the contributor's own existing, non-rejected, same-
    // currency iteration-1 pledge for this call, if any.
    const existingResult = await client.query(`
        SELECT * FROM capital_goal_pledges
        WHERE  monthly_call_id = $1 AND user_id = $2 AND iteration = 1 AND status != 'REJECTED'
        FOR UPDATE
    `, [monthlyCall.id, contributorId]);

    let pledge = existingResult.rows.length > 0 ? existingResult.rows[0] : null;
    if (pledge && parseFloat(pledge.currency_id) !== parseFloat(accountCurrencyId)) {
        // Currency mismatch — leave the existing pledge alone (a
        // Treasurer can still approve it normally later) and treat this
        // whole contribution as needing a fresh system-generated pledge.
        pledge = null;
    }

    if (pledge) {
        const remainingOnPledge = Math.max(0, parseFloat(pledge.pledged_amount) - parseFloat(pledge.amount_settled));
        if (remainingOnPledge > 0.0001) {
            const applyToExisting = Math.min(remaining, remainingOnPledge);
            const settled = await settleApprovedContributionIntoPledge(client, {
                pledge, monthlyCall, capitalGoal, amount: applyToExisting,
                transactionId, contributionId, accountId,
                effectiveDate: normalizedDate, approvedByUserId, notes: 'Auto-settled from a direct contribution',
                skipBaselineCap: true,
            });
            settlements.push(settled);
            remaining = parseFloat((remaining - applyToExisting).toFixed(4));
            // Re-read after settlement so the "grow" step below (if any
            // money is left) sees the up-to-date amount_settled.
            pledge = (await client.query('SELECT * FROM capital_goal_pledges WHERE id = $1', [pledge.id])).rows[0];
        }
    }

    if (remaining > 0.0001) {
        if (pledge) {
            // Their own pledge is fully settled but there's still money
            // left over — grow the pledge to absorb it (this is a
            // system-generated attribution, not a promise the member
            // made, so there's nothing to protect by leaving it short).
            const grownAmount = parseFloat(pledge.pledged_amount) + remaining;
            await client.query(
                'UPDATE capital_goal_pledges SET pledged_amount = $1 WHERE id = $2',
                [grownAmount, pledge.id]
            );
            pledge = { ...pledge, pledged_amount: grownAmount };
        } else {
            // No pledge to attach to at all — create one sized exactly
            // to what's being attributed, in the currency the money
            // actually arrived in.
            const baseline = await computeIteration1Baseline(client, monthlyCall);
            const { referenceId, referenceCode } = await generateReference(
                client, MODULE_CODES.CAPITAL_GOAL, 'CALL', 'capital_goal_pledges', contributorId
            );
            const inserted = await client.query(`
                INSERT INTO capital_goal_pledges (
                    reference_id, monthly_call_id, user_id, iteration, currency_id,
                    pledged_amount, baseline_amount_snapshot, status
                ) VALUES ($1, $2, $3, 1, $4, $5, $6, 'PENDING')
                RETURNING *
            `, [referenceId, monthlyCall.id, contributorId, accountCurrencyId, remaining, baseline]);
            pledge = inserted.rows[0];
            await linkReferenceToRecord(client, referenceId, pledge.id);
            await logAction(approvedByUserId, ACTIONS.CAPITAL_GOAL_CALL_PLEDGE_SUBMITTED, MODULES.FINANCE, {
                recordType: 'capital_goal_pledges',
                recordId:   pledge.id,
                newValues:  { monthlyCallId: monthlyCall.id, iteration: 1, pledgedAmount: remaining, baseline },
                description: `System-generated pledge from a direct contribution: ${referenceCode} (${remaining})`,
                client,
            });
        }

        const settled = await settleApprovedContributionIntoPledge(client, {
            pledge, monthlyCall, capitalGoal, amount: remaining,
            transactionId, contributionId, accountId,
            effectiveDate: normalizedDate, approvedByUserId, notes: 'Auto-settled from a direct contribution',
            skipBaselineCap: true,
        });
        settlements.push(settled);
    }

    return { monthlyCallId: monthlyCall.id, period: monthlyCall.period, settlements };
};

// ============================================================
// OLDEST-PERIOD-FIRST ALLOCATION (iteration 2 only) — mirrors
// sideFundService.applySideFundPayment's cascading pattern. Consumes
// the payment against every still-short period from the very oldest
// through the current one; any remainder beyond every real shortfall
// (including this month's own) is simply added to the current
// month — a deliberate, allowed overshoot.
// ============================================================
const allocateAcrossPeriodsOldestFirst = async (client, {
    paymentId, capitalGoalId, uptoPeriod, thisMonthlyCallId, amount, effectivePeriod,
}) => {
    // Historical (pre-effective-date) periods are excluded — they were
    // generated CLOSED with no real shortfall to speak of (their
    // "collected" figure is a read-only aggregate, never backed by
    // capital_goal_payment_applications), so without this filter every
    // historical month would look infinitely short and silently soak
    // up iteration-2 money that belongs to the live period it was
    // actually paid against.
    const periods = await client.query(`
        SELECT id, period, monthly_target FROM capital_goal_monthly_calls
        WHERE  capital_goal_id = $1 AND period <= $2
        ${effectivePeriod ? 'AND period >= $3' : ''}
        ORDER  BY period ASC
    `, effectivePeriod ? [capitalGoalId, uptoPeriod, effectivePeriod] : [capitalGoalId, uptoPeriod]);

    let remaining = amount;
    let appliedAny = false;
    for (const period of periods.rows) {
        if (remaining <= 0) break;
        const settled = await getPeriodSettled(client, period.id);
        const shortfall = Math.max(0, parseFloat(period.monthly_target) - settled);
        if (shortfall <= 0) continue;

        const applyAmount = Math.min(remaining, shortfall);
        await client.query(`
            INSERT INTO capital_goal_payment_applications (payment_id, monthly_call_id, amount)
            VALUES ($1, $2, $3)
        `, [paymentId, period.id, applyAmount]);
        remaining -= applyAmount;
        appliedAny = true;
    }

    // Overshoot beyond every real shortfall (including the current
    // month's own) — dumped onto the current month itself.
    if (remaining > 0.0001) {
        await client.query(`
            INSERT INTO capital_goal_payment_applications (payment_id, monthly_call_id, amount)
            VALUES ($1, $2, $3)
        `, [paymentId, thisMonthlyCallId, remaining]);
        appliedAny = true;
    }

    if (!appliedAny) {
        // Defensive — should be unreachable given the caller always
        // passes amount > 0, but never leave a payment with zero
        // application rows.
        await client.query(`
            INSERT INTO capital_goal_payment_applications (payment_id, monthly_call_id, amount)
            VALUES ($1, $2, $3)
        `, [paymentId, thisMonthlyCallId, amount]);
    }
};

// ============================================================
// CRON HELPERS — see jobs/scheduler.js for the actual schedules.
// ============================================================

// Called once a monthly call's iteration-1 deadline has passed.
// Closes it outright if the target was fully met by then; otherwise
// opens iteration 2 for exactly ITERATION2_WINDOW_DAYS.
const processIteration1Deadline = async (client, monthlyCall) => {
    const { shortfall } = await getPeriodShortfall(client, monthlyCall);
    if (shortfall <= 0) {
        await client.query("UPDATE capital_goal_monthly_calls SET status = 'CLOSED' WHERE id = $1", [monthlyCall.id]);
        return { opened: false, reason: 'target already met' };
    }

    const ctx = await computeIteration2Context(client, monthlyCall);
    const { iteration2_window_days } = await getFineSettings(client);
    const deadline2 = toISODate(addDaysUTC(monthlyCall.iteration1_deadline, iteration2_window_days));

    await client.query(`
        UPDATE capital_goal_monthly_calls
        SET    status = 'ITERATION_2', iteration2_deadline = $1
        WHERE  id = $2
    `, [deadline2, monthlyCall.id]);

    await logAction(null, ACTIONS.CAPITAL_GOAL_CALL_ITERATION2_OPENED, MODULES.FINANCE, {
        recordType: 'capital_goal_monthly_calls',
        recordId:   monthlyCall.id,
        description: `Iteration 2 opened for ${monthlyCall.period}: combined target ${ctx.combinedTarget} (own shortfall ${ctx.ownShortfall} + backlog ${ctx.backlog}), ${ctx.eligibleUserIds.length} eligible shareholder(s)`,
        client,
    });

    for (const userId of ctx.eligibleUserIds) {
        notify({
            userId,
            type:       'CAPITAL_GOAL_CALL_ITERATION2_OPENED',
            title:      'A second capital call round is open',
            body:       `${monthlyCall.period}'s capital call fell short — as someone who pledged above the baseline, you can offer to cover part or all of the remaining ${ctx.combinedTarget}, no fines apply.`,
            link:       '/capital-goals/my-calls',
            module:     'FINANCE',
            recordType: 'capital_goal_monthly_calls',
            recordId:   monthlyCall.id,
        });
    }

    return { opened: true, ...ctx, iteration2Deadline: deadline2 };
};

// Called once a monthly call's iteration-2 deadline has passed —
// simply closes the round out. No further iterations.
const processIteration2Deadline = async (client, monthlyCallId) => {
    await client.query("UPDATE capital_goal_monthly_calls SET status = 'CLOSED' WHERE id = $1", [monthlyCallId]);
};

// ============================================================
// CATCH-UP SWEEP (v1.48.0) — runs the exact same deadline-processing
// logic as jobs/scheduler.js's daily cron, but scoped to one goal and
// run synchronously, right after that goal's monthly schedule is
// (re)generated. Needed for activateCallSchedule below: a goal whose
// schedule is generated retroactively (e.g. a legacy goal turned into
// a call-based one, or a goal whose calls were somehow never created)
// would otherwise sit with every past month still showing
// ITERATION_1 — technically "open" but with a deadline that's already
// passed — until the next 00:30 cron tick. Running the sweep
// immediately means whichever period is genuinely current opens (or
// is correctly mid-iteration-2) right away, with no wait and no
// unfair backdated fines (a fine is only ever assigned at the moment
// a payment is actually approved late, never as a blanket penalty for
// an unmet/closed period with zero pledges).
// ============================================================
const catchUpMonthlyCalls = async (client, capitalGoalId) => {
    const today = new Date().toISOString().slice(0, 10);
    let iteration1Processed = 0;
    let iteration2Processed = 0;

    // A handful of rounds is enough — each round can only close out
    // calls whose deadline has already passed, and a single goal has
    // at most a few dozen monthly rows, so this converges immediately
    // rather than needing to match the daily cron's per-day cadence.
    for (let round = 0; round < 24; round++) {
        const dueIteration1 = await client.query(`
            SELECT id FROM capital_goal_monthly_calls
            WHERE  capital_goal_id = $1 AND status = 'ITERATION_1' AND iteration1_deadline < $2
        `, [capitalGoalId, today]);
        for (const row of dueIteration1.rows) {
            const callResult = await client.query(
                'SELECT * FROM capital_goal_monthly_calls WHERE id = $1 FOR UPDATE', [row.id]
            );
            if (callResult.rows.length === 0) continue;
            await processIteration1Deadline(client, callResult.rows[0]);
            iteration1Processed++;
        }

        const dueIteration2 = await client.query(`
            SELECT id FROM capital_goal_monthly_calls
            WHERE  capital_goal_id = $1 AND status = 'ITERATION_2' AND iteration2_deadline < $2
        `, [capitalGoalId, today]);
        for (const row of dueIteration2.rows) {
            await processIteration2Deadline(client, row.id);
            iteration2Processed++;
        }

        if (dueIteration1.rows.length === 0 && dueIteration2.rows.length === 0) break;
    }

    return { iteration1Processed, iteration2Processed };
};

// ============================================================
// PERSONAL STATS + LEADERBOARD (against a specific goal, normally
// the current year's PRIMARY goal) — every figure is in the goal's
// own currency (converted_amount_goal_currency), frozen at the date
// each tranche was actually approved.
// ============================================================
const computeGoalContributionStats = async (client, capitalGoalId) => {
    const result = await client.query(`
        SELECT p.user_id,
               SUM(pp.converted_amount_goal_currency) AS total,
               MAX(pp.converted_amount_goal_currency) AS biggest,
               MIN(pp.converted_amount_goal_currency) AS smallest,
               COUNT(*) AS num_payments
        FROM   capital_goal_pledge_payments pp
        JOIN   capital_goal_pledges p        ON p.id = pp.pledge_id
        JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
        WHERE  mc.capital_goal_id = $1
        GROUP  BY p.user_id
    `, [capitalGoalId]);

    const goalResult = await client.query('SELECT * FROM capital_goals WHERE id = $1', [capitalGoalId]);
    const goal = goalResult.rows[0];
    const target = parseFloat(goal?.target_amount || 0);

    const byUser = {};
    let top = null;
    for (const row of result.rows) {
        const total = parseFloat(row.total);
        byUser[row.user_id] = {
            userId:        row.user_id,
            total,
            percentage:    target > 0 ? Math.round((total / target) * 1000) / 10 : 0,
            biggest:       parseFloat(row.biggest),
            smallest:      parseFloat(row.smallest),
            numPayments:   parseInt(row.num_payments),
        };
    }

    // v1.51.0 — fold in historical (pre-effective-date) contributions
    // per shareholder, so a member's stats reflect what they put in
    // before the goal formally started calling, same as the live
    // pledge-payment total above ("in consideration of the
    // contribution party / shareholder, are counted towards the
    // months in the past").
    if (goal) {
        const historicalByUser = await getHistoricalContributionsByUser(client, goal);
        for (const [userIdStr, historicalTotal] of Object.entries(historicalByUser)) {
            const userId = parseInt(userIdStr, 10);
            const existing = byUser[userId];
            const combinedTotal = (existing?.total || 0) + historicalTotal;
            byUser[userId] = {
                userId,
                total:          combinedTotal,
                percentage:     target > 0 ? Math.round((combinedTotal / target) * 1000) / 10 : 0,
                biggest:        existing?.biggest ?? historicalTotal,
                smallest:       existing?.smallest ?? historicalTotal,
                numPayments:    existing?.numPayments || 0,
                historicalTotal,
            };
        }
    }

    for (const row of Object.values(byUser)) {
        if (!top || row.total > top.total) {
            top = { userId: row.userId, total: row.total };
        }
    }

    let topContributorName = null;
    if (top) {
        const nameResult = await client.query(
            'SELECT first_name, last_name FROM users WHERE id = $1', [top.userId]
        );
        if (nameResult.rows.length > 0) {
            topContributorName = `${nameResult.rows[0].first_name} ${nameResult.rows[0].last_name}`;
        }
    }

    return { byUser, topContributor: top ? { ...top, name: topContributorName } : null };
};

module.exports = {
    generateMonthlyCallsForGoal,
    getActiveShareholderCount,
    getPeriodSettled,
    getPeriodShortfall,
    getCarryForwardBacklog,
    computeIteration1Baseline,
    getIteration2EligibleUserIds,
    computeIteration2Context,
    submitPledge,
    editPledge,
    rejectPledge,
    shouldCapToBaseline,
    settleApprovedContributionIntoPledge,
    approvePledgePayment,
    attributeDirectContributionToPrimaryGoal,
    processIteration1Deadline,
    processIteration2Deadline,
    catchUpMonthlyCalls,
    computeGoalContributionStats,
    getFineSettings,
    getCapitalGoalSettings,
    isCapitalGoalTrackingEnabled,
    effectivePeriodOf,
    isHistoricalPeriod,
    getPeriodCollected,
    getHistoricalPeriodCollected,
    getHistoricalContributionsByUser,
    DEFAULT_FINE_SETTINGS,
    DEFAULT_CAPITAL_GOAL_SETTINGS,
};
