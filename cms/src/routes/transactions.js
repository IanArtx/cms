// ============================================================
// TRANSACTIONS ROUTES
// Prefix: /api/transactions
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View transactions: Treasurer, Directors, Admin
//   - Record contributions: Treasurer, Assistant Treasurer ONLY.
//     Regular members can no longer post their own contribution —
//     they submit a CONTRIBUTION_ACKNOWLEDGEMENT requisition instead
//     (see routes/requisitions.js) and the Treasurer/Assistant
//     Treasurer records it on approval.
//   - Record expenses: Treasurer, Assistant Treasurer ONLY
//   - Reverse transactions: Treasurer only
// ============================================================

const router = require('express').Router();
const { body, param, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requirePermissions, requireRoles } = require('../middleware/auth');
const transactionsController = require('../controllers/transactionsController');

// All routes require login
router.use(authenticate);

// ============================================================
// GET TRANSACTION LEDGER
// GET /api/transactions?account_id=1&page=1&limit=20
// ============================================================
router.get('/',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('from_date').optional().isISO8601().withMessage('from_date must be a valid date'),
        query('to_date').optional().isISO8601().withMessage('to_date must be a valid date'),
    ],
    validateRequest,
    transactionsController.getTransactions
);

// ============================================================
// GET SINGLE TRANSACTION
// GET /api/transactions/:id
// ============================================================
router.get('/:id',
    requirePermissions(['FINANCE_VIEW_ALL']),
    validators.idParam('id'),
    validateRequest,
    transactionsController.getTransactionById
);

// ============================================================
// RECORD SHAREHOLDER CONTRIBUTION
// POST /api/transactions/contributions
// ============================================================
router.post('/contributions',
    requireRoles(['Treasurer', 'Assistant Treasurer']),
    [
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('contribution_date')
            .isISO8601().withMessage('A valid date is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('contributed_by')
            .optional().isInt({ min: 1 }).withMessage('Invalid member ID'),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    transactionsController.recordContribution
);

// ============================================================
// RECORD DIRECT EXPENSE
// POST /api/transactions/expenses
// ============================================================
router.post('/expenses',
    requireRoles(['Treasurer', 'Assistant Treasurer']),
    [
        body('account_id')
            .isInt({ min: 1 }).withMessage('A valid account is required'),
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('description')
            .trim().notEmpty().withMessage('Description is required'),
        body('value_date')
            .isISO8601().withMessage('A valid date is required'),
    ],
    validateRequest,
    transactionsController.recordExpense
);

// ============================================================
// RECORD GENERAL INFLOW
// POST /api/transactions/inflows
// ============================================================
router.post('/inflows',
    requireRoles(['Treasurer', 'Assistant Treasurer']),
    [
        body('account_id')
            .isInt({ min: 1 }).withMessage('A valid account is required'),
        body('amount')
            .isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('description')
            .trim().notEmpty().withMessage('Description is required'),
        body('value_date')
            .isISO8601().withMessage('A valid date is required'),
    ],
    validateRequest,
    transactionsController.recordInflow
);

// ============================================================
// REVERSE A TRANSACTION
// POST /api/transactions/:id/reverse
// Treasurer only — creates a reversal entry
// ============================================================
router.post('/:id/reverse',
    requireRoles(['Treasurer']),
    validators.idParam('id'),
    [
        body('reason')
            .trim().notEmpty().withMessage('A reason for the reversal is required'),
    ],
    validateRequest,
    transactionsController.reverseTransaction
);

module.exports = router;