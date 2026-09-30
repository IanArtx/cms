// ============================================================
// FX REVALUATION SERVICE (v1.66.0)
//
// The month-end close for foreign currency, plus the status/repair
// tools the "FX & Revaluation" tab on the Financial Statements page
// uses. See fxService.js for the rules and glService.js for how the
// stored runs feed every statement.
//
// RUNNING A REVALUATION
// A run is done one calendar month at a time, oldest first, each in
// its own database transaction: for each month end it reads the
// ledger in UGX up to that date (including every earlier stored
// run), revalues each foreign-currency monetary balance to that
// month end's closing rate, and STORES the result with the rates
// used. A stored month never changes afterwards — that is what makes
// it "closed". If a month can't be revalued (a rate is missing, or a
// transaction in it still has no UGX value), the run stops there and
// says exactly what to enter; months already done stay done.
//
// UNDOING
// deleteRevaluationsFrom(periodEnd) removes that month's run and
// every later one (each month builds on the one before it). Used
// when something inside a closed month genuinely had to change —
// e.g. a missed transaction was back-dated into it.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const fxService = require('./fxService');
const glService = require('./glService');

const { BASIS, round2 } = fxService;

// ------------------------------------------------------------
// Month ends still to be closed, oldest first, up to `throughDate`.
// Starts the month after the last stored run, or — if nothing has
// ever been run — at the month of the very first transaction.
// ------------------------------------------------------------
const pendingMonthEnds = async (throughDate) => {
    const last = await fxService.getLastRevaluationPeriodEnd();
    let start;
    if (last) {
        start = fxService.nextMonthEnd(last);
    } else {
        const first = await query(`SELECT MIN(value_date)::text AS first FROM transactions WHERE status = 'POSTED'`);
        if (!first.rows[0].first) return [];
        start = fxService.monthEndOf(first.rows[0].first);
    }
    const end = fxService.lastMonthEndOnOrBefore(throughDate);
    const months = [];
    for (let me = start; me <= end; me = fxService.nextMonthEnd(me)) months.push(me);
    return months;
};

