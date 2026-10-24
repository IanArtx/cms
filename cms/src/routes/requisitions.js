// ============================================================
// REQUISITIONS ROUTES
// Prefix: /api/requisitions
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireRoles } = require('../middleware/auth');
const requisitionsController = require('../controllers/requisitionsController');
const { uploadSingle } = require('../middleware/upload'); // v1.80.0

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// Get my own requisitions — any authenticated member
router.get('/me',
    requisitionsController.getMyRequisitions
);

// v1.80.0 — investments a money request can be for (names only)
router.get('/investment-options', requisitionsController.getInvestmentOptions);

// Get all requisitions — Treasurer and Directors
router.get('/',
    requirePermissions(['FINANCE_VIEW_ALL']),
    requisitionsController.getAllRequisitions
);

// Create a requisition — any authenticated member
// requisition_type: 'EXPENSE' (default, a money request),
// 'CONTRIBUTION_ACKNOWLEDGEMENT' (asking the Treasurer to record
// capital the member says they've already contributed),
// 'SAVINGS_DEPOSIT' (asking to add money to their own savings —
// see savingsController.js), or 'SIDE_FUND_CONTRIBUTION' (v1.26.0 —
// asking to record a side fund payment already made; just an amount
// + date, the oldest-unpaid-first cascade sorts out which period(s)
// it covers), or 'FINE_PAYMENT' (v1.37.0 — asking to record a fine
// payment already made externally; requires fine_id so the Treasurer
// knows exactly which outstanding fine it settles).
router.post('/',
    [
        // v1.80.0 — optional when the requisition is for an investment
        // (its category is then Expense › Investments › <purpose>)
        body('category_id')
            .optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('A valid category is required'),
        body('investment_id').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Invalid investment'),
        body('investment_purpose').optional({ values: 'falsy' }).isIn(['CAPITAL', 'OPERATING', 'MAINTENANCE']).withMessage('Invalid purpose'),
        body('document_ids').optional().isArray(),
        body('title')
            .trim().notEmpty().withMessage('Title is required'),
        body('amount_requested')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('purpose')
            .trim().notEmpty().withMessage('Purpose is required'),
        body('description')
            .optional().trim(),
        // checkFalsy: true — an empty string ('') is "present" as far as
        // plain .optional() is concerned, so a blank date input (the
        // common case when this field isn't used, e.g. every EXPENSE
        // requisition) was reaching isISO8601() and failing validation
        // rather than being treated as omitted. Same fix applied to
        // contribution_date/fine_id below for the same reason.
        body('required_by_date')
            .optional({ checkFalsy: true }).isISO8601().withMessage('Invalid date'),
        body('priority')
            .optional()
            .isIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
            .withMessage('Invalid priority'),
        body('requisition_type')
            .optional()
            .isIn(['EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT', 'SIDE_FUND_CONTRIBUTION', 'FINE_PAYMENT'])
            .withMessage('Invalid requisition type'),
        body('contribution_date')
            .optional({ checkFalsy: true }).isISO8601().withMessage('Invalid contribution date').custom(notFutureDate),
        body('fine_id')
            .optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Invalid fine'),
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
        // Same checkFalsy fix as POST / above — a blank ('') date/id
        // field is "present" to plain .optional() and was failing
        // validation instead of being treated as omitted.
        body('required_by_date').optional({ checkFalsy: true }).isISO8601(),
        body('priority').optional().isIn(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
        body('requisition_type').optional().isIn(['EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT', 'SIDE_FUND_CONTRIBUTION', 'FINE_PAYMENT']),
        body('contribution_date').optional({ checkFalsy: true }).isISO8601().custom(notFutureDate),
        body('fine_id').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Invalid fine'),
        body('investment_id').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1 }),
        body('investment_purpose').optional({ nullable: true, values: 'falsy' }).isIn(['CAPITAL', 'OPERATING', 'MAINTENANCE']),
    ],
    validateRequest,
    requisitionsController.editRequisition
);

// ============================================================
// v1.80.0 — supporting documents of a requisition (needed before a
// money-out requisition can be approved). The requester while it is
// pending, or Treasury; checked in the controller.
// ============================================================
router.get('/:id/documents', validators.idParam('id'), validateRequest, requisitionsController.getRequisitionDocuments);
router.post('/:id/documents',
    validators.idParam('id'),
    [body('document_ids').isArray({ min: 1 }).withMessage('Choose at least one document')],
    validateRequest,
    requisitionsController.linkRequisitionDocuments
);
router.post('/:id/documents/upload',
    validators.idParam('id'),
    ...uploadSingle('document', 'documents'),
    requisitionsController.uploadRequisitionDocument
);
router.delete('/:id/documents/:documentId',
    validators.idParam('id'),
    validateRequest,
    requisitionsController.unlinkRequisitionDocument
);

// Approve a requisition.
// v1.87.0 — a money-out (EXPENSE) requisition: Treasurer, Assistant
// Treasurer, a Director or an Admin approve the amount; no money moves.
// Member payments to be recorded (contribution, side fund, fine): the
// Treasurer or Assistant Treasurer, and the money is recorded at once —
// account_id for FINE_PAYMENT (the account the fine was paid into); for
// CONTRIBUTION_ACKNOWLEDGEMENT it is optional (v1.69.1): the account the
// member paid into, in any currency; the primary account if omitted.
// The controller checks the role against the requisition's type.
router.post('/:id/approve',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Director', 'Admin']),
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

// v1.87.0 — release the money of an approved money request (Treasury,
// never the approver or the requester), then the requester acknowledges
// it — or reports a problem.
router.post('/:id/release',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Admin']),
    validators.idParam('id'),
    [
        body('account_id').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('A valid account is required'),
        body('release_date').isISO8601().withMessage('Enter the date the money was released').custom(notFutureDate),
        body('release_method').isIn(['BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE', 'OTHER']).withMessage('Choose how the money was paid'),
        body('release_reference').optional({ values: 'falsy' }).trim().isLength({ max: 120 }),
        body('release_notes').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
        body('document_ids').optional().isArray(),
    ],
    validateRequest,
    requisitionsController.releaseRequisition
);
router.post('/:id/acknowledge',
    validators.idParam('id'),
    [
        body('received_date').isISO8601().withMessage('Enter the date you received the money').custom(notFutureDate),
        body('note').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
        body('confirm').isBoolean().withMessage('Confirm you received the money'),
    ],
    validateRequest,
    requisitionsController.acknowledgeRequisition
);
router.post('/:id/report-issue',
    validators.idParam('id'),
    [body('note').trim().isLength({ min: 3, max: 1000 }).withMessage('Describe the problem (3–1000 characters)')],
    validateRequest,
    requisitionsController.reportRequisitionIssue
);

// Reject a requisition — Treasurer and Directors (v1.87.0: also one that
// was approved but whose money has not been released yet)
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