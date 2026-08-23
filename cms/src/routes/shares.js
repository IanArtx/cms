// ============================================================
// SHARES ROUTES
// Prefix: /api/shares
// Company-wide price-per-share, with history.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requireRoles, requireFinancialAccess } = require('../middleware/auth');
const sharesController = require('../controllers/sharesController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET CURRENT SHARE PRICE
// GET /api/shares/price
// v1.36.0: was "any authenticated user" — narrowed to the financial-
// role default (Treasurer/Assistant Treasurer/Shareholder/Director/
// Admin), same as the rest of this system's financial data.
// ============================================================
router.get('/price', requireFinancialAccess('FINANCE_VIEW_ALL'), sharesController.getCurrentPrice);

// ============================================================
// GET SHARE PRICE HISTORY
// GET /api/shares/price/history
// ============================================================
router.get('/price/history',
    requireFinancialAccess('FINANCE_VIEW_ALL'),
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

// ============================================================
// SHAREHOLDING RECALCULATE — PREVIEW & COMMIT (v1.33.0)
// Admin-only. See sharesController.js for the full explanation — this
// is the unit-price shareholding recompute, with a mandatory preview
// step before anything real gets overwritten.
// ============================================================
router.get('/recalculate-preview',
    requireRoles(['Admin']),
    sharesController.previewRecalculate
);

router.post('/recalculate',
    requireRoles(['Admin']),
    sharesController.commitRecalculate
);

module.exports = router;
