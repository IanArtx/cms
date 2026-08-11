// ============================================================
// CURRENCY EXCHANGE RATE ROUTES
// Prefix: /api/exchange-rates
// Monthly rates, used to display the share price/value in
// currencies other than the one it was set in.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requireRoles } = require('../middleware/auth');
const exchangeRatesController = require('../controllers/exchangeRatesController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET CURRENT EXCHANGE RATES
// GET /api/exchange-rates/current
// Any authenticated user
// ============================================================
router.get('/current', exchangeRatesController.getCurrentRates);

// ============================================================
// GET EXCHANGE RATE HISTORY
// GET /api/exchange-rates/history
// ============================================================
router.get('/history',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validateRequest,
    exchangeRatesController.getRateHistory
);

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

module.exports = router;
