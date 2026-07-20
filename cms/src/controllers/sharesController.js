// ============================================================
// SHARES CONTROLLER
// Company-wide price-per-share, with full history. A single
// "current" price is always in effect (effective_to IS NULL) —
// Treasurer/Admin can set a new price with an effective date,
// which automatically closes out the previous current price.
// Used across the app (shareholder dashboards, general reports)
// to value each shareholder's holding as shares_held × price.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');

// ============================================================
// GET CURRENT SHARE PRICE
// GET /api/shares/price
// Any authenticated user — needed to render "your shares are
// worth X" on every shareholder's own dashboard.
// ============================================================
const getCurrentPrice = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT sph.id, sph.price_per_share, sph.effective_from, sph.notes,
               c.code AS currency_code, c.symbol AS currency_symbol,
               u.first_name || ' ' || u.last_name AS set_by_name
        FROM   share_price_history sph
        JOIN   currencies c ON c.id = sph.currency_id
        JOIN   users u      ON u.id = sph.set_by
        WHERE  sph.effective_to IS NULL
        ORDER  BY sph.effective_from DESC
        LIMIT  1
    `);

    if (result.rows.length === 0) {
        return sendSuccess(res, null, 'No share price has been set yet');
    }

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// SET NEW SHARE PRICE
// POST /api/shares/price
// Treasurer / Admin only. Closes out the previous current price
// (effective_to = new effective_from) and inserts the new one.
// Every shareholder gets notified — this changes what their
// holding is worth.
// ============================================================
const setSharePrice = asyncHandler(async (req, res) => {
    const { price_per_share, currency_id, effective_from, notes } = req.body;

    if (!price_per_share || parseFloat(price_per_share) <= 0) {
        throw createError.badRequest('price_per_share must be a positive number');
    }
    if (!currency_id) {
        throw createError.badRequest('currency_id is required');
    }
    const effectiveDate = effective_from || new Date().toISOString().split('T')[0];

    const newPrice = await withTransaction(async (client) => {
        // Close out whatever is currently active
        await client.query(`
            UPDATE share_price_history
            SET    effective_to = $1
            WHERE  effective_to IS NULL
        `, [effectiveDate]);

        const result = await client.query(`
            INSERT INTO share_price_history
                (price_per_share, currency_id, effective_from, set_by, notes)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, price_per_share, effective_from, notes
        `, [price_per_share, currency_id, effectiveDate, req.user.id, notes || null]);

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'share_price_history',
            recordId:    result.rows[0].id,
            newValues:   result.rows[0],
            description: `Share price updated to ${price_per_share} effective ${effectiveDate}`,
            client,
        });

        return result.rows[0];
    });

    // Notify every active shareholder that their holding's value
    // has changed — best-effort, outside the transaction.
    const shareholders = await query(`
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name, sr.shares_held
        FROM   shareholding_registry sr
        JOIN   users u ON u.id = sr.user_id AND u.is_active = TRUE
        WHERE  sr.effective_to IS NULL
        AND    sr.shares_held > 0
    `);

    const emailShell = await wrapEmail(`
        <p>{{GREETING}}</p>
        <p>The company share price has been updated:</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
            <tr><td style="padding:4px 0; color:#6b7280;">New price per share</td><td style="padding:4px 0; text-align:right; font-weight:700;">${price_per_share}</td></tr>
            <tr><td style="padding:4px 0; color:#6b7280;">Effective from</td><td style="padding:4px 0; text-align:right;">${effectiveDate}</td></tr>
        </table>
        {{HOLDING}}
    `, { preheader: 'The share price has been updated' });

    notifyMany(shareholders.rows, 'SHARE_PRICE_UPDATED', (holder) => ({
        title: 'Share price updated',
        body:  `The price per share is now ${price_per_share}, effective ${effectiveDate}.`,
        link:  `/dashboard`,
        module: 'SYSTEM',
        recordType: 'share_price_history',
        recordId:   newPrice.id,
        email: {
            subject: `Share price updated — ${price_per_share} per share`,
            html: emailShell
                .replace('{{GREETING}}', `Dear ${holder.first_name},`)
                .replace('{{HOLDING}}', holder.shares_held
                    ? `<p>Your holding of <strong>${holder.shares_held}</strong> shares is now worth approximately <strong>${(parseFloat(holder.shares_held) * parseFloat(price_per_share)).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>.</p>`
                    : ''),
        },
    }));

    sendCreated(res, newPrice, `Share price set to ${price_per_share}, effective ${effectiveDate}`);
});

// ============================================================
// GET SHARE PRICE HISTORY
// GET /api/shares/price/history
// ============================================================
const getPriceHistory = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);

    const countResult = await query('SELECT COUNT(*) AS total FROM share_price_history');
    const total = parseInt(countResult.rows[0].total);

    const result = await query(`
        SELECT sph.id, sph.price_per_share, sph.effective_from, sph.effective_to,
               sph.notes, sph.created_at,
               c.code AS currency_code, c.symbol AS currency_symbol,
               u.first_name || ' ' || u.last_name AS set_by_name
        FROM   share_price_history sph
        JOIN   currencies c ON c.id = sph.currency_id
        JOIN   users u      ON u.id = sph.set_by
        ORDER  BY sph.effective_from DESC
        LIMIT  $1 OFFSET $2
    `, [limit, offset]);

    sendPaginated(res, result.rows, total, page, limit);
});

module.exports = {
    getCurrentPrice,
    setSharePrice,
    getPriceHistory,
};
