// ============================================================
// SERVICE FEE SERVICE (v1.52.0)
//
// Monthly-period tracking for Service Fee agreements — the same kind
// of shared "core logic used by several callers" module as
// sideFundService.js, which is the closer structural analog to copy
// (a flat recurring amount, no pledge/iteration/fine layer), NOT
// capitalGoalCallService.js (which has a whole pledge/iteration/fine
// machinery this feature doesn't need).
//
// Every function here that mutates data takes `client` and must be
// called from inside an existing withTransaction block — mirrors
// sideFundService.applySideFundPayment's own contract. Read-only
// stats functions take no client and use the shared `query` helper
// directly, since they're never part of a write transaction.
// ============================================================

const { query } = require('../config/database');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { periodAtOffset, monthsBetweenInclusive, dateInPeriod, normalizeDateInput } = require('../utils/dateUtils');
const { createError } = require('../utils/errors');

// ============================================================
// STATUS HELPER — shared by every place a period's cached status
// needs to be (re)computed after amount_due or amount_paid changes.
// amount_due <= 0 (a month waived down to zero via override) is
// always PAID, regardless of amount_paid — there's nothing left to
// collect.
// ============================================================
// ============================================================
// TREASURERS HELPER — same shape as serviceFeesController's own
// getTreasurers, kept as a separate small copy here (rather than the
// scheduler importing the whole controller, which pulls in
// storageService/emailTemplates/etc. it doesn't need) so the due-date
// reminder job can notify Treasury without that extra weight.
// ============================================================
const getTreasurers = async () => {
    const result = await query(`
        SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id
        WHERE  r.name IN ('Treasurer', 'Assistant Treasurer') AND u.is_active = TRUE
    `);
    return result.rows;
};

const statusForAmounts = (amountDue, amountPaid) => {
    const due = parseFloat(amountDue);
    const paid = parseFloat(amountPaid);
    if (due <= 0) return 'PAID';
    if (paid >= due) return 'PAID';
    if (paid > 0) return 'PARTIAL';
    return 'UNPAID';
};

// ============================================================
// INSERT ONE PERIOD IF IT DOESN'T ALREADY EXIST — the shared
// idempotent primitive both generateMonthlyPeriodsForAgreement (below)
// and extendPeriodsByCount (v1.53.0, advance recovery) build on.
// ============================================================
const insertPeriodIfMissing = async (client, agreement, period) => {
    const dueDate = dateInPeriod(period, agreement.payment_day);
    const result = await client.query(`
        INSERT INTO service_fee_monthly_periods (agreement_id, period, amount_due, due_date)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (agreement_id, period) DO NOTHING
        RETURNING id
    `, [agreement.id, period, agreement.monthly_amount, dueDate]);
    return result.rows.length > 0;
};

// ============================================================
// GENERATE MONTHLY PERIODS FOR AN AGREEMENT
// Creates one service_fee_monthly_periods row per calendar month from
// the agreement's start_date through the current month, inclusive.
// amount_due defaults to the agreement's current monthly_amount for
// every period that doesn't already exist — idempotent via
// ON CONFLICT (agreement_id, period) DO NOTHING, so it's always safe
// to re-run (e.g. a daily sweep extending every agreement's periods
// into a newly-arrived month, or re-running after an amendment).
//
// Deliberately does NOT touch any period that already exists — an
// amendment's own "regenerate FUTURE periods' amount_due" behaviour
// (updateAgreement) is a separate, explicit UPDATE, not a side effect
// of calling this again.
//
// Must be called from inside an existing withTransaction block.
// ============================================================
const generateMonthlyPeriodsForAgreement = async (client, agreement) => {
    const startDate = normalizeDateInput(agreement.start_date);
    const today = new Date().toISOString().split('T')[0];
    // An agreement that ended before it ever reached its own start
    // date can't happen (service_fee_end_after_start), but an ENDED
    // agreement's last relevant month is its end_date, not "now".
    const throughDate = agreement.end_date && normalizeDateInput(agreement.end_date) < today
        ? normalizeDateInput(agreement.end_date)
        : today;

    const monthCount = monthsBetweenInclusive(startDate, throughDate);
    let created = 0;
    for (let i = 0; i < monthCount; i++) {
        const period = periodAtOffset(startDate, i);
        if (await insertPeriodIfMissing(client, agreement, period)) created++;
    }
    return { created, monthCount };
};

