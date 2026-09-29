// ============================================================
// ONE-TIME OPENING CONVERSION — v1.69.0 whole shares + share credit.
//
// The same conversion as the "Run opening conversion" button on the
// Share Capital page (Overview tab) — use whichever you prefer, once.
// It replays every APPROVED contribution to date, oldest first:
//
//     credit          = credit carried + contribution value (UGX)
//     whole shares    = floor(credit / share price on that date)
//     credit carried  = credit - whole shares x that price
//
// at the share price that applied on each contribution's own date, so
// no historical holding is re-priced. Each member's old fractional
// holding becomes whole shares plus share credit (kept for their next
// contribution, or refundable).
//
// Run AFTER migration_v1.69.0.sql, once per company database (change
// DB_NAME in .env between runs):
//
//     cd cms
//     node backfill_v1.69.0_share_allotments.js --dry-run   (shows the result, saves nothing)
//     node backfill_v1.69.0_share_allotments.js             (saves it)
//
// Optional: --user-id=<id> records who ran it (defaults to the first
// active Treasurer, else the first active Admin).
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { pool, withTransaction } = require('./src/config/database');
const svc = require('./src/services/shareCapitalService');

const dryRun = process.argv.includes('--dry-run');
const userArg = process.argv.find(a => a.startsWith('--user-id='));

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

(async () => {
    try {
        console.log(`Database: ${process.env.DB_NAME} on ${process.env.DB_HOST}`);
        let userId = userArg ? parseInt(userArg.split('=')[1], 10) : null;
        if (!userId) {
            const r = await pool.query(`
                SELECT u.id FROM users u
                JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                JOIN roles r ON r.id = ur.role_id
                WHERE u.is_active = TRUE AND r.name IN ('Treasurer', 'Admin')
                ORDER BY (r.name = 'Treasurer') DESC, u.id ASC LIMIT 1
            `);
            if (!r.rows.length) throw new Error('No active Treasurer or Admin found — pass --user-id=<id>.');
            userId = r.rows[0].id;
        }

        const summary = dryRun
            ? await svc.previewOpeningConversion({ userId })
            : await withTransaction(client => svc.runOpeningConversion(client, { userId }));

        console.log(`\n${summary.contributions} approved contribution(s) replayed.`);
        console.log('Member'.padEnd(32), 'Old shares'.padStart(14), 'Whole shares'.padStart(13), 'Share credit'.padStart(16));
        for (const m of summary.members) {
            console.log(
                (m.name || `#${m.userId}`).padEnd(32),
                fmt(m.oldSharesHeld).padStart(14),
                String(m.newWholeShares).padStart(13),
                fmt(m.creditLeft).padStart(16),
            );
        }
        console.log(`\nTotal whole shares in issue: ${summary.totalShares}`);
        console.log(`Total members' share credit: ${fmt(summary.totalCredit)}`);
        if (summary.registeredShares !== null) {
            console.log(`Registered shares: ${summary.registeredShares} — beyond the registered number: ${summary.sharesBeyondRegistered}`);
        }
        if (summary.allottedBelowNominal.length) {
            console.log(`\nNOTE: ${summary.allottedBelowNominal.length} contribution(s) bought shares at a price below the nominal value (see Share Capital > Allotments).`);
        }
        console.log(dryRun ? '\nDRY RUN — nothing was saved.' : '\n✅ Saved.');
    } catch (err) {
        console.error(`❌ Opening conversion failed, nothing was saved: ${err.message}`);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
