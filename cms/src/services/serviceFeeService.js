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
        const dueDate = dateInPeriod(period, agreement.payment_day);
        const result = await client.query(`
            INSERT INTO service_fee_monthly_periods (agreement_id, period, amount_due, due_date)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (agreement_id, period) DO NOTHING
            RETURNING id
        `, [agreement.id, period, agreement.monthly_amount, dueDate]);
        if (result.rows.length > 0) created++;
    }
    return { created, monthCount };
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
// PER-AGREEMENT STATS — the "My Service Fee" personal chart tab
// (individual paid/unpaid months, most/least paid, total earned).
// Read-only, not part of any write transaction.
// ============================================================
const computeAgreementStats = async (agreementId) => {
    const result = await query(`
        SELECT period, amount_due, amount_paid, status
        FROM   service_fee_monthly_periods
        WHERE  agreement_id = $1
        ORDER  BY period ASC
    `, [agreementId]);
    const periods = result.rows;

    const paidMonths = periods.filter(p => p.status === 'PAID').length;
    const partialMonths = periods.filter(p => p.status === 'PARTIAL').length;
    const unpaidMonths = periods.filter(p => p.status === 'UNPAID').length;
    const totalEarned = periods.reduce((sum, p) => sum + parseFloat(p.amount_paid), 0);

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
            total_earned: totalEarned,
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
    const totals = await query(`
        SELECT
            COUNT(*) FILTER (WHERE smp.status = 'PAID')    AS paid_periods,
            COUNT(*) FILTER (WHERE smp.status = 'PARTIAL') AS partial_periods,
            COUNT(*) FILTER (WHERE smp.status = 'UNPAID')  AS unpaid_periods,
            COALESCE(SUM(smp.amount_paid), 0)              AS total_paid,
            COALESCE(SUM(GREATEST(smp.amount_due - smp.amount_paid, 0)), 0) AS total_outstanding
        FROM   service_fee_monthly_periods smp
    `);

    const perAgreement = await query(`
        SELECT sfa.id AS agreement_id, u.first_name, u.last_name,
               sfa.status AS agreement_status,
               COUNT(*) FILTER (WHERE smp.status = 'PAID')    AS paid_periods,
               COUNT(*) FILTER (WHERE smp.status = 'PARTIAL') AS partial_periods,
               COUNT(*) FILTER (WHERE smp.status = 'UNPAID')  AS unpaid_periods,
               COALESCE(SUM(smp.amount_paid), 0)              AS total_paid,
               COALESCE(SUM(GREATEST(smp.amount_due - smp.amount_paid, 0)), 0) AS total_outstanding
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
    applyAmendmentToFuturePeriods,
    getOutstandingPeriodsForUpdate,
    cascadeAmountAcrossPeriods,
    applyPaymentToPeriods,
    setPeriodOverride,
    computeAgreementStats,
    computeTreasuryAggregateStats,
};
