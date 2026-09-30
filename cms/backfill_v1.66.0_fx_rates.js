// ============================================================
// ONE-TIME BACKFILL — v1.66.0 historical exchange rates.
//
// Loads a whole history of exchange rates in one go from a CSV file,
// then values every transaction that still has no UGX value. Use it
// once, right after running migration_v1.66.0.sql, to enter the Bank
// of Uganda rates for every month since the company's first
// transaction. (Single rates can also be entered one at a time in
// Settings > Exchange Rates — since v1.66.0 a PAST date is slotted
// into the history correctly there too. This script is just quicker
// for many months at once.)
//
// Run it the same way as run_migration.js, once per company database
// (change DB_NAME in .env between runs):
//
//     cd cms
//     node backfill_v1.66.0_fx_rates.js fx_rates.csv
//     node backfill_v1.66.0_fx_rates.js fx_rates.csv --dry-run   (shows what it would do, changes nothing)
//
// CSV FORMAT — one rate per line, header row required:
//
//     effective_from,base,target,rate,notes
//     2024-03-01,EUR,UGX,4105.32,BoU mid-rate 1 Mar 2024
//     2024-04-01,EUR,UGX,4098.70,BoU mid-rate 1 Apr 2024
//
//   effective_from — the first day the rate applies (YYYY-MM-DD).
//                    Each rate runs until the next one for the same
//                    pair starts. One row per month (the 1st) is
//                    enough; add more rows if you want finer detail.
//   base, target   — currency codes as they appear in Settings >
//                    Currencies. "1 base = rate target", so EUR,UGX,
//                    4100 means 1 EUR = 4,100 UGX.
//   rate           — a positive number, no thousands separators.
//   notes          — optional; where the rate came from.
//
// SAFE TO RE-RUN: a row whose pair already has a rate starting on
// that exact date is skipped (never overwritten) and reported. Every
// insert slots into the existing history exactly as the Settings
// screen does: the rate covering that date is cut off there, and the
// new rate runs until the next later one.
//
// FIXED RATES (v1.76.0): if a company decision fixes a rate for dates
// before a cut-off (fx_fixed_rate_periods — e.g. 1 EUR = 4,000 UGX
// before 2025-08-20), a line giving that pair a DIFFERENT rate before
// the cut-off stops the whole load with the line number.
//
// The whole file is loaded in ONE database transaction — if any line
// is invalid, nothing is saved and the script says which line.
//
// Transactions inside months already closed by an FX revaluation keep
// their values (closed months are final); if any are still missing a
// value there, the script lists them — reopen those months on the
// Financial Statements page > FX & Revaluation tab and run it again.
// ============================================================

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const csvFile = args.find(a => !a.startsWith('--'));

if (!csvFile) {
    console.error('Usage: node backfill_v1.66.0_fx_rates.js <rates.csv> [--dry-run]');
    process.exit(1);
}
const csvPath = path.resolve(process.cwd(), csvFile);
if (!fs.existsSync(csvPath)) {
    console.error(`❌ File not found: ${csvPath}`);
    process.exit(1);
}

console.log(`Using DB_USER=${process.env.DB_USER}, DB_NAME=${process.env.DB_NAME}, DB_HOST=${process.env.DB_HOST}, password length=${(process.env.DB_PASSWORD || '').length}`);

const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Minimal CSV reader: commas separate fields; a field may be wrapped
// in double quotes (needed only if a note itself contains a comma).
const parseCsvLine = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    out.push(cur.trim());
    return out;
};