// ============================================================
// EXTEND PERIODS BY COUNT (v1.53.0) — generates `count` more periods
// immediately following the agreement's own latest existing period
// (or starting from the current month if it somehow has none yet).
// Used only by computeAdvanceRecoverySchedule below, when an advance
// is larger than every already-existing future period can absorb.
// Must be called from inside an existing withTransaction block.
// ============================================================
const extendPeriodsByCount = async (client, agreement, count) => {
    const latestResult = await client.query(
        `SELECT period FROM service_fee_monthly_periods WHERE agreement_id = $1 ORDER BY period DESC LIMIT 1`,
        [agreement.id]
    );
    const basePeriod = latestResult.rows.length > 0
        ? latestResult.rows[0].period
        : new Date().toISOString().slice(0, 7);
    const baseDate = `${basePeriod}-01`;
    let created = 0;
    for (let i = 1; i <= count; i++) {
        const period = periodAtOffset(baseDate, i);
        if (await insertPeriodIfMissing(client, agreement, period)) created++;
    }
    return created;
};

// ============================================================
// REGENERATE FUTURE PERIODS' amount_due AFTER AN AMENDMENT
// Called right after a new row lands in service_fee_agreement_
// amendments (updateAgreement, when monthly_amount actually changes).
// Updates amount_due (and re-derives status, since a change in
// amount_due can flip a PAID month back to PARTIAL or vice versa) for
// every period from effectiveFrom's month onward that has NOT been
// individually overridden (amount_override IS NULL) — an override is
// a deliberate one-off figure for that specific month and must never
// be silently clobbered by a later going-forward amendment.
// Must be called from inside an existing withTransaction block.
// ============================================================
const applyAmendmentToFuturePeriods = async (client, { agreementId, newAmount, effectiveFrom }) => {
    const effectivePeriod = effectiveFrom.slice(0, 7);
    const result = await client.query(`
        UPDATE service_fee_monthly_periods
        SET    amount_due = $1,
               status     = CASE WHEN $1::numeric <= 0 THEN 'PAID'
                                  WHEN amount_paid >= $1::numeric THEN 'PAID'
                                  WHEN amount_paid > 0 THEN 'PARTIAL'
                                  ELSE 'UNPAID' END,
               updated_at = NOW()
        WHERE  agreement_id = $2 AND period >= $3 AND amount_override IS NULL
        RETURNING id
    `, [newAmount, agreementId, effectivePeriod]);
    return { updated: result.rowCount };
};

// ============================================================
// OUTSTANDING PERIODS (oldest-first) — locks the rows (FOR UPDATE)
// since every caller uses this immediately before applying money
// against them.
// ============================================================
const getOutstandingPeriodsForUpdate = async (client, agreementId) => {
    const result = await client.query(`
        SELECT id, period, amount_due, amount_paid, status, due_date
        FROM   service_fee_monthly_periods
        WHERE  agreement_id = $1 AND status IN ('UNPAID', 'PARTIAL')
        ORDER  BY period ASC
        FOR UPDATE
    `, [agreementId]);
    return result.rows;
};

