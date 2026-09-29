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
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireRoles } = require('../middleware/auth');
const transactionsController = require('../controllers/transactionsController');
const { holdMoneyEntry } = require('../middleware/holdMoneyEntry'); // v1.73.0

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

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
// TRANSACTION ANALYTICS (v1.50.0) — Income vs Expense by currency +
// most/least income/expense quarter, for the Transactions page's
// chart section. Same filters as the ledger itself. Registered
// before /:id (a static path would otherwise be swallowed by the
// dynamic one — same reasoning as capitalGoals.js's /my-calls).
// GET /api/transactions/analytics
// ============================================================
router.get('/analytics',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('from_date').optional().isISO8601().withMessage('from_date must be a valid date'),
        query('to_date').optional().isISO8601().withMessage('to_date must be a valid date'),
    ],
    validateRequest,
    transactionsController.getTransactionAnalytics
);

// ============================================================
// EXPORT TRANSACTIONS AS CSV (v1.50.0)
// GET /api/transactions/export — same filters as the ledger; clear
// every filter first to export the complete general ledger.
// ============================================================
router.get('/export',
    requirePermissions(['FINANCE_VIEW_ALL']),
    [
        query('account_id').optional().isInt({ min: 1 }),
        query('from_date').optional().isISO8601().withMessage('from_date must be a valid date'),
        query('to_date').optional().isISO8601().withMessage('to_date must be a valid date'),
    ],
    validateRequest,
    transactionsController.exportTransactionsCsv
);

// ============================================================
// REVERSAL REQUESTS (v1.72.0) — a reversal is asked for by the
// Treasurer and approved by a DIFFERENT person (Treasurer, Assistant
// Treasurer, Director or Admin; an Admin may approve their own).
// Declared before GET /:id so "reversal-requests" isn't read as an id.
// ============================================================
router.get('/reversal-requests',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Director', 'Admin']),
    [query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'pending', 'approved', 'rejected'])],
    validateRequest,
    transactionsController.listReversalRequests
);
router.post('/reversal-requests/:id/approve',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Director', 'Admin']),
    validators.idParam('id'),
    validateRequest,
    transactionsController.approveReversalRequest
);
router.post('/reversal-requests/:id/reject',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Director', 'Admin']),
    validators.idParam('id'),
    [body('note').optional({ values: 'falsy' }).trim().isLength({ max: 1000 })],
    validateRequest,
    transactionsController.rejectReversalRequest
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
            .isISO8601().withMessage('A valid date is required')
            .custom(notFutureDate),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('contributed_by')
            .optional().isInt({ min: 1 }).withMessage('Invalid member ID'),
        body('notes')
            .optional().trim(),
        // v1.26.0 — optional side fund portion sliced out of the total;
        // the remainder is what gets recorded as the contribution.
        body('side_fund_amount')
            .optional().isFloat({ min: 0.01 }).withMessage('Side fund portion must be greater than zero'),
        // v1.31.0 — optional savings portion, independent of and
        // additional to the side fund portion above; both are sliced
        // out of the same total (combined cross-field check happens in
        // the controller, since it needs the total amount too).
        body('savings_amount')
            .optional().isFloat({ min: 0.01 }).withMessage('Savings portion must be greater than zero'),
        // v1.33.0 — which account the contribution portion is actually
        // paid into (Side Fund/Savings portions are unaffected — those
        // always go to their own dedicated accounts regardless of this
        // field). Defaults to Primary if omitted.
        body('account_id')
            .optional().isInt({ min: 1 }).withMessage('Invalid account'),
    ],
    validateRequest,
    holdMoneyEntry('transactions.contribution', transactionsController.recordContribution, { label: 'Shareholder contribution', account: b => b.account_id, subject: { type: 'member', id: r => r.body.contributed_by } }), // v1.73.0 — held for approval unless Treasurer/Admin
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
            .isISO8601().withMessage('A valid date is required')
            .custom(notFutureDate),
        // v1.70.0 — tax treatment and supplier withholding (all optional)
        body('tax_treatment').optional({ values: 'falsy' })
            .isIn(['DEDUCTIBLE', 'NOT_DEDUCTIBLE', 'CAPITAL']).withMessage('Invalid tax treatment'),
        body('payee_name').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
        body('payee_tin').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
        body('payee_residency').optional({ values: 'falsy' }).isIn(['RESIDENT', 'NON_RESIDENT']),
        body('apply_wht').optional().isBoolean(),
    ],
    validateRequest,
    holdMoneyEntry('transactions.expense', transactionsController.recordExpense, { label: 'Expense', account: b => b.account_id }), // v1.73.0 — held for approval unless Treasurer/Admin
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
            .isISO8601().withMessage('A valid date is required')
            .custom(notFutureDate),
        // v1.70.0 — income received net of tax kept back by the payer
        body('income_type').optional({ values: 'falsy' }).isIn(['OTHER_INCOME', 'INTEREST_IN']),
        body('tax_deducted').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Tax deducted must be a number'),
        body('tax_treatment').optional({ values: 'falsy' }).isIn(['FINAL', 'CREDITABLE']),
        body('tax_source_type').optional({ values: 'falsy' })
            .isIn(['BANK_INTEREST', 'MMF', 'DIVIDEND_RECEIVED', 'OTHER_INCOME', 'OTHER', 'INVESTMENT_RETURN']),
        body('payer_name').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
        body('payer_tin').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
        body('tax_certificate_number').optional({ values: 'falsy' }).trim().isLength({ max: 60 }),
    ],
    validateRequest,
    holdMoneyEntry('transactions.inflow', transactionsController.recordInflow, { label: 'Other income', account: b => b.account_id }), // v1.73.0 — held for approval unless Treasurer/Admin
    transactionsController.recordInflow
);

// ============================================================
// REVERSE A TRANSACTION
// POST /api/transactions/:id/reverse
// Treasurer only. v1.72.0: this now ASKS for the reversal — it is
// posted when someone else approves the request (see above).
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