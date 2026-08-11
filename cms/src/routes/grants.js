// ============================================================
// GRANTS ROUTES
// Prefix: /api/grants
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View grants: Treasurer, Directors, Admin
//   - Create grants: Treasurer, Directors
//   - Approve grants: Treasurer
//   - Record tranches: Treasurer
//   - Manage conditions: Treasurer, Coordinator
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireAnyPermission } = require('../middleware/auth');
const grantsController = require('../controllers/grantsController');

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET ALL GRANTS
// GET /api/grants?status=ACTIVE
// ============================================================
router.get('/',
    requirePermissions(['GRANT_VIEW']),
    grantsController.getAllGrants
);

// ============================================================
// GET SINGLE GRANT
// GET /api/grants/:id
// ============================================================
router.get('/:id',
    requirePermissions(['GRANT_VIEW']),
    validators.idParam('id'),
    validateRequest,
    grantsController.getGrantById
);

// ============================================================
// CREATE A GRANT
// POST /api/grants
// ============================================================
router.post('/',
    requirePermissions(['GRANT_CREATE']),
    [
        body('account_id')
            .isInt({ min: 1 }).withMessage('A valid account is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('grantor_name')
            .trim().notEmpty().withMessage('Grantor name is required'),
        body('grantor_type')
            .isIn(['GOVERNMENT','NGO','BANK','INSTITUTION','INDIVIDUAL','OTHER'])
            .withMessage('Invalid grantor type'),
        body('title')
            .trim().notEmpty().withMessage('Grant title is required'),
        body('total_amount')
            .isFloat({ min: 0.01 }).withMessage('Total amount must be greater than zero'),
        body('is_conditional')
            .optional().isBoolean(),
        body('start_date')
            .optional().isISO8601().withMessage('Invalid start date'),
        body('end_date')
            .optional().isISO8601().withMessage('Invalid end date'),
        body('conditions')
            .optional().isArray().withMessage('Conditions must be an array'),
        body('conditions.*.title')
            .optional().trim().notEmpty().withMessage('Each condition must have a title'),
        body('conditions.*.due_date')
            .optional().isISO8601().withMessage('Invalid condition due date'),
    ],
    validateRequest,
    grantsController.createGrant
);

// ============================================================
// EDIT A GRANT (before approval)
// PATCH /api/grants/:id
// ============================================================
router.patch('/:id',
    requireAnyPermission(['GRANT_CREATE', 'GRANT_APPROVE']),
    validators.idParam('id'),
    [
        body('account_id').optional().isInt({ min: 1 }),
        body('category_id').optional().isInt({ min: 1 }),
        body('total_amount').optional().isFloat({ min: 0.01 }),
        body('grantor_type').optional().isIn(['GOVERNMENT','NGO','BANK','INSTITUTION','INDIVIDUAL','OTHER']),
        body('start_date').optional().isISO8601(),
        body('end_date').optional().isISO8601(),
    ],
    validateRequest,
    grantsController.editGrant
);

// ============================================================
// APPROVE A GRANT
// POST /api/grants/:id/approve
// ============================================================
router.post('/:id/approve',
    requirePermissions(['GRANT_APPROVE']),
    validators.idParam('id'),
    validateRequest,
    grantsController.approveGrant
);

// ============================================================
// RECORD A TRANCHE
// POST /api/grants/:id/tranches
// ============================================================
router.post('/:id/tranches',
    requirePermissions(['GRANT_APPROVE']),
    validators.idParam('id'),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('received_date')
            .isISO8601().withMessage('A valid date is required').custom(notFutureDate),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    grantsController.recordTranche
);

// ============================================================
// UPDATE GRANT CONDITION
// PATCH /api/grants/:id/conditions/:conditionId
// ============================================================
router.patch('/:id/conditions/:conditionId',
    requirePermissions(['GRANT_CONDITION_MANAGE']),
    validators.idParam('id'),
    validators.idParam('conditionId'),
    [
        body('status')
            .isIn(['PENDING','MET','FAILED','WAIVED'])
            .withMessage('Invalid condition status'),
        body('met_at')
            .optional().isISO8601().withMessage('Invalid date'),
    ],
    validateRequest,
    grantsController.updateCondition
);

module.exports = router;