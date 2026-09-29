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
const savingsFineSettlementController = require('../controllers/savingsFineSettlementController');
const { holdMoneyEntry } = require('../middleware/holdMoneyEntry'); // v1.73.0

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
    holdMoneyEntry('fines.clear', finesController.clearFineDirect, { label: 'Fine paid', account: b => b.account_id, subject: { type: 'fine', id: r => r.params.id } }), // v1.73.0 — held for approval unless Treasurer/Admin
    finesController.clearFineDirect
);

// ============================================================
// SETTLE FINES WITH SAVINGS (v1.59.0)
// Pay one or more of a member's own OUTSTANDING fines straight out of
// their savings principal. Two entry points funnelling into the same
// review flow — see savingsFineSettlementController.js's header
// comment for the full breakdown of who may call what. Static paths
// declared before any /:id-shaped route in this section (this file
// has no bare /:id route, only /:id/clear, so there's no collision
// risk either way — kept in this order for clarity, matching the
// convention used everywhere else in this codebase).
// ============================================================
router.get('/settlements/me', savingsFineSettlementController.getMySettlements);

router.get('/settlements',
    requirePermissions(['FINE_VIEW']),
    savingsFineSettlementController.getAllSettlements
);

// Treasurer/Assistant Treasurer enters it directly on a member's
// behalf — sits PENDING_CONFIRMATION until the member confirms.
router.post('/settlements',
    requirePermissions(['FINE_MANAGE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid member is required'),
        body('fine_ids').isArray({ min: 1 }).withMessage('Select at least one outstanding fine'),
        body('fine_ids.*').isInt({ min: 1 }),
        body('settlement_date').isISO8601().withMessage('A valid settlement date is required'),
        body('destination_account_id').optional().isInt({ min: 1 }),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsFineSettlementController.createSettlement
);

// A member requests it themselves, for their own fines/savings — sits
// PENDING_APPROVAL until a Treasurer/Assistant Treasurer approves it.
router.post('/settlements/request',
    [
        body('fine_ids').isArray({ min: 1 }).withMessage('Select at least one outstanding fine'),
        body('fine_ids.*').isInt({ min: 1 }),
        body('settlement_date').isISO8601().withMessage('A valid settlement date is required'),
        body('destination_account_id').optional().isInt({ min: 1 }),
        body('notes').optional().trim(),
    ],
    validateRequest,
    savingsFineSettlementController.requestSettlement
);

router.get('/settlements/:id/items',
    [ param('id').isInt({ min: 1 }) ],
    validateRequest,
    savingsFineSettlementController.getSettlementItems
);

// Member-side review of a Treasury-direct entry (ownership checked in
// controller — no permission gate here, same as Savings Handout
// confirm/reject).
router.patch('/settlements/:id/confirm',
    [ param('id').isInt({ min: 1 }) ],
    validateRequest,
    savingsFineSettlementController.confirmSettlement
);
router.patch('/settlements/:id/reject',
    [ param('id').isInt({ min: 1 }), body('reason').optional().trim() ],
    validateRequest,
    savingsFineSettlementController.rejectSettlement
);

// Treasurer-side review of a member's own request.
router.patch('/settlements/:id/approve',
    requirePermissions(['FINE_MANAGE']),
    [ param('id').isInt({ min: 1 }) ],
    validateRequest,
    savingsFineSettlementController.approveSettlement
);
router.patch('/settlements/:id/deny',
    requirePermissions(['FINE_MANAGE']),
    [ param('id').isInt({ min: 1 }), body('reason').optional().trim() ],
    validateRequest,
    savingsFineSettlementController.denySettlement
);

module.exports = router;
