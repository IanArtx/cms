// ============================================================
// UPDATE A LIVE DATABASE (v1.73.0) — check, then apply migrations
//
// Written for bringing an online database from any older version up
// to the current one (e.g. the live system at v1.59.0 → v1.73.0)
// without editing .env and without installing psql.
//
// It talks to ONE database at a time, given by its connection string
// (Render dashboard › the database › Connect › "External Database URL").
// Your own .env is never read or changed unless you leave --url out.
//
// 1) CHECK (read-only — changes nothing):
//       node update_live_database.js --url "postgresql://…"
//    Shows which company/database it reached, and for every version
//    from 1.58.0 to 1.73.0 whether its migration is already applied.
//
// 2) APPLY the missing migrations, oldest first:
//       node update_live_database.js --url "postgresql://…" --apply --confirm=<database name>
//    --confirm must repeat the database name printed by the check —
//    a guard against updating the wrong company by mistake. Each file
//    runs as one database transaction: if one fails, nothing from THAT
//    file is saved (the ones before it are), and it stops. Running it
//    again carries on from where it stopped.
//
// 3) RUN a one-time script (backfill) against that same database:
//       node update_live_database.js --url "postgresql://…" --script backfill_v1.67.0_share_receipts.js --dry-run
//    Everything after the script name is passed to the script.
//
// Every migration file is also safe to run again on its own (they all
// check before changing anything) — this tool simply skips the ones it
// can see are already there.
// ============================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

// ---- the versions this tool knows, oldest first --------------------
// fingerprint: SQL returning one row { ok: true|false } — true once that
// migration has been applied. file: null = that version had no database
// change (code only).
const col = (t, c) => `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' AND column_name='${c}') AS ok`;
const tbl = (t) => `SELECT to_regclass('public.${t}') IS NOT NULL AS ok`;
const idx = (i) => `SELECT to_regclass('public.${i}') IS NOT NULL AS ok`;

const VERSIONS = [
    { v: '1.58.0', file: 'migration_v1.58.0.sql', what: 'savings → capital conversions', check: tbl('savings_capital_conversions') },
    { v: '1.59.0', file: 'migration_v1.59.0.sql', what: 'settle fines with savings', check: tbl('savings_fine_settlements') },
    { v: '1.60.0', file: 'migration_v1.60.0.sql', what: 'bond term (years)', check: col('investments', 'bond_term_years') },
    { v: '1.61.0', file: 'migration_v1.61.0.sql', what: 'savings in several currencies', check: col('savings_interest_accrual', 'currency_id') },
    { v: '1.62.0', file: 'migration_v1.62.0.sql', what: 'balances checked as of the transaction date', check: idx('idx_transactions_account_valuedate') },
    { v: '1.63.0', file: 'migration_v1.63.0.sql', what: 'online events / Google Meet', check: col('events', 'is_online') },
    { v: '1.64.0', file: 'migration_v1.64.0.sql', what: 'share certificates "as of" date', check: col('share_certificates', 'as_of_date') },
    { v: '1.65.0', file: null, what: '(no database change)' },
    { v: '1.66.0', file: 'migration_v1.66.0.sql', what: 'FX: functional currency, UGX value of every entry', check: col('transactions', 'functional_amount') },
    { v: '1.67.0', file: 'migration_v1.67.0.sql', what: 'share receipts in one currency (documents owner)', check: col('documents', 'owner_user_id') },
    { v: '1.68.0', file: null, what: '(no database change)' },
    { v: '1.69.0', file: 'migration_v1.69.0.sql', what: 'whole shares, share credit, nominal value', check: tbl('share_allotments') },
    { v: '1.69.1', file: null, what: '(no database change)' },
    { v: '1.69.2', file: null, what: '(no database change)' },
    { v: '1.70.0', file: 'migration_v1.70.0.sql', what: 'tax: WHT both ways, corporate tax years', check: col('company_settings', 'tin') },
    { v: '1.71.0', file: null, what: '(no database change — new look)' },
    { v: '1.72.0', file: 'migration_v1.72.0.sql', what: 'reversal requests + repair of past reversals', check: tbl('reversal_requests') },
    { v: '1.73.0', file: 'migration_v1.73.0.sql', what: 'money entries held for approval', check: tbl('held_money_entries') },
];

