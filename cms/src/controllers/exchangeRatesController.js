// ============================================================
// CURRENCY EXCHANGE RATES CONTROLLER
// Monthly, company-set exchange rates used ONLY to DISPLAY the
// share price/value in currencies other than the one it was set
// in — they do not change how any contribution, transaction, or
// shareholding is actually recorded or calculated.
//
// Each currency pair (base -> target) has its own effective_from/
// effective_to history, the same pattern as share_price_history:
// setting a new rate for a pair closes out the previous current
// rate for that same pair (other pairs are untouched).
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');

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
// SET / UPDATE A MONTHLY EXCHANGE RATE
// POST /api/exchange-rates
// Treasurer / Assistant Treasurer / Admin only. Closes out the
// previous current rate for this exact base->target pair (if any)
// and inserts the new one.
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
    const effectiveDate = effective_from || new Date().toISOString().split('T')[0];

    const newRate = await withTransaction(async (client) => {
        // Close out whatever is currently active for this specific pair only
        await client.query(`
            UPDATE currency_exchange_rates
            SET    effective_to = $1
            WHERE  base_currency_id = $2 AND target_currency_id = $3
            AND    effective_to IS NULL
        `, [effectiveDate, base_currency_id, target_currency_id]);

        const result = await client.query(`
            INSERT INTO currency_exchange_rates
                (base_currency_id, target_currency_id, rate, effective_from, set_by, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, base_currency_id, target_currency_id, rate, effective_from, notes
        `, [base_currency_id, target_currency_id, rate, effectiveDate, req.user.id, notes || null]);

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'currency_exchange_rates',
            recordId:    result.rows[0].id,
            newValues:   result.rows[0],
            description: `Exchange rate updated to ${rate} effective ${effectiveDate}`,
            client,
        });

        return result.rows[0];
    });

    sendCreated(res, newRate, `Exchange rate set to ${rate}, effective ${effectiveDate}`);
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
