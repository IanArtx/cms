// ============================================================
// ONE-TIME BACKFILL — v1.42.0 bond fixes, applied retroactively
//
// Run this once, AFTER deploying v1.42.0 and running
// migration_v1.42.0.sql, the same way you'd run run_migration.js:
//
//     cd cms
//     node backfill_v1.42.0_bonds.js
//
// It uses the exact same DB connection settings as the app itself
// (.env, same as run_migration.js), and does two things independently
// and safely:
//
// 1. FACE VALUE REPAYMENT — any BOND investment whose final coupon
//    was already marked PAID before this version existed never had
//    its face value credited back (payBondCoupon never did that
//    before v1.42.0). This finds those and credits face value now,
//    exactly the way paying that coupon today would. Purely additive
//    (a CREDIT) — cannot cause a negative balance, so this part is
//    always safe to run.
//
// 2. SETTLEMENT VALUE AUTO-FUNDING — any ACTIVE bond that already has
//    a settlement_value recorded but has NEVER been funded by any
//    means (actual_expenditure is still exactly 0) gets auto-funded
//    now, the same guarded way approving it would do going forward.
//    Guarded by the same negative-balance/floor-limit check as a live
//    funding — a bond whose account can't currently afford it is
//    SKIPPED and reported, not forced through.
//
//    Deliberately does NOT touch any investment that already has
//    actual_expenditure > 0 — that money already moved via the old
//    manual "Fund Investment" flow (the only option before this
//    version), and re-funding it here would double-charge the
//    account. Safe to run more than once: a second run finds nothing
//    left to do in either category.
//
// It does NOT attempt to fix the first-coupon-date schedule-collapse
// bug retroactively — there is no way to safely guess what the
// correct historical first coupon date should have been for an
// affected bond. Re-run "Edit Coupon Date / Frequency" on any
// affected bond by hand instead; the same validation that now
// prevents the bug going forward will also stop you from re-entering
// the same mistake by accident.
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

// Reuse the REAL business logic — same reference generation and
// balance-guarded posting the live app uses for every other money
// movement — rather than hand-rolling an equivalent copy here.
const { postTransaction } = require('./src/controllers/transactionsController');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('./src/services/referenceService');

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

async function backfillFaceValueRepayments() {
    console.log('\n=== PART 1: Face value repayment for already-paid final coupons ===');

    const candidates = await pool.query(`
        SELECT i.id, bc.id AS coupon_id, bc.coupon_number, bc.paid_at, bc.due_date
        FROM   investments i
        JOIN   bond_coupons bc ON bc.investment_id = i.id
        WHERE  i.investment_type = 'BOND'
        AND    bc.status = 'PAID'
        AND    bc.coupon_number = (SELECT MAX(coupon_number) FROM bond_coupons WHERE investment_id = i.id)
        AND    NOT EXISTS (
            SELECT 1 FROM investment_returns ir
            WHERE  ir.investment_id = i.id AND ir.return_type = 'PRINCIPAL'
        )
    `);

    if (candidates.rows.length === 0) {
        console.log('Nothing to backfill — no already-paid final coupons are missing their face value repayment.');
        return;
    }

    let corrected = 0;
    for (const row of candidates.rows) {
        try {
            await withTransaction(async (client) => {
                const investResult = await client.query(`
                    SELECT i.*, a.currency_id, r.reference_code, r.public_id
                    FROM   investments i
                    JOIN   accounts a ON a.id = i.funding_account_id
                    JOIN   references_registry r ON r.id = i.reference_id
                    WHERE  i.id = $1
                    FOR UPDATE
                `, [row.id]);
                const investment = investResult.rows[0];
                const faceValue = parseFloat(investment.face_value);
                const paidAt = row.paid_at instanceof Date ? row.paid_at : (row.paid_at ? new Date(row.paid_at) : null);
                const dueDate = row.due_date instanceof Date ? row.due_date : new Date(row.due_date);
                const paymentDate = (paidAt || dueDate).toISOString().slice(0, 10);

                const { referenceId: prinRefId, referenceCode: prinRefCode } =
                    await generateReference(client, MODULE_CODES.INVESTMENT, 'PRINCIPAL', 'INVESTMENT_RETURN', investment.created_by);
                const { referenceId: prinTxRefId } =
                    await generateReference(client, resolveModuleCode(investment), 'INVEST-IN', 'TRANSACTION', investment.created_by);

                const posted = await postTransaction(client, {
                    accountId:       investment.returns_account_id,
                    transactionType: 'CREDIT',
                    inflowType:      'INVESTMENT_RETURN',
                    amount:          faceValue,
                    currencyId:      investment.currency_id,
                    categoryId:      investment.category_id,
                    description:     `Bond face value repaid at maturity (backfilled) — ${investment.name} (${investment.reference_code})`,
                    valueDate:       paymentDate,
                    createdBy:       investment.created_by,
                    referenceId:     prinTxRefId,
                    investmentId:    investment.id,
                });
                await linkReferenceToRecord(client, prinTxRefId, posted.transactionId);

                const returnResult = await client.query(`
                    INSERT INTO investment_returns (
                        reference_id, investment_id, transaction_id,
                        return_type, amount, return_date, notes, created_by
                    ) VALUES ($1, $2, $3, 'PRINCIPAL', $4, $5, $6, $7)
                    RETURNING id
                `, [
                    prinRefId, investment.id, posted.transactionId, faceValue, paymentDate,
                    `Face value (principal) repaid alongside final coupon #${row.coupon_number} (backfilled by v1.42.0 migration)`,
                    investment.created_by,
                ]);
                await linkReferenceToRecord(client, prinRefId, returnResult.rows[0].id);

                let completed = false;
                if (investment.status === 'ACTIVE') {
                    await client.query(`
                        UPDATE investments SET status = 'COMPLETED', actual_end_date = $1
                        WHERE  id = $2 AND status = 'ACTIVE'
                    `, [paymentDate, investment.id]);
                    completed = true;
                }

                console.log(`  [CORRECTED] Investment #${investment.id} (${investment.name}, ${investment.reference_code}): face value ${faceValue} credited (ref ${prinRefCode})${completed ? ', marked COMPLETED' : ''}.`);
                corrected += 1;
            });
        } catch (e) {
            console.log(`  [FAILED — needs manual review] Investment #${row.id}: ${e.message}`);
        }
    }
    console.log(`Part 1 done — ${corrected} of ${candidates.rows.length} investment(s) corrected.`);
}

