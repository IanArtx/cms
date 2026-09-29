// ============================================================
// MEMBER SAVINGS ROUTES
// Prefix: /api/savings
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireAnyPermission, requireRoles, requireFinancialAccess } = require('../middleware/auth');
const savingsController = require('../controllers/savingsController');
const { holdMoneyEntry } = require('../middleware/holdMoneyEntry'); // v1.73.0

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ------------------------------------------------------------
// STATIC ROUTES — must be declared before any /:id route below,
// otherwise Express would treat e.g. "handouts" as an :id value.
// ------------------------------------------------------------

// Own savings summary (flexible + fixed-term)
router.get('/me', savingsController.getMySavings);

// Own running flexible savings balance
router.get('/balance/me', savingsController.getMySavingsBalance);

// Own savings handouts
router.get('/handouts/me', savingsController.getMySavingsHandouts);

// Own savings-to-capital conversions (v1.58.0)
router.get('/capital-conversions/me', savingsController.getMySavingsCapitalConversions);

// A specific member's balance — for treasury to check before entering a handout
router.get('/balance/:userId',
    requireAnyPermission(['SAVINGS_VIEW', 'SAVINGS_HANDOUT_CREATE']),
    savingsController.getSavingsBalanceByUser
);

// Currencies that already have an active SAVINGS account set up
// (v1.61.0) — every currency picker on the Savings page needs this,
// so it's open to anyone holding any Savings-related permission
// rather than gated behind FINANCE_VIEW_ALL like the general
// accounts list.
router.get('/currencies',
    requireAnyPermission([
        'SAVINGS_VIEW', 'SAVINGS_CREATE', 'SAVINGS_HANDOUT_CREATE',
        'SAVINGS_CAPITAL_CONVERT_CREATE', 'SAVINGS_CURRENCY_CONVERT_CREATE',
    ]),
    savingsController.getSavingsCurrencies
);

// Company-wide interest settings. v1.36.0: was "anyone can view" (any
// authenticated user) — narrowed to the same financial-role default as
// the rest of this module's data; only Admin/Treasurer can change.
router.get('/settings', requireFinancialAccess('SAVINGS_VIEW'), savingsController.getSavingsSettings);
router.patch('/settings',
    requirePermissions(['SAVINGS_SETTINGS_MANAGE']),
    [
        body('interest_rate').optional().isFloat({ min: 0 }),
        body('interest_period').optional().isIn(['DAILY', 'WEEKLY', 'MONTHLY', 'ANNUALLY']),
        body('interest_calculation').optional().isIn(['SIMPLE', 'COMPOUND']),
    ],
    validateRequest,
    savingsController.updateSavingsSettings
);

// All members' handouts — Treasurer/Admin
router.get('/handouts',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getAllSavingsHandouts
);

