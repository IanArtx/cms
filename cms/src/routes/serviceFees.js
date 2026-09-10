// ============================================================
// SERVICE FEES ROUTES (v1.21.0)
// Prefix: /api/service-fees
//
// v1.47.0 — converted from hardcoded requireRoles(['Admin']) /
// requireRoles(['Treasurer','Assistant Treasurer']) gates to the
// same permission-based system every other finance module
// (Fines, Requisitions, Payment Acknowledgements/Confirmations)
// already uses. Two new permissions:
//   - SERVICE_FEE_VIEW: list/read agreements and reimbursements —
//     lets a Treasurer/Admin monitor everything even if they don't
//     hold SERVICE_FEE_MANAGE, mirroring FINANCE_VIEW_ALL elsewhere.
//   - SERVICE_FEE_MANAGE: create/edit/terminate an agreement, record
//     a payment, approve/reject a reimbursement — actually moving
//     money or changing the arrangement.
// Neither permission is auto-granted to any role by the migration —
// an Admin must assign them via Settings > Roles > Permissions,
// same as every other permission added this way.
// SELF-SERVICE routes: open to any authenticated user (not just the
// Administrative Officer role), since a service fee arrangement
// could in principle be set up for anyone contracted this way.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requirePermissions } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const serviceFeesController = require('../controllers/serviceFeesController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

// ============================================================
// ADMIN — AGREEMENTS
// ============================================================

router.get('/agreements',
    requirePermissions(['SERVICE_FEE_VIEW']),
    [query('status').optional().isIn(['ACTIVE', 'ENDED'])],
    validateRequest,
    serviceFeesController.listAgreements
);

router.get('/agreements/:id',
    requirePermissions(['SERVICE_FEE_VIEW']),
    validators.idParam('id'),
    validateRequest,
    serviceFeesController.getAgreementById
);

