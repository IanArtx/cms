// ============================================================
// ACCOUNTS ROUTES
// Prefix: /api/accounts
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - Summary and currencies: all authenticated users
//   - Full account details: Treasurer, Directors, Admin
//   - Creating accounts: Admin only
//   - Floor limit changes: Treasurer / Assistant Treasurer (any
//     account except SAVINGS, which is always exempt)
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions } = require('../middleware/auth');
const accountsController = require('../controllers/accountsController');

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// Bank details — shared by primary/secondary creation and update.
// The "required unless virtual" rule is enforced in the controller
// (it depends on the value of is_virtual, which express-validator
// field-level rules can't easily cross-check), so every field here
// is just optional/well-formed at the validator level.
const bankDetailValidators = [
    body('is_virtual')
        .optional().isBoolean().withMessage('is_virtual must be true or false'),
    body('bank_name')
        .optional({ checkFalsy: true }).trim()
        .isLength({ max: 150 }).withMessage('Bank name is too long'),
    body('bank_branch')
        .optional({ checkFalsy: true }).trim()
        .isLength({ max: 150 }).withMessage('Branch is too long'),
    body('bank_account_number')
        .optional({ checkFalsy: true }).trim()
        .isLength({ max: 100 }).withMessage('Account number is too long'),
    body('swift_routing_code')
        .optional({ checkFalsy: true }).trim()
        .isLength({ max: 50 }).withMessage('SWIFT/routing code is too long'),
];

// ============================================================
// CURRENCY ROUTES
// ============================================================

// Get all currencies (any authenticated user — needed for forms)
router.get('/currencies', accountsController.getCurrencies);

// Add a new currency (Admin only)
router.post('/currencies',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        body('code')
            .trim().notEmpty().withMessage('Currency code is required')
            .isLength({ max: 10 }).withMessage('Code too long')
            .matches(/^[A-Za-z]+$/).withMessage('Code must contain letters only'),
        body('name')
            .trim().notEmpty().withMessage('Currency name is required'),
        body('symbol')
            .optional().trim(),
    ],
    validateRequest,
    accountsController.addCurrency
);

// Update an existing currency (Admin only)
router.patch('/currencies/:id',
    requirePermissions(['SYSTEM_CONFIG']),
    validators.idParam('id'),
    [
        body('code')
            .optional().trim().notEmpty().withMessage('Currency code cannot be empty')
            .isLength({ max: 10 }).withMessage('Code too long')
            .matches(/^[A-Za-z]+$/).withMessage('Code must contain letters only'),
        body('name')
            .optional().trim().notEmpty().withMessage('Currency name cannot be empty'),
        body('symbol')
            .optional().trim(),
        body('is_active')
            .optional().isBoolean().withMessage('is_active must be true or false'),
    ],
    validateRequest,
    accountsController.updateCurrency
);

// ============================================================
// ACCOUNT SUMMARY (Dashboard)
// ============================================================

// Get all account balances — used by dashboard (all members)
router.get('/summary', accountsController.getAccountSummary);

// ============================================================
// PRIMARY ACCOUNT SETUP (one-time)
// ============================================================

// Create the primary Euro account — Admin only, one time ever
router.post('/primary',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        body('name')
            .trim().notEmpty().withMessage('Account name is required'),
        body('floor_amount')
            .optional()
            .isFloat({ min: 0 }).withMessage('Floor amount must be a positive number'),
        body('description')
            .optional().trim(),
        ...bankDetailValidators,
    ],
    validateRequest,
    accountsController.createPrimaryAccount
);

// ============================================================
// SAVINGS ACCOUNT SETUP (one-time)
// ============================================================

// Create the dedicated savings account — Admin only, one time ever
router.post('/savings',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        body('name')
            .trim().notEmpty().withMessage('Account name is required'),
        body('currency_id')
            .isInt({ min: 1 }).withMessage('A valid currency is required'),
        body('description')
            .optional().trim(),
        ...bankDetailValidators,
    ],
    validateRequest,
    accountsController.createSavingsAccount
);

// ============================================================
// ACCOUNT ROUTES
// ============================================================

// Get all accounts (Treasurer, Directors, Admin)
router.get('/',
    requirePermissions(['FINANCE_VIEW_ALL']),
    accountsController.getAllAccounts
);

// Create a secondary account (Admin only)
router.post('/',
    requirePermissions(['SYSTEM_CONFIG']),
    [
        body('name')
            .trim().notEmpty().withMessage('Account name is required'),
        body('currency_id')
            .isInt({ min: 1 }).withMessage('A valid currency is required'),
        body('description')
            .optional().trim(),
        body('reference_prefix')
            .optional({ checkFalsy: true }).trim()
            .isLength({ max: 10 }).withMessage('Reference prefix must be 10 characters or fewer')
            .matches(/^[A-Za-z0-9]+$/).withMessage('Reference prefix must be letters/numbers only'),
        ...bankDetailValidators,
    ],
    validateRequest,
    accountsController.createSecondaryAccount
);

// Get a single account by ID (Treasurer, Directors, Admin)
router.get('/:id',
    requirePermissions(['FINANCE_VIEW_ALL']),
    validators.idParam('id'),
    validateRequest,
    accountsController.getAccountById
);

// Update an account's name/description/reference prefix (Admin only)
router.patch('/:id',
    requirePermissions(['SYSTEM_CONFIG']),
    validators.idParam('id'),
    [
        body('name')
            .optional().trim().notEmpty().withMessage('Account name cannot be empty'),
        body('description')
            .optional().trim(),
        body('reference_prefix')
            .optional({ nullable: true, checkFalsy: false })
            .custom(value => value === null || value === '' || /^[A-Za-z0-9]{1,10}$/.test(value))
            .withMessage('Reference prefix must be 1-10 letters/numbers, or empty to clear'),
        ...bankDetailValidators,
    ],
    validateRequest,
    accountsController.updateAccount
);

// ============================================================
// FLOOR LIMIT
// ============================================================

// Update floor limit — anyone holding FINANCE_FLOOR_LIMIT_UPDATE
// (matches the frontend's hasPermission gate on this same action —
// previously mismatched to requireRoles(['Treasurer','Assistant
// Treasurer']), which 403'd anyone granted the permission under a
// differently-named role).
// Any account can have a floor limit (v1.14.0) except SAVINGS, which
// the controller always rejects.
router.post('/:id/floor-limit',
    requirePermissions(['FINANCE_FLOOR_LIMIT_UPDATE']),
    validators.idParam('id'),
    [
        body('floor_amount')
            .isFloat({ min: 0 }).withMessage('Floor amount must be a positive number'),
        body('notes')
            .optional().trim(),
        body('effective_from')
            .optional().isISO8601().withMessage('effective_from must be a valid date'),
    ],
    validateRequest,
    accountsController.updateFloorLimit
);

module.exports = router;