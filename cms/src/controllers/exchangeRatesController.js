// ============================================================
// CURRENCY EXCHANGE RATES CONTROLLER
// Company-set exchange rates, one history per currency pair
// (base -> target), each row covering effective_from up to (but not
// including) effective_to — the same pattern as share_price_history.
//
// v1.66.0 — THESE RATES NOW DRIVE THE BOOKS. They were originally
// display-only (showing the share price in other currencies). Since
// v1.66.0 they are also the rates the financial statements use to
// value every foreign-currency transaction in UGX (except transfers,
// which use their own actual rate) and to revalue foreign-currency
// balances at each month end. So:
//   - Enter the Bank of Uganda rate for each month (at least one row
//     per month, effective the 1st), or more often if you want.
//   - A rate can now be entered for a PAST date and it slots into
//     the history correctly (it used to always be treated as "the
//     newest rate", which scrambled the history if entered out of
//     order). Two rates for the same pair can't start on the same day.
//   - Saving a rate immediately re-values the affected transactions
//     (see fxService.recomputeFunctionalAmounts): any transaction
//     still missing a UGX value, and any transaction on/after the
//     rate's date that is NOT inside a month already revalued and
//     closed. Closed months keep their values — that's what makes
//     them final.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const fxService = require('../services/fxService');

// ============================================================
// GET CURRENT EXCHANGE RATES
// GET /api/exchange-rates/current
// Any authenticated user. Returns every currently-active rate,
// each showing the base currency it was entered against and the
// target currency it converts to.
// ============================================================
const getCurrentRates = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT cer.id, cer.rate, cer.effective_from, cer.notes,
               bc.id AS base_currency_id, bc.code AS base_currency_code,
               tc.id AS target_currency_id, tc.code AS target_currency_code, tc.symbol AS target_currency_symbol,
               u.first_name || ' ' || u.last_name AS set_by_name
        FROM   currency_exchange_rates cer
        JOIN   currencies bc ON bc.id = cer.base_currency_id
        JOIN   currencies tc ON tc.id = cer.target_currency_id
        JOIN   users u       ON u.id = cer.set_by
        WHERE  cer.effective_to IS NULL
        ORDER  BY bc.code, tc.code
    `);

    sendSuccess(res, result.rows);
});

// ============================================================
// SET AN EXCHANGE RATE (current or historical)
// POST /api/exchange-rates
// Treasurer / Assistant Treasurer / Admin only. The new rate is
// slotted into this pair's history at effective_from: the rate that
// was covering that date now ends there, and the new rate runs until
// the next later rate starts (or stays open-ended if it's the newest).
// ============================================================
const setExchangeRate = asyncHandler(async (req, res) => {
    const { base_currency_id, target_currency_id, rate, effective_from, notes } = req.body;

    if (!base_currency_id || !target_currency_id) {
        throw createError.badRequest('base_currency_id and target_currency_id are required');
    }
    if (parseInt(base_currency_id) === parseInt(target_currency_id)) {
        throw createError.badRequest('base_currency_id and target_currency_id must be different currencies');
    }
    if (!rate || parseFloat(rate) <= 0) {
        throw createError.badRequest('rate must be a positive number');
    }
    const effectiveDate = effective_from ? String(effective_from).slice(0, 10) : fxService.todayStr();

    const newRate = await withTransaction(async (client) => {
        const duplicate = await client.query(`
            SELECT id, rate FROM currency_exchange_rates
            WHERE  base_currency_id = $1 AND target_currency_id = $2 AND effective_from = $3
        `, [base_currency_id, target_currency_id, effectiveDate]);
        if (duplicate.rows.length > 0) {
            throw createError.conflict(
                `A rate for this currency pair already starts on ${effectiveDate} (${duplicate.rows[0].rate}). ` +
                `Pick a different start date — rates already used by the books are never overwritten.`
            );
        }

        // The rate that was covering effectiveDate now stops there.
        await client.query(`
            UPDATE currency_exchange_rates
            SET    effective_to = $1
            WHERE  base_currency_id = $2 AND target_currency_id = $3
            AND    effective_from < $1
            AND    (effective_to IS NULL OR effective_to > $1)
        `, [effectiveDate, base_currency_id, target_currency_id]);

        // The new rate runs until the next later rate starts, if any.
        const next = await client.query(`
            SELECT MIN(effective_from)::text AS next_from FROM currency_exchange_rates
            WHERE  base_currency_id = $1 AND target_currency_id = $2 AND effective_from > $3
        `, [base_currency_id, target_currency_id, effectiveDate]);
        const effectiveTo = next.rows[0].next_from || null;

        const result = await client.query(`
            INSERT INTO currency_exchange_rates
                (base_currency_id, target_currency_id, rate, effective_from, effective_to, set_by, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, base_currency_id, target_currency_id, rate,
                      effective_from::text AS effective_from, effective_to::text AS effective_to, notes
        `, [base_currency_id, target_currency_id, rate, effectiveDate, effectiveTo, req.user.id, notes || null]);

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'currency_exchange_rates',
            recordId:    result.rows[0].id,
            newValues:   result.rows[0],
            description: `Exchange rate set to ${rate} effective ${effectiveDate}${effectiveTo ? ` until ${effectiveTo}` : ''}`,
            client,
        });

        // v1.66.0 — re-value the transactions this rate affects.
        const fx = await fxService.recomputeFunctionalAmounts(client, { fromDate: effectiveDate });

        return { ...result.rows[0], fx };
    });

    let message = `Exchange rate set to ${rate}, effective ${effectiveDate}`;
    if (newRate.effective_to) message += ` until ${newRate.effective_to}`;
    message += `. ${newRate.fx.recalculated} transaction(s) re-valued in UGX`;
    if (newRate.fx.keptInClosedMonths > 0) {
        message += `; ${newRate.fx.keptInClosedMonths} transaction(s) in months already closed (through ${newRate.fx.lastRevaluedPeriodEnd}) kept their existing values`;
    }
    if (newRate.fx.stillMissing > 0) message += `; ${newRate.fx.stillMissing} transaction(s) still have no rate`;
    sendCreated(res, newRate, message + '.');
});

// ============================================================
// GET EXCHANGE RATE HISTORY
// GET /api/exchange-rates/history
// ============================================================
const getRateHistory = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);

    const countResult = await query('SELECT COUNT(*) AS total FROM currency_exchange_rates');
    const total = parseInt(countResult.rows[0].total);

    const result = await query(`
        SELECT cer.id, cer.rate, cer.effective_from, cer.effective_to,
               cer.notes, cer.created_at,
               bc.code AS base_currency_code,
               tc.code AS target_currency_code,
               u.first_name || ' ' || u.last_name AS set_by_name
        FROM   currency_exchange_rates cer
        JOIN   currencies bc ON bc.id = cer.base_currency_id
        JOIN   currencies tc ON tc.id = cer.target_currency_id
        JOIN   users u       ON u.id = cer.set_by
        ORDER  BY cer.effective_from DESC
        LIMIT  $1 OFFSET $2
    `, [limit, offset]);

    sendPaginated(res, result.rows, total, page, limit);
});

module.exports = {
    getCurrentRates,
    setExchangeRate,
    getRateHistory,
};