// ============================================================
// RUN — close every pending month end up to throughDate.
// Returns { closed: [...], stoppedAt, reason }.
// ============================================================
const runRevaluation = async ({ throughDate, userId, notes = null, ipAddress = null }) => {
    const through = fxService.toDateStr(throughDate) || fxService.todayStr();
    if (through > fxService.todayStr()) {
        throw createError.badRequest('A revaluation can only close months that have already ended.');
    }
    const months = await pendingMonthEnds(through);
    if (months.length === 0) {
        return { closed: [], stoppedAt: null, reason: 'Nothing to close — every month end up to that date is already revalued.' };
    }

    const ctx = await glService.getFunctionalContext();
    const closed = [];

    for (const monthEnd of months) {
        // Every transaction up to this month end must have a UGX value.
        const missing = await query(`
            SELECT COUNT(*)::int AS n, MIN(value_date)::text AS first_date
            FROM   transactions
            WHERE  status = 'POSTED' AND functional_amount IS NULL AND value_date <= $1
        `, [monthEnd]);
        if (missing.rows[0].n > 0) {
            return {
                closed,
                stoppedAt: monthEnd,
                reason: `${missing.rows[0].n} transaction(s) dated on or before ${monthEnd} (the first on ${missing.rows[0].first_date}) have no UGX value yet, because no exchange rate covers their date. Enter the missing rate(s) in Settings > Exchange Rates, or set a manual rate on each one, then run again.`,
            };
        }

        const { lines } = await glService.getLedgerLines({ toDate: monthEnd, basis: BASIS.FUNCTIONAL, includeProvisional: false });
        const reval = fxService.computeRevaluation({
            lines, date: monthEnd, functionalCurrencyId: ctx.functionalCurrency.id,
            monetaryGlIds: ctx.monetaryGlIds, rateOn: ctx.rateOn,
        });
        if (reval.missingCurrencyIds.length > 0) {
            const codes = reval.missingCurrencyIds.map(id => ctx.currencyCodeById.get(id) || id).join(', ');
            return {
                closed,
                stoppedAt: monthEnd,
                reason: `No ${codes} → ${ctx.functionalCurrency.code} exchange rate covers ${monthEnd}. Enter the closing rate for that month in Settings > Exchange Rates, then run again.`,
            };
        }

        const totalGain = round2(reval.adjustments.filter(a => a.adjustment > 0).reduce((s, a) => s + a.adjustment, 0));
        const totalLoss = round2(reval.adjustments.filter(a => a.adjustment < 0).reduce((s, a) => s - a.adjustment, 0));
        const ratesUsed = reval.ratesUsed.map(r => ({
            currencyId: r.currencyId, currencyCode: ctx.currencyCodeById.get(r.currencyId) || null, rate: r.rate,
        }));

        const runId = await withTransaction(async (client) => {
            const runResult = await client.query(`
                INSERT INTO fx_revaluation_runs
                    (period_end, functional_currency_id, rates_used, total_gain, total_loss, notes, run_by)
                VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
                RETURNING id
            `, [monthEnd, ctx.functionalCurrency.id, JSON.stringify(ratesUsed), totalGain, totalLoss, notes, userId]);
            const id = runResult.rows[0].id;

            for (const a of reval.adjustments) {
                await client.query(`
                    INSERT INTO fx_revaluation_lines
                        (run_id, gl_account_id, account_id, currency_id, foreign_balance,
                         closing_rate, carrying_before, revalued_balance, adjustment)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [id, a.glAccountId, a.accountId, a.currencyId, a.foreignBalance,
                    a.closingRate, a.carryingBefore, a.revaluedBalance, a.adjustment]);
            }

            await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
                ipAddress,
                recordType:  'fx_revaluation_runs',
                recordId:    id,
                newValues:   { periodEnd: monthEnd, ratesUsed, totalGain, totalLoss, lines: reval.adjustments.length },
                description: `FX revaluation closed for ${monthEnd}: gain ${totalGain}, loss ${totalLoss} (${ctx.functionalCurrency.code})`,
                client,
            });
            return id;
        });

        closed.push({ runId, periodEnd: monthEnd, totalGain, totalLoss, ratesUsed, lines: reval.adjustments.length });
    }

    return { closed, stoppedAt: null, reason: null };
};

// ============================================================
// UNDO — remove the run for periodEnd and every later one.
// ============================================================
const deleteRevaluationsFrom = async ({ periodEnd, userId, ipAddress = null }) => {
    return withTransaction(async (client) => {
        const result = await client.query(`
            DELETE FROM fx_revaluation_runs
            WHERE  period_end >= $1
            RETURNING id, period_end::text AS period_end
        `, [periodEnd]);
        if (result.rows.length === 0) {
            throw createError.notFound(`No revaluation on or after ${periodEnd} to remove.`);
        }
        const periods = result.rows.map(r => r.period_end).sort();
        await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress,
            recordType:  'fx_revaluation_runs',
            oldValues:   { periods },
            description: `FX revaluation reopened from ${periodEnd}: removed ${periods.length} closed month(s) (${periods.join(', ')})`,
            client,
        });
        return { removed: periods };
    });
};

// ============================================================
// LIST — every stored run with its lines.
// ============================================================
const listRevaluations = async () => {
    const runs = await fxService.getRevaluationRuns();
    if (runs.length === 0) return [];
    const lines = await query(`
        SELECT l.run_id, ga.code AS gl_code, ga.name AS gl_name, a.name AS account_name,
               cur.code AS currency_code, l.foreign_balance, l.closing_rate,
               l.carrying_before, l.revalued_balance, l.adjustment
        FROM   fx_revaluation_lines l
        JOIN   gl_accounts ga ON ga.id = l.gl_account_id
        JOIN   currencies cur ON cur.id = l.currency_id
        LEFT JOIN accounts a  ON a.id = l.account_id
        ORDER  BY l.run_id, ga.code, a.name
    `);
    const byRun = new Map();
    for (const l of lines.rows) {
        if (!byRun.has(l.run_id)) byRun.set(l.run_id, []);
        byRun.get(l.run_id).push({
            glCode: l.gl_code, glName: l.gl_name, accountName: l.account_name, currencyCode: l.currency_code,
            foreignBalance: parseFloat(l.foreign_balance), closingRate: parseFloat(l.closing_rate),
            carryingBefore: parseFloat(l.carrying_before), revaluedBalance: parseFloat(l.revalued_balance),
            adjustment: parseFloat(l.adjustment),
        });
    }
    return runs.reverse().map(r => ({
        id: r.id, periodEnd: r.period_end, ratesUsed: r.rates_used,
        totalGain: parseFloat(r.total_gain), totalLoss: parseFloat(r.total_loss),
        notes: r.notes, runAt: r.run_at, runByName: r.run_by_name,
        lines: byRun.get(r.id) || [],
    }));
};

// ============================================================
// STATUS — everything the FX & Revaluation tab shows at a glance.
// ============================================================
const getStatus = async () => {
    const settings = await fxService.getAccountingSettings();
    const lastPeriodEnd = await fxService.getLastRevaluationPeriodEnd();
    const today = fxService.todayStr();
    const pending = settings.functionalCurrency ? await pendingMonthEnds(today) : [];

    const unconverted = await query(`
        SELECT t.id, t.value_date::text AS value_date, t.amount, t.description, t.inflow_type,
               cur.code AS currency_code, r.reference_code, a.name AS account_name
        FROM   transactions t
        JOIN   currencies cur ON cur.id = t.currency_id
        JOIN   accounts a     ON a.id = t.account_id
        LEFT JOIN references_registry r ON r.id = t.reference_id
        WHERE  t.status = 'POSTED' AND t.functional_amount IS NULL
        ORDER  BY t.value_date ASC, t.id ASC
        LIMIT  200
    `);
    const unconvertedCount = await query(`
        SELECT COUNT(*)::int AS n FROM transactions WHERE status = 'POSTED' AND functional_amount IS NULL
    `);

    // Foreign-currency transactions posted AFTER the month they belong
    // to was closed — that month's revaluation didn't include them, so
    // it should be reopened and re-run from that month.
    const stale = await query(`
        SELECT t.id, t.value_date::text AS value_date, cur.code AS currency_code, t.amount,
               rr.period_end::text AS closed_period_end
        FROM   transactions t
        JOIN   currencies cur ON cur.id = t.currency_id
        JOIN   LATERAL (
                   SELECT period_end, run_at FROM fx_revaluation_runs r
                   WHERE  r.period_end >= t.value_date
                   ORDER  BY r.period_end ASC LIMIT 1
               ) rr ON TRUE
        WHERE  t.status = 'POSTED'
        AND    t.currency_id IS DISTINCT FROM $1
        AND    COALESCE(t.posted_at, t.transaction_date) > rr.run_at
        ORDER  BY t.value_date ASC
        LIMIT  50
    `, [settings.functionalCurrency ? settings.functionalCurrency.id : null]);

    const sources = await query(`
        SELECT COALESCE(functional_rate_source, 'MISSING') AS source, COUNT(*)::int AS n
        FROM   transactions WHERE status = 'POSTED'
        GROUP  BY 1 ORDER BY 1
    `);

    const currentRates = await query(`
        SELECT bc.code AS base, tc.code AS target, cer.rate, cer.effective_from::text AS effective_from
        FROM   currency_exchange_rates cer
        JOIN   currencies bc ON bc.id = cer.base_currency_id
        JOIN   currencies tc ON tc.id = cer.target_currency_id
        WHERE  cer.effective_to IS NULL
        ORDER  BY bc.code, tc.code
    `);

    return {
        functionalCurrency: settings.functionalCurrency,
        presentationCurrency: settings.presentationCurrency,
        fiscalYearStartMonth: settings.fiscalYearStartMonth,
        currentFiscalYearStart: fxService.fiscalYearStartFor(today, settings.fiscalYearStartMonth),
        lastRevaluedPeriodEnd: lastPeriodEnd,
        pendingMonthEnds: pending,
        unconvertedCount: unconvertedCount.rows[0].n,
        unconverted: unconverted.rows.map(r => ({
            id: r.id, date: r.value_date, amount: parseFloat(r.amount), currencyCode: r.currency_code,
            description: r.description, inflowType: r.inflow_type, referenceCode: r.reference_code,
            accountName: r.account_name,
        })),
        staleAfterClose: stale.rows.map(r => ({
            id: r.id, date: r.value_date, currencyCode: r.currency_code, amount: parseFloat(r.amount),
            closedPeriodEnd: r.closed_period_end,
        })),
        valuationSources: sources.rows,
        currentRates: currentRates.rows.map(r => ({ ...r, rate: parseFloat(r.rate) })),
    };
};

// ============================================================
// MANUAL RATE — a System Admin fixes the UGX value of one
// transaction to a specific rate (e.g. the rate on the bank's own
// proof of transfer). Not allowed inside a closed month: reopen the
// month first, so the revaluation is redone with the new value.
// ============================================================
const assertNotInClosedMonth = async (valueDate) => {
    const last = await fxService.getLastRevaluationPeriodEnd();
    if (last && valueDate <= last) {
        throw createError.badRequest(
            `This transaction (dated ${valueDate}) falls inside a month that has already been revalued and closed (through ${last}). ` +
            `Reopen the revaluation from ${fxService.monthEndOf(valueDate)} first (FX & Revaluation tab), then change the rate and run the revaluation again.`
        );
    }
};

const setManualRate = async ({ transactionId, rate, note, userId, ipAddress = null }) => {
    const settings = await fxService.getAccountingSettings();
    const txResult = await query(`
        SELECT id, value_date::text AS value_date, currency_id, amount, functional_rate, functional_rate_source, status
        FROM   transactions WHERE id = $1
    `, [transactionId]);
    const tx = txResult.rows[0];
    if (!tx) throw createError.notFound('Transaction not found');
    if (settings.functionalCurrency && tx.currency_id === settings.functionalCurrency.id) {
        throw createError.badRequest('This transaction is already in the functional currency — it has no exchange rate to set.');
    }
    await assertNotInClosedMonth(tx.value_date);

    // v1.76.0 — a fixed-rate company decision covers this date: the
    // transaction is valued at that rate, not a rate of its own.
    if (settings.functionalCurrency) {
        const fixedRule = await fxService.fixedRateRuleFor(tx.currency_id, settings.functionalCurrency.id, tx.value_date);
        if (fixedRule && !fxService.matchesFixedRule(fixedRule, tx.currency_id, rate)) {
            throw createError.badRequest(
                `This transaction is dated ${tx.value_date}, where the rate is fixed by company decision ` +
                `(${fxService.describeFixedRule(fixedRule)}). It can't be given a different rate.`
            );
        }
    }

    return withTransaction(async (client) => {
        const updated = await client.query(`
            UPDATE transactions
            SET    functional_rate = $1, functional_rate_source = 'MANUAL',
                   functional_rate_note = $2, functional_set_by = $3, functional_set_at = NOW()
            WHERE  id = $4
            RETURNING id, functional_amount, functional_rate, functional_rate_source
        `, [rate, note, userId, transactionId]);
        await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress,
            recordType:  'transactions',
            recordId:    transactionId,
            oldValues:   { functionalRate: tx.functional_rate, source: tx.functional_rate_source },
            newValues:   { functionalRate: rate, source: 'MANUAL', note },
            description: `Manual exchange rate ${rate} set on transaction #${transactionId}: ${note}`,
            client,
        });
        return updated.rows[0];
    });
};

