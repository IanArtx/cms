// ============================================================
// FINES ROUTES
// Prefix: /api/fines
// PERMISSION LEVELS:
//   - /me: any authenticated, role-assigned, consented member
//     (excluding Auditor/Administrative Officer, see below)
//   - List all / assign / clear: FINE_VIEW / FINE_MANAGE
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const {
    authenticate, requireAssignedRole, requireConsent,
    blockFinanceRestricted, requirePermissions,
} = require('../middleware/auth');
const finesController = require('../controllers/finesController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ============================================================
// GET MY FINES
// GET /api/fines/me
// Must be declared before GET /:id-style routes if any are ever
// added — none exist yet, but this matches the established
// convention elsewhere in this codebase.
// ============================================================
router.get('/me', finesController.getMyFines);

// ============================================================
// GET ALL FINES — Treasury oversight
// GET /api/fines
// ============================================================
router.get('/', requirePermissions(['FINE_VIEW']), finesController.getAllFines);

// ============================================================
// ASSIGN A FINE — Treasurer / Assistant Treasurer / Admin
// POST /api/fines
// ============================================================
router.post('/',
    requirePermissions(['FINE_MANAGE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('user_id is required'),
        body('reason').isIn(['CONTRIBUTION_FAILURE', 'MEETING_VIOLATION', 'GENERAL'])
            .withMessage('reason must be CONTRIBUTION_FAILURE, MEETING_VIOLATION, or GENERAL'),
        body('currency_id').isInt({ min: 1 }).withMessage('currency_id is required'),
        body('description').optional().isString(),
        body('amount').optional().isFloat({ gt: 0 }),
        body('default_deadline').optional().isISO8601(),
        body('defaulted_amount').optional().isFloat({ gt: 0 }),
        body('fine_percentage').optional().isFloat({ gt: 0, lt: 100 }),
    ],
    validateRequest,
    finesController.createFine
);

// ============================================================
// CLEAR A FINE DIRECTLY — Treasurer / Assistant Treasurer / Admin
// PATCH /api/fines/:id/clear
// Only a receiving account, paid date, and description are needed —
// everything else (currency match, category, the transaction) is
// handled by finesService.clearFine.
// ============================================================
router.patch('/:id/clear',
    requirePermissions(['FINE_MANAGE']),
    [
        param('id').isInt({ min: 1 }),
        body('account_id').isInt({ min: 1 }).withMessage('An account to receive the payment is required'),
        body('paid_date').optional().isISO8601(),
        body('description').optional().isString(),
    ],
    validateRequest,
    finesController.clearFineDirect
);

module.exports = router;
