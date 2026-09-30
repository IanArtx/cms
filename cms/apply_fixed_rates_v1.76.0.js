// ============================================================
// ONE-TIME CORRECTION — v1.76.0 fixed exchange rate before a cut-off
//
// Requested directly: "would like that each euro is valued at UGX 4000
// for any date in both companies before 20th Aug 2025".
// The rule itself is stored by migration_v1.76.0.sql (table
// fx_fixed_rate_periods). THIS script puts it into the books, once per
// company database, with a dry run first:
//
//     node update_live_database.js --url "…" --script apply_fixed_rates_v1.76.0.js --dry-run
//     node update_live_database.js --url "…" --script apply_fixed_rates_v1.76.0.js
//
// Options:
//     --dry-run          show everything it would change, save nothing
//     --include-manual   also re-value transactions before the cut-off
//                        that an Admin had given a MANUAL rate (by
//                        default they keep it and are listed)
//
// RUN IT BEFORE THE OPENING SHARE CONVERSION (update guide step C2).
// Whole shares and share credit are worked out from each contribution's
// UGX value; the script refuses to run once shares have been allotted,
// so the share register is always built from the corrected values.
//
// WHAT IT CHANGES (everything in ONE database transaction — if any
// check fails, nothing is saved):
//   1. Exchange-rate table, for each rule (e.g. EUR→UGX 4,000 before
//      2025-08-20), in both directions of the pair:
//        - rates that ended on or before the cut-off are removed (their
//          old values are kept in the audit log entry);
//        - a rate that was running across the cut-off now starts ON the
//          cut-off (same rate as before — dates from the cut-off on do
//          not change);
//        - one rate row is added: the fixed rate, from 1 Jan 2000 (or
//          the oldest date in the books, if earlier) up to the cut-off.
//   2. The UGX value of every transaction dated before the cut-off is
//      worked out again with exactly the usual rules (the database
//      trigger): EUR amounts from the rate table become x 4,000.
//      NOT changed: transfers between accounts (each keeps its own
//      recorded rate, so the shillings that arrived stay the same),
//      amounts already in UGX, and MANUAL rates unless --include-manual.
//      Reversals follow the entry they reverse, as always.
//   3. Month-end FX revaluations: any stored month from the first
//      affected date onwards is removed (each month builds on the one
//      before) — run them again afterwards on Financial Statements ›
//      FX & Revaluation. Months before the first affected date stay.
//   4. Withholding-tax and tax-deducted-at-source records dated before
//      the cut-off in the fixed currency: their UGX value is updated
//      to the fixed rate. (Stops instead, if one was already paid over
//      to URA — that needs a person to look at it.)
//   5. Capital-goal pledge payments dated before the cut-off: their
//      "converted into the goal's currency" figure uses the fixed rate.
//
// WHAT IT ONLY REPORTS (real money already moved at an agreed rate —
// left exactly as recorded): transfers, savings currency conversions,
// dividend payouts in another currency, deposit entries with a rate.
//
// CHECKS BEFORE SAVING: the rate on every date before the cut-off is
// the fixed rate; the cut-off day keeps its previous rate; every posted
// transaction has a UGX value; every transfer leg is unchanged; every
// rate-table transaction before the cut-off now uses the fixed rate.
//
// Safe to run again: a second run finds nothing left to change.
// ============================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const includeManual = args.includes('--include-manual');

const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const FIXED_START_DEFAULT = '2000-01-01';

const fmt = (n, dp = 2) => (n === null || n === undefined) ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n).slice(-n);

class Stop extends Error {}

