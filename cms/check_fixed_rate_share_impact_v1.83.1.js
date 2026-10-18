// ============================================================
// READ-ONLY REPORT — what the fixed exchange rate (v1.76.0) would change
// in the share register (v1.83.1)
//
// apply_fixed_rates_v1.76.0.js refuses to run once the opening share
// conversion has been done, because whole shares and share credit were
// worked out from the UGX values the correction would change. Before a
// correction that also rebuilds the share register is built, this report
// shows exactly what it would mean, member by member — and what has
// already been issued on the current figures (certificates, dividends,
// returns of allotment filed with URSB, refunds, registered shares).
//
//     node update_live_database.js --script check_fixed_rate_share_impact_v1.83.1.js
//     node update_live_database.js --url "…" --script check_fixed_rate_share_impact_v1.83.1.js
//
// NOTHING IS WRITTEN: the whole report runs inside a READ ONLY database
// transaction.
//
// How the new figures are worked out — the same rule as the opening
// conversion and every live contribution: each contribution's value in
// UGX is added to the member's share credit, whole shares are allotted
// at the issue price of that contribution's date, the rest stays as
// credit. The only difference: a contribution in the fixed-rate currency
// dated before the cut-off is valued at the fixed rate (e.g. 4,000),
// unless an Admin had given its transaction a MANUAL rate. Refunds keep
// their amounts. The report first replays the CURRENT values and checks
// that it reproduces today's register exactly — if it does not, it says
// so and the new figures should not be trusted.
//
// Section 0 (added after the first online run): contributions whose
// share credit was valued DIFFERENTLY from the books already today (for
// example EUR x 4,000 in the share register but the actual rate of the
// day in the books), and what every member's shares and credit would be
// if the register were rebuilt from the books' values. These differences
// are not caused by the fixed rate; they mean 3020 Capital Pending
// Allotment and the members' credit no longer agree.
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const EPS = 1e-9;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const exists = async (c, table) => (await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])).rows[0].ok;
const count = async (c, sql, params = []) => parseInt((await c.query(sql, params)).rows[0].n, 10);

