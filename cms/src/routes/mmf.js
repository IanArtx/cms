// ============================================================
// MONEY MARKET FUND (MMF) SUB-ACCOUNT ROUTES
// Prefix: /api/mmf
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View MMF sub-accounts: MMF_VIEW
//   - Create/top-up/withdraw/interest/fee/close: MMF_MANAGE
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions } = require('../middleware/auth');
const mmfController = require('../controllers/mmfController');

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET ALL MMF SUB-ACCOUNTS
// GET /api/mmf?status=ACTIVE
// ============================================================
router.get('/',
    requirePermissions(['MMF_VIEW']),
    mmfController.getAllMmfAccounts
);

// ============================================================
// BEST/WORST PERFORMING MMF (comparison summary)
// GET /api/mmf/performance-summary
// Declared before GET /:id so Express doesn't treat
// "performance-summary" as an :id value. No MMF_VIEW gate,
// mirroring investments' performance-summary — safe for any
// authenticated user's dashboard.
// ============================================================
router.get('/performance-summary',
    mmfController.getMmfPerformanceSummary
);

// ============================================================
// CREATE MMF SUB-ACCOUNT
// POST /api/mmf
// ============================================================
router.post('/',
    requirePermissions(['MMF_MANAGE']),
    [
        body('parent_account_id')
            .isInt({ min: 1 }).withMessage('A valid parent account is required'),
        body('name')
            .trim().notEmpty().withMessage('A name for this MMF sub-account is required'),
        body('provider')
            .optional().trim(),
        body('description')
            .optional().trim(),
        body('initial_amount')
            .optional().isFloat({ min: 0.01 }).withMessage('Initial amount must be greater than zero'),
        body('category_id')
            .optional().isInt({ min: 1 }),
        body('entry_date')
            .optional().isISO8601().withMessage('Invalid entry date').custom(notFutureDate),
    ],
    validateRequest,
    mmfController.createMmfAccount
);

// ============================================================
// TOP UP MMF SUB-ACCOUNT
// POST /api/mmf/:id/topup
// ============================================================
router.post('/:id/topup',
    requirePermissions(['MMF_MANAGE']),
    validators.idParam('id'),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('entry_date')
            .isISO8601().withMessage('A valid date is required').custom(notFutureDate),
        body('description')
            .optional().trim(),
    ],
    validateRequest,
    mmfController.topUpMmfAccount
);

// ============================================================
// WITHDRAW FROM MMF SUB-ACCOUNT
// POST /api/mmf/:id/withdraw
// ============================================================
router.post('/:id/withdraw',
    requirePermissions(['MMF_MANAGE']),
    validators.idParam('id'),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('entry_date')
            .isISO8601().withMessage('A valid date is required').custom(notFutureDate),
        body('description')
            .optional().trim(),
    ],
    validateRequest,
    mmfController.withdrawFromMmfAccount
);

// ============================================================
// RECORD MONTHLY INTEREST
// POST /api/mmf/:id/interest
// ============================================================
router.post('/:id/interest',
    requirePermissions(['MMF_MANAGE']),
    validators.idParam('id'),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('interest_period')
            .isISO8601().withMessage('A valid month is required (any date within that month)'),
        body('entry_date')
            .isISO8601().withMessage('A valid date is required').custom(notFutureDate),
        body('description')
            .optional().trim(),
    ],
    validateRequest,
    mmfController.recordInterest
);

// ============================================================
// RECORD MANAGEMENT FEE
// POST /api/mmf/:id/fee
// ============================================================
router.post('/:id/fee',
    requirePermissions(['MMF_MANAGE']),
    validators.idParam('id'),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('entry_date')
            .isISO8601().withMessage('A valid date is required').custom(notFutureDate),
        body('description')
            .optional().trim(),
    ],
    validateRequest,
    mmfController.recordManagementFee
);

// ============================================================
// CLOSE MMF SUB-ACCOUNT
// POST /api/mmf/:id/close
// ============================================================
router.post('/:id/close',
    requirePermissions(['MMF_MANAGE']),
    validators.idParam('id'),
    validateRequest,
    mmfController.closeMmfAccount
);

// ============================================================
// GET SINGLE MMF SUB-ACCOUNT
// GET /api/mmf/:id
// ============================================================
router.get('/:id',
    requirePermissions(['MMF_VIEW']),
    validators.idParam('id'),
    validateRequest,
    mmfController.getMmfById
);

module.exports = router;
