// ============================================================
// ONE-TIME — signatories on share purchase receipts already issued
// (v1.85.1)
//
// Requested: "the share purchase receipts … shows the last person or
// the final approver on the Treasurer signatory … i would like that all
// parties involved get signatories positions and reflect their
// respective positions".
// From v1.85.1 every new receipt lists everyone involved. This adds the
// same list to the receipts issued before, worked out from the records:
//   • Recorded by   — the person who posted the contribution
//   • Approved by   — who approved it, when it was held for approval
//                     (transactions.approved_by is someone else)
//   • Requested by  — the member, when it came from a contribution
//                     acknowledgement requisition
//   • Pledged by    — the member, when it settled a capital call pledge
//   • Entered by / Confirmed by — a savings-to-capital conversion
// Positions are each person's role now (the most senior one); the
// signature is a snapshot of the one saved on their profile now.
// Nothing else on the receipt changes — figures, references and dates
// stay exactly as issued. A receipt that already has the list is left
// alone, so it is safe to run again.
//
//     node update_live_database.js --url "…" --script backfill_v1.85.1_receipt_signatories.js --dry-run
//     node update_live_database.js --url "…" --script backfill_v1.85.1_receipt_signatories.js
// (without --url it uses the database in cms/.env)
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Pool } = require('pg');
const { buildParties } = require('./src/services/signatoryService');

const dryRun = process.argv.includes('--dry-run');
const isLocal = /^(localhost|127\.0\.0\.1|::1)$/i.test(String(process.env.DB_HOST || ''));
const pool = new Pool({
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
    const c = await pool.connect();
    try {
        const who = (await c.query('SELECT current_database() AS db')).rows[0].db;
        console.log(`\nDatabase: ${who} — ${dryRun ? 'DRY RUN, nothing will be saved' : 'SAVING'}\n`);
        await c.query('BEGIN');
        const has = async (t, col) => (await c.query(
            `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, col])).rows.length > 0;
        const hasReq = await has('requisitions', 'transaction_id');
        const hasConv = await has('savings_capital_conversions', 'contribution_transaction_id');
        const hasPledgePay = await has('capital_goal_pledge_payments', 'shareholder_contribution_id');

        const docs = await c.query(`
            SELECT d.id, d.related_record_id AS contribution_id, r.reference_code, d.template_data
            FROM   documents d JOIN references_registry r ON r.id = d.reference_id
            WHERE  d.template_data->>'receipt_kind' = 'SHARE_PURCHASE'
            AND    d.related_record_type = 'shareholder_contributions'
            AND    COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(d.template_data->'signatories') = 'array'
                                                    THEN d.template_data->'signatories' END), 0) = 0
            ORDER  BY d.id`);
        console.log(`Receipts without the list of signatories: ${docs.rows.length}\n`);

        let done = 0;
        for (const d of docs.rows) {
            const tx = (await c.query(`
                SELECT t.id, t.created_by, t.approved_by, COALESCE(t.posted_at, t.transaction_date::timestamptz) AS created_at, t.approved_at
                FROM   transactions t
                WHERE  t.contribution_id = $1 AND t.is_reversal = FALSE
                ORDER  BY t.id LIMIT 1`, [d.contribution_id])).rows[0];
            const sc = (await c.query(`SELECT created_by, created_at, user_id FROM shareholder_contributions WHERE id = $1`, [d.contribution_id])).rows[0];
            if (!tx && !sc) { console.log(`   ${d.reference_code}: contribution not found — skipped`); continue; }
            const recorder = tx ? tx.created_by : sc.created_by;
            const recordedAt = tx ? tx.created_at : sc.created_at;
            const parties = [];

            let req = null; let conv = null; let pledge = null;
            if (hasReq && tx) req = (await c.query(`SELECT requested_by, created_at FROM requisitions WHERE transaction_id = $1 LIMIT 1`, [tx.id])).rows[0];
            if (hasConv && tx) conv = (await c.query(`SELECT entered_by, created_at FROM savings_capital_conversions WHERE contribution_transaction_id = $1 LIMIT 1`, [tx.id])).rows[0];
            if (hasPledgePay) pledge = (await c.query(`
                SELECT pl.user_id, pl.submitted_at, pp.approved_by, pp.approved_at
                FROM   capital_goal_pledge_payments pp JOIN capital_goal_pledges pl ON pl.id = pp.pledge_id
                WHERE  pp.shareholder_contribution_id = $1
                -- a direct contribution that was only counted towards a pledge
                -- afterwards is an ordinary recorded contribution
                AND    COALESCE(pp.notes, '') NOT LIKE 'Auto-settled%'
                LIMIT  1`, [d.contribution_id])).rows[0];

            if (req) {
                parties.push({ action: 'Requested by', userId: req.requested_by, at: req.created_at });
                parties.push({ action: 'Approved and recorded by', userId: recorder, at: recordedAt });
            } else if (conv) {
                parties.push({ action: 'Entered by', userId: conv.entered_by, at: conv.created_at });
                parties.push({ action: 'Confirmed by', userId: recorder, at: recordedAt });
            } else if (pledge) {
                parties.push({ action: 'Pledged by', userId: pledge.user_id, at: pledge.submitted_at });
                parties.push({ action: 'Approved by', userId: pledge.approved_by || recorder, at: pledge.approved_at || recordedAt });
            } else {
                parties.push({ action: 'Recorded by', userId: recorder, at: recordedAt });
                if (tx && tx.approved_by && Number(tx.approved_by) !== Number(recorder)) {
                    parties.push({ action: 'Approved by', userId: tx.approved_by, at: tx.approved_at || recordedAt });
                }
            }

            // A signature snapshot is a copy in THIS computer's file storage —
            // only made for a local database. Online, the receipt points at the
            // signature saved on the person's profile (in the online storage).
            const list = await buildParties(c, parties, { snapshotPrefix: `share-receipt-${d.contribution_id}`, snapshot: !dryRun && isLocal });
            console.log(`   ${d.reference_code}: ${list.map(p => `${p.action} ${p.name} (${p.position || '—'})`).join('; ')}`);
            if (!dryRun) {
                await c.query(`UPDATE documents SET template_data = template_data || jsonb_build_object('signatories', $1::jsonb) WHERE id = $2`,
                    [JSON.stringify(list), d.id]);
            }
            done += 1;
        }

        if (dryRun) {
            await c.query('ROLLBACK');
            console.log(`\nDRY RUN — ${done} receipt(s) would get their signatories. Nothing was saved. Run again without --dry-run to save.`);
        } else {
            await c.query('SAVEPOINT audit');
            try {
                await c.query(`
                    INSERT INTO audit_log (user_id, action, module, record_type, description, status)
                    VALUES (NULL, 'DOCUMENT_UPDATED', 'DOCUMENTS', 'documents', $1, 'SUCCESS')`,
                [`v1.85.1 backfill: signatories (every party in their own position) added to ${done} share purchase receipt(s)`]);
                await c.query('RELEASE SAVEPOINT audit');
            } catch (_) { await c.query('ROLLBACK TO SAVEPOINT audit'); }
            await c.query('COMMIT');
            console.log(`\n✅ Saved — ${done} receipt(s) now list everyone involved.`);
        }
    } catch (err) {
        try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
        console.error(`\n❌ ${err.message}\n   Nothing was saved.`);
        process.exitCode = 1;
    } finally {
        c.release();
        await pool.end();
    }
})();
