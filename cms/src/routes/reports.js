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
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions } = require('../middleware/auth');
const reportsController = require('../controllers/reportsController');

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

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
// GET CHART OF ACCOUNTS
// GET /api/reports/chart-of-accounts
// A live, as-of-right-now snapshot of every money pool — gated by
// FINANCE_VIEW_ALL (not REPORT_VIEW_ALL) since it's a live balance
// snapshot, not a generated/archived report.
// ============================================================
router.get('/chart-of-accounts',
    requirePermissions(['FINANCE_VIEW_ALL']),
    reportsController.getChartOfAccounts
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

// ============================================================
// GENERAL LEDGER SUITE (v1.55.0)
// Prefix stays /api/reports — "GL Accounts" deliberately, not
// "chart-of-accounts", which the older /chart-of-accounts route
// above already uses for a different, unrelated snapshot report.
// ============================================================

// GET /api/reports/gl-accounts — the chart of accounts + every
// inflow_type's current classification. Gated SYSTEM_CONFIG (an
// accounting-policy setting, not a day-to-day finance report).
router.get('/gl-accounts',
    requirePermissions(['SYSTEM_CONFIG']),
    reportsController.getGLAccounts
);

// PATCH /api/reports/gl-accounts/mapping/:inflowType — reclassify
// one inflow_type to a different GL account.
router.patch('/gl-accounts/mapping/:inflowType',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        param('inflowType').trim().notEmpty(),
        body('gl_account_id').isInt({ min: 1 }).withMessage('A valid GL account is required'),
        body('notes').optional({ checkFalsy: true }).isString(),
    ],
    validateRequest,
    reportsController.updateGLAccountMapping
);

// GET /api/reports/trial-balance?account_id=&as_of_date=
router.get('/trial-balance',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('as_of_date').optional().isISO8601().withMessage('Invalid date'),
    ],
    validateRequest,
    reportsController.getTrialBalance
);

// GET /api/reports/general-ledger?gl_account_id=&account_id=&from_date=&to_date=
router.get('/general-ledger',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('gl_account_id').optional().isInt({ min: 1 }),
        query('account_id').optional().isInt({ min: 1 }),
        query('from_date').optional().isISO8601().withMessage('Invalid from date'),
        query('to_date').optional().isISO8601().withMessage('Invalid to date'),
    ],
    validateRequest,
    reportsController.getGeneralLedger
);

// GET /api/reports/balance-sheet?account_id=&as_of_date=
router.get('/balance-sheet',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('as_of_date').optional().isISO8601().withMessage('Invalid date'),
    ],
    validateRequest,
    reportsController.getBalanceSheet
);

// GET /api/reports/income-statement?account_id=&from_date=&to_date=
router.get('/income-statement',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('from_date').optional().isISO8601().withMessage('Invalid from date'),
        query('to_date').optional().isISO8601().withMessage('Invalid to date'),
    ],
    validateRequest,
    reportsController.getIncomeStatement
);

// GET /api/reports/cash-flow-statement?account_id=&from_date=&to_date=
router.get('/cash-flow-statement',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('from_date').optional().isISO8601().withMessage('Invalid from date'),
        query('to_date').optional().isISO8601().withMessage('Invalid to date'),
    ],
    validateRequest,
    reportsController.getCashFlowStatement
);

module.exports = router;