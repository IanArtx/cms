// ============================================================
// LOANS ROUTES
// Prefix: /api/loans
// All routes require authentication.
//
// PERMISSION LEVELS:
//   - View loans: Treasurer, Directors, Admin
//   - Create loans: Treasurer, Directors
//   - Approve loans: Treasurer
//   - Record repayments: Treasurer
//   - Amend penalty rates: Treasurer only
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireRoles, requireAnyPermission } = require('../middleware/auth');
const loansController = require('../controllers/loansController');

// All routes require login
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// LOANS RECEIVED (company borrows)
// ============================================================

// Get all loans received
router.get('/received',
    requirePermissions(['LOAN_VIEW']),
    loansController.getAllLoansReceived
);

// Get single loan received
router.get('/received/:id',
    requirePermissions(['LOAN_VIEW']),
    validators.idParam('id'),
    validateRequest,
    loansController.getLoanReceivedById
);

// Create a loan received record
router.post('/received',
    requirePermissions(['LOAN_CREATE']),
    [
        body('account_id')
            .isInt({ min: 1 }).withMessage('A valid account is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('lender_type')
            .isIn(['BANK','INSTITUTION','INDIVIDUAL','MEMBER','AUTHORITY','OTHER'])
            .withMessage('Invalid lender type'),
        body('lender_name')
            .trim().notEmpty().withMessage('Lender name is required'),
        body('principal_amount')
            .isFloat({ min: 0.01 }).withMessage('Principal must be greater than zero'),
        body('fixed_interest_rate')
            .isFloat({ min: 0 }).withMessage('Fixed interest rate is required'),
        body('penalty_interest_rate')
            .isFloat({ min: 0 }).withMessage('Penalty interest rate is required'),
        body('interest_period')
            .isIn(['DAILY','WEEKLY','MONTHLY','ANNUALLY'])
            .withMessage('Invalid interest period'),
        body('interest_calculation')
            .isIn(['SIMPLE','COMPOUND'])
            .withMessage('Must be SIMPLE or COMPOUND'),
        body('due_date')
            .isISO8601().withMessage('A valid due date is required'),
        body('disbursement_date')
            .optional().isISO8601().withMessage('Invalid disbursement date').custom(notFutureDate),
        body('instalments')
            .optional().isInt({ min: 1 }).withMessage('Instalments must be a positive integer'),
        body('is_member_lender')
            .optional().isBoolean(),
        body('member_lender_id')
            .optional().isInt({ min: 1 }),
        body('witnesses')
            .optional().isArray(),
        body('witnesses.*.type')
            .optional().isIn(['DIRECTOR','EXTERNAL']),
        body('witnesses.*.user_id')
            .optional().isInt({ min: 1 }),
    ],
    validateRequest,
    loansController.createLoanReceived
);

// Edit a loan received before approval
router.patch('/received/:id',
    requireAnyPermission(['LOAN_CREATE', 'LOAN_APPROVE']),
    validators.idParam('id'),
    [
        body('principal_amount').optional().isFloat({ min: 0.01 }),
        body('fixed_interest_rate').optional().isFloat({ min: 0 }),
        body('penalty_interest_rate').optional().isFloat({ min: 0 }),
        body('interest_period').optional().isIn(['DAILY','WEEKLY','MONTHLY','ANNUALLY']),
        body('interest_calculation').optional().isIn(['SIMPLE','COMPOUND']),
        body('due_date').optional().isISO8601(),
        body('disbursement_date').optional().isISO8601().custom(notFutureDate),
        body('instalments').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    loansController.editLoanReceived
);

// Approve loan received
router.post('/received/:id/approve',
    requirePermissions(['LOAN_APPROVE']),
    validators.idParam('id'),
    validateRequest,
    loansController.approveLoanReceived
);

// Record repayment on loan received
router.post('/received/:id/repayments',
    requirePermissions(['LOAN_REPAYMENT_RECORD']),
    validators.idParam('id'),
    [
        // amount is required UNLESS is_payoff is set — the controller
        // computes the exact payoff amount itself from live outstanding
        // figures, ignoring whatever (if anything) was submitted here.
        body('is_payoff').optional().isBoolean(),
        body('amount')
            .custom((value, { req }) => {
                if (req.body.is_payoff === true || req.body.is_payoff === 'true') return true;
                if (value === undefined || value === null || parseFloat(value) <= 0) {
                    throw new Error('Amount must be greater than zero');
                }
                return true;
            }),
        body('payment_date')
            .isISO8601().withMessage('A valid payment date is required').custom(notFutureDate),
        body('schedule_id')
            .optional().isInt({ min: 1 }),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    loansController.recordLoanReceivedRepayment
);

// Amend penalty rate — Treasurer only
router.post('/received/:id/amend-rate',
    requireRoles(['Treasurer']),
    validators.idParam('id'),
    [
        body('new_penalty_rate')
            .isFloat({ min: 0 }).withMessage('New penalty rate is required'),
        body('reason')
            .trim().notEmpty().withMessage('A reason for the amendment is required'),
        body('effective_from')
            .isISO8601().withMessage('A valid effective date is required'),
    ],
    validateRequest,
    loansController.amendPenaltyRate
);

// ============================================================
// LOANS GIVEN (company lends money out)
// ============================================================

// Get all loans given
router.get('/given',
    requirePermissions(['LOAN_VIEW']),
    loansController.getAllLoansGiven
);

// Get single loan given
router.get('/given/:id',
    requirePermissions(['LOAN_VIEW']),
    validators.idParam('id'),
    validateRequest,
    loansController.getLoanGivenById
);

// Create a loan given record
router.post('/given',
    requirePermissions(['LOAN_CREATE']),
    [
        body('account_id')
            .isInt({ min: 1 }).withMessage('A valid account is required'),
        body('category_id')
            .isInt({ min: 1 }).withMessage('A valid category is required'),
        body('borrower_type')
            .isIn(['MEMBER','INDIVIDUAL','INSTITUTION','BANK','AUTHORITY','OTHER'])
            .withMessage('Invalid borrower type'),
        body('borrower_name')
            .trim().notEmpty().withMessage('Borrower name is required'),
        body('principal_amount')
            .isFloat({ min: 0.01 }).withMessage('Principal must be greater than zero'),
        body('fixed_interest_rate')
            .isFloat({ min: 0 }).withMessage('Fixed interest rate is required'),
        body('penalty_interest_rate')
            .isFloat({ min: 0 }).withMessage('Penalty interest rate is required'),
        body('interest_period')
            .isIn(['DAILY','WEEKLY','MONTHLY','ANNUALLY'])
            .withMessage('Invalid interest period'),
        body('interest_calculation')
            .isIn(['SIMPLE','COMPOUND'])
            .withMessage('Must be SIMPLE or COMPOUND'),
        body('due_date')
            .isISO8601().withMessage('A valid due date is required'),
        body('disbursement_date')
            .optional().isISO8601().withMessage('Invalid disbursement date').custom(notFutureDate),
        body('instalments')
            .optional().isInt({ min: 1 }),
    ],
    validateRequest,
    loansController.createLoanGiven
);

// Edit a loan given before approval
router.patch('/given/:id',
    requireAnyPermission(['LOAN_CREATE', 'LOAN_APPROVE']),
    validators.idParam('id'),
    [
        body('principal_amount').optional().isFloat({ min: 0.01 }),
        body('fixed_interest_rate').optional().isFloat({ min: 0 }),
        body('penalty_interest_rate').optional().isFloat({ min: 0 }),
        body('interest_period').optional().isIn(['DAILY','WEEKLY','MONTHLY','ANNUALLY']),
        body('interest_calculation').optional().isIn(['SIMPLE','COMPOUND']),
        body('due_date').optional().isISO8601(),
        body('disbursement_date').optional().isISO8601().custom(notFutureDate),
        body('instalments').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    loansController.editLoanGiven
);

// Approve loan given
router.post('/given/:id/approve',
    requirePermissions(['LOAN_APPROVE']),
    validators.idParam('id'),
    validateRequest,
    loansController.approveLoanGiven
);

// Record repayment received on loan given
router.post('/given/:id/repayments',
    requirePermissions(['LOAN_REPAYMENT_RECORD']),
    validators.idParam('id'),
    [
        body('is_payoff').optional().isBoolean(),
        body('amount')
            .custom((value, { req }) => {
                if (req.body.is_payoff === true || req.body.is_payoff === 'true') return true;
                if (value === undefined || value === null || parseFloat(value) <= 0) {
                    throw new Error('Amount must be greater than zero');
                }
                return true;
            }),
        body('payment_date')
            .isISO8601().withMessage('A valid payment date is required').custom(notFutureDate),
        body('schedule_id')
            .optional().isInt({ min: 1 }),
        body('notes')
            .optional().trim(),
    ],
    validateRequest,
    loansController.recordLoanGivenRepayment
);

// Amend penalty rate — Treasurer only
router.post('/given/:id/amend-rate',
    requireRoles(['Treasurer']),
    validators.idParam('id'),
    [
        body('new_penalty_rate')
            .isFloat({ min: 0 }).withMessage('New penalty rate is required'),
        body('reason')
            .trim().notEmpty().withMessage('A reason is required'),
        body('effective_from')
            .isISO8601().withMessage('A valid effective date is required'),
    ],
    validateRequest,
    loansController.amendLoanGivenRate
);

module.exports = router;