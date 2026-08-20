// ============================================================
// PAYMENT ACKNOWLEDGEMENTS ROUTES (v1.30.0, Section 4.35)
// Prefix: /api/payment-acknowledgements
//
// SELF-SERVICE routes (my, :id/acknowledge, :id/dispute) are open to
// any authenticated user, deliberately NOT gated by
// blockFinanceRestricted — an Administrative Officer is a legitimate
// recipient of service fee payments and must be able to acknowledge
// their own, the same reasoning routes/serviceFees.js already follows
// for its own self-service endpoints.
//
// TREASURY routes (the full list, and final approval) require
// PAYMENT_ACK_VIEW / PAYMENT_ACK_MANAGE respectively — permissions
// that start ungranted for every role including Admin, per this
// system's standard convention.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requirePermissions } = require('../middleware/auth');
const paymentAcknowledgementsController = require('../controllers/paymentAcknowledgementsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

// ============================================================
// SELF-SERVICE
// ============================================================

router.get('/my',
    paymentAcknowledgementsController.getMyAcknowledgements
);

router.post('/:id/acknowledge',
    validators.idParam('id'),
    [ body('note').optional().trim() ],
    validateRequest,
    paymentAcknowledgementsController.acknowledgeReceipt
);

router.post('/:id/dispute',
    validators.idParam('id'),
    [ body('reason').trim().notEmpty().withMessage('A reason is required') ],
    validateRequest,
    paymentAcknowledgementsController.disputeAcknowledgement
);

// ============================================================
// TREASURY OVERSIGHT
// ============================================================

router.get('/',
    requirePermissions(['PAYMENT_ACK_VIEW']),
    [
        query('status').optional().isIn(['PENDING_ACK', 'ACKNOWLEDGED', 'DISPUTED', 'FINAL_APPROVED']),
        query('source_type').optional().isIn(['DIVIDEND', 'SERVICE_FEE_PAYMENT', 'REIMBURSEMENT', 'SAVINGS_HANDOUT']),
    ],
    validateRequest,
    paymentAcknowledgementsController.getAllAcknowledgements
);

router.post('/:id/reopen',
    requirePermissions(['PAYMENT_ACK_MANAGE']),
    validators.idParam('id'),
    validateRequest,
    paymentAcknowledgementsController.reopenAcknowledgement
);

router.post('/:id/final-approve',
    requirePermissions(['PAYMENT_ACK_MANAGE']),
    validators.idParam('id'),
    validateRequest,
    paymentAcknowledgementsController.finalApprove
);

// ============================================================
// SHARED — must come after the more specific GET routes above so
// '/my' and the query-string list route aren't swallowed by :id
// ============================================================
router.get('/:id',
    validators.idParam('id'),
    validateRequest,
    paymentAcknowledgementsController.getAcknowledgementById
);

module.exports = router;
