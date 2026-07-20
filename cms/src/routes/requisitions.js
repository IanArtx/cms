// ============================================================
// REQUISITIONS ROUTES
// Prefix: /api/requisitions
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requirePermissions, requireRoles } = require('../middleware/auth');
const requisitionsController = require('../controllers/requisitionsController');

router.use(authenticate);

// Get my own requisitions — any authenticated member
router.get('/me',
    requisitionsController.getMyRequisitions
);

// Get all requisitions — Treasurer and Directors
router.get('/',
    requirePermissions(['FINANCE_VIEW_ALL']),
    requisitionsController.getAllRequisitions
);

// Create a requisition — any authenticated member
// requisition_type: 'EXPENSE' (default, a money request),
// 'CONTRIBUTION_ACKNOWLEDGEMENT' (asking the Treasurer to record
// capital the member says they've already contributed), or
// 'SAVINGS_DEPOSIT' (asking to add money to their own savings —
// see savingsController.js).
router.post('/',
    [
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('title')
            .trim().notEmpty().withMessage('Title is required'),
        body('amount_requested')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('purpose')
            .trim().notEmpty().withMessage('Purpose is required'),
        body('description')
            .optional().trim(),
        body('required_by_date')
            .optional().isISO8601().withMessage('Invalid date'),
        body('priority')
            .optional()
            .isIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
            .withMessage('Invalid priority'),
        body('requisition_type')
            .optional()
            .isIn(['EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT'])
            .withMessage('Invalid requisition type'),
        body('contribution_date')
            .optional().isISO8601().withMessage('Invalid contribution date'),
    ],
    validateRequest,
    requisitionsController.createRequisition
);

// Edit a requisition before approval — the requester, or
// Treasurer/Assistant Treasurer.
router.patch('/:id',
    validators.idParam('id'),
    [
        body('category_id').optional().isInt({ min: 1 }),
        body('title').optional().trim().notEmpty(),
        body('amount_requested').optional().isFloat({ min: 0.01 }),
        body('purpose').optional().trim().notEmpty(),
        body('required_by_date').optional().isISO8601(),
        body('priority').optional().isIn(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
        body('requisition_type').optional().isIn(['EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT']),
        body('contribution_date').optional().isISO8601(),
    ],
    validateRequest,
    requisitionsController.editRequisition
);

// Approve a requisition — Treasurer and Assistant Treasurer.
// account_id is required for EXPENSE requisitions (which account to
// pay from) but not for CONTRIBUTION_ACKNOWLEDGEMENT — those always
// credit the primary account, resolved automatically.
router.post('/:id/approve',
    requireRoles(['Treasurer', 'Assistant Treasurer']),
    validators.idParam('id'),
    [
        body('account_id')
            .optional().isInt({ min: 1 }).withMessage('A valid account is required'),
        body('amount_approved')
            .optional().isFloat({ min: 0.01 }),
        body('review_notes')
            .optional().trim(),
    ],
    validateRequest,
    requisitionsController.approveRequisition
);

// Reject a requisition — Treasurer and Directors
router.post('/:id/reject',
    requirePermissions(['FINANCE_VIEW_ALL']),
    validators.idParam('id'),
    [
        body('review_notes')
            .trim().notEmpty().withMessage('A reason for rejection is required'),
    ],
    validateRequest,
    requisitionsController.rejectRequisition
);

module.exports = router;