// ---- arguments ------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (name) => {
    const eq = argv.find(a => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name) => argv.includes(`--${name}`) || argv.some(a => a.startsWith(`--${name}=`));

const scriptIdx = argv.indexOf('--script');
const scriptName = scriptIdx >= 0 ? argv[scriptIdx + 1] : null;
const scriptArgs = scriptIdx >= 0 ? argv.slice(scriptIdx + 2) : [];

let url = getArg('url');
if (url && (argv.indexOf('--url') > scriptIdx && scriptIdx >= 0)) url = null; // --url must come before --script

// ---- connection -----------------------------------------------------
const isLocal = (host) => !host || ['localhost', '127.0.0.1', '::1'].includes(host);

let conn;
if (url) {
    let u;
    try { u = new URL(url); } catch (_) {
        console.error('❌ That --url is not a valid connection string. Copy the "External Database URL" from Render (it starts with postgresql://).');
        process.exit(1);
    }
    conn = {
        host: u.hostname, port: parseInt(u.port, 10) || 5432,
        database: decodeURIComponent(u.pathname.replace(/^\//, '')),
        user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    };
    conn.ssl = isLocal(conn.host) ? false : { rejectUnauthorized: false };
} else {
    require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
    conn = {
        host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT, 10) || 5432,
        database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };
    console.log('(no --url given — using the database in cms/.env)');
}

// ---- 3) run a script against this database ---------------------------
if (scriptName) {
    const file = path.resolve(__dirname, scriptName);
    if (!fs.existsSync(file)) { console.error(`❌ Script not found: ${file}`); process.exit(1); }
    console.log(`Running ${scriptName} ${scriptArgs.join(' ')} against ${conn.database} @ ${conn.host}\n`);
    const env = {
        ...process.env,
        DB_HOST: conn.host, DB_PORT: String(conn.port), DB_NAME: conn.database,
        DB_USER: conn.user, DB_PASSWORD: conn.password, DB_SSL: conn.ssl ? 'true' : 'false',
    };
    const child = spawn(process.execPath, [file, ...scriptArgs], { cwd: __dirname, env, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    return;
}

// ---- 1) check / 2) apply ------------------------------------------------
const pool = new Pool({ ...conn, connectionTimeoutMillis: 15000 });

const status = async (client) => {
    const out = [];
    for (const x of VERSIONS) {
        if (!x.file) { out.push({ ...x, applied: null }); continue; }
        const r = await client.query(x.check);
        out.push({ ...x, applied: !!r.rows[0].ok });
    }
    return out;
};

const printStatus = (rows) => {
    console.log('\n  Version  Status        What it adds');
    console.log('  -------  ------------  ------------------------------------------');
    for (const r of rows) {
        const s = r.applied === null ? 'no DB change' : r.applied ? 'applied' : 'MISSING';
        console.log(`  ${r.v.padEnd(7)}  ${s.padEnd(12)}  ${r.what}`);
    }
};

(async () => {
    let client;
    try {
        client = await pool.connect();
    } catch (err) {
        console.error(`❌ Could not connect to ${conn.database} @ ${conn.host}: ${err.message}`);
        console.error('   Check the connection string, and that you copied the EXTERNAL Database URL.');
        process.exit(1);
    }
    try {
        const who = await client.query(`SELECT current_database() AS db, version() AS pg`);
        let company = '(unknown)';
        try { company = (await client.query(`SELECT company_name FROM company_settings ORDER BY id LIMIT 1`)).rows[0]?.company_name || company; } catch (_) {}
        const counts = await client.query(`
            SELECT (SELECT COUNT(*) FROM users) AS users,
                   (SELECT COUNT(*) FROM transactions) AS transactions,
                   (SELECT MAX(value_date) FROM transactions) AS last_entry
        `);
        const c = counts.rows[0];
        console.log('\n=== Database reached ===');
        console.log(`  Company:       ${company}`);
        console.log(`  Database name: ${who.rows[0].db}      <- use this for --confirm`);
        console.log(`  Server:        ${conn.host}`);
        console.log(`  PostgreSQL:    ${who.rows[0].pg.split(',')[0]}`);
        console.log(`  Users: ${c.users} · Ledger entries: ${c.transactions} · Latest entry date: ${c.last_entry ? new Date(c.last_entry).toISOString().slice(0, 10) : '—'}`);

        let rows = await status(client);
        printStatus(rows);
        let missing = rows.filter(r => r.applied === false);

        // A gap (an older one missing while a newer one is applied) is unusual — say so.
        const firstMissing = rows.findIndex(r => r.applied === false);
        const laterApplied = firstMissing >= 0 && rows.slice(firstMissing + 1).some(r => r.applied === true);
        if (laterApplied) {
            console.log('\n⚠️  An older migration is missing while a newer one is applied. That is unusual but');
            console.log('   safe: every migration file checks before it changes anything. The missing ones will run in order.');
        }

        if (!missing.length) {
            console.log('\n✅ This database is up to date (1.73.0). Nothing to apply.');
            return;
        }
        console.log(`\n${missing.length} migration(s) to apply, in this order: ${missing.map(m => m.v).join(' → ')}`);

        if (!has('apply')) {
            console.log('\nThis was a CHECK only — nothing was changed.');
            console.log(`To apply them:  node update_live_database.js --url "…" --apply --confirm=${who.rows[0].db}`);
            return;
        }
        const confirm = getArg('confirm');
        if (confirm !== who.rows[0].db) {
            console.log(`\n❌ Not applied: add --confirm=${who.rows[0].db} (the database name above) to confirm this is the right database.`);
            process.exitCode = 1;
            return;
        }

        for (const m of missing) {
            const file = path.join(__dirname, m.file);
            if (!fs.existsSync(file)) {
                console.error(`\n❌ ${m.file} is not in the cms folder — stopping. Nothing more was changed.`);
                process.exitCode = 1; return;
            }
            const sql = fs.readFileSync(file, 'utf8');
            process.stdout.write(`\n→ ${m.v}  ${m.file} … `);
            const t0 = Date.now();
            try {
                await client.query(sql);
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (_) {}
                console.log('FAILED');
                console.error(`\n❌ ${m.file} failed: ${err.message}`);
                console.error('   Nothing from this file was saved (it runs as one transaction). Everything before it IS saved.');
                console.error('   Do not push the new code yet. Send this message to Claude; run this tool again once fixed —');
                console.error('   it carries on from here.');
                process.exitCode = 1;
                return;
            }
            const again = await client.query(m.check);
            if (!again.rows[0].ok) {
                console.log('done, but its fingerprint is still missing');
                console.error(`\n❌ ${m.file} ran but the change it makes is not visible — stopping to be safe. Send this to Claude.`);
                process.exitCode = 1;
                return;
            }
            console.log(`applied (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        }

        rows = await status(client);
        printStatus(rows);
        missing = rows.filter(r => r.applied === false);
        if (missing.length) {
            console.log('\n⚠️  Still missing: ' + missing.map(m => m.v).join(', '));
            process.exitCode = 1;
        } else {
            console.log('\n✅ Database is now at 1.73.0.');
            try {
                const rc = await client.query(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE needs_attention) AS a FROM record_corrections`);
                console.log(`   Automatic corrections logged by the v1.72.0 repair: ${rc.rows[0].n} (needing a look: ${rc.rows[0].a}) — see Reports › Records check after the code is live.`);
            } catch (_) {}
        }
    } finally {
        client.release();
        await pool.end();
    }
})().catch((err) => { console.error('❌', err.message); process.exit(1); });