router.post('/agreements',
    requirePermissions(['SERVICE_FEE_MANAGE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid user is required'),
        body('monthly_amount').isFloat({ gt: 0 }).withMessage('A valid monthly amount is required'),
        // currency_id is deliberately not accepted here — see createAgreement's
        // comment in serviceFeesController.js. It's derived from account_id.
        body('account_id').isInt({ min: 1 }).withMessage('A valid paying account is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('start_date').isISO8601().withMessage('A valid start date is required'),
        body('notes').optional().trim(),
        // v1.52.0 — the day of the month this agreement's fee is due;
        // falls back to start_date's own day-of-month if omitted (see
        // createAgreement).
        body('payment_day').optional().isInt({ min: 1, max: 28 }).withMessage('Payment day must be between 1 and 28'),
    ],
    validateRequest,
    serviceFeesController.createAgreement
);

router.patch('/agreements/:id',
    requirePermissions(['SERVICE_FEE_MANAGE']),
    validators.idParam('id'),
    [
        body('monthly_amount').optional().isFloat({ gt: 0 }),
        body('account_id').optional().isInt({ min: 1 }),
        body('category_id').optional().isInt({ min: 1 }),
        body('notes').optional().trim(),
        body('status').optional().isIn(['ACTIVE', 'ENDED']),
        body('end_date').optional().isISO8601(),
        // v1.47.0 — required by the controller only when monthly_amount
        // is actually changing (checked there, since that's conditional
        // on comparing against the existing row); optional here so a
        // PATCH that doesn't touch the amount isn't forced to send them.
        body('reason').optional().trim(),
        body('effective_from').optional().isISO8601().withMessage('Invalid effective date'),
        body('payment_day').optional().isInt({ min: 1, max: 28 }).withMessage('Payment day must be between 1 and 28'),
    ],
    validateRequest,
    serviceFeesController.updateAgreement
);

router.post('/agreements/:id/pay',
    requirePermissions(['SERVICE_FEE_MANAGE']),
    validators.idParam('id'),
    [
        body('amount').optional().isFloat({ gt: 0 }),
        body('payment_date').optional().isISO8601().custom(notFutureDate),
        body('notes').optional().trim(),
        body('payment_method').isIn(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'])
            .withMessage('payment_method must be CASH, BANK_TRANSFER, or MOBILE_MONEY'),
        body('mobile_money_provider').optional().isIn(['MTN', 'AIRTEL', 'OTHER']),
        body('external_reference').optional().trim().isLength({ max: 100 }),
    ],
    validateRequest,
    serviceFeesController.recordPayment
);

// v1.52.0 — read-only preview of outstanding months, used to
// pre-fill the "Settle Past Months" modal.
router.get('/agreements/:id/outstanding-periods',
    requirePermissions(['SERVICE_FEE_VIEW']),
    validators.idParam('id'),
    validateRequest,
    serviceFeesController.getOutstandingPeriods
);

// v1.52.0 — "issue to settle all past months": one lump-sum payment
// across an editable, auto-filled per-month breakdown.
router.post('/agreements/:id/settle',
    requirePermissions(['SERVICE_FEE_MANAGE']),
    validators.idParam('id'),
    [
        body('breakdown').isArray({ min: 1 }).withMessage('At least one month to settle is required'),
        body('breakdown.*.period_id').isInt({ min: 1 }),
        body('breakdown.*.amount').isFloat({ gt: 0 }),
        body('payment_date').optional().isISO8601().custom(notFutureDate),
        body('notes').optional().trim(),
        body('payment_method').isIn(['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'])
            .withMessage('payment_method must be CASH, BANK_TRANSFER, or MOBILE_MONEY'),
        body('mobile_money_provider').optional().isIn(['MTN', 'AIRTEL', 'OTHER']),
        body('external_reference').optional().trim().isLength({ max: 100 }),
    ],
    validateRequest,
    serviceFeesController.settlePastMonths
);

// v1.52.0 — per-month override, a single historical month's
// amount_due changed without touching the agreement's ongoing
// monthly_amount.
router.patch('/agreements/:id/periods/:periodId/override',
    requirePermissions(['SERVICE_FEE_MANAGE']),
    validators.idParam('id'),
    validators.idParam('periodId'),
    [
        body('amount_due').isFloat({ min: 0 }).withMessage('A valid amount is required'),
        body('reason').trim().notEmpty().withMessage('A reason is required'),
    ],
    validateRequest,
    serviceFeesController.overridePeriod
);

// v1.52.0 — treasury-wide chart/summary data, across every agreement.
router.get('/stats',
    requirePermissions(['SERVICE_FEE_VIEW']),
    serviceFeesController.getTreasuryStats
);

// ============================================================
// SELF-SERVICE — MY AGREEMENT
// ============================================================

router.get('/my-agreement',
    serviceFeesController.getMyAgreement
);

// ============================================================
// EXPENSE REIMBURSEMENTS
// ============================================================

router.post('/reimbursements',
    ...uploadSingle('receipt', 'service-fees'),
    [
        body('amount').isFloat({ gt: 0 }).withMessage('A valid amount is required'),
        body('currency_id').isInt({ min: 1 }).withMessage('A valid currency is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('description').trim().notEmpty().withMessage('A description is required'),
        body('expense_date').isISO8601().withMessage('A valid expense date is required').custom(notFutureDate),
    ],
    validateRequest,
    serviceFeesController.requestReimbursement
);

router.get('/my-reimbursements',
    serviceFeesController.getMyReimbursements
);

router.get('/reimbursements',
    requirePermissions(['SERVICE_FEE_VIEW']),
    [query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED'])],
    validateRequest,
    serviceFeesController.listReimbursements
);

router.get('/reimbursements/:id/receipt',
    validators.idParam('id'),
    validateRequest,
    serviceFeesController.previewReceipt
);

router.post('/reimbursements/:id/approve',
    requirePermissions(['SERVICE_FEE_MANAGE']),
    validators.idParam('id'),
    [
        body('account_id').isInt({ min: 1 }).withMessage('A valid account is required'),
        body('review_notes').optional().trim(),
    ],
    validateRequest,
    serviceFeesController.approveReimbursement
);

router.post('/reimbursements/:id/reject',
    requirePermissions(['SERVICE_FEE_MANAGE']),
    validators.idParam('id'),
    [body('review_notes').trim().notEmpty().withMessage('A reason is required')],
    validateRequest,
    serviceFeesController.rejectReimbursement
);

module.exports = router;
