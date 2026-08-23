// ============================================================
// PAYMENT CONFIRMATIONS ROUTES (v1.39.0)
// Prefix: /api/payment-confirmations
//
// SELF-SERVICE routes (my, :id/confirm, :id/dispute) are open to any
// authenticated, role-assigned, consented user — anyone in the system
// can be the recipient of a payment entry, the same reasoning
// routes/paymentAcknowledgements.js already follows.
//
// TREASURY routes (create, list all, cancel) require
// PAYMENT_ACK_VIEW / PAYMENT_ACK_MANAGE — the same permissions
// payment_acknowledgements already uses, since this lives in the same
// Payment Acknowledgements page as a second tab, not a separate module.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requirePermissions } = require('../middleware/auth');
const paymentConfirmationsController = require('../controllers/paymentConfirmationsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

// ============================================================
// TREASURY — CREATE
// ============================================================
router.post('/',
    requirePermissions(['PAYMENT_ACK_MANAGE']),
    [
        body('recipient_id').isInt({ min: 1 }).withMessage('recipient_id is required'),
        body('account_id').isInt({ min: 1 }).withMessage('account_id is required'),
        body('category_id').isInt({ min: 1 }).withMessage('category_id is required'),
        body('amount').isFloat({ gt: 0 }).withMessage('A positive amount is required'),
        body('entry_date').optional().isISO8601().withMessage('Invalid date'),
        body('payment_method').isIn(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'])
            .withMessage('payment_method must be CASH, BANK_TRANSFER, or MOBILE_MONEY'),
        body('mobile_money_provider').optional().isIn(['MTN', 'AIRTEL', 'OTHER']),
        body('external_reference').optional().trim().isLength({ max: 100 }),
        body('purpose').trim().notEmpty().withMessage('A purpose is required'),
    ],
    validateRequest,
    paymentConfirmationsController.createPaymentConfirmation
);

// ============================================================
// SELF-SERVICE
// ============================================================
router.get('/my',
    paymentConfirmationsController.getMyPaymentConfirmations
);

router.post('/:id/confirm',
    validators.idParam('id'),
    [ body('note').optional().trim() ],
    validateRequest,
    paymentConfirmationsController.confirmPayment
);

router.post('/:id/dispute',
    validators.idParam('id'),
    [ body('reason').trim().notEmpty().withMessage('A reason is required') ],
    validateRequest,
    paymentConfirmationsController.disputePayment
);

// ============================================================
// TREASURY OVERSIGHT
// ============================================================
router.get('/',
    requirePermissions(['PAYMENT_ACK_VIEW']),
    [
        query('status').optional().isIn(['PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED', 'CANCELLED']),
        query('source_type').optional().isIn(['GENERAL_PAYMENT', 'SERVICE_FEE_PAYMENT']),
    ],
    validateRequest,
    paymentConfirmationsController.getAllPaymentConfirmations
);

router.post('/:id/cancel',
    requirePermissions(['PAYMENT_ACK_MANAGE']),
    validators.idParam('id'),
    [ body('reason').optional().trim() ],
    validateRequest,
    paymentConfirmationsController.cancelPaymentConfirmation
);

// ============================================================
// SHARED — must come after the more specific GET routes above so
// '/my' and the query-string list route aren't swallowed by :id
// ============================================================
router.get('/:id',
    validators.idParam('id'),
    validateRequest,
    paymentConfirmationsController.getPaymentConfirmationById
);

module.exports = router;
