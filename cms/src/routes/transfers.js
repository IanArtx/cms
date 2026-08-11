// ============================================================
// TRANSFERS ROUTES
// Prefix: /api/transfers
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View transfers: Treasurer, Directors, Admin
//   - Initiate transfers: Directors
//   - Approve Primary to Secondary: Treasurer only
//   - Approve Secondary to Primary: Directors (needs 3)
//   - Reject transfers: Treasurer, Directors
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireRoles, requireAnyPermission } = require('../middleware/auth');
const transfersController = require('../controllers/transfersController');

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET ALL TRANSFERS
// GET /api/transfers?status=PENDING&transfer_type=PRIMARY_TO_SECONDARY
// ============================================================
router.get('/',
    requirePermissions(['FINANCE_VIEW_ALL']),
    transfersController.getTransfers
);

// ============================================================
// GET SINGLE TRANSFER WITH FULL APPROVAL HISTORY
// GET /api/transfers/:id
// ============================================================
router.get('/:id',
    requirePermissions(['FINANCE_VIEW_ALL']),
    validators.idParam('id'),
    validateRequest,
    transfersController.getTransferById
);

// ============================================================
// INITIATE A TRANSFER
// POST /api/transfers
// Any Director can initiate
// ============================================================
router.post('/',
    requirePermissions(['FINANCE_TRANSFER_CREATE']),
    [
        body('from_account_id')
            .isInt({ min: 1 }).withMessage('Source account is required'),
        body('to_account_id')
            .isInt({ min: 1 }).withMessage('Destination account is required'),
        body('amount_sent')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        // Optional — required only when the two accounts use different
        // currencies (enforced in the controller, which also locks it to
        // 1 automatically whenever they share a currency).
        body('exchange_rate')
            .optional().isFloat({ min: 0.00000001 }).withMessage('Exchange rate must be greater than zero'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('value_date')
            .isISO8601().withMessage('A valid date is required')
            .custom(notFutureDate),
        body('description')
            .optional().trim(),
    ],
    validateRequest,
    transfersController.initiateTransfer
);

// ============================================================
// EDIT A TRANSFER (before approval)
// PATCH /api/transfers/:id
// ============================================================
router.patch('/:id',
    requireAnyPermission(['FINANCE_TRANSFER_CREATE', 'FINANCE_TRANSFER_APPROVE']),
    validators.idParam('id'),
    [
        body('amount_sent').optional().isFloat({ min: 0.01 }),
        body('exchange_rate').optional().isFloat({ min: 0.00000001 }),
        body('category_id').optional().isInt({ min: 1 }),
        body('value_date').optional().isISO8601().custom(notFutureDate),
        body('description').optional().trim(),
    ],
    validateRequest,
    transfersController.editTransfer
);

// ============================================================
// APPROVE A TRANSFER
// POST /api/transfers/:id/approve
// ============================================================
router.post('/:id/approve',
    requirePermissions(['FINANCE_TRANSFER_APPROVE']),
    validators.idParam('id'),
    [
        body('notes').optional().trim(),
    ],
    validateRequest,
    transfersController.approveTransfer
);

// ============================================================
// REJECT A TRANSFER
// POST /api/transfers/:id/reject
// ============================================================
router.post('/:id/reject',
    requireAnyPermission(['FINANCE_TRANSFER_APPROVE', 'FINANCE_TRANSFER_APPROVE_REVERSE']),
    validators.idParam('id'),
    [
        body('reason')
            .trim().notEmpty().withMessage('A reason for rejection is required'),
    ],
    validateRequest,
    transfersController.rejectTransfer
);

module.exports = router;