// ============================================================
// MONEY APPROVALS ROUTES (v1.73.0)
// Prefix: /api/money-approvals
//
// Money entries recorded by anyone who is not the Treasurer or an Admin
// are held here until the Treasurer or an Admin approves them (see
// middleware/holdMoneyEntry.js). The controller decides what each
// person may see and do:
//   GET  /               Treasurer/Admin: all entries; others: their own
//   POST /:id/approve    Treasurer or Admin (never their own)
//   POST /:id/reject     Treasurer/Admin refuse (reason required), or the
//                        person who recorded it withdraws it
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted } = require('../middleware/auth');
const c = require('../controllers/moneyApprovalsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

router.get('/', c.listHeld);

router.post('/:id/approve',
    [param('id').isInt({ min: 1 })],
    validateRequest,
    c.approveHeld
);

router.post('/:id/reject',
    [
        param('id').isInt({ min: 1 }),
        body('note').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    ],
    validateRequest,
    c.rejectHeld
);

module.exports = router;
