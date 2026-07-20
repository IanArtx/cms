// ============================================================
// NOTIFICATIONS ROUTES
// Prefix: /api/notifications
// Always scoped to the logged-in user — no permission checks
// needed beyond being authenticated.
// ============================================================

const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { validators } = require('../middleware/validate');
const notificationsController = require('../controllers/notificationsController');

router.use(authenticate);

router.get('/', notificationsController.getMyNotifications);
router.get('/unread-count', notificationsController.getUnreadCount);
router.patch('/read-all', notificationsController.markAllAsRead);
router.patch('/:id/read', validators.idParam('id'), notificationsController.markAsRead);

module.exports = router;
