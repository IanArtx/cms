// ============================================================
// EVENTS ROUTES
// Prefix: /api/events
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View events: all authenticated members
//   - Create events: Secretary, Assistant Secretary, Directors
//   - Approve events: Directors, Admin
//   - Cancel events: Secretary, Directors
// ============================================================

const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockAuditor, requirePermissions, requireAnyPermission } = require('../middleware/auth');
const eventsController = require('../controllers/eventsController');

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
// Events aren't finance data — an Administrative Officer legitimately
// manages meetings/minutes here (Section 4.29), so only the Auditor
// (fully external, scoped to /api/audit only) is blocked from this
// file. Everyone else's access is governed by EVENT_* permissions below.
router.use(blockAuditor);

// ============================================================
// SPECIAL ROUTES — must come before /:id
// ============================================================

// Get upcoming events — used by dashboard
router.get('/upcoming',
    eventsController.getUpcomingEvents
);

// Get all event types
router.get('/types',
    eventsController.getEventTypes
);

// ============================================================
// GET ALL EVENTS
// GET /api/events?status=APPROVED&from_date=2026-01-01
// ============================================================
router.get('/',
    requirePermissions(['EVENT_VIEW']),
    [
        query('from_date').optional().isISO8601().withMessage('Invalid from date'),
        query('to_date').optional().isISO8601().withMessage('Invalid to date'),
        query('event_type_id').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    eventsController.getAllEvents
);

// ============================================================
// CREATE EVENT
// POST /api/events
// ============================================================
router.post('/',
    requirePermissions(['EVENT_CREATE']),
    [
        body('event_type_id')
            .isInt({ min: 1 }).withMessage('A valid event type is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('title')
            .trim().notEmpty().withMessage('Event title is required'),
        body('event_date')
            .isISO8601().withMessage('A valid event date is required'),
        body('end_date')
            .optional().isISO8601().withMessage('Invalid end date'),
        body('location')
            .optional().trim(),
        body('description')
            .optional().trim(),
        body('recurrence')
            .optional()
            .isIn(['NONE','DAILY','WEEKLY','MONTHLY','ANNUALLY'])
            .withMessage('Invalid recurrence value'),
        body('notifications')
            .optional().isArray(),
        body('notifications.*.user_id')
            .optional().isInt({ min: 1 }),
        body('notifications.*.role_id')
            .optional().isInt({ min: 1 }),
        body('notifications.*.email_override')
            .optional().isEmail().withMessage('Invalid email in notifications'),
        body('notifications.*.notification_type')
            .optional()
            .isIn(['EMAIL','IN_APP','BOTH'])
            .withMessage('Invalid notification type'),
    ],
    validateRequest,
    eventsController.createEvent
);

// ============================================================
// GET SINGLE EVENT
// GET /api/events/:id
// ============================================================
router.get('/:id',
    requirePermissions(['EVENT_VIEW']),
    validators.idParam('id'),
    validateRequest,
    eventsController.getEventById
);

// ============================================================
// EDIT EVENT (before approval)
// PATCH /api/events/:id
// ============================================================
router.patch('/:id',
    requireAnyPermission(['EVENT_CREATE', 'EVENT_APPROVE']),
    validators.idParam('id'),
    [
        body('event_type_id').optional().isInt({ min: 1 }),
        body('category_id').optional().isInt({ min: 1 }),
        body('title').optional().trim().notEmpty(),
        body('event_date').optional().isISO8601(),
        body('end_date').optional().isISO8601(),
        body('recurrence').optional().isIn(['NONE','DAILY','WEEKLY','MONTHLY','ANNUALLY']),
    ],
    validateRequest,
    eventsController.editEvent
);

// ============================================================
// APPROVE EVENT
// POST /api/events/:id/approve
// ============================================================
router.post('/:id/approve',
    requirePermissions(['EVENT_APPROVE']),
    validators.idParam('id'),
    validateRequest,
    eventsController.approveEvent
);

// ============================================================
// CANCEL EVENT
// POST /api/events/:id/cancel
// ============================================================
router.post('/:id/cancel',
    requirePermissions(['EVENT_MANAGE']),
    validators.idParam('id'),
    [
        body('reason')
            .trim().notEmpty().withMessage('A reason for cancellation is required'),
    ],
    validateRequest,
    eventsController.cancelEvent
);

// ============================================================
// EXTEND EVENT (v1.28.3)
// PATCH /api/events/:id/extend
// Pushes event_date and/or end_date of an already-approved event
// further out — dates can only move later, never earlier.
// ============================================================
router.patch('/:id/extend',
    requirePermissions(['EVENT_MANAGE']),
    validators.idParam('id'),
    [
        body('event_date').optional().isISO8601().withMessage('Invalid event date'),
        body('end_date').optional().isISO8601().withMessage('Invalid end date'),
        body('reason').optional().trim(),
    ],
    validateRequest,
    eventsController.extendEvent
);

// ============================================================
// MARK EVENT AS COMPLETED (v1.28.3)
// POST /api/events/:id/complete
// ============================================================
router.post('/:id/complete',
    requirePermissions(['EVENT_MANAGE']),
    validators.idParam('id'),
    validateRequest,
    eventsController.completeEvent
);

module.exports = router;