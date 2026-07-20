// ============================================================
// NOTIFICATIONS CONTROLLER
// The "bell" — every user's own in-app activity feed. Always
// scoped to req.user.id; there is no cross-user notification
// browsing here (that's what the audit log is for).
// ============================================================

const { query } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, getPagination } = require('../utils/response');

// ============================================================
// GET MY NOTIFICATIONS
// GET /api/notifications?unread_only=true
// ============================================================
const getMyNotifications = asyncHandler(async (req, res) => {
    const { unread_only } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = ['user_id = $1'];
    const params = [req.user.id];

    if (unread_only === 'true') {
        conditions.push('is_read = FALSE');
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM notifications ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(`
        SELECT id, type, title, body, link, related_module,
               related_record_type, related_record_id,
               is_read, read_at, created_at
        FROM   notifications
        ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    sendSuccess(res, {
        notifications: result.rows,
        total,
        page,
        limit,
    });
});

// ============================================================
// GET UNREAD COUNT
// GET /api/notifications/unread-count
// Polled frequently by the bell icon — deliberately lightweight.
// ============================================================
const getUnreadCount = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT COUNT(*) AS count
        FROM   notifications
        WHERE  user_id = $1 AND is_read = FALSE
    `, [req.user.id]);

    sendSuccess(res, { count: parseInt(result.rows[0].count) });
});

// ============================================================
// MARK ONE AS READ
// PATCH /api/notifications/:id/read
// ============================================================
const markAsRead = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE notifications
        SET    is_read = TRUE,
               read_at = NOW()
        WHERE  id = $1 AND user_id = $2
        RETURNING id
    `, [id, req.user.id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Notification not found');
    }

    sendSuccess(res, null, 'Marked as read');
});

// ============================================================
// MARK ALL AS READ
// PATCH /api/notifications/read-all
// ============================================================
const markAllAsRead = asyncHandler(async (req, res) => {
    await query(`
        UPDATE notifications
        SET    is_read = TRUE,
               read_at = NOW()
        WHERE  user_id = $1 AND is_read = FALSE
    `, [req.user.id]);

    sendSuccess(res, null, 'All notifications marked as read');
});

module.exports = {
    getMyNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
};