async function backfillSettlementFunding() {
    console.log('\n=== PART 2: Settlement value auto-funding for never-funded active bonds ===');

    const candidates = await pool.query(`
        SELECT id, name FROM investments
        WHERE  investment_type = 'BOND'
        AND    status = 'ACTIVE'
        AND    settlement_value IS NOT NULL
        AND    COALESCE(actual_expenditure, 0) = 0
    `);

    if (candidates.rows.length === 0) {
        console.log('Nothing to backfill — no active bonds have a known settlement value that was never funded.');
        return;
    }

    let corrected = 0;
    for (const row of candidates.rows) {
        try {
            await withTransaction(async (client) => {
                const investResult = await client.query(`
                    SELECT i.*, a.currency_id, r.reference_code, r.public_id
                    FROM   investments i
                    JOIN   accounts a ON a.id = i.funding_account_id
                    JOIN   references_registry r ON r.id = i.reference_id
                    WHERE  i.id = $1
                    FOR UPDATE
                `, [row.id]);
                const investment = investResult.rows[0];
                const amount = parseFloat(investment.settlement_value);

                const { referenceId: txRefId, referenceCode: txRefCode } =
                    await generateReference(client, resolveModuleCode(investment), 'INVEST-OUT', 'TRANSACTION', investment.created_by);

                const posted = await postTransaction(client, {
                    accountId:       investment.funding_account_id,
                    transactionType: 'DEBIT',
                    inflowType:      'EXPENSE',
                    amount,
                    currencyId:      investment.currency_id,
                    categoryId:      investment.category_id,
                    description:     `Bond settlement value, auto-funded (backfilled by v1.42.0 migration) — ${investment.name} (${investment.reference_code})`,
                    valueDate:       new Date().toISOString().slice(0, 10),
                    createdBy:       investment.created_by,
                    referenceId:     txRefId,
                    investmentId:    investment.id,
                });
                await linkReferenceToRecord(client, txRefId, posted.transactionId);

                await client.query(`
                    INSERT INTO investment_funding (investment_id, transaction_id, amount, created_by)
                    VALUES ($1, $2, $3, $4)
                `, [investment.id, posted.transactionId, amount, investment.created_by]);

                const before = parseFloat(investment.actual_expenditure);
                const planned = parseFloat(investment.planned_budget);
                const newExpenditure = before + amount;
                const overageBefore = Math.max(0, before - planned);
                const overageAfter  = Math.max(0, newExpenditure - planned);
                const supplementaryDelta = overageAfter - overageBefore;

                await client.query(`
                    UPDATE investments
                    SET    actual_expenditure = $1, supplementary_budget = supplementary_budget + $2
                    WHERE  id = $3
                `, [newExpenditure, supplementaryDelta, investment.id]);

                console.log(`  [CORRECTED] Investment #${investment.id} (${investment.name}): settlement value ${amount} auto-funded (ref ${txRefCode}).`);
                corrected += 1;
            });
        } catch (e) {
            console.log(`  [SKIPPED — needs manual review] Investment #${row.id} (${row.name}): ${e.message}`);
        }
    }
    console.log(`Part 2 — ${corrected} of ${candidates.rows.length} investment(s) auto-funded (see above for any skipped and why).`);
}

(async () => {
    try {
        await backfillFaceValueRepayments();
        await backfillSettlementFunding();
        console.log('\n✅ Backfill complete.');
    } catch (e) {
        console.error('\n❌ Backfill FAILED:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