const clearManualRate = async ({ transactionId, userId, ipAddress = null }) => {
    const txResult = await query(`
        SELECT id, value_date::text AS value_date, functional_rate, functional_rate_source
        FROM   transactions WHERE id = $1
    `, [transactionId]);
    const tx = txResult.rows[0];
    if (!tx) throw createError.notFound('Transaction not found');
    if (tx.functional_rate_source !== 'MANUAL') {
        throw createError.badRequest('This transaction has no manual rate to remove.');
    }
    await assertNotInClosedMonth(tx.value_date);

    return withTransaction(async (client) => {
        // Clearing both columns lets the trigger work the rate out again
        // from the transfer / rate table, exactly as for a new posting.
        const updated = await client.query(`
            UPDATE transactions
            SET    functional_rate = NULL, functional_rate_source = NULL
            WHERE  id = $1
            RETURNING id, functional_amount, functional_rate, functional_rate_source
        `, [transactionId]);
        await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress,
            recordType:  'transactions',
            recordId:    transactionId,
            oldValues:   { functionalRate: tx.functional_rate, source: 'MANUAL' },
            newValues:   updated.rows[0],
            description: `Manual exchange rate removed from transaction #${transactionId}`,
            client,
        });
        return updated.rows[0];
    });
};

module.exports = {
    runRevaluation,
    deleteRevaluationsFrom,
    listRevaluations,
    getStatus,
    setManualRate,
    clearManualRate,
};
