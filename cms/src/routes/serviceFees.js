// ============================================================
// SERVICE FEES ROUTES (v1.21.0)
// Prefix: /api/service-fees
//
// ADMIN routes (requireRoles(['Admin'])): create/edit a service fee
// agreement — the same direct-role-check treatment given to
// Settings, floor limits, and Audit engagement management.
// TREASURER routes (requireRoles(['Treasurer','Assistant Treasurer'])):
// record payments and review reimbursement requests — actually
// moving money is a Treasurer duty, same as everywhere else.
// SELF-SERVICE routes: open to any authenticated user (not just the
// Administrative Officer role), since a service fee arrangement
// could in principle be set up for anyone contracted this way.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requireRoles } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const serviceFeesController = require('../controllers/serviceFeesController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

// ============================================================
// ADMIN — AGREEMENTS
// ============================================================

router.get('/agreements',
    requireRoles(['Admin', 'Treasurer', 'Assistant Treasurer']),
    [query('status').optional().isIn(['ACTIVE', 'ENDED'])],
    validateRequest,
    serviceFeesController.listAgreements
);

router.get('/agreements/:id',
    requireRoles(['Admin', 'Treasurer', 'Assistant Treasurer']),
    validators.idParam('id'),
    validateRequest,
    serviceFeesController.getAgreementById
);

router.post('/agreements',
    requireRoles(['Admin']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('A valid user is required'),
        body('monthly_amount').isFloat({ gt: 0 }).withMessage('A valid monthly amount is required'),
        // currency_id is deliberately not accepted here — see createAgreement's
        // comment in serviceFeesController.js. It's derived from account_id.
        body('account_id').isInt({ min: 1 }).withMessage('A valid paying account is required'),
        body('category_id').isInt({ min: 1 }).withMessage('A valid category is required'),
        body('start_date').isISO8601().withMessage('A valid start date is required'),
        body('notes').optional().trim(),
    ],
    validateRequest,
    serviceFeesController.createAgreement
);

router.patch('/agreements/:id',
    requireRoles(['Admin']),
    validators.idParam('id'),
    [
        body('monthly_amount').optional().isFloat({ gt: 0 }),
        body('account_id').optional().isInt({ min: 1 }),
        body('category_id').optional().isInt({ min: 1 }),
        body('notes').optional().trim(),
        body('status').optional().isIn(['ACTIVE', 'ENDED']),
        body('end_date').optional().isISO8601(),
    ],
    validateRequest,
    serviceFeesController.updateAgreement
);

router.post('/agreements/:id/pay',
    requireRoles(['Treasurer', 'Assistant Treasurer', 'Admin']),
    validators.idParam('id'),
    [
        body('amount').optional().isFloat({ gt: 0 }),
        body('payment_date').optional().isISO8601().custom(notFutureDate),
        body('notes').optional().trim(),
    ],
    validateRequest,
    serviceFeesController.recordPayment
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
    requireRoles(['Admin', 'Treasurer', 'Assistant Treasurer']),
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
    requireRoles(['Treasurer', 'Assistant Treasurer']),
    validators.idParam('id'),
    [
        body('account_id').isInt({ min: 1 }).withMessage('A valid account is required'),
        body('review_notes').optional().trim(),
    ],
    validateRequest,
    serviceFeesController.approveReimbursement
);

router.post('/reimbursements/:id/reject',
    requireRoles(['Treasurer', 'Assistant Treasurer']),
    validators.idParam('id'),
    [body('review_notes').trim().notEmpty().withMessage('A reason is required')],
    validateRequest,
    serviceFeesController.rejectReimbursement
);

module.exports = router;