// Enter a new handout — Treasurer/Assistant Treasurer
router.post('/handouts',
    requirePermissions(['SAVINGS_HANDOUT_CREATE']),
    [
        // No account_id here — a handout always pays out of the one
        // dedicated SAVINGS account for the chosen currency, resolved
        // server-side, never chosen by the client (Section 4.11).
        body('user_id').isInt({ min: 1 }).withMessage('A valid member is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        // v1.61.0 — which of the member's currency balances this pays out of.
        body('currency_id').isInt({ min: 1 }).withMessage('A currency is required'),
        body('principal_amount').isFloat({ min: 0.01 }).withMessage('Principal must be greater than zero'),
        body('interest_amount').optional().isFloat({ min: 0 }),
        body('handout_date').isISO8601().withMessage('A valid handout date is required').custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsController.createSavingsHandout
);

// Confirm / reject a handout — the receiving member only (checked in controller)
router.patch('/handouts/:id/confirm',
    validators.idParam('id'),
    validateRequest,
    savingsController.confirmSavingsHandout
);
router.patch('/handouts/:id/reject',
    validators.idParam('id'),
    [ body('reason').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsHandout
);

// Legacy fixed-term deposit — self-service, any shareholder
router.post('/fixed-term',
    requirePermissions(['FINANCE_TRANSACTION_CREATE']),
    [
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        // v1.61.0 — which Savings account/currency this fixed-term deposit goes into.
        body('currency_id').isInt({ min: 1 }).withMessage('A currency is required'),
        body('principal_amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('interest_rate').optional().isFloat({ min: 0 }),
        body('interest_period').optional().isIn(['DAILY', 'WEEKLY', 'MONTHLY', 'ANNUALLY']),
        body('deposit_date').isISO8601().withMessage('A valid deposit date is required').custom(notFutureDate),
        body('maturity_date').isISO8601().withMessage('A valid maturity date is required'),
        body('notes').optional().trim(),
    ],
    validateRequest,
    holdMoneyEntry('savings.fixedTerm', savingsController.createFixedTermSavings, { label: 'Fixed-term savings deposit', subject: { type: 'currency', id: r => r.body.currency_id } }), // v1.73.0 — held for approval unless Treasurer/Admin
    savingsController.createFixedTermSavings
);

// All members' savings — Treasurer/Admin
router.get('/',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getAllSavings
);

// Record a flexible deposit on behalf of a member — Treasurer/Assistant Treasurer
router.post('/',
    requirePermissions(['SAVINGS_CREATE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid member is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        // v1.61.0 — which Savings account/currency this deposit goes into.
        body('currency_id').isInt({ min: 1 }).withMessage('A currency is required'),
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('deposit_date').isISO8601().withMessage('A valid deposit date is required').custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsController.createSavingsDeposit
);

// ------------------------------------------------------------
// SAVINGS POOL "OTHER" INFLOW — a non-member credit into the SAVINGS
// account's pool (e.g. investment profit returned to the pool).
// Reuses SAVINGS_CREATE / SAVINGS_APPROVE — same Treasurer/Assistant
// Treasurer pipeline as a member deposit, no new permissions needed.
// Declared here (static path, no :id) before the /:id routes below.
// ------------------------------------------------------------
router.get('/pool-inflows',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getSavingsPoolInflows
);
router.post('/pool-inflows',
    requirePermissions(['SAVINGS_CREATE']),
    [
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        // v1.61.0 — which Savings account/currency this inflow lands in.
        body('currency_id').isInt({ min: 1 }).withMessage('A currency is required'),
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('value_date').isISO8601().withMessage('A valid date is required').custom(notFutureDate),
        body('description').trim().notEmpty().withMessage('A description is required'),
    ],
    validateRequest,
    savingsController.createSavingsPoolInflow
);
router.patch('/pool-inflows/:id/approve',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.approveSavingsPoolInflow
);
router.patch('/pool-inflows/:id/reject',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsPoolInflow
);

// ------------------------------------------------------------
// SAVINGS-TO-CAPITAL CONVERSION (v1.58.0) — a Treasurer/Assistant
// Treasurer redirects a member's own savings principal into a capital
// contribution instead of paying it out as cash. Nothing moves until
// the member themselves confirms it (checked in controller, same
// shape as Handouts above). Declared here (static paths, no bare
// /:id) before the /:id routes below.
// ------------------------------------------------------------
router.get('/capital-conversions',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getAllSavingsCapitalConversions
);
router.post('/capital-conversions',
    requirePermissions(['SAVINGS_CAPITAL_CONVERT_CREATE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid member is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        // v1.61.0 — which of the member's currency balances this draws from.
        body('currency_id').isInt({ min: 1 }).withMessage('A currency is required'),
        body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('conversion_date').isISO8601().withMessage('A valid conversion date is required').custom(notFutureDate),
        body('destination_account_id').optional().isInt({ min: 1 }),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsController.createSavingsCapitalConversion
);
router.patch('/capital-conversions/:id/confirm',
    validators.idParam('id'),
    validateRequest,
    savingsController.confirmSavingsCapitalConversion
);
router.patch('/capital-conversions/:id/reject',
    validators.idParam('id'),
    [ body('reason').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsCapitalConversion
);

// ------------------------------------------------------------
// SAVINGS CURRENCY CONVERSION (v1.61.0) — a Treasurer/Assistant
// Treasurer moves a member's own savings from one currency they hold
// into another they also hold, at a manually-entered exchange rate,
// with no bank charges. Nothing moves until the member themselves
// confirms it (checked in controller, same shape as Handouts/Capital
// Conversion above). Declared here (static paths, no bare /:id)
// before the /:id routes below.
// ------------------------------------------------------------
router.get('/currency-conversions/me', savingsController.getMySavingsCurrencyConversions);
router.get('/currency-conversions',
    requirePermissions(['SAVINGS_VIEW']),
    savingsController.getAllSavingsCurrencyConversions
);
router.post('/currency-conversions',
    requirePermissions(['SAVINGS_CURRENCY_CONVERT_CREATE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid member is required'),
        body('from_currency_id').isInt({ min: 1 }).withMessage('A source currency is required'),
        body('to_currency_id').isInt({ min: 1 }).withMessage('A destination currency is required'),
        body('from_amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than zero'),
        body('exchange_rate').isFloat({ gt: 0 }).withMessage('Exchange rate must be a positive number'),
        body('conversion_date').isISO8601().withMessage('A valid conversion date is required').custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsController.createSavingsCurrencyConversion
);
router.patch('/currency-conversions/:id/confirm',
    validators.idParam('id'),
    validateRequest,
    savingsController.confirmSavingsCurrencyConversion
);
router.patch('/currency-conversions/:id/reject',
    validators.idParam('id'),
    [ body('reason').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsCurrencyConversion
);

// ------------------------------------------------------------
// /:id ROUTES — must come after all the static routes above
// ------------------------------------------------------------

// Approve / reject a pending flexible deposit — Treasurer/Assistant Treasurer
router.patch('/:id/approve',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.approveSavingsDeposit
);
router.patch('/:id/reject',
    requirePermissions(['SAVINGS_APPROVE']),
    validators.idParam('id'),
    [ body('review_notes').optional().trim() ],
    validateRequest,
    savingsController.rejectSavingsDeposit
);

// Withdraw fixed-term savings at maturity — Treasurer only
router.post('/:id/withdraw',
    requireRoles(['Treasurer']),
    validators.idParam('id'),
    validateRequest,
    savingsController.withdrawSavings
);

module.exports = router;