(async () => {
    const c = await pool.connect();
    try {
        await c.query('BEGIN READ ONLY');
        const who = (await c.query(`SELECT current_database() AS db, inet_server_addr()::text AS host`)).rows[0];
        console.log(`\nDatabase: ${who.db} @ ${who.host || 'localhost'}  — READ ONLY REPORT, nothing is changed\n`);

        if (!(await exists(c, 'fx_fixed_rate_periods')) || !(await exists(c, 'share_allotments'))) {
            console.log('This database has no fixed-rate rule or no share register yet — nothing to report.');
            return;
        }
        const rules = (await c.query(`
            SELECT f.*, f.valid_before::text AS cutoff, b.code AS base_code, t.code AS target_code
            FROM   fx_fixed_rate_periods f
            JOIN   currencies b ON b.id = f.base_currency_id JOIN currencies t ON t.id = f.target_currency_id
            ORDER  BY f.id`)).rows;
        if (!rules.length) { console.log('No fixed-rate rule is on file — nothing to report.'); return; }

        const F = (await c.query(`SELECT functional_currency_id AS f FROM company_settings WHERE id = 1`)).rows[0].f;
        // For each rule: the foreign currency and UGX per 1 unit of it.
        const ruleOf = new Map();
        for (const r of rules) {
            const foreign = r.base_currency_id === F ? r.target_currency_id : r.base_currency_id;
            const toF = r.base_currency_id === F ? 1 / parseFloat(r.rate) : parseFloat(r.rate);
            ruleOf.set(foreign, { cutoff: r.cutoff, toF, code: r.base_currency_id === F ? r.target_code : r.base_code, applied: !!r.applied_at });
            console.log(`Rule: 1 ${r.base_code} = ${fmt(r.rate)} ${r.target_code} for every date before ${r.cutoff} — ${r.applied_at ? 'ALREADY APPLIED' : 'not yet applied'}`);
        }

        // ---------------- the members' credit ledger, as it is today ----------------
        const entries = (await c.query(`
            SELECT e.id, e.user_id, e.entry_date::text AS d, e.entry_type, e.amount::float8 AS amount,
                   e.contribution_id, e.allotment_id, e.original_amount::float8 AS original_amount,
                   e.original_currency_id, e.rate_used::float8 AS rate_used
            FROM   member_capital_credit_entries e
            ORDER  BY e.user_id, e.entry_date, e.id`)).rows;
        const allots = (await c.query(`
            SELECT a.id, a.user_id, a.contribution_id, a.source, a.allotment_date::text AS d, a.shares,
                   a.issue_price::float8 AS issue_price, a.status, a.return_filed_at
            FROM   share_allotments a ORDER BY a.id`)).rows;
        const allotById = new Map(allots.map(a => [a.id, a]));

        const splits = await count(c, `SELECT COUNT(*) AS n FROM share_allotments WHERE source IN ('SPLIT','CONSOLIDATION')`);

        // Each affected contribution's new value.
        const contribs = (await c.query(`
            SELECT sc.id, sc.user_id, sc.amount::float8 AS amount, sc.currency_id, sc.contribution_date::text AS d,
                   cur.code,
                   (SELECT t.functional_rate_source FROM transactions t
                    WHERE t.contribution_id = sc.id AND t.is_reversal = FALSE ORDER BY t.id LIMIT 1) AS rate_source,
                   (SELECT t.functional_amount::float8 FROM transactions t
                    WHERE t.contribution_id = sc.id AND t.is_reversal = FALSE ORDER BY t.id LIMIT 1) AS books_value,
                   (SELECT t.functional_rate::float8 FROM transactions t
                    WHERE t.contribution_id = sc.id AND t.is_reversal = FALSE ORDER BY t.id LIMIT 1) AS books_rate
            FROM   shareholder_contributions sc JOIN currencies cur ON cur.id = sc.currency_id
            WHERE  sc.status = 'APPROVED'`)).rows;
        const contribById = new Map(contribs.map(x => [x.id, x]));

        const priceOn = async (d) => {
            const r = await c.query(`
                SELECT price_per_share::float8 AS p FROM share_price_history
                WHERE  effective_from <= $1 AND (effective_to IS NULL OR effective_to > $1)
                ORDER  BY effective_from DESC LIMIT 1`, [d]);
            if (r.rows.length) return r.rows[0].p;
            return (await c.query(`SELECT price_per_share::float8 AS p FROM share_price_history ORDER BY effective_from LIMIT 1`)).rows[0].p;
        };

        const changed = [];        // contributions whose value changes
        const newValueOf = new Map();
        const booksValueOf = new Map();
        const mismatched = [];     // section 0: share credit ≠ books today
        for (const e of entries.filter(x => x.entry_type === 'CONTRIBUTION')) {
            const ct = contribById.get(e.contribution_id);
            const rule = ct ? ruleOf.get(ct.currency_id) : null;
            let v = e.amount;
            if (rule && !rule.applied && ct.d < rule.cutoff && ct.rate_source !== 'MANUAL' && ct.currency_id !== F) {
                v = round2(ct.amount * rule.toF);
            }
            newValueOf.set(e.id, v);
            const bv = ct && ct.currency_id !== F && ct.books_value !== null ? round2(ct.books_value) : e.amount;
            booksValueOf.set(e.id, bv);
            if (Math.abs(bv - e.amount) >= 0.01) {
                mismatched.push({ user: e.user_id, contribution: e.contribution_id, d: ct.d, code: ct.code, amount: ct.amount,
                    creditRate: e.rate_used, creditValue: e.amount, booksRate: ct.books_rate, booksValue: bv, source: ct.rate_source });
            }
            if (Math.abs(v - e.amount) >= 0.01) {
                changed.push({ user: e.user_id, contribution: e.contribution_id, d: ct.d, code: ct.code, amount: ct.amount, oldRate: e.rate_used, oldValue: e.amount, newValue: v });
            }
        }

        // ---------------- replay one member's ledger --------------------------------
        // mode 'current': today's values (must reproduce today's register)
        // mode 'fixed':   contributions before the cut-off at the fixed rate
        const replay = async (userEntries, mode) => {
            let credit = 0; let shares = 0;
            const allotNew = new Map();   // allotment id -> new shares
            const contribShares = new Map();
            for (const e of userEntries) {
                switch (e.entry_type) {
                    case 'CONTRIBUTION': {
                        const v = mode === 'fixed' ? newValueOf.get(e.id) : mode === 'books' ? booksValueOf.get(e.id) : e.amount;
                        credit = round2(credit + v);
                        // the allotment of this contribution (if any), and its price
                        const a = allots.find(x => x.contribution_id === e.contribution_id && (x.source === 'CONTRIBUTION' || x.source === 'OPENING_CONVERSION'));
                        const price = a ? a.issue_price : await priceOn(e.d);
                        const s = credit > 0 ? Math.floor(credit / price + EPS) : 0;
                        if (s > 0) { credit = round2(credit - round2(s * price)); shares += s; }
                        contribShares.set(e.contribution_id, { shares: s, price });
                        if (a) allotNew.set(a.id, s);
                        break;
                    }
                    case 'ALLOTMENT': break;           // already taken in the CONTRIBUTION step
                    case 'CONTRIBUTION_REVERSAL': {
                        const orig = userEntries.find(x => x.entry_type === 'CONTRIBUTION' && x.contribution_id === e.contribution_id);
                        const v = orig ? (mode === 'fixed' ? newValueOf.get(orig.id) : mode === 'books' ? booksValueOf.get(orig.id) : orig.amount) : -e.amount;
                        credit = round2(credit - v);
                        break;
                    }
                    case 'ALLOTMENT_REVERSAL': {
                        const cs = contribShares.get(e.contribution_id);
                        if (cs) { credit = round2(credit + round2(cs.shares * cs.price)); shares -= cs.shares; }
                        else credit = round2(credit + e.amount);
                        break;
                    }
                    default: credit = round2(credit + e.amount); // REFUND, CONSOLIDATION_LEFTOVER — kept as recorded
                }
            }
            return { credit, shares, allotNew };
        };

        const users = (await c.query(`SELECT id, first_name || ' ' || last_name AS name FROM users`)).rows;
        const nameOf = new Map(users.map(u => [u.id, u.name]));
        const byUser = new Map();
        for (const e of entries) { if (!byUser.has(e.user_id)) byUser.set(e.user_id, []); byUser.get(e.user_id).push(e); }

        const actualShares = new Map();
        for (const a of allots.filter(x => x.status === 'ACTIVE')) actualShares.set(a.user_id, (actualShares.get(a.user_id) || 0) + a.shares);
        const actualCredit = new Map();
        for (const e of entries) actualCredit.set(e.user_id, round2((actualCredit.get(e.user_id) || 0) + e.amount));

        let replayOk = true;
        const rows = [];
        const allotChanges = [];
        for (const [uid, list] of byUser) {
            const cur = await replay(list, 'current');
            const nxt = await replay(list, 'fixed');
            const bk = await replay(list, 'books');
            const aShares = actualShares.get(uid) || 0;
            const aCredit = actualCredit.get(uid) || 0;
            if (cur.shares !== aShares || Math.abs(cur.credit - aCredit) >= 0.01) replayOk = false;
            rows.push({ uid, name: nameOf.get(uid) || `#${uid}`, aShares, aCredit, nShares: nxt.shares, nCredit: nxt.credit, bShares: bk.shares, bCredit: bk.credit, curCheck: cur });
            for (const [aid, s] of nxt.allotNew) {
                const a = allotById.get(aid);
                if (a.shares !== s) allotChanges.push({ ...a, newShares: s, name: nameOf.get(uid) });
            }
        }
        rows.sort((a, b) => a.name.localeCompare(b.name));

        // ---------------- report ----------------
        console.log(`\n0) SHARE REGISTER vs BOOKS TODAY — contributions valued differently (${mismatched.length})`);
        if (!mismatched.length) {
            console.log('   none — every contribution\'s share credit equals its UGX value in the books.');
        } else {
            const byMember = new Map();
            for (const x of mismatched) {
                const k = nameOf.get(x.user) || `#${x.user}`;
                const m = byMember.get(k) || { n: 0, diff: 0 };
                m.n += 1; m.diff = round2(m.diff + (x.booksValue - x.creditValue));
                byMember.set(k, m);
            }
            const rates = new Map();
            for (const x of mismatched) { const k = `${fmt(x.creditRate || 0, 2)} → ${fmt(x.booksRate || 0, 4)}`; rates.set(k, (rates.get(k) || 0) + 1); }
            const total = round2(mismatched.reduce((a, x) => a + (x.booksValue - x.creditValue), 0));
            console.log(`   Share credit was valued at a different rate than the books for ${mismatched.length} contribution(s); books are UGX ${fmt(total)} ${total >= 0 ? 'higher' : 'lower'} in total.`);
            console.log('   By member:');
            for (const [k, m] of [...byMember].sort()) console.log(`     ${pad(k, 28)} ${lpad(m.n, 4)} contribution(s)   books ${m.diff >= 0 ? '+' : ''}UGX ${fmt(m.diff)}`);
            console.log('   Dates and rates (first 40):');
            for (const x of mismatched.sort((a, b) => a.d.localeCompare(b.d)).slice(0, 40)) {
                console.log(`     ${x.d}  ${pad(nameOf.get(x.user) || x.user, 24)} ${x.code} ${lpad(fmt(x.amount), 10)}  share credit at ${lpad(fmt(x.creditRate || 0, 2), 9)} = ${lpad(fmt(x.creditValue), 14)}   books at ${lpad(fmt(x.booksRate || 0, 4), 10)} (${x.source || '?'}) = ${lpad(fmt(x.booksValue), 14)}`);
            }
            console.log('   Rates used, share register → books (count):');
            for (const [k, n] of rates) console.log(`     ${k}   ×${n}`);
            console.log('\n   If the share register were rebuilt from the BOOKS\' values:');
            console.log(`   ${pad('Member', 26)}${lpad('Shares now', 11)}${lpad('→ rebuilt', 11)}${lpad('Credit now', 16)}${lpad('→ rebuilt', 16)}`);
            let a1 = 0; let b1 = 0; let a2 = 0; let b2 = 0;
            for (const r of rows) {
                const mark = r.aShares !== r.bShares ? '  ◀ shares change' : Math.abs(r.aCredit - r.bCredit) >= 0.01 ? '  ◀ credit changes' : '';
                console.log(`   ${pad(r.name, 26)}${lpad(r.aShares, 11)}${lpad(r.bShares, 11)}${lpad(fmt(r.aCredit), 16)}${lpad(fmt(r.bCredit), 16)}${mark}`);
                a1 += r.aShares; b1 += r.bShares; a2 = round2(a2 + r.aCredit); b2 = round2(b2 + r.bCredit);
            }
            console.log(`   ${pad('TOTAL', 26)}${lpad(a1, 11)}${lpad(b1, 11)}${lpad(fmt(a2), 16)}${lpad(fmt(b2), 16)}`);
        }

        console.log(`\n1) CONTRIBUTIONS WHOSE UGX VALUE WOULD CHANGE (${changed.length})`);
        if (!changed.length) console.log('   none — every contribution before the cut-off is already at the fixed rate (or has a MANUAL rate).');
        for (const x of changed.sort((a, b) => a.d.localeCompare(b.d))) {
            console.log(`   ${x.d}  ${pad(nameOf.get(x.user) || x.user, 24)} ${x.code} ${lpad(fmt(x.amount), 12)}  at ${lpad(fmt(x.oldRate || 0, 2), 9)} = UGX ${lpad(fmt(x.oldValue), 15)}  →  UGX ${lpad(fmt(x.newValue), 15)}  (${x.newValue >= x.oldValue ? '+' : ''}${fmt(x.newValue - x.oldValue)})`);
        }

        console.log(`\n2) EACH MEMBER — whole shares and share credit (UGX)`);
        console.log(`   ${pad('Member', 26)}${lpad('Shares now', 11)}${lpad('→ new', 8)}${lpad('Credit now', 16)}${lpad('→ new', 16)}`);
        let tA = 0; let tN = 0; let cA = 0; let cN = 0;
        for (const r of rows) {
            const mark = r.aShares !== r.nShares || Math.abs(r.aCredit - r.nCredit) >= 0.01 ? '  ◀ changes' : '';
            console.log(`   ${pad(r.name, 26)}${lpad(r.aShares, 11)}${lpad(r.nShares, 8)}${lpad(fmt(r.aCredit), 16)}${lpad(fmt(r.nCredit), 16)}${mark}`);
            tA += r.aShares; tN += r.nShares; cA = round2(cA + r.aCredit); cN = round2(cN + r.nCredit);
        }
        console.log(`   ${pad('TOTAL', 26)}${lpad(tA, 11)}${lpad(tN, 8)}${lpad(fmt(cA), 16)}${lpad(fmt(cN), 16)}`);
        console.log(`\n   Replay check (today's values reproduce today's register): ${replayOk ? 'OK' : 'NOT OK — the new figures above may be wrong; send this report as it is'}`);
        if (splits) console.log(`   Note: ${splits} split/consolidation allotment(s) exist — the replay does not model them; send this report as it is.`);

        console.log(`\n3) ALLOTMENTS WHOSE NUMBER OF SHARES WOULD CHANGE (${allotChanges.length})`);
        for (const a of allotChanges) {
            console.log(`   #${a.id} ${a.d} ${pad(a.name, 24)} ${a.source}: ${a.shares} → ${a.newShares} share(s)${a.status !== 'ACTIVE' ? ' (reversed)' : ''}${a.return_filed_at ? `  — RETURN ALREADY FILED ${String(a.return_filed_at).slice(0, 10)}` : ''}`);
        }

        console.log(`\n4) ALREADY ISSUED ON TODAY'S FIGURES (would need a look if shares change)`);
        const opt = async (label, table, sql) => console.log(`   ${pad(label, 58)} ${(await exists(c, table)) ? await count(c, sql) : 'n/a'}`);
        await opt('Share certificates issued', 'share_certificates', `SELECT COUNT(*) AS n FROM share_certificates`);
        await opt('Dividends declared (not cancelled)', 'dividends', `SELECT COUNT(*) AS n FROM dividends WHERE status <> 'CANCELLED'`);
        await opt('Returns of allotment marked as filed with URSB', 'share_allotments', `SELECT COUNT(*) AS n FROM share_allotments WHERE return_filed_at IS NOT NULL`);
        await opt('Share credit refunds paid', 'capital_credit_refunds', `SELECT COUNT(*) AS n FROM capital_credit_refunds WHERE status = 'PAID'`);
        await opt('Members with URSB-registered shares recorded (v1.81)', 'member_registered_shares', `SELECT COUNT(*) AS n FROM member_registered_shares WHERE superseded_at IS NULL`);
        await opt('Allotments made after the opening conversion', 'share_allotments', `SELECT COUNT(*) AS n FROM share_allotments WHERE source = 'CONTRIBUTION'`);
        await opt('Month-end FX revaluations closed', 'fx_revaluation_runs', `SELECT COUNT(*) AS n FROM fx_revaluation_runs`);

        console.log('\nNothing was changed. Copy everything from "Database:" down and send it.');
    } catch (err) {
        console.error(`\n❌ The report could not be made: ${err.message}`);
        process.exitCode = 1;
    } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
        await pool.end();
    }
})();
