// ============================================================
// SEARCH ROUTES
// Prefix: /api/search
// ============================================================

const router = require('express').Router();
const { query } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted } = require('../middleware/auth');
const searchController = require('../controllers/searchController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GLOBAL SEARCH
// GET /api/search?q=...
// ============================================================
router.get('/',
    [ query('q').isString().isLength({ min: 2 }).withMessage('Search term must be at least 2 characters') ],
    validateRequest,
    searchController.globalSearch
);

module.exports = router;
