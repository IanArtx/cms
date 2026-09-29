// ============================================================
// ONE-TIME BACKFILL — v1.67.0 Share Purchase Receipts in one currency.
//
// Receipts issued before v1.67.0 printed the price per share (a UGX
// figure) with the contribution's own currency symbol ("€ 50,000.00").
// v1.67.0 receipts carry the share price's currency, the contribution
// converted into it, and the exact rate used. This script adds those
// same fields to every receipt already issued, so old and new receipts
// read the same way. It changes nothing else — not the shares, not
// the amount paid, not the signature, not the reference.
//
// Run this once, AFTER running migration_v1.67.0.sql, once per company
// database (change DB_NAME in .env between runs):
//
//     cd cms
//     node backfill_v1.67.0_share_receipts.js
//     node backfill_v1.67.0_share_receipts.js --dry-run   (shows what it would do, saves nothing)
//
// The rate and price are looked up exactly as the share calculation
// itself does (sharePricingService.convertToShareCurrency, as of the
// contribution's own date), so each receipt's figures always agree
// with the shares it reports. Safe to re-run: it simply recomputes
// the same fields.
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');
const { convertToShareCurrency } = require('./src/services/sharePricingService');

const dryRun = process.argv.includes('--dry-run');

console.log(`Using DB_USER=${process.env.DB_USER}, DB_NAME=${process.env.DB_NAME}, DB_HOST=${process.env.DB_HOST}, password length=${(process.env.DB_PASSWORD || '').length}`);

const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const col = await client.query(`
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'documents' AND column_name = 'owner_user_id'
        `);
        if (col.rows.length === 0) {
            throw new Error('documents.owner_user_id does not exist — run migration_v1.67.0.sql first.');
        }

        const receipts = await client.query(`
            SELECT d.id, d.template_data, r.reference_code,
                   sc.id AS contribution_id, sc.user_id, sc.amount, sc.currency_id,
                   sc.contribution_date::text AS contribution_date
            FROM   documents d
            JOIN   references_registry r ON r.id = d.reference_id
            JOIN   shareholder_contributions sc
                   ON d.related_record_type = 'shareholder_contributions' AND sc.id = d.related_record_id
            WHERE  d.template_data ->> 'receipt_kind' = 'SHARE_PURCHASE'
            ORDER  BY d.id
        `);
        console.log(`Found ${receipts.rows.length} share purchase receipt(s).`);

        const currencies = await client.query(`SELECT id, code, symbol FROM currencies`);
        const curById = new Map(currencies.rows.map(c => [c.id, c]));

        let updated = 0;
        let skipped = 0;
        for (const rc of receipts.rows) {
            let conv;
            try {
                conv = await convertToShareCurrency(client, 1, rc.currency_id, rc.contribution_date);
            } catch (err) {
                console.log(`  - ${rc.reference_code}: skipped — ${err.message}`);
                skipped++;
                continue;
            }
            const shareCur = curById.get(conv.shareCurrencyId) || {};
            const rate = conv.rateUsed;
            const fields = {
                member_user_id:           rc.user_id,
                price_per_share:          conv.sharePricePerUnit,
                share_currency_code:      shareCur.code || null,
                share_currency_symbol:    shareCur.symbol || null,
                exchange_rate:            rate,
                exchange_rate_date:       rc.contribution_date,
                amount_in_share_currency: Math.round(parseFloat(rc.amount) * rate * 100) / 100,
            };
            await client.query(`
                UPDATE documents
                SET    template_data = COALESCE(template_data, '{}'::jsonb) || $1::jsonb,
                       owner_user_id = $2
                WHERE  id = $3
            `, [JSON.stringify(fields), rc.user_id, rc.id]);
            console.log(`  - ${rc.reference_code}: ${fields.share_currency_code} ${fields.amount_in_share_currency} ` +
                `(rate ${rate}, price ${fields.share_currency_code} ${fields.price_per_share})`);
            updated++;
        }

        console.log(`Updated ${updated}, skipped ${skipped}.`);
        if (dryRun) {
            await client.query('ROLLBACK');
            console.log('DRY RUN — rolled back, nothing was saved.');
        } else {
            await client.query('COMMIT');
            console.log('✅ Saved.');
        }
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`❌ Backfill failed, nothing was saved: ${err.message}`);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
