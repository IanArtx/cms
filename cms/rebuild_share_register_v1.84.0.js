// ============================================================
// ONE-TIME CORRECTION — v1.84.0 share register from the books' values
//
// Found by check_fixed_rate_share_impact_v1.83.1.js (section 0): euro
// contributions after 20 Aug 2025 entered the share register at
// EUR x 4,000, while the books value them at the exchange rate of their
// own day (e.g. EUR 150 on 12 Sep 2025 = UGX 622,702.50 at 4,151.35, not
// 600,000). Members therefore paid in more than their share credit shows
// and 3020 Capital Pending Allotment no longer equals their credit.
// Decided (option A): rebuild the share register from the books' values,
// keeping every existing allotment and reference; extra whole shares are
// allotted on the contributions' own dates.
//
//     node update_live_database.js --url "…" --script rebuild_share_register_v1.84.0.js --dry-run
//     node update_live_database.js --url "…" --script rebuild_share_register_v1.84.0.js
//
// WHAT IT DOES (one database transaction — any failed check: nothing saved)
//   1. Replays every member's share-credit ledger exactly as the system
//      does (contribution → credit → whole shares at that date's issue
//      price → the rest stays as credit), once with today's values (must
//      reproduce today's register) and once with each contribution at its
//      UGX value in the books.
//   2. Each contribution's credit entry is set to its value in the books
//      (the old value and rate are kept in the note and the audit log).
//   3. Where the books' values buy more whole shares, a CORRECTION
//      allotment is added for the extra shares, dated on the contribution
//      that bought them, at that contribution's issue price and nominal
//      value (rate_correction = TRUE, own SCP reference). Its return of
//      allotment is due 60 days after that date, so it is flagged as
//      still to be filed with URSB — those shares are "allotted inside the
//      company" and become registered (and certified) once the return is
//      marked filed.
//   4. Shareholding (shares held, %) is recalculated.
//   NOT changed: existing allotments, their references and dates; the
//   URSB-registered figures; certificates already issued (they keep basis
//   INTERNAL); the books (they were already right).
//
// CHECKS BEFORE SAVING
//   - today's register is reproduced exactly by the replay;
//   - every member's shares and credit equal the books' replay;
//   - every contribution's share credit equals its UGX value in the books;
//   - no member's shares go down.
// Stops (nothing saved) if: the database is not at v1.84.0, the opening
// conversion has not run, there are splits/consolidations, or a dividend
// was declared on or after the first affected contribution.
//
// Safe to run again: a second run finds nothing to change.
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

class Stop extends Error {}
const EPS = 1e-9;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

