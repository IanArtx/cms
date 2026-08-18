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
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions } = require('../middleware/auth');
const capitalGoalsController = require('../controllers/capitalGoalsController');

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
// GET SINGLE CAPITAL GOAL WITH FULL PROGRESS BREAKDOWN
// GET /api/capital-goals/:id
// ============================================================
router.get('/:id',
    requirePermissions(['CAPITAL_GOAL_VIEW']),
    validators.idParam('id'),
    validateRequest,
    capitalGoalsController.getGoalById
);

module.exports = router;
