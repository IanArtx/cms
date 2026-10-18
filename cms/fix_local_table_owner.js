// ============================================================
// FIX "must be owner of table …" ON YOUR OWN COMPUTER (v1.85.0)
//
// Why it happens: some tables in your LOCAL database were created by
// the PostgreSQL administrator account ("postgres" — e.g. when a file
// was run from pgAdmin), while the system connects as the user in
// cms/.env (DB_USER). PostgreSQL only lets a table's OWNER change it,
// so a migration run as DB_USER stops with
//     must be owner of table share_certificates
//
// What this does: connects ONCE as the administrator ("postgres") and
// makes DB_USER the owner of everything in the database's public
// schema — tables (with their id counters), views, functions, types —
// so every later migration, run the normal way, works.
// It changes ownership only: no data, no figures, nothing else.
//
//     node fix_local_table_owner.js            (shows what it would change)
//     node fix_local_table_owner.js --apply    (changes it)
//
// It asks for the administrator's password (the one chosen when
// PostgreSQL was installed on this computer). Nothing is stored.
// Options: --admin=<name> if the administrator is not called "postgres".
// For your LOCAL database only — the online (Render) databases do not
// need this.
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const readline = require('readline');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const adminArg = args.find(a => a.startsWith('--admin='));
const admin = adminArg ? adminArg.slice(8) : 'postgres';
const appUser = process.env.DB_USER;
const dbName = process.env.DB_NAME;

const ask = (q) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a); });
});

(async () => {
    if (!appUser || !dbName) {
        console.error('❌ DB_USER / DB_NAME are not set in cms/.env — run this from the cms folder.');
        process.exit(1);
    }
    const host = process.env.DB_HOST || 'localhost';
    if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) {
        console.error(`❌ cms/.env points to ${host}, not this computer. This tool is only for a local database.`);
        process.exit(1);
    }
    if (appUser === admin) {
        console.log(`The system already connects as "${admin}". Nothing to change — send the migration error to Claude.`);
        return;
    }
    const password = process.env.PG_ADMIN_PASSWORD || await ask(`Password of the PostgreSQL administrator "${admin}": `);
    const pool = new Pool({
        host, port: parseInt(process.env.DB_PORT, 10) || 5432, database: dbName,
        user: admin, password, ssl: false,
    });
    const c = await pool.connect().catch((err) => {
        console.error(`❌ Could not log in as "${admin}": ${err.message}`);
        process.exit(1);
    });
    try {
        const role = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser]);
        if (!role.rows.length) throw new Error(`The user "${appUser}" from cms/.env does not exist in PostgreSQL.`);

        const q = async (sql) => (await c.query(sql, [appUser])).rows;
        const notExt = (oidCol) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = ${oidCol} AND d.deptype = 'e')`;
        const tables = await q(`
            SELECT c.relname AS name, c.relkind, pg_get_userbyid(c.relowner) AS owner
            FROM   pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE  n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND    pg_get_userbyid(c.relowner) <> $1 AND ${notExt('c.oid')}
            ORDER  BY c.relname`);
        const routines = await q(`
            SELECT p.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner) AS owner
            FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE  n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> $1 AND ${notExt('p.oid')}
            ORDER  BY 1`);
        const types = await q(`
            SELECT t.typname AS name, pg_get_userbyid(t.typowner) AS owner
            FROM   pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE  n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND pg_get_userbyid(t.typowner) <> $1
            AND    (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class r WHERE r.oid = t.typrelid AND r.relkind = 'c'))
            AND    ${notExt('t.oid')}
            ORDER  BY 1`);

        console.log(`\nDatabase: ${dbName}   the system's user (cms/.env): ${appUser}\n`);
        if (!tables.length && !routines.length && !types.length) {
            console.log(`✅ Everything is already owned by ${appUser}. Nothing to change.`);
            console.log('   If a migration still stops with "must be owner of …", send that message to Claude.');
            return;
        }
        const kind = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' };
        console.log(`Owned by someone else (will become ${appUser}'s):`);
        for (const t of tables) console.log(`   ${kind[t.relkind].padEnd(18)} ${t.name}   (now: ${t.owner})`);
        for (const r of routines) console.log(`   ${'function'.padEnd(18)} ${r.name}   (now: ${r.owner})`);
        for (const t of types) console.log(`   ${'type'.padEnd(18)} ${t.name}   (now: ${t.owner})`);
        console.log(`\n${tables.length} table(s)/view(s), ${routines.length} function(s), ${types.length} type(s).`);

        if (!apply) {
            console.log('\nNothing was changed. Run again with --apply to change the owner.');
            return;
        }
        await c.query('BEGIN');
        const id = (s) => `"${String(s).replace(/"/g, '""')}"`;
        const to = id(appUser);
        for (const t of tables) {
            const word = t.relkind === 'v' ? 'VIEW' : t.relkind === 'm' ? 'MATERIALIZED VIEW' : t.relkind === 'f' ? 'FOREIGN TABLE' : 'TABLE';
            await c.query(`ALTER ${word} public.${id(t.name)} OWNER TO ${to}`);
        }
        // id counters not tied to a table (tables carry their own along)
        const seqs = await q(`
            SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE  n.nspname = 'public' AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) <> $1
            AND    NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))`);
        for (const s of seqs) await c.query(`ALTER SEQUENCE public.${id(s.name)} OWNER TO ${to}`);
        for (const r of routines) await c.query(`ALTER ROUTINE ${r.name} OWNER TO ${to}`);
        for (const t of types) await c.query(`ALTER TYPE public.${id(t.name)} OWNER TO ${to}`);
        await c.query('COMMIT');
        console.log(`\n✅ Done — ${appUser} now owns them.`);
        console.log('   Next: node update_live_database.js   (then --apply --confirm=' + dbName + ')');
    } catch (err) {
        try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
        console.error(`\n❌ ${err.message}\n   Nothing was changed.`);
        process.exitCode = 1;
    } finally {
        c.release();
        await pool.end();
    }
})();
