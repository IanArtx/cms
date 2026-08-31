// ============================================================
// CAPITAL GOALS ROUTES
// Prefix: /api/capital-goals
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View goals + progress: CAPITAL_GOAL_VIEW
//   - Create/edit/cancel/complete: CAPITAL_GOAL_MANAGE
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions } = require('../middleware/auth');
const capitalGoalsController = require('../controllers/capitalGoalsController');
const capitalGoalCallsController = require('../controllers/capitalGoalCallsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET ALL CAPITAL GOALS
// GET /api/capital-goals?status=ACTIVE
// ============================================================
router.get('/',
    requirePermissions(['CAPITAL_GOAL_VIEW']),
    capitalGoalsController.getAllGoals
);

// ============================================================
// CREATE CAPITAL GOAL
// POST /api/capital-goals
// ============================================================
router.post('/',
    requirePermissions(['CAPITAL_GOAL_MANAGE']),
    [
        body('title')
            .trim().notEmpty().withMessage('A title is required'),
        body('description')
            .optional().trim(),
        body('target_amount')
            .isFloat({ min: 0.01 }).withMessage('Target amount must be greater than zero'),
        body('currency_id')
            .isInt({ min: 1 }).withMessage('A valid currency is required'),
        body('start_date')
            .isISO8601().withMessage('A valid start date is required'),
        body('end_date')
            .isISO8601().withMessage('A valid end date is required')
            .custom((value, { req }) => {
                if (new Date(value) < new Date(req.body.start_date)) {
                    throw new Error('End date cannot be before start date');
                }
                return true;
            }),
        // v1.43.0 — every new goal is call-based: exactly one PRIMARY
        // goal per fiscal year, any number of SECONDARY goals.
        body('goal_type')
            .isIn(['PRIMARY', 'SECONDARY']).withMessage('goal_type must be PRIMARY or SECONDARY'),
        body('fiscal_year')
            .isInt({ min: 2000, max: 2200 }).withMessage('A valid fiscal year is required'),
        body('call_deadline_day')
            .isInt({ min: 1, max: 28 }).withMessage('call_deadline_day must be between 1 and 28'),
    ],
    validateRequest,
    capitalGoalsController.createGoal
);

// ============================================================
// EDIT CAPITAL GOAL
// PATCH /api/capital-goals/:id
// ============================================================
router.patch('/:id',
    requirePermissions(['CAPITAL_GOAL_MANAGE']),
    validators.idParam('id'),
    [
        body('title').optional().trim().notEmpty(),
        body('description').optional().trim(),
        body('target_amount').optional().isFloat({ min: 0.01 }).withMessage('Target amount must be greater than zero'),
        body('currency_id').optional().isInt({ min: 1 }),
        body('start_date').optional().isISO8601(),
        body('end_date').optional().isISO8601(),
    ],
    validateRequest,
    capitalGoalsController.updateGoal
);

// ============================================================
// CANCEL CAPITAL GOAL
// POST /api/capital-goals/:id/cancel
// ============================================================
router.post('/:id/cancel',
    requirePermissions(['CAPITAL_GOAL_MANAGE']),
    validators.idParam('id'),
    [ body('reason').optional().trim() ],
    validateRequest,
    capitalGoalsController.cancelGoal
);

// ============================================================
// MARK CAPITAL GOAL AS COMPLETED
// POST /api/capital-goals/:id/complete
// ============================================================
router.post('/:id/complete',
    requirePermissions(['CAPITAL_GOAL_MANAGE']),
    validators.idParam('id'),
    validateRequest,
    capitalGoalsController.completeGoal
);

// ============================================================
// CAPITAL GOAL CALLS (v1.43.0) — pledges against a specific monthly
// call. Reuses CAPITAL_GOAL_VIEW/MANAGE — no new permission codes.
//
// NOTE: /my-calls MUST be registered before the generic GET /:id
// below — Express matches routes in registration order, and /:id
// would otherwise swallow a request for "/my-calls" by treating
// "my-calls" as the :id value.
// ============================================================

// My own pledges + which open calls I can still pledge into.
// GET /api/capital-goals/my-calls
router.get('/my-calls',
    capitalGoalCallsController.getMyPledges
);

// ============================================================
// GET SINGLE CAPITAL GOAL WITH FULL PROGRESS BREAKDOWN
// GET /api/capital-goals/:id
// ============================================================
router.get('/:id',
    requirePermissions(['CAPITAL_GOAL_VIEW']),
    validators.idParam('id'),
    validateRequest,
    capitalGoalsController.getGoalById
);

// Submit a pledge into a specific monthly call — any Shareholder.
// POST /api/capital-goals/monthly-calls/:monthlyCallId/pledges
router.post('/monthly-calls/:monthlyCallId/pledges',
    validators.idParam('monthlyCallId'),
    [
        body('iteration').optional().isInt({ min: 1, max: 2 }).withMessage('iteration must be 1 or 2'),
        body('currency_id').isInt({ min: 1 }).withMessage('A valid currency is required'),
        body('pledged_amount').isFloat({ min: 0 }).withMessage('Pledged amount cannot be negative'),
    ],
    validateRequest,
    capitalGoalCallsController.submitPledge
);

// One monthly call's own period/target/deadlines/status, plus its
// parent goal's title/currency — open to every authenticated member
// (same permission as viewing the goal itself), since the anonymous
// status grid below is also open to everyone.
// GET /api/capital-goals/monthly-calls/:id
router.get('/monthly-calls/:id',
    requirePermissions(['CAPITAL_GOAL_VIEW']),
    validators.idParam('id'),
    validateRequest,
    capitalGoalCallsController.getMonthlyCallById
);

// All pledges for one monthly call — Treasurer's approval queue.
// GET /api/capital-goals/monthly-calls/:id/pledges
router.get('/monthly-calls/:id/pledges',
    requirePermissions(['CAPITAL_GOAL_MANAGE']),
    validators.idParam('id'),
    validateRequest,
    capitalGoalCallsController.getPledgesForMonthlyCall
);

// Anonymous, color-code-only status of one monthly call — open to
// every authenticated member, no names or amounts.
// GET /api/capital-goals/monthly-calls/:id/status
router.get('/monthly-calls/:id/status',
    validators.idParam('id'),
    validateRequest,
    capitalGoalCallsController.getMonthlyCallStatus
);

// Edit my own pledge — only while nothing's been settled against it.
// PATCH /api/capital-goals/pledges/:id
router.patch('/pledges/:id',
    validators.idParam('id'),
    [
        body('pledged_amount').optional().isFloat({ min: 0 }).withMessage('Pledged amount cannot be negative'),
        body('currency_id').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    capitalGoalCallsController.editPledge
);

// Reject a pledge — Treasurer, only while nothing's settled.
// POST /api/capital-goals/pledges/:id/reject
router.post('/pledges/:id/reject',
    requirePermissions(['CAPITAL_GOAL_MANAGE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    capitalGoalCallsController.rejectPledge
);

// Approve (= settle) a pledge payment — Treasurer. The account's
// currency must match the pledge's own currency (enforced in the
// service, not just here).
// POST /api/capital-goals/pledges/:id/approve
router.post('/pledges/:id/approve',
    requirePermissions(['CAPITAL_GOAL_MANAGE']),
    validators.idParam('id'),
    [
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('account_id').isInt({ min: 1 }).withMessage('A receiving account is required'),
        body('paid_date').optional().isISO8601().withMessage('Invalid date').custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    capitalGoalCallsController.approvePledgePayment
);

// Every monthly call under a goal (targets, deadlines, status, settled).
// GET /api/capital-goals/:id/monthly-calls
router.get('/:id/monthly-calls',
    requirePermissions(['CAPITAL_GOAL_VIEW']),
    validators.idParam('id'),
    validateRequest,
    capitalGoalCallsController.listMonthlyCallsForGoal
);

// Personal contribution stats + public top-contributor callout for a
// specific goal (normally the current year's primary goal).
// GET /api/capital-goals/:id/stats
router.get('/:id/stats',
    requirePermissions(['CAPITAL_GOAL_VIEW']),
    validators.idParam('id'),
    validateRequest,
    capitalGoalCallsController.getGoalContributionStats
);

module.exports = router;
