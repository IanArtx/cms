// ============================================================
// REPAIR SCRIPT — v1.54.0. System-wide pass that finds every
// CONFIRMED service fee payment whose amount isn't fully reflected in
// service_fee_payment_applications, and applies the unapplied
// remainder against that agreement's CURRENT outstanding periods,
// oldest-first — exactly the cascade the live recordPayment/
// confirmPayment flow already uses going forward.
//
// Reported directly: a real, posted payment (visible in Payment
// History, with its own transaction reference) showed zero effect on
// any month in the agreement's monthly breakdown — every month still
// UNPAID. The most likely cause: at the moment that payment's
// confirmation was created, recordPayment's own cascade
// (getOutstandingPeriodsForUpdate + cascadeAmountAcrossPeriods) found
// NO outstanding periods to cascade against (e.g. the agreement's
// periods hadn't caught up to "today" yet at that exact moment), so
// periodBreakdown came back empty — createServiceFeePaymentConfirmation
// skips writing any service_fee_payment_confirmation_periods rows when
// the breakdown is empty, and confirmPayment later has nothing stored
// to apply. The transaction and service_fee_payments row still post
// correctly either way — only the NEW per-period bookkeeping silently
// has nothing to work with.
//
// This is NOT the same job as backfill_v1.52.0_service_fees.js, which
// was a one-time initial replay for agreements that had no periods at
// all yet and skipped a payment outright the moment it had ANY
// applications recorded. This script instead computes each payment's
// already-applied amount directly from service_fee_payment_applications
// and only ever applies the leftover — safe to run repeatedly, and
// safe to run alongside payments that were already applied correctly
// (their leftover computes to ~0, so they're simply skipped).
//
// Run it the same way as any other one-off script in this repo:
//
//     cd cms
//     node backfill_v1.54.0_orphaned_service_fee_payments.js
//
// Uses the same .env DB connection settings as the live app.
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');

console.log(`Using DB_USER=${process.env.DB_USER}, DB_NAME=${process.env.DB_NAME}, DB_HOST=${process.env.DB_HOST}, password length=${(process.env.DB_PASSWORD || '').length}`);

const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Reuse the REAL business logic — the exact same generator/cascade/
// applier the live app uses for every payment going forward.
const {
    generateMonthlyPeriodsForAgreement,
    getOutstandingPeriodsForUpdate,
    cascadeAmountAcrossPeriods,
    applyPaymentToPeriods,
} = require('./src/services/serviceFeeService');

// Amounts here are NUMERIC(20,4) in Postgres, which the pg driver
// returns as strings — a tiny epsilon avoids treating rounding noise
// as a real unapplied remainder.
const EPSILON = 0.001;

async function withTransaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function findUnderAppliedPayments() {
    // Every confirmed service_fee_payments row alongside how much of
    // it has actually been applied to a period so far (0 if none).
    const result = await pool.query(`
        SELECT p.id, p.agreement_id, p.amount, p.payment_date,
               COALESCE(SUM(a.amount), 0) AS applied_amount
        FROM   service_fee_payments p
        LEFT JOIN service_fee_payment_applications a ON a.payment_id = p.id
        GROUP  BY p.id, p.agreement_id, p.amount, p.payment_date
        HAVING p.amount - COALESCE(SUM(a.amount), 0) > $1
        ORDER  BY p.agreement_id, p.payment_date ASC, p.id ASC
    `, [EPSILON]);
    return result.rows;
}

async function repairOrphanedPayments() {
    console.log('\n=== Repair pass: service fee payments not fully reflected in their monthly periods ===');

    const underApplied = await findUnderAppliedPayments();
    if (underApplied.length === 0) {
        console.log('Nothing to repair — every confirmed payment is already fully applied to its periods.');
        return;
    }

    console.log(`Found ${underApplied.length} payment(s) with an unapplied remainder.`);

    // Cache each agreement's own row (generateMonthlyPeriodsForAgreement
    // needs the full agreement, not just its id) — payments are already
    // ordered oldest-first within each agreement above.
    const agreementCache = new Map();
    const getAgreement = async (agreementId) => {
        if (!agreementCache.has(agreementId)) {
            const result = await pool.query('SELECT * FROM service_fee_agreements WHERE id = $1', [agreementId]);
            agreementCache.set(agreementId, result.rows[0] || null);
        }
        return agreementCache.get(agreementId);
    };

    let repaired = 0;
    let totalApplied = 0;
    let totalLeftover = 0;

    for (const payment of underApplied) {
        const unappliedAmount = parseFloat(payment.amount) - parseFloat(payment.applied_amount);
        try {
            await withTransaction(async (client) => {
                const agreement = await getAgreement(payment.agreement_id);
                if (!agreement) {
                    console.log(`  [SKIPPED] Payment #${payment.id}: agreement #${payment.agreement_id} no longer exists.`);
                    return;
                }

                // Idempotent — makes sure periods exist up through the
                // current month before cascading, same as recordPayment
                // already does on every live call.
                await generateMonthlyPeriodsForAgreement(client, agreement);

                const outstandingPeriods = await getOutstandingPeriodsForUpdate(client, agreement.id);
                const { breakdown, remainder } = cascadeAmountAcrossPeriods(outstandingPeriods, unappliedAmount);

                if (breakdown.length > 0) {
                    await applyPaymentToPeriods(client, { paymentId: payment.id, breakdown });
                    totalApplied += (unappliedAmount - remainder);
                    repaired++;
                    console.log(`  Payment #${payment.id} (agreement ${agreement.id}, ${payment.payment_date.toISOString?.() || payment.payment_date}): ` +
                        `${unappliedAmount.toFixed(2)} unapplied → settled across ${breakdown.length} period(s): ` +
                        breakdown.map(b => `${b.period} (${b.amount.toFixed ? b.amount.toFixed(2) : b.amount})`).join(', ') + '.');
                } else {
                    console.log(`  Payment #${payment.id} (agreement ${agreement.id}): ${unappliedAmount.toFixed(2)} unapplied, ` +
                        `but no outstanding month exists to absorb it (every month is PAID/EXCLUDED) — left as-is.`);
                }

                if (remainder > EPSILON) {
                    totalLeftover += remainder;
                    console.log(`    ${remainder.toFixed(2)} still left over after every outstanding month at this agreement was covered.`);
                }
            });
        } catch (e) {
            console.log(`  [FAILED — needs manual review] Payment #${payment.id} (agreement ${payment.agreement_id}): ${e.message}`);
        }
    }

    console.log(`\nRepair pass done — ${repaired} payment(s) repaired, ${totalApplied.toFixed(2)} total newly applied` +
        (totalLeftover > EPSILON ? `, ${totalLeftover.toFixed(2)} total left with no outstanding month to absorb it.` : '.'));
}

(async () => {
    try {
        await repairOrphanedPayments();
        console.log('\nDone.');
    } catch (e) {
        console.error('\nRepair pass FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
