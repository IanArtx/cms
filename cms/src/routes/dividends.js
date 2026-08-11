// ============================================================
// DIVIDENDS & AUTHORITY PAYMENTS ROUTES
// Prefix: /api/dividends
// IMPORTANT: specific routes must come before /:id routes
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireRoles } = require('../middleware/auth');
const dividendsController = require('../controllers/dividendsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// AUTHORITY PAYMENTS — must come before /:id routes
// ============================================================

// Get all authority payments
router.get('/authority-payments',
    requirePermissions(['FINANCE_VIEW_ALL']),
    dividendsController.getAllAuthorityPayments
);

// Record an authority payment
router.post('/authority-payments',
    requirePermissions(['FINANCE_TRANSACTION_CREATE']),
    [
        body('account_id')
            .isInt({ min: 1 }).withMessage('A valid account is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('authority_type')
            .isIn(['URA', 'URSB', 'BANK', 'NSSF', 'OTHER'])
            .withMessage('Invalid authority type'),
        body('authority_name')
            .trim().notEmpty().withMessage('Authority name is required'),
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('payment_date')
            .isISO8601().withMessage('A valid payment date is required').custom(notFutureDate),
        body('payment_type')
            .optional().trim(),
        body('authority_ref')
            .optional().trim(),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    dividendsController.recordAuthorityPayment
);

// ============================================================
// DIVIDENDS
// ============================================================

// Get all dividends
router.get('/',
    requirePermissions(['FINANCE_VIEW_ALL']),
    dividendsController.getAllDividends
);

// Edit a dividend before approval — whoever declared it, or a Treasurer
router.patch('/:id',
    validators.idParam('id'),
    [
        body('account_id').optional().isInt({ min: 1 }),
        body('category_id').optional().isInt({ min: 1 }),
        body('total_amount').optional().isFloat({ min: 0.01 }),
        body('declaration_date').optional().isISO8601().custom(notFutureDate),
    ],
    validateRequest,
    dividendsController.editDividend
);

// Declare a dividend
router.post('/',
    requireRoles(['Treasurer']),
    [
        body('account_id')
            .isInt({ min: 1 }).withMessage('A valid account is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('total_amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('declaration_date')
            .isISO8601().withMessage('A valid declaration date is required').custom(notFutureDate),
        body('period_label')
            .optional().trim(),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    dividendsController.declareDividend
);

// Get single dividend with distributions
router.get('/:id',
    requirePermissions(['FINANCE_VIEW_ALL']),
    validators.idParam('id'),
    validateRequest,
    dividendsController.getDividendById
);

// Approve and pay dividend — credits every shareholder's Savings
// balance (Section 4.12). exchange_rate is only required when the
// dividend's own currency differs from the Savings account's
// currency; the controller validates that condition itself since it
// depends on which account exists, not something express-validator
// can check statically.
router.post('/:id/approve',
    requireRoles(['Treasurer']),
    validators.idParam('id'),
    [body('exchange_rate').optional().isFloat({ gt: 0 }).withMessage('Exchange rate must be a positive number')],
    validateRequest,
    dividendsController.approveDividend
);

module.exports = router;