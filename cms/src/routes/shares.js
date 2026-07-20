// ============================================================
// SHARES ROUTES
// Prefix: /api/shares
// Company-wide price-per-share, with history.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, blockAuditor, requireRoles } = require('../middleware/auth');
const sharesController = require('../controllers/sharesController');

router.use(authenticate);
router.use(blockAuditor);

// ============================================================
// GET CURRENT SHARE PRICE
// GET /api/shares/price
// Any authenticated user
// ============================================================
router.get('/price', sharesController.getCurrentPrice);

// ============================================================
// GET SHARE PRICE HISTORY
// GET /api/shares/price/history
// ============================================================
router.get('/price/history',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
    ],
    validateRequest,
    sharesController.getPriceHistory
);

// ============================================================
// SET NEW SHARE PRICE
// POST /api/shares/price
// Treasurer / Admin only
// ============================================================
router.post('/price',
    requireRoles(['Treasurer', 'Admin']),
    [
        body('price_per_share').isFloat({ gt: 0 }).withMessage('price_per_share must be a positive number'),
        body('currency_id').isInt().withMessage('currency_id is required'),
        body('effective_from').optional().isISO8601().withMessage('Invalid effective_from date'),
        body('notes').optional().isString(),
    ],
    validateRequest,
    sharesController.setSharePrice
);

module.exports = router;