const readRows = () => {
    const lines = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
    const header = parseCsvLine(lines[0]).map(h => h.toLowerCase());
    const col = (name) => {
        const i = header.indexOf(name);
        if (i === -1 && name !== 'notes') throw new Error(`CSV header is missing the "${name}" column (found: ${header.join(', ')})`);
        return i;
    };
    const idx = { date: col('effective_from'), base: col('base'), target: col('target'), rate: col('rate'), notes: col('notes') };
    const rows = [];
    for (let n = 1; n < lines.length; n++) {
        if (!lines[n].trim()) continue;
        const f = parseCsvLine(lines[n]);
        const date = f[idx.date];
        const rate = parseFloat(f[idx.rate]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`Line ${n + 1}: effective_from "${date}" is not a YYYY-MM-DD date`);
        if (!(rate > 0)) throw new Error(`Line ${n + 1}: rate "${f[idx.rate]}" is not a positive number`);
        rows.push({
            line: n + 1, date, rate,
            base: (f[idx.base] || '').toUpperCase(), target: (f[idx.target] || '').toUpperCase(),
            notes: idx.notes >= 0 ? (f[idx.notes] || null) : null,
        });
    }
    // Oldest first, so the history is built in order.
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.line - b.line));
    return rows;
};

(async () => {
    let rows;
    try {
        rows = readRows();
    } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    }
    console.log(`Read ${rows.length} rate(s) from ${path.basename(csvPath)}${dryRun ? ' — DRY RUN, nothing will be saved' : ''}.`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const setting = await client.query(`SELECT functional_currency_id FROM company_settings WHERE id = 1`);
        if (!setting.rows[0] || !setting.rows[0].functional_currency_id) {
            throw new Error('company_settings.functional_currency_id is not set — run migration_v1.66.0.sql first.');
        }

        const currencies = await client.query(`SELECT id, code FROM currencies`);
        const idByCode = new Map(currencies.rows.map(c => [c.code.toUpperCase(), c.id]));

        // Rates are recorded as set by the earliest System Admin/Treasurer
        // on file — whoever runs this script is not a logged-in user.
        const setter = await client.query(`
            SELECT u.id FROM users u
            JOIN   user_roles ur ON ur.user_id = u.id
            JOIN   roles r ON r.id = ur.role_id
            WHERE  r.name IN ('Admin', 'Treasurer') AND u.is_active = TRUE AND ur.revoked_at IS NULL
            ORDER  BY u.id ASC LIMIT 1
        `);
        const fallback = await client.query(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
        const setBy = (setter.rows[0] || fallback.rows[0] || {}).id;
        if (!setBy) throw new Error('No user exists to record as the person who set these rates.');

        // v1.76.0 — fixed-rate rules, if that migration has run.
        let fixedRules = [];
        try {
            fixedRules = (await client.query(`
                SELECT f.base_currency_id, f.target_currency_id, f.rate, f.valid_before::text AS valid_before,
                       b.code AS base_code, t.code AS target_code
                FROM fx_fixed_rate_periods f
                JOIN currencies b ON b.id = f.base_currency_id JOIN currencies t ON t.id = f.target_currency_id
            `)).rows;
        } catch (e) {
            if (e.code !== '42P01') throw e;
            await client.query('ROLLBACK');       // the failed read aborted the transaction —
            await client.query('BEGIN');          // start again (nothing had been written yet)
        }

        let inserted = 0;
        let skipped = 0;
        for (const r of rows) {
            const baseId = idByCode.get(r.base);
            const targetId = idByCode.get(r.target);
            if (!baseId) throw new Error(`Line ${r.line}: unknown currency code "${r.base}"`);
            if (!targetId) throw new Error(`Line ${r.line}: unknown currency code "${r.target}"`);
            if (baseId === targetId) throw new Error(`Line ${r.line}: base and target are the same currency`);

            // v1.76.0 — a fixed-rate company decision (fx_fixed_rate_periods)
            // covers this date: only that rate may be loaded for it.
            const fixed = fixedRules.find(f => r.date < f.valid_before
                && ((f.base_currency_id === baseId && f.target_currency_id === targetId)
                 || (f.base_currency_id === targetId && f.target_currency_id === baseId)));
            if (fixed) {
                const expected = fixed.base_currency_id === baseId ? parseFloat(fixed.rate) : 1 / parseFloat(fixed.rate);
                if (Math.abs(r.rate - expected) > Math.max(1e-9, expected * 1e-6)) {
                    throw new Error(`Line ${r.line}: ${r.base}->${r.target} ${r.rate} on ${r.date} — by company decision the rate before ` +
                        `${fixed.valid_before} is fixed at 1 ${fixed.base_code} = ${parseFloat(fixed.rate)} ${fixed.target_code} (v1.76.0). ` +
                        `Remove this line or give it that rate.`);
                }
            }

            const dup = await client.query(`
                SELECT rate FROM currency_exchange_rates
                WHERE base_currency_id = $1 AND target_currency_id = $2 AND effective_from = $3
            `, [baseId, targetId, r.date]);
            if (dup.rows.length > 0) {
                console.log(`  - skipped line ${r.line}: ${r.base}->${r.target} already has a rate starting ${r.date} (${dup.rows[0].rate})`);
                skipped++;
                continue;
            }

            await client.query(`
                UPDATE currency_exchange_rates SET effective_to = $1
                WHERE  base_currency_id = $2 AND target_currency_id = $3
                AND    effective_from < $1 AND (effective_to IS NULL OR effective_to > $1)
            `, [r.date, baseId, targetId]);
            const next = await client.query(`
                SELECT MIN(effective_from)::text AS next_from FROM currency_exchange_rates
                WHERE  base_currency_id = $1 AND target_currency_id = $2 AND effective_from > $3
            `, [baseId, targetId, r.date]);
            await client.query(`
                INSERT INTO currency_exchange_rates
                    (base_currency_id, target_currency_id, rate, effective_from, effective_to, set_by, notes)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [baseId, targetId, r.rate, r.date, next.rows[0].next_from || null, setBy,
                r.notes || 'Loaded by backfill_v1.66.0_fx_rates.js']);
            inserted++;
        }
        console.log(`Rates: ${inserted} added, ${skipped} skipped (already on file).`);

        // Value every transaction still missing a UGX value, and refresh
        // every open-month RATE_TABLE value (same rule as the Settings
        // screen): originals first, then reversals.
        const lastRun = (await client.query(`SELECT MAX(period_end)::text AS last FROM fx_revaluation_runs`)).rows[0].last;
        const openCond = lastRun
            ? `(functional_amount IS NULL OR (functional_rate_source IS DISTINCT FROM 'MANUAL' AND value_date > '${lastRun}'))`
            : `(functional_amount IS NULL OR functional_rate_source IS DISTINCT FROM 'MANUAL')`;
        const a = await client.query(`UPDATE transactions SET functional_rate_source = functional_rate_source WHERE reversal_of IS NULL AND ${openCond}`);
        const b = await client.query(`UPDATE transactions SET functional_rate_source = functional_rate_source WHERE reversal_of IS NOT NULL AND ${openCond}`);
        console.log(`Transactions re-valued in UGX: ${a.rowCount + b.rowCount}.`);

        const missing = await client.query(`
            SELECT t.id, t.value_date::text AS value_date, cur.code AS currency, t.amount, t.description
            FROM   transactions t JOIN currencies cur ON cur.id = t.currency_id
            WHERE  t.status = 'POSTED' AND t.functional_amount IS NULL
            ORDER  BY t.value_date, t.id
        `);
        if (missing.rows.length === 0) {
            console.log('✅ Every posted transaction now has a UGX value.');
        } else {
            console.log(`⚠️  ${missing.rows.length} posted transaction(s) still have no UGX value (no rate covers their date):`);
            for (const m of missing.rows.slice(0, 50)) {
                console.log(`   #${m.id}  ${m.value_date}  ${m.currency} ${m.amount}  ${m.description}`);
            }
            if (missing.rows.length > 50) console.log(`   ... and ${missing.rows.length - 50} more`);
            console.log('   Add rates covering those dates to the CSV and run it again (already-loaded rows are skipped).');
        }

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