const tableExists = async (c, t) => (await c.query(`SELECT to_regclass('public.${t}') IS NOT NULL AS ok`)).rows[0].ok;
const columnExists = async (c, t, col) => (await c.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS ok`, [t, col])).rows[0].ok;

(async () => {
    console.log(`Database: ${process.env.DB_NAME} @ ${process.env.DB_HOST}${dryRun ? '  — DRY RUN, nothing will be saved' : ''}\n`);
    const c = await pool.connect();
    try {
        await c.query('BEGIN');

        // ---------------- 0. the rules, the setting, the person ---------------
        if (!(await tableExists(c, 'fx_fixed_rate_periods'))) {
            throw new Stop('The table fx_fixed_rate_periods is missing — run migration_v1.76.0.sql first (node update_live_database.js --url "…" --apply --confirm=<database name>).');
        }
        const settings = (await c.query(`
            SELECT cs.functional_currency_id AS fid, cur.code AS fcode
            FROM company_settings cs LEFT JOIN currencies cur ON cur.id = cs.functional_currency_id WHERE cs.id = 1`)).rows[0];
        if (!settings || !settings.fid) throw new Stop('company_settings.functional_currency_id is not set (migration_v1.66.0.sql).');
        const F = settings.fid;

        const rules = (await c.query(`
            SELECT f.*, f.valid_before::text AS valid_before, b.code AS base_code, t.code AS target_code
            FROM fx_fixed_rate_periods f
            JOIN currencies b ON b.id = f.base_currency_id JOIN currencies t ON t.id = f.target_currency_id
            ORDER BY f.id`)).rows.map(r => ({ ...r, rate: parseFloat(r.rate) }));
        if (rules.length === 0) throw new Stop('No fixed-rate rule is stored in fx_fixed_rate_periods — nothing to apply.');
        for (const r of rules) {
            console.log(`Rule #${r.id}: 1 ${r.base_code} = ${fmt(r.rate, 2)} ${r.target_code} for every date before ${r.valid_before}`);
            if (r.base_currency_id !== F && r.target_currency_id !== F) {
                throw new Stop(`Rule #${r.id} (${r.base_code}/${r.target_code}) does not involve the functional currency ${settings.fcode} — this script only handles rules against ${settings.fcode}.`);
            }
        }
        // For each rule: the foreign currency and its rate INTO the functional currency.
        const ruleInfo = rules.map(r => ({
            ...r,
            foreignId: r.base_currency_id === F ? r.target_currency_id : r.base_currency_id,
            foreignCode: r.base_currency_id === F ? r.target_code : r.base_code,
            toFunctional: r.base_currency_id === F ? 1 / r.rate : r.rate,
        }));
        const maxCutoff = ruleInfo.map(r => r.valid_before).sort().pop();

        const setter = await c.query(`
            SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
            WHERE r.name IN ('Admin', 'Treasurer') AND u.is_active = TRUE AND ur.revoked_at IS NULL
            ORDER BY u.id LIMIT 1`);
        const setBy = (setter.rows[0] || (await c.query(`SELECT id FROM users ORDER BY id LIMIT 1`)).rows[0] || {}).id;
        if (!setBy) throw new Stop('No user exists to record as the person who made this change.');

        // ---------------- 1. the share register must not be built yet --------
        if (await tableExists(c, 'share_capital_settings')) {
            const sc = (await c.query(`SELECT opening_converted_at FROM share_capital_settings WHERE id = 1`)).rows[0];
            const allots = (await c.query(`SELECT COUNT(*)::int AS n FROM share_allotments`)).rows[0].n;
            if ((sc && sc.opening_converted_at) || allots > 0) {
                throw new Stop(
                    `The opening share conversion has already run on this database (${allots} allotment(s) on file). ` +
                    `Whole shares and share credit were worked out from the OLD UGX values, so changing them now would ` +
                    `leave the share register and the books disagreeing. Nothing was changed — ask for a version of this ` +
                    `correction that also rebuilds the share register.`);
            }
        }

        // ---------------- 2. snapshot of every UGX value ------------------------
        await c.query(`
            CREATE TEMP TABLE fx_before ON COMMIT DROP AS
            SELECT id, functional_amount, functional_rate, functional_rate_source FROM transactions`);

        // Oldest date in the books (so "any date" really is any date).
        const oldest = (await c.query(`
            SELECT LEAST(
                (SELECT MIN(value_date) FROM transactions),
                (SELECT MIN(contribution_date) FROM shareholder_contributions)
            )::text AS d`)).rows[0].d;
        const fixedStart = oldest && oldest < FIXED_START_DEFAULT ? oldest : FIXED_START_DEFAULT;

        // ---------------- 3. the rate table -------------------------------------
        const rateChanges = [];
        for (const r of ruleInfo) {
            for (const [b, t, directRate] of [[r.base_currency_id, r.target_currency_id, r.rate], [r.target_currency_id, r.base_currency_id, 1 / r.rate]]) {
                const rows = (await c.query(`
                    SELECT id, rate, effective_from::text AS ef, effective_to::text AS et, notes
                    FROM currency_exchange_rates
                    WHERE base_currency_id = $1 AND target_currency_id = $2 AND effective_from < $3
                    ORDER BY effective_from, id`, [b, t, r.valid_before])).rows;
                for (const x of rows) {
                    const isFixedRow = b === r.base_currency_id && x.ef === fixedStart && x.et === r.valid_before
                        && Math.abs(parseFloat(x.rate) - directRate) < 1e-6;
                    if (isFixedRow) continue;
                    const pair = `${b === r.base_currency_id ? r.base_code : r.target_code}→${b === r.base_currency_id ? r.target_code : r.base_code}`;
                    if (x.et !== null && x.et <= r.valid_before) {
                        await c.query(`DELETE FROM currency_exchange_rates WHERE id = $1`, [x.id]);
                        rateChanges.push({ action: 'removed', pair, id: x.id, rate: parseFloat(x.rate), from: x.ef, to: x.et, notes: x.notes });
                    } else {
                        const clash = (await c.query(`
                            SELECT id FROM currency_exchange_rates
                            WHERE base_currency_id = $1 AND target_currency_id = $2 AND effective_from = $3`, [b, t, r.valid_before])).rows[0];
                        if (clash) {
                            await c.query(`DELETE FROM currency_exchange_rates WHERE id = $1`, [x.id]);
                            rateChanges.push({ action: 'removed', pair, id: x.id, rate: parseFloat(x.rate), from: x.ef, to: x.et, notes: x.notes });
                        } else {
                            await c.query(`UPDATE currency_exchange_rates SET effective_from = $1 WHERE id = $2`, [r.valid_before, x.id]);
                            rateChanges.push({ action: 'now starts on the cut-off', pair, id: x.id, rate: parseFloat(x.rate), from: x.ef, to: x.et, newFrom: r.valid_before, notes: x.notes });
                        }
                    }
                }
            }
            const exists = (await c.query(`
                SELECT id FROM currency_exchange_rates
                WHERE base_currency_id = $1 AND target_currency_id = $2 AND effective_from = $3 AND effective_to = $4 AND rate = $5`,
                [r.base_currency_id, r.target_currency_id, fixedStart, r.valid_before, r.rate])).rows[0];
            if (!exists) {
                // Anything else starting on fixedStart in this direction was removed above.
                await c.query(`
                    INSERT INTO currency_exchange_rates (base_currency_id, target_currency_id, rate, effective_from, effective_to, set_by, notes)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [r.base_currency_id, r.target_currency_id, r.rate, fixedStart, r.valid_before, setBy, r.reason]);
                rateChanges.push({ action: 'added', pair: `${r.base_code}→${r.target_code}`, rate: r.rate, from: fixedStart, to: r.valid_before });
            }
        }

        console.log('\n1) EXCHANGE-RATE TABLE');
        if (rateChanges.length === 0) console.log('   Already correct — nothing to change.');
        for (const x of rateChanges) {
            const span = `${x.from} → ${x.to || 'open'}`;
            if (x.action === 'added') console.log(`   + added    ${pad(x.pair, 9)} ${padL(fmt(x.rate), 12)}   ${span}`);
            else if (x.action === 'removed') console.log(`   - removed  ${pad(x.pair, 9)} ${padL(fmt(x.rate), 12)}   ${span}`);
            else console.log(`   ~ moved    ${pad(x.pair, 9)} ${padL(fmt(x.rate), 12)}   ${span}  → now starts ${x.newFrom}`);
        }

        // ---------------- 4. month-end revaluations ------------------------------
        const foreignIds = ruleInfo.map(r => r.foreignId);
        const firstAffected = (await c.query(`
            SELECT MIN(value_date)::text AS d FROM transactions
            WHERE currency_id = ANY($1::int[]) AND value_date < $2`, [foreignIds, maxCutoff])).rows[0].d;
        const firstRunBefore = (await c.query(`
            SELECT MIN(period_end)::text AS d FROM fx_revaluation_runs WHERE period_end < $1`, [maxCutoff])).rows[0].d;
        const reopenFrom = [firstAffected, firstRunBefore].filter(Boolean).sort()[0] || null;
        let runsRemoved = [];
        if (reopenFrom) {
            runsRemoved = (await c.query(`
                DELETE FROM fx_revaluation_runs WHERE period_end >= $1
                RETURNING period_end::text AS period_end, total_gain, total_loss, rates_used`, [reopenFrom])).rows
                .sort((a, b) => (a.period_end < b.period_end ? -1 : 1));
        }
        console.log('\n2) MONTH-END FX REVALUATIONS');
        if (runsRemoved.length === 0) console.log('   None stored from the affected dates on — nothing to reopen.');
        else {
            console.log(`   Reopened ${runsRemoved.length} month(s): ${runsRemoved[0].period_end} … ${runsRemoved[runsRemoved.length - 1].period_end}.`);
            console.log('   Run them again afterwards: Financial Statements › FX & Revaluation.');
        }

        // ---------------- 5. UGX value of each transaction ------------------------
        let manualList = (await c.query(`
            SELECT t.id, t.value_date::text AS d, cur.code, t.amount, t.functional_rate, t.functional_rate_note
            FROM transactions t JOIN currencies cur ON cur.id = t.currency_id
            WHERE t.functional_rate_source = 'MANUAL' AND t.currency_id = ANY($1::int[]) AND t.value_date < $2
            ORDER BY t.value_date, t.id`, [foreignIds, maxCutoff])).rows;
        if (includeManual && manualList.length) {
            await c.query(`
                UPDATE transactions SET functional_rate_source = 'RATE_TABLE'
                WHERE functional_rate_source = 'MANUAL' AND currency_id = ANY($1::int[]) AND value_date < $2`, [foreignIds, maxCutoff]);
        }
        // Originals first, then reversals (a reversal takes its original's rate).
        await c.query(`
            UPDATE transactions SET functional_rate_source = functional_rate_source
            WHERE reversal_of IS NULL
            AND (functional_amount IS NULL OR (functional_rate_source IS DISTINCT FROM 'MANUAL' AND value_date < $1))`, [maxCutoff]);
        await c.query(`
            UPDATE transactions r SET functional_rate_source = r.functional_rate_source
            WHERE r.reversal_of IS NOT NULL AND r.functional_rate_source IS DISTINCT FROM 'MANUAL'
            AND (r.functional_amount IS NULL OR r.value_date < $1
                 OR EXISTS (SELECT 1 FROM transactions o WHERE o.id = r.reversal_of AND o.value_date < $1))`, [maxCutoff]);

        const changed = (await c.query(`
            SELECT t.id, t.value_date::text AS d, cur.code, t.amount, t.inflow_type, t.transaction_type,
                   LEFT(COALESCE(t.description, ''), 46) AS description,
                   b.functional_rate AS old_rate, t.functional_rate AS new_rate,
                   b.functional_amount AS old_ugx, t.functional_amount AS new_ugx,
                   b.functional_rate_source AS old_src, t.functional_rate_source AS new_src
            FROM transactions t JOIN fx_before b ON b.id = t.id JOIN currencies cur ON cur.id = t.currency_id
            WHERE b.functional_amount IS DISTINCT FROM t.functional_amount
            ORDER BY t.value_date, t.id`)).rows;

        console.log('\n3) UGX VALUE OF TRANSACTIONS');
        if (changed.length === 0) console.log('   Already correct — no transaction changes value.');
        else {
            let tOld = 0; let tNew = 0;
            const byType = new Map();
            for (const x of changed) {
                const o = x.old_ugx === null ? 0 : parseFloat(x.old_ugx);
                const n = x.new_ugx === null ? 0 : parseFloat(x.new_ugx);
                tOld += o; tNew += n;
                const k = `${x.transaction_type} ${x.inflow_type || ''}`.trim();
                const g = byType.get(k) || { n: 0, old: 0, now: 0 };
                g.n += 1; g.old += o; g.now += n; byType.set(k, g);
            }
            console.log(`   ${changed.length} transaction(s) re-valued. UGX total of those rows: ${fmt(tOld)} → ${fmt(tNew)} (difference ${fmt(tNew - tOld)}).`);
            console.log('   By kind:');
            for (const [k, g] of Array.from(byType.entries()).sort()) {
                console.log(`     ${pad(k, 44)} ${padL(g.n, 4)} row(s)   ${padL(fmt(g.old), 18)} → ${padL(fmt(g.now), 18)}`);
            }
            console.log('   Row by row (first 60):');
            console.log(`     ${pad('#', 7)} ${pad('date', 10)} ${padL('amount', 16)} ${pad('', 3)} ${padL('old rate', 12)} ${padL('new rate', 12)} ${padL('old UGX', 18)} ${padL('new UGX', 18)}  description`);
            for (const x of changed.slice(0, 60)) {
                console.log(`     ${pad(x.id, 7)} ${pad(x.d, 10)} ${padL(fmt(x.amount), 16)} ${pad(x.code, 3)} ${padL(fmt(x.old_rate, 4), 12)} ${padL(fmt(x.new_rate, 4), 12)} ${padL(fmt(x.old_ugx), 18)} ${padL(fmt(x.new_ugx), 18)}  ${x.description}`);
            }
            if (changed.length > 60) console.log(`     … and ${changed.length - 60} more`);
        }
        if (manualList.length) {
            console.log(includeManual
                ? `   ${manualList.length} transaction(s) that had a MANUAL rate were re-valued at the fixed rate (--include-manual).`
                : `   ${manualList.length} transaction(s) before the cut-off keep the MANUAL rate an Admin gave them (add --include-manual to re-value them too):`);
            if (!includeManual) {
                for (const m of manualList.slice(0, 20)) console.log(`     #${m.id}  ${m.d}  ${m.code} ${fmt(m.amount)} at ${fmt(m.functional_rate, 4)}  ${m.functional_rate_note || ''}`);
            }
        }

        // ---------------- 6. tax records -----------------------------------------
        const taxUpdates = [];
        for (const r of ruleInfo) {
            if (await tableExists(c, 'wht_withholdings')) {
                const paid = (await c.query(`
                    SELECT id, withholding_date::text AS d, tax_amount, functional_rate FROM wht_withholdings
                    WHERE currency_id = $1 AND withholding_date < $2 AND tax_functional IS NOT NULL
                    AND functional_rate IS DISTINCT FROM $3::numeric AND (remittance_id IS NOT NULL OR status = 'REMITTED')`,
                    [r.foreignId, r.valid_before, r.toFunctional])).rows;
                if (paid.length) {
                    throw new Stop(`${paid.length} withholding-tax record(s) dated before ${r.valid_before} were already paid over to URA at a different rate (ids ${paid.map(p => p.id).join(', ')}). Nothing was changed — these need a person to decide how to correct them with URA first.`);
                }
                const u = await c.query(`
                    UPDATE wht_withholdings
                    SET functional_rate = $3, tax_functional = ROUND(tax_amount * $3, 2)
                    WHERE currency_id = $1 AND withholding_date < $2 AND functional_rate IS NOT NULL
                    AND functional_rate IS DISTINCT FROM $3::numeric
                    RETURNING id`, [r.foreignId, r.valid_before, r.toFunctional]);
                if (u.rowCount) taxUpdates.push(`${u.rowCount} withholding-tax record(s)`);
            }
            if (await tableExists(c, 'tax_at_source')) {
                const u = await c.query(`
                    UPDATE tax_at_source
                    SET functional_rate = $3, gross_functional = ROUND(gross_amount * $3, 2), tax_functional = ROUND(tax_amount * $3, 2)
                    WHERE currency_id = $1 AND deduction_date < $2 AND functional_rate IS NOT NULL
                    AND functional_rate IS DISTINCT FROM $3::numeric
                    RETURNING id`, [r.foreignId, r.valid_before, r.toFunctional]);
                if (u.rowCount) taxUpdates.push(`${u.rowCount} tax-deducted-at-source record(s)`);
            }
        }
        console.log('\n4) TAX RECORDS');
        console.log(taxUpdates.length ? `   Updated to the fixed rate: ${taxUpdates.join(', ')}.` : '   None dated before the cut-off in the fixed currency.');

        // ---------------- 7. capital-goal pledge payments --------------------------
        let pledgeUpdated = 0;
        if (await tableExists(c, 'capital_goal_pledge_payments')) {
            for (const r of rules) {
                for (const [from, to, rate] of [[r.base_currency_id, r.target_currency_id, r.rate], [r.target_currency_id, r.base_currency_id, 1 / r.rate]]) {
                    const u = await c.query(`
                        UPDATE capital_goal_pledge_payments pp
                        SET exchange_rate_to_goal_currency = $3, converted_amount_goal_currency = ROUND(pp.amount * $3, 4)
                        FROM capital_goal_pledges p, capital_goal_monthly_calls mc, capital_goals g, transactions t
                        WHERE p.id = pp.pledge_id AND mc.id = p.monthly_call_id AND g.id = mc.capital_goal_id
                        AND t.id = pp.transaction_id
                        AND p.currency_id = $1 AND g.currency_id = $2 AND t.value_date < $4
                        AND pp.exchange_rate_to_goal_currency IS DISTINCT FROM $3::numeric`, [from, to, rate, r.valid_before]);
                    pledgeUpdated += u.rowCount || 0;
                }
            }
        }
        console.log('\n5) CAPITAL-GOAL PLEDGE PAYMENTS');
        console.log(pledgeUpdated ? `   ${pledgeUpdated} payment(s) now converted into the goal's currency at the fixed rate.` : '   None to change.');

        // ---------------- 8. reported only (real money, agreed rates) ---------------
        console.log('\n6) LEFT AS RECORDED (money already moved at an agreed rate)');
        const report = async (label, sql, params) => {
            try {
                const n = (await c.query(sql, params)).rows[0].n;
                console.log(`   ${pad(label, 58)} ${n}`);
            } catch (e) { if (!['42P01', '42703'].includes(e.code)) throw e; }
        };
        for (const r of ruleInfo) {
            const pairIds = [r.base_currency_id, r.target_currency_id];
            await report(`Transfers ${r.base_code}/${r.target_code} before ${r.valid_before} (own rate kept)`, `
                SELECT COUNT(*)::int AS n FROM transfers
                WHERE value_date < $2 AND currency_sent_id = ANY($1::int[]) AND currency_received_id = ANY($1::int[])`, [pairIds, r.valid_before]);
            await report('Savings currency conversions before the cut-off', `
                SELECT COUNT(*)::int AS n FROM savings_currency_conversions
                WHERE conversion_date < $2 AND from_currency_id = ANY($1::int[]) AND to_currency_id = ANY($1::int[])`, [pairIds, r.valid_before]);
            await report('Deposit entries with a conversion rate before the cut-off', `
                SELECT COUNT(*)::int AS n FROM deposit_entries WHERE entry_date < $1 AND exchange_rate_used <> 1`, [r.valid_before]);
            await report('Dividend payouts at their own rate before the cut-off', `
                SELECT COUNT(*)::int AS n FROM dividend_distributions dd JOIN dividends d ON d.id = dd.dividend_id
                WHERE dd.exchange_rate IS NOT NULL AND d.declaration_date < $1`, [r.valid_before]);
        }

        // ---------------- 9. checks ---------------------------------------------------
        const problems = [];
        for (const r of ruleInfo) {
            const probe = async (d) => {
                const v = (await c.query(`SELECT fx_rate_on($1, $2, $3::date) AS v`, [r.base_currency_id, r.target_currency_id, d])).rows[0].v;
                return v === null ? null : parseFloat(v);
            };
            const dayBefore = (await c.query(`SELECT ($1::date - 1)::text AS d`, [r.valid_before])).rows[0].d;
            for (const d of [fixedStart, '2024-06-15', '2025-01-01', dayBefore]) {
                if (d >= r.valid_before) continue;
                const v = await probe(d);
                if (v === null || Math.abs(v - r.rate) > 1e-6) problems.push(`rate on ${d} is ${v}, expected ${r.rate}`);
            }
            const onCutoff = await probe(r.valid_before);
            console.log(`\n   Check: 1 ${r.base_code} on ${dayBefore} = ${fmt(await probe(dayBefore))} ${r.target_code};  on ${r.valid_before} = ${onCutoff === null ? 'NO RATE' : fmt(onCutoff)} ${r.target_code}`);
            if (onCutoff !== null && Math.abs(onCutoff - r.rate) < 1e-9) {
                console.log(`   Note: the rate on the cut-off day itself is also ${fmt(r.rate)} — no later rate was on file for it.`);
            }
            const wrong = (await c.query(`
                SELECT COUNT(*)::int AS n FROM transactions
                WHERE currency_id = $1 AND value_date < $2 AND functional_rate_source = 'RATE_TABLE'
                AND ABS(functional_rate - $3::numeric) > 0.000001`, [r.foreignId, r.valid_before, r.toFunctional])).rows[0].n;
            if (wrong) problems.push(`${wrong} rate-table transaction(s) before ${r.valid_before} are not at the fixed rate`);
        }
        const transfersMoved = (await c.query(`
            SELECT COUNT(*)::int AS n FROM transactions t JOIN fx_before b ON b.id = t.id
            JOIN transfers tr ON tr.id = t.transfer_id
            WHERE t.functional_rate_source = 'TRANSFER'
            AND (tr.currency_sent_id = $1 OR tr.currency_received_id = $1)
            AND b.functional_amount IS DISTINCT FROM t.functional_amount`, [F])).rows[0].n;
        if (transfersMoved) problems.push(`${transfersMoved} transfer leg(s) changed value — transfers must keep their own rate`);
        const missing = (await c.query(`
            SELECT t.id, t.value_date::text AS d, cur.code, t.amount FROM transactions t JOIN currencies cur ON cur.id = t.currency_id
            WHERE t.status = 'POSTED' AND t.functional_amount IS NULL ORDER BY t.value_date LIMIT 20`)).rows;
        if (missing.length) problems.push(`${missing.length}+ posted transaction(s) have no UGX value: ` + missing.map(m => `#${m.id} ${m.d} ${m.code} ${m.amount}`).join('; '));

        if (problems.length) {
            throw new Stop('A check failed, so nothing was saved:\n   - ' + problems.join('\n   - '));
        }
        console.log('   ✅ Every date before the cut-off uses the fixed rate; transfers unchanged; every posted transaction has a UGX value.');

        // ---------------- 10. record it ---------------------------------------------
        const summary = {
            applied_by_script: 'apply_fixed_rates_v1.76.0.js',
            fixed_rate_from: fixedStart,
            rate_rows: rateChanges,
            revaluations_reopened: runsRemoved.map(x => x.period_end),
            transactions_revalued: changed.length,
            manual_rates_kept: includeManual ? 0 : manualList.length,
            tax_records_updated: taxUpdates,
            pledge_payments_updated: pledgeUpdated,
        };
        for (const r of rules) {
            await c.query(`UPDATE fx_fixed_rate_periods SET applied_at = NOW(), applied_summary = $2 WHERE id = $1`, [r.id, JSON.stringify(summary)]);
        }
        await c.query(`
            INSERT INTO audit_log (user_id, action, module, record_type, record_id, old_values, new_values, description, status)
            VALUES ($1, 'FX_FIXED_RATE_APPLIED', 'SYSTEM', 'fx_fixed_rate_periods', $2, $3, $4, $5, 'SUCCESS')`,
            [setBy, rules[0].id,
             JSON.stringify({ rates_replaced: rateChanges.filter(x => x.action !== 'added'), revaluations_removed: runsRemoved }),
             JSON.stringify(summary),
             `Fixed exchange rate applied (${rules.map(r => `1 ${r.base_code} = ${r.rate} ${r.target_code} before ${r.valid_before}`).join('; ')}): ` +
             `${changed.length} transaction(s) re-valued, ${runsRemoved.length} revaluation month(s) reopened.`]);

        if (dryRun) {
            await c.query('ROLLBACK');
            console.log('\nDRY RUN — rolled back, nothing was saved. Run again without --dry-run to save it.');
        } else {
            await c.query('COMMIT');
            console.log('\n✅ Saved.');
            if (runsRemoved.length) console.log(`   Next: Financial Statements › FX & Revaluation › run the revaluation through ${runsRemoved[runsRemoved.length - 1].period_end} again.`);
            console.log('   Then carry on with the opening share conversion (update guide step C2).');
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