(async () => {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const who = (await c.query(`SELECT current_database() AS db`)).rows[0];
        console.log(`\nDatabase: ${who.db}  — ${dryRun ? 'DRY RUN, nothing will be saved' : 'SAVING'}\n`);

        // ---------------- preconditions ----------------
        const col = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'share_allotments' AND column_name = 'rate_correction'`);
        if (!col.rows.length) throw new Stop('The database is not at v1.84.0 yet — run update_live_database.js --apply first.');
        const sc = (await c.query(`SELECT opening_converted_at FROM share_capital_settings WHERE id = 1`)).rows[0];
        if (!sc || !sc.opening_converted_at) throw new Stop('The opening share conversion has not run on this database — nothing to correct.');
        const splits = (await c.query(`SELECT COUNT(*)::int AS n FROM share_allotments WHERE source IN ('SPLIT','CONSOLIDATION')`)).rows[0].n;
        if (splits) throw new Stop(`${splits} split/consolidation allotment(s) exist — this correction does not handle them. Nothing was changed.`);

        // services (the same code the system uses to allot)
        const svc = require('./src/services/shareCapitalService');
        const { getSharePriceOn } = require('./src/services/sharePricingService');

        const F = (await c.query(`SELECT functional_currency_id AS f FROM company_settings WHERE id = 1`)).rows[0].f;
        const setter = (await c.query(`
            SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            JOIN roles r ON r.id = ur.role_id WHERE r.name IN ('Admin','Treasurer') AND u.is_active ORDER BY u.id LIMIT 1`)).rows[0];
        const by = setter ? setter.id : (await c.query('SELECT MIN(id) AS id FROM users')).rows[0].id;
        const settings = await svc.getSettings(c);

        // ---------------- data ----------------
        const entries = (await c.query(`
            SELECT e.id, e.user_id, e.entry_date::text AS d, e.entry_type, e.amount::float8 AS amount,
                   e.contribution_id, e.allotment_id, e.rate_used::float8 AS rate_used, e.notes
            FROM   member_capital_credit_entries e
            ORDER  BY e.user_id, e.entry_date, e.id`)).rows;
        const allots = (await c.query(`
            SELECT id, user_id, contribution_id, source, allotment_date::text AS d, shares,
                   issue_price::float8 AS issue_price, nominal_value::float8 AS nominal_value, currency_id, status
            FROM   share_allotments ORDER BY id`)).rows;
        const contribs = (await c.query(`
            SELECT sc.id, sc.user_id, sc.amount::float8 AS amount, sc.currency_id, sc.contribution_date::text AS d, cur.code,
                   t.functional_amount::float8 AS books_value, t.functional_rate::float8 AS books_rate
            FROM   shareholder_contributions sc
            JOIN   currencies cur ON cur.id = sc.currency_id
            LEFT JOIN LATERAL (SELECT functional_amount, functional_rate FROM transactions
                               WHERE contribution_id = sc.id AND is_reversal = FALSE ORDER BY id LIMIT 1) t ON TRUE`)).rows;
        const contribById = new Map(contribs.map(x => [x.id, x]));
        const names = new Map((await c.query(`SELECT id, first_name || ' ' || last_name AS n FROM users`)).rows.map(r => [r.id, r.n]));

        // the books' value of each CONTRIBUTION credit entry
        const booksOf = new Map();
        const toFix = [];
        for (const e of entries.filter(x => x.entry_type === 'CONTRIBUTION')) {
            const ct = contribById.get(e.contribution_id);
            let v = e.amount;
            if (ct && ct.currency_id !== F && ct.books_value !== null) v = round2(ct.books_value);
            booksOf.set(e.id, v);
            if (Math.abs(v - e.amount) >= 0.01) toFix.push({ e, ct, v });
        }
        if (!toFix.length) {
            console.log('Every contribution\'s share credit already equals its UGX value in the books — nothing to correct.');
            await c.query('ROLLBACK');
            return;
        }
        const firstDate = toFix.map(x => x.e.d).sort()[0];
        const divs = (await c.query(`SELECT COUNT(*)::int AS n FROM dividends WHERE status <> 'CANCELLED' AND declaration_date >= $1`, [firstDate])).rows[0].n;
        if (divs) throw new Stop(`${divs} dividend(s) were declared on or after ${firstDate} on the current shares — correcting the shares now needs a person to decide about those dividends first. Nothing was changed.`);

        const priceCache = new Map();
        const priceOn = async (d) => {
            if (!priceCache.has(d)) priceCache.set(d, parseFloat((await getSharePriceOn(c, d)).price_per_share));
            return priceCache.get(d);
        };

        // replay: returns per-contribution cumulative shares and final credit/shares
        const replay = async (list, useBooks) => {
            let credit = 0; let shares = 0;
            const steps = []; const contribShares = new Map();
            for (const e of list) {
                if (e.entry_type === 'CONTRIBUTION') {
                    const v = useBooks ? booksOf.get(e.id) : e.amount;
                    credit = round2(credit + v);
                    const a = allots.find(x => x.contribution_id === e.contribution_id && (x.source === 'CONTRIBUTION' || x.source === 'OPENING_CONVERSION'));
                    const price = a ? a.issue_price : await priceOn(e.d);
                    const s = credit > 0 ? Math.floor(credit / price + EPS) : 0;
                    if (s > 0) { credit = round2(credit - round2(s * price)); shares += s; }
                    contribShares.set(e.contribution_id, { shares: s, price });
                    steps.push({ entry: e, cumShares: shares, price, allot: a });
                } else if (e.entry_type === 'ALLOTMENT') {
                    // taken in the CONTRIBUTION step (correction allotments included below)
                } else if (e.entry_type === 'CONTRIBUTION_REVERSAL') {
                    const orig = list.find(x => x.entry_type === 'CONTRIBUTION' && x.contribution_id === e.contribution_id);
                    credit = round2(credit - (orig ? (useBooks ? booksOf.get(orig.id) : orig.amount) : -e.amount));
                } else if (e.entry_type === 'ALLOTMENT_REVERSAL') {
                    const cs = contribShares.get(e.contribution_id);
                    if (cs) { credit = round2(credit + round2(cs.shares * cs.price)); shares -= cs.shares; } else credit = round2(credit + e.amount);
                } else {
                    credit = round2(credit + e.amount);
                }
            }
            return { credit, shares, steps };
        };

        const byUser = new Map();
        for (const e of entries) { if (!byUser.has(e.user_id)) byUser.set(e.user_id, []); byUser.get(e.user_id).push(e); }
        const actualShares = new Map(); for (const a of allots.filter(x => x.status === 'ACTIVE')) actualShares.set(a.user_id, (actualShares.get(a.user_id) || 0) + a.shares);
        const actualCredit = new Map(); for (const e of entries) actualCredit.set(e.user_id, round2((actualCredit.get(e.user_id) || 0) + e.amount));

        // ---------------- plan ----------------
        const plan = [];
        const problems = [];
        for (const [uid, list] of byUser) {
            const cur = await replay(list, false);
            if (cur.shares !== (actualShares.get(uid) || 0) || Math.abs(cur.credit - (actualCredit.get(uid) || 0)) >= 0.01) {
                problems.push(`${names.get(uid)}: the replay of today's values does not reproduce today's register (shares ${cur.shares} vs ${actualShares.get(uid) || 0}, credit ${fmt(cur.credit)} vs ${fmt(actualCredit.get(uid) || 0)})`);
                continue;
            }
            const nxt = await replay(list, true);
            if (nxt.shares < cur.shares) { problems.push(`${names.get(uid)}: shares would go DOWN (${cur.shares} → ${nxt.shares}) — needs a person`); continue; }
            // correction allotments: wherever the books' cumulative shares run ahead
            const corrections = [];
            let emitted = 0;
            for (let i = 0; i < nxt.steps.length; i++) {
                const delta = nxt.steps[i].cumShares - cur.steps[i].cumShares - emitted;
                if (delta > 0) {
                    corrections.push({ contributionId: nxt.steps[i].entry.contribution_id, date: nxt.steps[i].entry.d, shares: delta, price: nxt.steps[i].price, allot: nxt.steps[i].allot });
                    emitted += delta;
                }
            }
            if (emitted !== nxt.shares - cur.shares) { problems.push(`${names.get(uid)}: correction shares (${emitted}) do not add up to the difference (${nxt.shares - cur.shares})`); continue; }
            plan.push({ uid, cur, nxt, corrections, fixes: toFix.filter(x => x.e.user_id === uid) });
        }
        if (problems.length) throw new Stop('Nothing was changed:\n   - ' + problems.join('\n   - '));

        // ---------------- report ----------------
        console.log('1) EACH MEMBER');
        console.log(`   ${pad('Member', 28)}${lpad('Shares', 8)}${lpad('→', 3)}${lpad('new', 6)}${lpad('Credit', 15)}${lpad('→ new', 16)}   Contributions revalued`);
        for (const p of plan.sort((a, b) => names.get(a.uid).localeCompare(names.get(b.uid)))) {
            console.log(`   ${pad(names.get(p.uid), 28)}${lpad(p.cur.shares, 8)}${lpad('→', 3)}${lpad(p.nxt.shares, 6)}${lpad(fmt(p.cur.credit), 15)}${lpad(fmt(p.nxt.credit), 16)}   ${p.fixes.length}`);
        }

        // ---------------- write ----------------
        const created = [];
        for (const p of plan) {
            for (const f of p.fixes) {
                const note = `${f.e.notes ? f.e.notes + ' — ' : ''}v1.84.0 correction: valued at the rate of the day ${fmt(f.ct.books_rate || 0, 4)} (books UGX ${fmt(f.v)}), was ${fmt(f.e.rate_used || 0, 2)} = UGX ${fmt(f.e.amount)}`;
                await c.query(`UPDATE member_capital_credit_entries SET amount = $2, rate_used = $3, notes = $4 WHERE id = $1`,
                    [f.e.id, f.v, f.ct.books_rate, note.slice(0, 1000)]);
                // a reversal of this contribution takes back the corrected value
                await c.query(`UPDATE member_capital_credit_entries SET amount = $2 WHERE entry_type = 'CONTRIBUTION_REVERSAL' AND contribution_id = $1`,
                    [f.e.contribution_id, -f.v]);
            }
            for (const k of p.corrections) {
                const nominal = k.allot ? k.allot.nominal_value : parseFloat((await svc.getNominalOn(c, k.date)).nominal_value);
                const currencyId = k.allot ? k.allot.currency_id : (await getSharePriceOn(c, k.date)).currency_id;
                const a = await svc.createAllotment(c, {
                    userId: p.uid, contributionId: k.contributionId, source: 'CONTRIBUTION', date: k.date, shares: k.shares,
                    nominalValue: nominal, issuePrice: k.price, currencyId, createdBy: by,
                    notes: 'v1.84.0 correction — extra whole share(s) from valuing the contribution at the exchange rate of its day (books) instead of 4,000',
                    returnDays: settings.allotment_return_days || 60,
                });
                await c.query('UPDATE share_allotments SET rate_correction = TRUE WHERE id = $1', [a.allotmentId]);
                await svc.addCreditEntry(c, {
                    userId: p.uid, date: k.date, entryType: 'ALLOTMENT', amount: -a.considerationAmount, currencyId,
                    contributionId: k.contributionId, allotmentId: a.allotmentId,
                    notes: `v1.84.0 correction: ${k.shares} extra whole share(s) at ${fmt(k.price)}`, createdBy: by,
                });
                created.push({ name: names.get(p.uid), ref: a.referenceCode, date: k.date, shares: k.shares, price: k.price });
            }
        }
        await svc.recalculateShareholding(c, { recordedByUserId: by });

        console.log(`\n2) CORRECTION ALLOTMENTS (${created.length}) — returns of allotment still to be filed with URSB`);
        for (const x of created) console.log(`   ${x.ref}  ${x.date}  ${pad(x.name, 26)} +${x.shares} share(s) at ${fmt(x.price)}`);

        // ---------------- checks ----------------
        const checkProblems = [];
        const sharesNow = new Map((await c.query(`SELECT user_id, SUM(shares)::int AS s FROM share_allotments WHERE status = 'ACTIVE' GROUP BY user_id`)).rows.map(r => [r.user_id, r.s]));
        const creditNow = new Map((await c.query(`SELECT user_id, ROUND(SUM(amount), 2)::float8 AS c FROM member_capital_credit_entries GROUP BY user_id`)).rows.map(r => [r.user_id, r.c]));
        for (const p of plan) {
            if ((sharesNow.get(p.uid) || 0) !== p.nxt.shares) checkProblems.push(`${names.get(p.uid)}: shares ${sharesNow.get(p.uid)} ≠ ${p.nxt.shares}`);
            if (Math.abs((creditNow.get(p.uid) || 0) - p.nxt.credit) >= 0.01) checkProblems.push(`${names.get(p.uid)}: credit ${fmt(creditNow.get(p.uid) || 0)} ≠ ${fmt(p.nxt.credit)}`);
        }
        const stillDiff = (await c.query(`
            SELECT COUNT(*)::int AS n FROM member_capital_credit_entries e
            JOIN shareholder_contributions sc ON sc.id = e.contribution_id
            JOIN LATERAL (SELECT functional_amount FROM transactions WHERE contribution_id = sc.id AND is_reversal = FALSE ORDER BY id LIMIT 1) t ON TRUE
            WHERE e.entry_type = 'CONTRIBUTION' AND sc.currency_id <> $1 AND ABS(e.amount - ROUND(t.functional_amount, 2)) >= 0.01`, [F])).rows[0].n;
        if (stillDiff) checkProblems.push(`${stillDiff} contribution(s) still differ from the books`);
        if (checkProblems.length) throw new Stop('A check failed, so nothing was saved:\n   - ' + checkProblems.join('\n   - '));
        console.log('\n   ✅ Every member\'s shares and credit equal the replay at the books\' values; every contribution\'s share credit equals the books.');

        const certs = (await c.query(`SELECT COUNT(*)::int AS n FROM share_certificates`)).rows[0].n;
        console.log(`   Certificates already issued (${certs}) are not changed — from v1.84.0 certificates show only shares registered with URSB.`);

        await c.query(`
            INSERT INTO audit_log (user_id, action, module, record_type, record_id, old_values, new_values, description, status)
            VALUES ($1, 'SHARE_REGISTER_CORRECTED', 'FINANCE', 'share_allotments', NULL, $2, $3, $4, 'SUCCESS')`,
        [by,
         JSON.stringify(plan.map(p => ({ user_id: p.uid, shares: p.cur.shares, credit: p.cur.credit, entries: p.fixes.map(f => ({ id: f.e.id, amount: f.e.amount, rate: f.e.rate_used })) }))),
         JSON.stringify({ members: plan.map(p => ({ user_id: p.uid, shares: p.nxt.shares, credit: p.nxt.credit })), allotments: created }),
         `Share register corrected to the books' exchange rates (v1.84.0): ${toFix.length} contribution(s) revalued, ${created.length} correction allotment(s), ${created.reduce((s, x) => s + x.shares, 0)} extra share(s).`]);

        if (dryRun) {
            await c.query('ROLLBACK');
            console.log('\nDRY RUN — rolled back, nothing was saved. Run again without --dry-run to save it.');
        } else {
            await c.query('COMMIT');
            console.log('\n✅ Saved.');
            console.log('   Next: Members\' funds › Share capital — the correction allotments are listed with their returns of allotment due.');
            console.log('   When a return is filed with URSB, mark it filed: the shares become registered and a registration certificate is issued for signing.');
        }
    } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        if (err instanceof Stop) console.error(`\n❌ ${err.message}`);
        else console.error(`\n❌ Failed, nothing was saved: ${err.message}`);
        process.exitCode = 1;
    } finally {
        c.release();
        await pool.end();
    }
})();