// ============================================================
// CASCADE AN AMOUNT ACROSS OUTSTANDING PERIODS, OLDEST-FIRST
// (per the user's explicit answer: oldest-unpaid-period-first
// cascade, NOT matching a payment's own calendar month). Pure
// computation — does not write anything. Used both to build the
// auto-filled, editable "Settle Past Months" breakdown (Q3's answer)
// and as recordPayment's default single-period behaviour when no
// period is specified.
//
// Returns { breakdown: [{ period_id, period, amount }], remainder }
// — remainder is whatever's left over once every outstanding period
// is fully covered (e.g. an overpayment); callers decide what to do
// with it (today: nothing automatic, unlike side fund's credit-
// banking — service fees have no "future credit" concept the user
// asked for, so an overpayment simply isn't auto-applied anywhere).
// ============================================================
const cascadeAmountAcrossPeriods = (outstandingPeriods, amount) => {
    let remaining = parseFloat(amount);
    const breakdown = [];
    for (const p of outstandingPeriods) {
        if (remaining <= 0) break;
        const owed = parseFloat(p.amount_due) - parseFloat(p.amount_paid);
        if (owed <= 0) continue;
        const applied = Math.min(remaining, owed);
        breakdown.push({ period_id: p.id, period: p.period, amount: applied });
        remaining = parseFloat((remaining - applied).toFixed(4));
    }
    return { breakdown, remainder: remaining };
};

// ============================================================
// APPLY A CONFIRMED PAYMENT'S BREAKDOWN TO ITS PERIODS
// Called by paymentConfirmationsController.confirmPayment once the
// real service_fee_payments row exists (paymentId). breakdown is
// whatever was stored in service_fee_payment_confirmation_periods at
// confirmation-creation time (one row for a single-month payment,
// several for a bulk settlement) — this is the ONLY place
// service_fee_monthly_periods.amount_paid/status actually change, and
// the only place service_fee_payment_applications rows get written.
// Must be called from inside an existing withTransaction block.
// ============================================================
const applyPaymentToPeriods = async (client, { paymentId, breakdown }) => {
    for (const line of breakdown) {
        const periodResult = await client.query(
            'SELECT id, amount_due, amount_paid FROM service_fee_monthly_periods WHERE id = $1 FOR UPDATE',
            [line.period_id]
        );
        if (periodResult.rows.length === 0) continue; // period was somehow removed — skip rather than fail the whole confirmation
        const p = periodResult.rows[0];
        const newPaid = parseFloat(p.amount_paid) + parseFloat(line.amount);
        const newStatus = statusForAmounts(p.amount_due, newPaid);

        await client.query(`
            UPDATE service_fee_monthly_periods
            SET    amount_paid = $1, status = $2, updated_at = NOW()
            WHERE  id = $3
        `, [newPaid, newStatus, p.id]);

        await client.query(`
            INSERT INTO service_fee_payment_applications (payment_id, period_id, amount)
            VALUES ($1, $2, $3)
        `, [paymentId, line.period_id, line.amount]);
    }
};

// ============================================================
// COMPUTE AN ADVANCE'S RECOVERY SCHEDULE (v1.53.0)
// Per the Treasurer's confirmed answer: an approved advance is
// recovered IN FULL from the very next unpaid month(s), oldest-future
// first, spilling into further months if one isn't enough. "Future"
// here means the current calendar month onward — a PAST unpaid month
// is separate arrears, handled by the ordinary payment/settle flows,
// never silently absorbed by an advance.
//
// If every already-existing future period together can't fully cover
// the amount, this generates as many additional periods as needed
// (extendPeriodsByCount) so the schedule can still be computed in
// full — an advance is always fully scheduled up front, never left
// partially unscheduled because periods hadn't been created yet.
//
// Pure-ish: the only side effect is generating new (always-going-to-
// exist-eventually) future periods; it does NOT write any recovery
// rows itself — the caller (approveAdvance) reviews/edits the
// returned breakdown and persists it. Must be called from inside an
// existing withTransaction block.
//
// Returns { breakdown: [{ period_id, period, amount }], remainder }
// — remainder should always be 0 in practice (the generation loop is
// bounded at 60 months purely as a runaway-input guard, not something
// a real advance should ever hit).
// ============================================================
const computeAdvanceRecoverySchedule = async (client, agreement, amount) => {
    const todayPeriod = new Date().toISOString().slice(0, 7);
    const amt = parseFloat(amount);

    const getFuturePeriods = async () => (await client.query(`
        SELECT id, period, amount_due, amount_paid
        FROM   service_fee_monthly_periods
        WHERE  agreement_id = $1 AND period >= $2 AND status NOT IN ('PAID', 'EXCLUDED')
        ORDER  BY period ASC
    `, [agreement.id, todayPeriod])).rows;

    let futurePeriods = await getFuturePeriods();
    const owedTotal = (periods) => periods.reduce(
        (sum, p) => sum + Math.max(0, parseFloat(p.amount_due) - parseFloat(p.amount_paid)), 0
    );

    if (owedTotal(futurePeriods) < amt) {
        const deficit = amt - owedTotal(futurePeriods);
        const monthlyCapacity = parseFloat(agreement.monthly_amount) > 0 ? parseFloat(agreement.monthly_amount) : amt;
        const additionalMonths = Math.min(60, Math.ceil(deficit / monthlyCapacity));
        if (additionalMonths > 0) {
            await extendPeriodsByCount(client, agreement, additionalMonths);
            futurePeriods = await getFuturePeriods();
        }
    }

    return cascadeAmountAcrossPeriods(futurePeriods, amt);
};

