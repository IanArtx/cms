// ============================================================
// ONE-TIME BACKFILL — v1.52.0 service fee monthly period tracking,
// applied retroactively to every existing agreement.
//
// Run this once, AFTER deploying v1.52.0 and running
// migration_v1.52.0.sql, the same way you'd run run_migration.js:
//
//     cd cms
//     node backfill_v1.52.0_service_fees.js
//
// It uses the exact same DB connection settings as the app itself
// (.env, same as run_migration.js), and does two things, in order:
//
// 1. PERIOD GENERATION — every existing service_fee_agreements row
//    gets its full run of service_fee_monthly_periods, from its own
//    start_date through the current month (or through end_date for
//    an already-ENDED agreement). Reuses the exact same
//    generateMonthlyPeriodsForAgreement the live app now calls on
//    create/amend — same idempotent ON CONFLICT DO NOTHING behaviour,
//    so this part is always safe to re-run.
//
// 2. HISTORICAL PAYMENT CASCADE — every existing service_fee_payments
//    row is walked in payment_date order, OLDEST FIRST, one agreement
//    at a time, and applied against whichever period is oldest-and-
//    still-unsettled AT THAT MOMENT in the replay — NOT matched to the
//    payment's own calendar month. This is the Treasurer's explicit,
//    confirmed answer for how historical payments should be
//    attributed (the same oldest-unpaid-period-first rule the live
//    recordPayment endpoint now uses going forward). Reuses the exact
//    same getOutstandingPeriodsForUpdate/cascadeAmountAcrossPeriods/
//    applyPaymentToPeriods functions the live confirm flow calls, so
//    behaviour is identical between backfilled and future payments.
//
//    Skips any payment that already has service_fee_payment_applications
//    rows (so re-running this script after a partial or previous run
//    never double-applies a payment).
//
// Any amount left over after a payment has cleared every period that
// existed up to that point (e.g. a payment that was actually ahead of
// schedule) is simply left unapplied and reported — service fees have
// no "banked credit for future months" concept (unlike the side fund),
// so nothing further happens to it automatically; it's already
// reflected in the real transaction/service_fee_payments row exactly
// as before, only the NEW per-period breakdown is skipped for that
// leftover amount.
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

// Reuse the REAL business logic — same generator/cascade the live
// app now uses for every agreement/payment going forward, rather than
// hand-rolling an equivalent copy here.
const {
    generateMonthlyPeriodsForAgreement,
    getOutstandingPeriodsForUpdate,
    cascadeAmountAcrossPeriods,
    applyPaymentToPeriods,
} = require('./src/services/serviceFeeService');

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

async function backfillPeriodGeneration() {
    console.log('\n=== PART 1: Monthly period generation for every existing agreement ===');

    const agreements = await pool.query('SELECT * FROM service_fee_agreements');
    if (agreements.rows.length === 0) {
        console.log('Nothing to backfill — no service fee agreements exist yet.');
        return;
    }

    let totalCreated = 0;
    for (const agreement of agreements.rows) {
        try {
            await withTransaction(async (client) => {
                const result = await generateMonthlyPeriodsForAgreement(client, agreement);
                totalCreated += result.created;
                console.log(`  Agreement #${agreement.id}: ${result.created} period(s) created (${result.monthCount} month(s) covered in total).`);
            });
        } catch (e) {
            console.log(`  [FAILED — needs manual review] Agreement #${agreement.id}: ${e.message}`);
        }
    }
    console.log(`Part 1 done — ${totalCreated} new period(s) created across ${agreements.rows.length} agreement(s).`);
}

async function backfillHistoricalPayments() {
    console.log('\n=== PART 2: Oldest-unpaid-period-first cascade for existing payments ===');

    const agreements = await pool.query('SELECT id FROM service_fee_agreements');
    let paymentsApplied = 0;
    let paymentsSkipped = 0;
    let totalLeftover = 0;

    for (const { id: agreementId } of agreements.rows) {
        // Every past payment for this agreement, oldest first — same
        // ordering the user explicitly asked the cascade to follow.
        const payments = await pool.query(`
            SELECT id, amount, payment_date
            FROM   service_fee_payments
            WHERE  agreement_id = $1
            ORDER  BY payment_date ASC, id ASC
        `, [agreementId]);

        for (const payment of payments.rows) {
            try {
                await withTransaction(async (client) => {
                    const alreadyApplied = await client.query(
                        'SELECT 1 FROM service_fee_payment_applications WHERE payment_id = $1',
                        [payment.id]
                    );
                    if (alreadyApplied.rows.length > 0) {
                        paymentsSkipped++;
                        return;
                    }

                    const outstandingPeriods = await getOutstandingPeriodsForUpdate(client, agreementId);
                    const { breakdown, remainder } = cascadeAmountAcrossPeriods(outstandingPeriods, payment.amount);

                    if (breakdown.length > 0) {
                        await applyPaymentToPeriods(client, { paymentId: payment.id, breakdown });
                    }

                    if (remainder > 0) {
                        totalLeftover += remainder;
                        console.log(`  Payment #${payment.id} (agreement ${agreementId}, ${payment.payment_date.toISOString?.() || payment.payment_date}): ` +
                            `${breakdown.length} period(s) settled, ${remainder} left over (no outstanding period existed for it at that point — left unapplied).`);
                    } else {
                        console.log(`  Payment #${payment.id} (agreement ${agreementId}): applied across ${breakdown.length} period(s).`);
                    }
                    paymentsApplied++;
                });
            } catch (e) {
                console.log(`  [FAILED — needs manual review] Payment #${payment.id} (agreement ${agreementId}): ${e.message}`);
            }
        }
    }

    console.log(`Part 2 done — ${paymentsApplied} payment(s) applied, ${paymentsSkipped} already-applied payment(s) skipped` +
        (totalLeftover > 0 ? `, ${totalLeftover} total left over with no matching period.` : '.'));
}

(async () => {
    try {
        await backfillPeriodGeneration();
        await backfillHistoricalPayments();
        console.log('\nBackfill complete.');
    } catch (e) {
        console.error('\nBackfill FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
