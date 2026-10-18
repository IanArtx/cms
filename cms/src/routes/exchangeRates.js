// ============================================================
// CURRENCY EXCHANGE RATE ROUTES
// Prefix: /api/exchange-rates
// Company-set rates per currency pair. Since v1.66.0 they also value
// foreign-currency transactions in UGX for the financial statements.
// v1.83.0: daily Bank of Uganda suggestions (/suggestions, /feed) and
// the reference rate for the transfer form (/reference).
// ============================================================

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requireRoles, requireFinancialAccess } = require('../middleware/auth');
const exchangeRatesController = require('../controllers/exchangeRatesController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET CURRENT EXCHANGE RATES
// GET /api/exchange-rates/current
// v1.36.0: was "any authenticated user" — narrowed to the financial-
// role default, same as the rest of this system's financial data.
// ============================================================
router.get('/current', requireFinancialAccess('FINANCE_VIEW_ALL'), exchangeRatesController.getCurrentRates);

// ============================================================
// GET EXCHANGE RATE HISTORY
// GET /api/exchange-rates/history
// ============================================================
router.get('/history',
    requireFinancialAccess('FINANCE_VIEW_ALL'),
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validateRequest,
    exchangeRatesController.getRateHistory
);

// ============================================================
// FIXED-RATE RULES (v1.76.0)
// GET /api/exchange-rates/fixed
// ============================================================
router.get('/fixed', requireFinancialAccess('FINANCE_VIEW_ALL'), exchangeRatesController.getFixedRates);

// ============================================================
// SET A MONTHLY EXCHANGE RATE
// POST /api/exchange-rates
// Treasurer / Assistant Treasurer / Admin only
// ============================================================
router.post('/',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Admin']),
    [
        body('base_currency_id').isInt().withMessage('base_currency_id is required'),
        body('target_currency_id').isInt().withMessage('target_currency_id is required'),
        body('rate').isFloat({ gt: 0 }).withMessage('rate must be a positive number'),
        body('effective_from').optional().isISO8601().withMessage('Invalid effective_from date'),
        body('notes').optional().isString(),
    ],
    validateRequest,
    exchangeRatesController.setExchangeRate
);

// ============================================================
// DAILY BANK OF UGANDA RATES (v1.83.0)
// The feed suggests; a person approves. Viewing needs the usual
// financial access; deciding needs Treasurer / Assistant Treasurer /
// Admin (the same people who may set a rate by hand); switching the
// feed on/off and changing its limits is Admin (or Treasurer).
// ============================================================
const RATE_SETTERS = ['Treasurer', 'Assistant Treasurer', 'Admin'];

router.get('/suggestions',
    requireFinancialAccess('FINANCE_VIEW_ALL'),
    [
        query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'KEPT_MANUAL', 'SUPERSEDED', 'ALL']),
        query('limit').optional().isInt({ min: 1, max: 200 }),
    ],
    validateRequest,
    exchangeRatesController.listSuggestions
);

router.post('/suggestions/approve-all',
    requireRoles(RATE_SETTERS),
    exchangeRatesController.approveAllSuggestions
);

router.post('/suggestions/:id/approve',
    requireRoles(RATE_SETTERS),
    [
        param('id').isInt(),
        body('confirm_flagged').optional().isBoolean(),
    ],
    validateRequest,
    exchangeRatesController.approveSuggestion
);

router.post('/suggestions/:id/reject',
    requireRoles(RATE_SETTERS),
    [
        param('id').isInt(),
        body('reason').isString().trim().isLength({ min: 3, max: 500 }).withMessage('Say why the rate is rejected (at least 3 characters).'),
    ],
    validateRequest,
    exchangeRatesController.rejectSuggestion
);

router.get('/feed', requireFinancialAccess('FINANCE_VIEW_ALL'), exchangeRatesController.getFeedStatus);

router.post('/feed/run', requireRoles(RATE_SETTERS), exchangeRatesController.runFeedNow);

router.patch('/feed/settings',
    requireRoles(['Admin', 'Treasurer']),
    [
        body('enabled').optional().isBoolean(),
        body('jump_limit_pct').optional().isFloat({ gt: 0, max: 50 }),
        body('transfer_warn_pct').optional().isFloat({ gt: 0, max: 50 }),
    ],
    validateRequest,
    exchangeRatesController.updateFeedSettings
);

// The rate on file for a date — the transfer form compares the bank's
// rate with it. Same access as making a transfer screen needs.
router.get('/reference',
    requireFinancialAccess('FINANCE_VIEW_ALL'),
    [
        query('from').matches(/^(\d+|[A-Za-z]{3})$/).withMessage('from must be a currency id or code'),
        query('to').matches(/^(\d+|[A-Za-z]{3})$/).withMessage('to must be a currency id or code'),
        query('date').optional().isISO8601(),
    ],
    validateRequest,
    exchangeRatesController.getReferenceRate
);

module.exports = router;
