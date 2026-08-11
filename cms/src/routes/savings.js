// ============================================================
// MEMBER SAVINGS ROUTES
// Prefix: /api/savings
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireAnyPermission, requireRoles } = require('../middleware/auth');
const savingsController = require('../controllers/savingsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ------------------------------------------------------------
// STATIC ROUTES — must be declared before any /:id route below,
// otherwise Express would treat e.g. "handouts" as an :id value.
// ------------------------------------------------------------

// Own savings summary (flexible + fixed-term)
router.get('/me', savingsController.getMySavings);

// Own running flexible savings balance
router.get('/balance/me', savingsController.getMySavingsBalance);

// Own savings handouts
router.get('/handouts/me', savingsController.getMySavingsHandouts);

// A specific member's balance — for treasury to check before entering a handout
router.get('/balance/:userId',
    requireAnyPermission(['SAVINGS_VIEW', 'SAVINGS_HANDOUT_CREATE']),
    savingsController.getSavingsBalanceByUser
);

// Company-wide interest settings — anyone can view, only Admin/Treasurer can change
router.get('/settings', savingsController.getSavingsSettings);
router.patch('/settings',
    requirePermissions(['SAVINGS_SETTINGS_MANAGE']),
    [
        body('interest_rate').optional().isFloat({ min: 0 }),
        body('interest_period').optional().isIn(['DAILY', 'WEEKLY', 'MONTHLY', 'ANNUALLY']),
        body('interest_calculation').optional().isIn(['SIMPLE', 'COMPOUND']),
    ],
    validateRequest,
    savingsController.updateSavingsSettings
);

// All members' handouts — Treasurer/Admin
router.get('/handouts',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getAllSavingsHandouts
);

// Enter a new handout — Treasurer/Assistant Treasurer
router.post('/handouts',
    requirePermissions(['SAVINGS_HANDOUT_CREATE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid member is required'),
        body('account_id').isInt({ min: 1 }).withMessage('A valid account is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('principal_amount').isFloat({ min: 0.01 }).withMessage('Principal must be greater than zero'),
        body('interest_amount').optional().isFloat({ min: 0 }),
        body('handout_date').isISO8601().withMessage('A valid handout date is required').custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsController.createSavingsHandout
);

// Confirm / reject a handout — the receiving member only (checked in controller)
router.patch('/handouts/:id/confirm',
    validators.idParam('id'),
    validateRequest,
    savingsController.confirmSavingsHandout
);
router.patch('/handouts/:id/reject',
    validators.idParam('id'),
    [ body('reason').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsHandout
);

// Legacy fixed-term deposit — self-service, any shareholder
router.post('/fixed-term',
    requirePermissions(['FINANCE_TRANSACTION_CREATE']),
    [
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('principal_amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('interest_rate').optional().isFloat({ min: 0 }),
        body('interest_period').optional().isIn(['DAILY', 'WEEKLY', 'MONTHLY', 'ANNUALLY']),
        body('deposit_date').isISO8601().withMessage('A valid deposit date is required').custom(notFutureDate),
        body('maturity_date').isISO8601().withMessage('A valid maturity date is required'),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsController.createFixedTermSavings
);

// All members' savings — Treasurer/Admin
router.get('/',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getAllSavings
);

// Record a flexible deposit on behalf of a member — Treasurer/Assistant Treasurer
router.post('/',
    requirePermissions(['SAVINGS_CREATE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid member is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('deposit_date').isISO8601().withMessage('A valid deposit date is required').custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsController.createSavingsDeposit
);

// ------------------------------------------------------------
// SAVINGS POOL "OTHER" INFLOW — a non-member credit into the SAVINGS
// account's pool (e.g. investment profit returned to the pool).
// Reuses SAVINGS_CREATE / SAVINGS_APPROVE — same Treasurer/Assistant
// Treasurer pipeline as a member deposit, no new permissions needed.
// Declared here (static path, no :id) before the /:id routes below.
// ------------------------------------------------------------
router.get('/pool-inflows',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getSavingsPoolInflows
);
router.post('/pool-inflows',
    requirePermissions(['SAVINGS_CREATE']),
    [
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('value_date').isISO8601().withMessage('A valid date is required').custom(notFutureDate),
        body('description').trim().notEmpty().withMessage('A description is required'),
    ],
    validateRequest,
    savingsController.createSavingsPoolInflow
);
router.patch('/pool-inflows/:id/approve',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.approveSavingsPoolInflow
);
router.patch('/pool-inflows/:id/reject',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsPoolInflow
);

// ------------------------------------------------------------
// /:id ROUTES — must come after all the static routes above
// ------------------------------------------------------------

// Approve / reject a pending flexible deposit — Treasurer/Assistant Treasurer
router.patch('/:id/approve',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.approveSavingsDeposit
);
router.patch('/:id/reject',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsDeposit
);

// Withdraw fixed-term savings at maturity — Treasurer only
router.post('/:id/withdraw',
    requireRoles(['Treasurer']),
    validators.idParam('id'),
    validateRequest,
    savingsController.withdrawSavings
);

module.exports = router;
