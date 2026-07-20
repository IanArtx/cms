// ============================================================
// INVESTMENTS ROUTES
// Prefix: /api/investments
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View investments: all authenticated members
//   - Create investments: Directors, Treasurer
//   - Approve investments: Treasurer, Directors
//   - Fund investments: Treasurer
//   - Record returns: Treasurer
//   - Manage projects and milestones: Coordinator, Directors
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requirePermissions, requireAnyPermission } = require('../middleware/auth');
const investmentsController = require('../controllers/investmentsController');

// All routes require login
router.use(authenticate);

// ============================================================
// GET ALL INVESTMENTS
// GET /api/investments?status=ACTIVE
// ============================================================
router.get('/',
    requirePermissions(['INVESTMENT_VIEW']),
    investmentsController.getAllInvestments
);

// ============================================================
// CREATE INVESTMENT
// POST /api/investments
// ============================================================
router.post('/',
    requirePermissions(['INVESTMENT_CREATE']),
    [
        body('name')
            .trim().notEmpty().withMessage('Investment name is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('funding_account_id')
            .isInt({ min: 1 }).withMessage('A valid funding account is required'),
        body('planned_budget')
            .isFloat({ min: 0.01 }).withMessage('Planned budget must be greater than zero'),
        body('start_date')
            .optional().isISO8601().withMessage('Invalid start date'),
        body('expected_end_date')
            .optional().isISO8601().withMessage('Invalid end date'),
        body('responsible_user_id')
            .optional().isInt({ min: 1 }),
        body('investment_type')
            .optional().isIn(['STANDARD', 'BOND']).withMessage('Invalid investment type'),
        body('face_value')
            .optional().isFloat({ min: 0.01 }).withMessage('Face value must be greater than zero'),
        body('coupon_rate')
            .optional().isFloat({ min: 0 }).withMessage('Coupon rate must be zero or greater'),
        body('coupon_frequency')
            .optional().isIn(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY', 'AT_MATURITY'])
            .withMessage('Invalid coupon frequency'),
        body('tax_withholding_rate')
            .optional().isFloat({ min: 0, max: 100 }).withMessage('Tax withholding rate must be between 0 and 100'),
    ],
    validateRequest,
    investmentsController.createInvestment
);

// ============================================================
// BEST/WORST PERFORMING INVESTMENT (dashboard summary)
// GET /api/investments/performance-summary
// Deliberately has NO INVESTMENT_VIEW gate — just authentication —
// so every user's dashboard can show this, not only staff with full
// investment access. Must be declared before GET /:id so Express
// doesn't treat "performance-summary" as an :id value.
// ============================================================
router.get('/performance-summary',
    investmentsController.getPerformanceSummary
);

// ============================================================
// GET SINGLE INVESTMENT
// GET /api/investments/:id
// ============================================================
router.get('/:id',
    requirePermissions(['INVESTMENT_VIEW']),
    validators.idParam('id'),
    validateRequest,
    investmentsController.getInvestmentById
);

// ============================================================
// EDIT INVESTMENT (before approval)
// PATCH /api/investments/:id
// ============================================================
router.patch('/:id',
    requireAnyPermission(['INVESTMENT_CREATE', 'INVESTMENT_APPROVE']),
    validators.idParam('id'),
    [
        body('funding_account_id').optional().isInt({ min: 1 }),
        body('category_id').optional().isInt({ min: 1 }),
        body('planned_budget').optional().isFloat({ min: 0.01 }),
        body('start_date').optional().isISO8601(),
        body('expected_end_date').optional().isISO8601(),
        body('face_value').optional().isFloat({ min: 0.01 }),
        body('coupon_rate').optional().isFloat({ min: 0 }),
        body('coupon_frequency').optional().isIn(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY', 'AT_MATURITY']),
        body('tax_withholding_rate').optional().isFloat({ min: 0, max: 100 }),
        body('first_coupon_date').optional().isISO8601(),
    ],
    validateRequest,
    investmentsController.editInvestment
);

// ============================================================
// APPROVE INVESTMENT
// POST /api/investments/:id/approve
// ============================================================
router.post('/:id/approve',
    requirePermissions(['INVESTMENT_APPROVE']),
    validators.idParam('id'),
    validateRequest,
    investmentsController.approveInvestment
);

// ============================================================
// FUND INVESTMENT
// POST /api/investments/:id/fund
// ============================================================
router.post('/:id/fund',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('value_date')
            .isISO8601().withMessage('A valid date is required'),
        body('category_id')
            .optional().isInt({ min: 1 }),
        body('description')
            .optional().trim(),
        body('project_id')
            .optional().isInt({ min: 1 }),
    ],
    validateRequest,
    investmentsController.fundInvestment
);

// ============================================================
// RECORD INVESTMENT RETURN
// POST /api/investments/:id/returns
// ============================================================
router.post('/:id/returns',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('return_type')
            .isIn(['DIVIDEND','PROFIT_SHARE','CAPITAL_GAIN','INTEREST','RENTAL','OTHER'])
            .withMessage('Invalid return type'),
        body('return_date')
            .isISO8601().withMessage('A valid date is required'),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    investmentsController.recordReturn
);

// ============================================================
// RECORD INVESTMENT OPERATIONAL TRANSACTION
// POST /api/investments/:id/transactions
// A dedicated expense, extra inflow, or tax entry against this one
// investment's own operating budget. Always posts to the general
// ledger automatically (see recordInvestmentTransaction).
// ============================================================
router.post('/:id/transactions',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('entry_type')
            .isIn(['EXPENSE', 'INFLOW', 'TAX']).withMessage('Invalid entry type'),
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('entry_date')
            .isISO8601().withMessage('A valid date is required'),
        body('description')
            .optional().trim(),
        body('category_id')
            .optional().isInt({ min: 1 }),
    ],
    validateRequest,
    investmentsController.recordInvestmentTransaction
);

// ============================================================
// BOND COUPONS
// ============================================================

// Mark a scheduled bond coupon as paid — records the return + transaction
router.patch('/:id/coupons/:couponId/pay',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    validators.idParam('couponId'),
    [
        body('paid_date')
            .optional().isISO8601().withMessage('Invalid payment date'),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    investmentsController.payBondCoupon
);

// ============================================================
// UPDATE INVESTMENT STATUS
// PATCH /api/investments/:id/status
// ============================================================
router.patch('/:id/status',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('status')
            .isIn(['PENDING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED'])
            .withMessage('Invalid status'),
        body('actual_end_date')
            .optional().isISO8601().withMessage('Invalid date'),
    ],
    validateRequest,
    investmentsController.updateInvestmentStatus
);

// ============================================================
// PROJECTS
// ============================================================

// Create project under investment
router.post('/:id/projects',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    [
        body('name')
            .trim().notEmpty().withMessage('Project name is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('planned_budget')
            .isFloat({ min: 0.01 }).withMessage('Planned budget must be greater than zero'),
        body('start_date')
            .optional().isISO8601().withMessage('Invalid start date'),
        body('expected_end_date')
            .optional().isISO8601().withMessage('Invalid end date'),
        body('responsible_user_id')
            .optional().isInt({ min: 1 }),
    ],
    validateRequest,
    investmentsController.createProject
);

// Get single project
router.get('/:id/projects/:projectId',
    requirePermissions(['INVESTMENT_VIEW']),
    validators.idParam('id'),
    validators.idParam('projectId'),
    validateRequest,
    investmentsController.getProjectById
);

// ============================================================
// MILESTONES
// ============================================================

// Add milestone to project
router.post('/:id/projects/:projectId/milestones',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    validators.idParam('projectId'),
    [
        body('name')
            .trim().notEmpty().withMessage('Milestone name is required'),
        body('due_date')
            .isISO8601().withMessage('A valid due date is required'),
        body('description')
            .optional().trim(),
    ],
    validateRequest,
    investmentsController.addMilestone
);

// Update milestone status
router.patch('/:id/projects/:projectId/milestones/:milestoneId',
    requirePermissions(['INVESTMENT_MANAGE']),
    validators.idParam('id'),
    validators.idParam('projectId'),
    validators.idParam('milestoneId'),
    [
        body('status')
            .isIn(['PENDING','IN_PROGRESS','COMPLETED','MISSED'])
            .withMessage('Invalid milestone status'),
        body('completed_at')
            .optional().isISO8601().withMessage('Invalid date'),
    ],
    validateRequest,
    investmentsController.updateMilestone
);

module.exports = router;