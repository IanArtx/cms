// ============================================================
// SIDE FUND ROUTES
// Prefix: /api/side-fund
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions } = require('../middleware/auth');
const sideFundController = require('../controllers/sideFundController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

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
        body('expense_date').isISO8601().withMessage('A valid expense date is required').custom(notFutureDate),
    ],
    validateRequest,
    sideFundController.recordSideFundExpense
);

// Bulk pay-all-dues (v1.26.0) — mark several/all members' monthly due
// as paid in one batch entry. Per-row amounts are editable in the
// frontend (not necessarily the full amount owed), so this is
// validated as a plain array rather than assumed to equal what's
// outstanding. Treasurer/Assistant Treasurer.
router.patch('/dues/bulk-pay',
    requirePermissions(['SIDE_FUND_CONTRIBUTION_RECORD']),
    [
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('paid_date').optional().isISO8601().custom(notFutureDate),
        body('payments').isArray({ min: 1 }).withMessage('At least one member payment is required'),
        body('payments.*.user_id').isInt({ min: 1 }).withMessage('Each payment needs a valid user_id'),
        body('payments.*.amount').isFloat({ min: 0.01 }).withMessage('Each payment amount must be greater than zero'),
    ],
    validateRequest,
    sideFundController.bulkPayDues
);

// Generate this month's (or a given period's) dues on demand — same
// pipeline the monthly cron job runs. For when the fund was
// activated, or the backend deployed, after the 1st already passed
// for the current month, so the automatic run never happened.
// SIDE_FUND_MANAGE, same audience as the fund's other settings.
router.post('/dues/generate',
    requirePermissions(['SIDE_FUND_MANAGE']),
    [
        body('period').optional().matches(/^\d{4}-\d{2}$/).withMessage('period must be in YYYY-MM format'),
    ],
    validateRequest,
    sideFundController.generateDues
);

// Overdue summary (v1.26.0) — own, then Treasurer/Admin's view of
// every member currently overdue.
router.get('/overdue/me', sideFundController.getMyOverdueSummary);

router.get('/overdue',
    requirePermissions(['SIDE_FUND_VIEW']),
    sideFundController.getAllOverdueSummary
);

// ------------------------------------------------------------
// PER-MEMBER AMOUNT OVERRIDES (v1.25.0) — SIDE_FUND_MANAGE, same
// permission as the company-wide default.
// ------------------------------------------------------------
router.get('/overrides',
    requirePermissions(['SIDE_FUND_MANAGE']),
    sideFundController.getMemberOverrides
);

router.put('/overrides/:userId',
    requirePermissions(['SIDE_FUND_MANAGE']),
    validators.idParam('userId'),
    [body('monthly_amount').isFloat({ min: 0 }).withMessage('monthly_amount must be zero or a positive number')],
    validateRequest,
    sideFundController.setMemberOverride
);

router.delete('/overrides/:userId',
    requirePermissions(['SIDE_FUND_MANAGE']),
    validators.idParam('userId'),
    validateRequest,
    sideFundController.clearMemberOverride
);

// ------------------------------------------------------------
// OVERPAYMENT CREDIT (v1.25.0)
// ------------------------------------------------------------
router.get('/credit/me', sideFundController.getMyCredit);

router.get('/credit',
    requirePermissions(['SIDE_FUND_VIEW']),
    sideFundController.getAllCredit
);

// ------------------------------------------------------------
// MEMBERSHIP CHECKLIST (v1.32.0) — SIDE_FUND_MANAGE for anything that
// changes membership or previews/executes a payout; SIDE_FUND_VIEW
// for the read-only checklist itself.
// ------------------------------------------------------------
router.get('/members',
    requirePermissions(['SIDE_FUND_VIEW']),
    sideFundController.getMembershipChecklist
);

router.post('/members/:userId',
    requirePermissions(['SIDE_FUND_MANAGE']),
    validators.idParam('userId'),
    [
        body('start_period').matches(/^\d{4}-\d{2}$/).withMessage('start_period is required, in YYYY-MM format'),
    ],
    validateRequest,
    sideFundController.addMember
);

router.get('/members/:userId/payout-preview',
    requirePermissions(['SIDE_FUND_MANAGE']),
    validators.idParam('userId'),
    validateRequest,
    sideFundController.getExitPayoutPreview
);

router.patch('/members/:userId/remove',
    requirePermissions(['SIDE_FUND_MANAGE']),
    validators.idParam('userId'),
    [
        body('category_id').optional().isInt({ min: 1 }),
        body('exchange_rate').optional().isFloat({ min: 0.000001 }),
    ],
    validateRequest,
    sideFundController.removeMember
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
        body('paid_date').optional().isISO8601().custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    sideFundController.recordDuePayment
);

module.exports = router;
