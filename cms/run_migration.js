// ============================================================
// ONE-OFF MIGRATION RUNNER
// Runs a migration_vX.X.X.sql file against the database using
// the same connection settings as the app itself (.env).
// Avoids needing the `psql` CLI on your PATH.
//
// Usage:
//   node run_migration.js migration_v1.6.0.sql
//   node run_migration.js                (defaults to migration_v1.6.0.sql)
// ============================================================

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load .env explicitly from this script's own folder (cms/), regardless
// of which directory the `node` command was actually run from.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fileName = process.argv[2] || 'migration_v1.6.0.sql';
const filePath = path.resolve(__dirname, fileName);

console.log(`Using DB_USER=${process.env.DB_USER}, DB_NAME=${process.env.DB_NAME}, DB_HOST=${process.env.DB_HOST}, password length=${(process.env.DB_PASSWORD || '').length}`);

if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
}

const sql = fs.readFileSync(filePath, 'utf8');

const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
    console.log(`Running ${fileName} against ${process.env.DB_NAME}@${process.env.DB_HOST}...`);
    const client = await pool.connect();
    try {
        await client.query(sql);
        console.log('✅ Migration applied successfully.');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
})();