// ============================================================
// APPLY AN ADVANCE'S RECOVERY SCHEDULE (v1.53.0)
// Called by paymentConfirmationsController.confirmPayment once an
// advance's disbursement is actually confirmed received — NOT at
// approval time. breakdown is whatever was stored (unapplied) in
// service_fee_advance_recoveries when the Treasurer approved the
// advance. This is an internal accounting offset only, per the
// Treasurer's confirmed answer: each named period's amount_paid is
// incremented exactly like a real payment would, but no separate
// transaction or service_fee_payment_applications row is written —
// the money already moved once, at disbursement.
// Must be called from inside an existing withTransaction block.
// ============================================================
const applyAdvanceRecovery = async (client, { advanceId, breakdown }) => {
    for (const line of breakdown) {
        const periodResult = await client.query(
            'SELECT id, amount_due, amount_paid FROM service_fee_monthly_periods WHERE id = $1 FOR UPDATE',
            [line.period_id]
        );
        if (periodResult.rows.length === 0) continue;
        const p = periodResult.rows[0];
        const newPaid = parseFloat(p.amount_paid) + parseFloat(line.amount);
        const newStatus = statusForAmounts(p.amount_due, newPaid);

        await client.query(`
            UPDATE service_fee_monthly_periods
            SET    amount_paid = $1, status = $2, updated_at = NOW()
            WHERE  id = $3
        `, [newPaid, newStatus, p.id]);

        await client.query(`
            UPDATE service_fee_advance_recoveries
            SET    applied_at = NOW()
            WHERE  advance_id = $1 AND period_id = $2
        `, [advanceId, line.period_id]);
    }
};

// ============================================================
// READ AN ADVANCE'S STORED RECOVERY SCHEDULE — used both to show the
// already-approved schedule back to the Treasurer/recipient, and by
// confirmPayment to know exactly what to apply.
// ============================================================
const getAdvanceRecoverySchedule = async (advanceId) => {
    const result = await query(`
        SELECT r.id, r.period_id, p.period, r.amount, r.applied_at
        FROM   service_fee_advance_recoveries r
        JOIN   service_fee_monthly_periods p ON p.id = r.period_id
        WHERE  r.advance_id = $1
        ORDER  BY p.period ASC
    `, [advanceId]);
    return result.rows;
};

