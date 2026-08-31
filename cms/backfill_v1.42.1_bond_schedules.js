// ============================================================
// ONE-TIME BACKFILL — v1.42.1 bond coupon schedule repair
//
// Run this once, AFTER deploying v1.42.1 (no schema migration for
// this one — it's a pure code fix, so just redeploy then run this):
//
//     cd cms
//     node backfill_v1.42.1_bond_schedules.js
//
// THE BUG (see docs/CMS_BIBLE.md Section 39.6 for the full writeup):
// generateBondCouponSchedule() (cms/src/utils/bondSchedule.js) builds
// its dates with `new Date(`${someDate}T00:00:00Z`)`, which assumes
// someDate is a plain "YYYY-MM-DD" string. Editing a bond's coupon
// schedule after creation (PATCH /:id/coupon-schedule, or editing a
// still-PENDING bond) always passed the investment's OWN start_date /
// expected_end_date straight from the database row — and node-postgres
// returns a DATE column as a native JS Date object, not a string. The
// template literal silently stringified that Date object into
// something unparseable, producing an Invalid Date — and because every
// comparison against an Invalid Date evaluates to false, the schedule
// silently collapsed to just the one always-forced final coupon, with
// no error at all. This affected EVERY bond ever rescheduled this way
// (first coupon date and/or frequency), regardless of what date or
// frequency was actually entered — the v1.42.0 fix's own anchor
// validation didn't catch it either, for the exact same reason.
//
// THE FIX: bondSchedule.js now normalizes any Date object (or full ISO
// timestamp string) to a plain date string before using it, and throws
// a clear error if a date still can't be parsed after that, instead of
// silently producing Invalid Date comparisons.
//
// THE GOOD NEWS: unlike the v1.42.0-era diagnosis (which assumed the
// wrong first_coupon_date might have been entered and was unrecoverable
// after the fact), the REAL bug never had anything to do with what date
// was entered — the value the user typed was always stored correctly
// in investments.first_coupon_date / investments.coupon_frequency, it
// just never got used correctly to REGENERATE the schedule. That means
// every affected bond IS safely recoverable: this script just
// regenerates each affected bond's schedule from its own currently
// stored fields, exactly as if "Edit Coupon Date / Frequency" were
// re-submitted right now with the same values already on file — except
// now going through the fixed generator.
//
// SCOPE: every BOND investment where no coupon has ever been marked
// PAID or MISSED (the same boundary updateCouponSchedule itself
// enforces — a coupon that's already been paid or written off is never
// touched). Deliberately regenerates ALL of them, not just the ones
// that look collapsed to one row — this is always safe and always a
// no-op for a bond whose schedule was already correct (regenerating
// from the same stored inputs produces the identical schedule), and it
// also catches an AT_MATURITY-frequency bond that was silently given
// NaN amounts by the exact same bug (a different symptom, same root
// cause) that a "only 1 row" scan wouldn't have caught.
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

// Reuse the REAL, now-fixed schedule generator — same one the app
// itself uses for every create/edit/reschedule.
const { generateBondCouponSchedule } = require('./src/utils/bondSchedule');

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

async function backfillBondSchedules() {
    console.log('\n=== Regenerating bond coupon schedules from each bond\'s own stored fields ===');

    const candidates = await pool.query(`
        SELECT id, name FROM investments i
        WHERE  investment_type = 'BOND'
        AND    NOT EXISTS (
            SELECT 1 FROM bond_coupons bc
            WHERE  bc.investment_id = i.id AND bc.status != 'PENDING'
        )
        ORDER BY id
    `);

    if (candidates.rows.length === 0) {
        console.log('No eligible bonds found (every bond either has a paid/missed coupon already, or there are no bonds).');
        return;
    }

    let changed = 0;
    let uncharged = 0;
    let failed = 0;

    for (const row of candidates.rows) {
        try {
            await withTransaction(async (client) => {
                const investResult = await client.query(
                    'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [row.id]
                );
                const investment = investResult.rows[0];

                const before = await client.query(
                    'SELECT COUNT(*) AS n FROM bond_coupons WHERE investment_id = $1', [row.id]
                );
                const beforeCount = parseInt(before.rows[0].n);

                const schedule = generateBondCouponSchedule({
                    faceValue:          investment.face_value,
                    couponRate:         investment.coupon_rate,
                    frequency:          investment.coupon_frequency,
                    taxWithholdingRate: investment.tax_withholding_rate || 0,
                    issueDate:          investment.start_date,
                    maturityDate:       investment.expected_end_date,
                    firstCouponDate:    investment.first_coupon_date || null,
                });

                await client.query('DELETE FROM bond_coupons WHERE investment_id = $1', [row.id]);
                for (const coupon of schedule) {
                    await client.query(`
                        INSERT INTO bond_coupons (
                            investment_id, coupon_number, due_date,
                            gross_amount, tax_amount, net_amount
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                    `, [
                        row.id, coupon.coupon_number, coupon.due_date,
                        coupon.gross_amount, coupon.tax_amount, coupon.net_amount,
                    ]);
                }

                if (schedule.length !== beforeCount) {
                    console.log(`  [CORRECTED] Investment #${investment.id} (${investment.name}): schedule regenerated, ${beforeCount} -> ${schedule.length} coupon(s).`);
                    changed += 1;
                } else {
                    console.log(`  [unchanged] Investment #${investment.id} (${investment.name}): schedule was already correct (${schedule.length} coupon(s)).`);
                    uncharged += 1;
                }
            });
        } catch (e) {
            console.log(`  [FAILED — needs manual review] Investment #${row.id} (${row.name}): ${e.message}`);
            failed += 1;
        }
    }

    console.log(`\nDone — ${changed} corrected, ${uncharged} already correct, ${failed} failed, out of ${candidates.rows.length} eligible bond(s).`);
}

(async () => {
    try {
        await backfillBondSchedules();
        console.log('\n✅ Backfill complete.');
    } catch (e) {
        console.error('\n❌ Backfill FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
