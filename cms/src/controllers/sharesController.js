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
const { computeShareUnitsPerUser, recalculateShareholding } = require('./transactionsController');

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
        // v1.41.0 fix: the dashboard's index route is '/', not '/dashboard' —
        // this only ever "worked" by accident, via the router's catch-all
        // redirecting the unmatched path back to '/'.
        link:  `/`,
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

// ============================================================
// SHARED HELPER — build the old-vs-proposed comparison table used by
// both endpoints below, so the preview a Treasurer reviews and the
// numbers actually committed can never disagree (same pattern as
// sideFundController.computeExitPayout's shared preview/commit core).
// ============================================================
const buildRecalculatePreview = async (client) => {
    const { unitsByUser, breakdownByContribution } = await computeShareUnitsPerUser(client);
    const grandTotal = Object.values(unitsByUser).reduce((sum, u) => sum + u, 0);

    // Every active user, LEFT JOINed against their current registry row —
    // this is what lets someone who's never contributed (current = 0,
    // proposed = 0) get filtered out below, while still catching anyone
    // whose current shares_held is stale/wrong under the old raw-money
    // model even if they show 0 contributions today (e.g. a fully
    // reversed contribution).
    const usersResult = await client.query(`
        SELECT u.id,
               u.first_name || ' ' || u.last_name AS name,
               COALESCE(sr.shares_held, 0) AS current_shares_held,
               sr.percentage AS current_percentage
        FROM   users u
        LEFT JOIN shareholding_registry sr
               ON  sr.user_id = u.id AND sr.effective_to IS NULL
        WHERE  u.is_active = TRUE
    `);

    const comparison = [];
    for (const row of usersResult.rows) {
        const currentSharesHeld = parseFloat(row.current_shares_held);
        const currentPercentage = row.current_percentage !== null ? parseFloat(row.current_percentage) : 0;
        const proposedUnits = unitsByUser[row.id] || 0;
        const proposedPercentage = grandTotal > 0
            ? parseFloat(((proposedUnits / grandTotal) * 100).toFixed(4))
            : 0;

        // Skip anyone with nothing to show either way — keeps the report
        // focused on actual shareholders, current or proposed.
        if (currentSharesHeld === 0 && proposedUnits === 0) continue;

        comparison.push({
            userId:             row.id,
            name:               row.name,
            currentSharesHeld,
            currentPercentage,
            proposedSharesHeld: parseFloat(proposedUnits.toFixed(4)),
            proposedPercentage,
            delta:              parseFloat((proposedUnits - currentSharesHeld).toFixed(4)),
        });
    }

    // Largest change first — what a Treasurer actually wants to review first.
    comparison.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return { comparison, breakdownByContribution, grandTotalUnits: grandTotal };
};

// ============================================================
// PREVIEW A FULL SHAREHOLDING RECALCULATE (v1.33.0)
// GET /api/shares/recalculate-preview
// Admin only. Read-only — computes what a recalculate WOULD change
// without writing anything, so the real historical figures (or any
// future recompute) can be reviewed before they overwrite anyone's
// real shares_held/percentage.
// ============================================================
const previewRecalculate = asyncHandler(async (req, res) => {
    // withTransaction, not a plain query — computeShareUnitsPerUser runs
    // many small queries and this keeps them all on one consistent
    // snapshot of the data. Nothing here writes anything, so there is
    // nothing to roll back; the transaction commits a no-op.
    const result = await withTransaction(async (client) => buildRecalculatePreview(client));
    sendSuccess(res, result);
});

// ============================================================
// COMMIT A FULL SHAREHOLDING RECALCULATE (v1.33.0)
// POST /api/shares/recalculate
// Admin only. Actually overwrites every shareholder's shares_held/
// percentage via recalculateShareholding() — the exact same
// computation the preview above just showed, guaranteeing they can
// never disagree. Returns the same before/after comparison as the
// preview, this time reflecting what was actually written.
// ============================================================
const commitRecalculate = asyncHandler(async (req, res) => {
    const result = await withTransaction(async (client) => {
        const preview = await buildRecalculatePreview(client);
        await recalculateShareholding(client, { recordedByUserId: req.user.id });

        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'shareholding_registry',
            newValues:   { affectedMembers: preview.comparison.length },
            description: `Full shareholding recalculate committed — ${preview.comparison.length} member(s) affected`,
            client,
        });

        return preview;
    });
    sendSuccess(res, result, `Shareholding recalculated for ${result.comparison.length} member(s)`);
});

module.exports = {
    getCurrentPrice,
    setSharePrice,
    getPriceHistory,
    previewRecalculate,
    commitRecalculate,
};