// ============================================================
// PER-MONTH OVERRIDE — Treasurer changes ONE historical period's
// amount_due without touching the agreement's ongoing monthly_amount
// (service_fee_agreement_amendments is the going-forward tool; this
// is deliberately separate and scoped to a single period). Re-derives
// status the same way applyAmendmentToFuturePeriods does, since
// raising/lowering amount_due can flip PAID/PARTIAL/UNPAID either
// way. Audited via logAction (no dedicated history table — matches
// the scope this needs).
// Must be called from inside an existing withTransaction block.
// ============================================================
const setPeriodOverride = async (client, { periodId, agreementId, newAmountDue, reason, overrideBy }) => {
    const periodResult = await client.query(
        'SELECT id, agreement_id, period, amount_due, amount_paid FROM service_fee_monthly_periods WHERE id = $1 FOR UPDATE',
        [periodId]
    );
    if (periodResult.rows.length === 0 || periodResult.rows[0].agreement_id !== agreementId) {
        return null;
    }
    const p = periodResult.rows[0];
    const newStatus = statusForAmounts(newAmountDue, p.amount_paid);

    await client.query(`
        UPDATE service_fee_monthly_periods
        SET    amount_due      = $1,
               status          = $2,
               amount_override = $1,
               override_reason = $3,
               override_by     = $4,
               override_at     = NOW(),
               updated_at      = NOW()
        WHERE  id = $5
    `, [newAmountDue, newStatus, reason, overrideBy, periodId]);

    await logAction(overrideBy, ACTIONS.SERVICE_FEE_PERIOD_OVERRIDE_SET, MODULES.FINANCE, {
        recordType:  'service_fee_monthly_periods',
        recordId:    periodId,
        oldValues:   { amount_due: p.amount_due },
        newValues:   { amount_due: newAmountDue, reason },
        description: `Service fee period ${p.period} (agreement ${agreementId}) amount overridden from ${p.amount_due} to ${newAmountDue}: ${reason}`,
        client,
    });

    return { id: periodId, period: p.period, amount_due: newAmountDue, status: newStatus };
};

// ============================================================
// EXCLUDE / INCLUDE A PERIOD (v1.54.0)
// Deliberately separate from setPeriodOverride above: an override
// changes what a month is WORTH (amount_due), and a zero-override
// still counts the month as PAID once settled — which is misleading
// for a month that was never actually paid, just forgiven. Exclude
// instead cancels the obligation outright: the period is pulled out of
// every outstanding/overdue calculation, but is never counted as PAID
// either, since no money moved. amount_due/amount_paid are left
// completely untouched by exclusion, which is what makes reversing it
// (includePeriod) a pure status recompute rather than a data restore.
//
// Only an UNPAID or PARTIAL period can be excluded — a PAID period has
// nothing left to forgive, and an already-EXCLUDED period is a no-op
// guarded against here rather than silently double-processed.
// Must be called from inside an existing withTransaction block.
// ============================================================
const excludePeriod = async (client, { periodId, agreementId, reason, excludedBy }) => {
    const periodResult = await client.query(
        'SELECT id, agreement_id, period, status, amount_due, amount_paid FROM service_fee_monthly_periods WHERE id = $1 FOR UPDATE',
        [periodId]
    );
    if (periodResult.rows.length === 0 || periodResult.rows[0].agreement_id !== agreementId) {
        return null;
    }
    const p = periodResult.rows[0];
    if (p.status === 'PAID') {
        throw createError.badRequest('This month is already fully paid — there is nothing to exclude');
    }
    if (p.status === 'EXCLUDED') {
        throw createError.badRequest('This month is already excluded');
    }

    await client.query(`
        UPDATE service_fee_monthly_periods
        SET    status = 'EXCLUDED', excluded_reason = $1, excluded_by = $2, excluded_at = NOW(), updated_at = NOW()
        WHERE  id = $3
    `, [reason, excludedBy, periodId]);

    await logAction(excludedBy, ACTIONS.SERVICE_FEE_PERIOD_EXCLUDED, MODULES.FINANCE, {
        recordType:  'service_fee_monthly_periods',
        recordId:    periodId,
        oldValues:   { status: p.status },
        newValues:   { status: 'EXCLUDED', reason },
        description: `Service fee period ${p.period} (agreement ${agreementId}) excluded from obligations: ${reason}`,
        client,
    });

    return { id: periodId, period: p.period, status: 'EXCLUDED', previous_status: p.status };
};

