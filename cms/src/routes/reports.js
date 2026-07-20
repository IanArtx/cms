// ============================================================
// REPORTS ROUTES
// Prefix: /api/reports
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - Own report: any authenticated member
//   - Individual reports: Admin, Treasurer
//   - General report: Treasurer, Directors, Admin
//   - Send monthly reports: Admin only
//   - Audit log: Admin only
// ============================================================

const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requirePermissions } = require('../middleware/auth');
const reportsController = require('../controllers/reportsController');

// All routes require login
router.use(authenticate);

// ============================================================
// GET OWN PERSONAL REPORT
// GET /api/reports/me?year=2026&month=6
// Any authenticated member
// ============================================================
router.get('/me',
    reportsController.getMyReport
);

// ============================================================
// GET REPORT LOG
// GET /api/reports/log
// ============================================================
router.get('/log',
    requirePermissions(['REPORT_VIEW_ALL']),
    reportsController.getReportLog
);

// ============================================================
// GET AUDIT LOG
// GET /api/reports/audit
// Admin only
// ============================================================
router.get('/audit',
    requirePermissions(['AUDIT_VIEW']),
    [
        query('from_date').optional().isISO8601().withMessage('Invalid from date'),
        query('to_date').optional().isISO8601().withMessage('Invalid to date'),
    ],
    validateRequest,
    reportsController.getAuditLog
);

// ============================================================
// GET GENERAL COMPANY REPORT
// GET /api/reports/general?year=2026&month=6
// ============================================================
router.get('/general',
    requirePermissions(['REPORT_VIEW_ALL']),
    [
        query('year').optional().isInt({ min: 2020, max: 2100 }),
        query('month').optional().isInt({ min: 1, max: 12 }),
    ],
    validateRequest,
    reportsController.getGeneralReport
);

// ============================================================
// GET INDIVIDUAL MEMBER REPORT
// GET /api/reports/individual/:userId?year=2026&month=6
// ============================================================
router.get('/individual/:userId',
    requirePermissions(['REPORT_VIEW_ALL']),
    validators.idParam('userId'),
    [
        query('year').optional().isInt({ min: 2020, max: 2100 }),
        query('month').optional().isInt({ min: 1, max: 12 }),
    ],
    validateRequest,
    reportsController.getIndividualReport
);

// ============================================================
// SEND MONTHLY REPORTS MANUALLY
// POST /api/reports/send-monthly
// Admin only
// ============================================================
router.post('/send-monthly',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        body('year')
            .optional().isInt({ min: 2020, max: 2100 }),
        body('month')
            .optional().isInt({ min: 1, max: 12 }),
    ],
    validateRequest,
    reportsController.sendMonthlyReports
);

// ============================================================
// SEND GENERAL ANNOUNCEMENT BROADCAST
// POST /api/reports/broadcast
// Admin only — the "central email" for general meeting notices
// and ad-hoc company-wide announcements to every active member.
// ============================================================
router.post('/broadcast',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        body('subject').trim().notEmpty().withMessage('Subject is required'),
        body('message').trim().notEmpty().withMessage('Message is required'),
        body('link').optional({ checkFalsy: true }).isString(),
    ],
    validateRequest,
    reportsController.sendBroadcastAnnouncement
);

module.exports = router;