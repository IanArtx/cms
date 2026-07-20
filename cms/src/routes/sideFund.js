// ============================================================
// SIDE FUND ROUTES
// Prefix: /api/side-fund
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, blockAuditor, requirePermissions } = require('../middleware/auth');
const sideFundController = require('../controllers/sideFundController');

router.use(authenticate);
router.use(blockAuditor);

// ------------------------------------------------------------
// STATIC ROUTES — must be declared before any /:id route below.
// ------------------------------------------------------------

// Settings/summary — anyone signed in can view whether the fund is
// active, its balance, and its monthly due; only SIDE_FUND_MANAGE
// holders can change it.
router.get('/settings', sideFundController.getSideFundConfig);
router.patch('/settings',
    requirePermissions(['SIDE_FUND_MANAGE']),
    [
        body('is_active').optional().isBoolean(),
        body('parent_account_id').optional().isInt({ min: 1 }),
        body('monthly_amount').optional().isFloat({ min: 0 }),
    ],
    validateRequest,
    sideFundController.updateSideFundConfig
);

// Own due history
router.get('/dues/me', sideFundController.getMyDues);

// All members' dues — Treasurer/Admin
router.get('/dues',
    requirePermissions(['SIDE_FUND_VIEW']),
    sideFundController.getAllDues
);

// Side fund spending history
router.get('/expenses',
    requirePermissions(['SIDE_FUND_VIEW']),
    sideFundController.getSideFundExpenses
);

// Record an expense drawn from the side fund — Treasurer/Assistant Treasurer
router.post('/expenses',
    requirePermissions(['SIDE_FUND_EXPENSE_RECORD']),
    [
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('description').trim().notEmpty().withMessage('A description is required'),
        body('expense_date').isISO8601().withMessage('A valid expense date is required'),
    ],
    validateRequest,
    sideFundController.recordSideFundExpense
);

// Direct/batch inflow — money added straight to the fund that isn't
// tied to any individual member's due (e.g. an existing balance being
// brought in, or a lump-sum top-up). Treasurer/Assistant Treasurer.
router.post('/inflows',
    requirePermissions(['SIDE_FUND_CONTRIBUTION_RECORD']),
    [
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('value_date').optional().isISO8601(),
        body('description').optional().trim(),
        body('notes').optional().trim(),
    ],
    validateRequest,
    sideFundController.recordDirectInflow
);

// ------------------------------------------------------------
// /:id ROUTES — must come after all the static routes above
// ------------------------------------------------------------

// Record a due payment — Treasurer/Assistant Treasurer
router.patch('/dues/:id/pay',
    requirePermissions(['SIDE_FUND_CONTRIBUTION_RECORD']),
    validators.idParam('id'),
    [
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('paid_date').optional().isISO8601(),
        body('notes').optional().trim(),
    ],
    validateRequest,
    sideFundController.recordDuePayment
);

module.exports = router;