const includePeriod = async (client, { periodId, agreementId, reason, includedBy }) => {
    const periodResult = await client.query(
        'SELECT id, agreement_id, period, status, amount_due, amount_paid FROM service_fee_monthly_periods WHERE id = $1 FOR UPDATE',
        [periodId]
    );
    if (periodResult.rows.length === 0 || periodResult.rows[0].agreement_id !== agreementId) {
        return null;
    }
    const p = periodResult.rows[0];
    if (p.status !== 'EXCLUDED') {
        throw createError.badRequest('This month is not currently excluded');
    }

    const restoredStatus = statusForAmounts(p.amount_due, p.amount_paid);

    await client.query(`
        UPDATE service_fee_monthly_periods
        SET    status = $1, excluded_reason = NULL, excluded_by = NULL, excluded_at = NULL, updated_at = NOW()
        WHERE  id = $2
    `, [restoredStatus, periodId]);

    await logAction(includedBy, ACTIONS.SERVICE_FEE_PERIOD_INCLUDED, MODULES.FINANCE, {
        recordType:  'service_fee_monthly_periods',
        recordId:    periodId,
        oldValues:   { status: 'EXCLUDED' },
        newValues:   { status: restoredStatus, reason },
        description: `Service fee period ${p.period} (agreement ${agreementId}) restored to the agreement's obligations: ${reason}`,
        client,
    });

    return { id: periodId, period: p.period, status: restoredStatus, previous_status: 'EXCLUDED' };
};

// ============================================================
// PER-AGREEMENT STATS — the "My Service Fee" personal chart tab
// (individual paid/unpaid months, most/least paid, total earned).
// Read-only, not part of any write transaction.
// ============================================================
const computeAgreementStats = async (agreementId) => {
    // v1.54.1 — id MUST be selected here: every period row returned to
    // the frontend (My Service Fee tab, agreement detail page) comes
    // from this query, and Request Payment / Override / Exclude /
    // Include all key off period.id. Without it every row's id was
    // undefined, so React's selection state collapsed onto a single
    // shared `undefined` key — checking one month in Request Payment
    // checked/unchecked ALL of them together, and Override/Exclude/
    // Include silently sent periodId=undefined to the API.
    const result = await query(`
        SELECT id, period, amount_due, amount_paid, status,
               excluded_reason, excluded_at
        FROM   service_fee_monthly_periods
        WHERE  agreement_id = $1
        ORDER  BY period ASC
    `, [agreementId]);
    const periods = result.rows;

    const paidMonths = periods.filter(p => p.status === 'PAID').length;
    const partialMonths = periods.filter(p => p.status === 'PARTIAL').length;
    const unpaidMonths = periods.filter(p => p.status === 'UNPAID').length;
    // v1.54.0 — an EXCLUDED month is deliberately its own bucket, never
    // folded into paid_months (no money moved) or unpaid_months (it's
    // not actually owed) — see excludePeriod's own header comment.
    const excludedMonths = periods.filter(p => p.status === 'EXCLUDED').length;
    const totalEarned = periods.reduce((sum, p) => sum + parseFloat(p.amount_paid), 0);
    const totalExcluded = periods
        .filter(p => p.status === 'EXCLUDED')
        .reduce((sum, p) => sum + parseFloat(p.amount_due), 0);

    let mostPaid = null;
    let leastPaid = null;
    for (const p of periods) {
        const paid = parseFloat(p.amount_paid);
        if (paid <= 0) continue; // "least paid month" should mean the smallest NON-ZERO payment, not every unpaid month
        if (!mostPaid || paid > parseFloat(mostPaid.amount_paid)) mostPaid = p;
        if (!leastPaid || paid < parseFloat(leastPaid.amount_paid)) leastPaid = p;
    }

    return {
        periods,
        summary: {
            total_months: periods.length,
            paid_months: paidMonths,
            partial_months: partialMonths,
            unpaid_months: unpaidMonths,
            excluded_months: excludedMonths,
            total_earned: totalEarned,
            total_excluded: totalExcluded,
            most_paid_month: mostPaid ? { period: mostPaid.period, amount: parseFloat(mostPaid.amount_paid) } : null,
            least_paid_month: leastPaid ? { period: leastPaid.period, amount: parseFloat(leastPaid.amount_paid) } : null,
        },
    };
};

// ============================================================
// TREASURY-WIDE AGGREGATE STATS — the Treasurer-side equivalent,
// across every agreement (active and ended), for SERVICE_FEE_VIEW
// holders. Read-only.
// ============================================================
const computeTreasuryAggregateStats = async () => {
    // v1.54.0 — total_outstanding must never include an EXCLUDED
    // period's (amount_due - amount_paid) — that gap was deliberately
    // forgiven, not left unpaid. Scoping the GREATEST(...) sum to
    // non-excluded rows is what actually fixes the bug the Treasurer
    // would otherwise see (an excluded month still inflating "how much
    // is still owed" treasury-wide).
    const totals = await query(`
        SELECT
            COUNT(*) FILTER (WHERE smp.status = 'PAID')     AS paid_periods,
            COUNT(*) FILTER (WHERE smp.status = 'PARTIAL')  AS partial_periods,
            COUNT(*) FILTER (WHERE smp.status = 'UNPAID')   AS unpaid_periods,
            COUNT(*) FILTER (WHERE smp.status = 'EXCLUDED') AS excluded_periods,
            COALESCE(SUM(smp.amount_paid), 0) AS total_paid,
            COALESCE(SUM(GREATEST(smp.amount_due - smp.amount_paid, 0))
                FILTER (WHERE smp.status != 'EXCLUDED'), 0) AS total_outstanding,
            COALESCE(SUM(smp.amount_due) FILTER (WHERE smp.status = 'EXCLUDED'), 0) AS total_excluded
        FROM   service_fee_monthly_periods smp
    `);

    const perAgreement = await query(`
        SELECT sfa.id AS agreement_id, u.first_name, u.last_name,
               sfa.status AS agreement_status,
               COUNT(*) FILTER (WHERE smp.status = 'PAID')     AS paid_periods,
               COUNT(*) FILTER (WHERE smp.status = 'PARTIAL')  AS partial_periods,
               COUNT(*) FILTER (WHERE smp.status = 'UNPAID')   AS unpaid_periods,
               COUNT(*) FILTER (WHERE smp.status = 'EXCLUDED') AS excluded_periods,
               COALESCE(SUM(smp.amount_paid), 0) AS total_paid,
               COALESCE(SUM(GREATEST(smp.amount_due - smp.amount_paid, 0))
                   FILTER (WHERE smp.status != 'EXCLUDED'), 0) AS total_outstanding
        FROM   service_fee_agreements sfa
        JOIN   users u ON u.id = sfa.user_id
        LEFT JOIN service_fee_monthly_periods smp ON smp.agreement_id = sfa.id
        GROUP  BY sfa.id, u.first_name, u.last_name, sfa.status
        ORDER  BY total_outstanding DESC
    `);

    return {
        totals: totals.rows[0],
        per_agreement: perAgreement.rows,
    };
};

module.exports = {
    getTreasurers,
    statusForAmounts,
    generateMonthlyPeriodsForAgreement,
    extendPeriodsByCount,
    applyAmendmentToFuturePeriods,
    getOutstandingPeriodsForUpdate,
    cascadeAmountAcrossPeriods,
    applyPaymentToPeriods,
    computeAdvanceRecoverySchedule,
    applyAdvanceRecovery,
    getAdvanceRecoverySchedule,
    setPeriodOverride,
    excludePeriod,
    includePeriod,
    computeAgreementStats,
    computeTreasuryAggregateStats,
};
