// ============================================================
// SHARE CAPITAL ROUTES (v1.69.0)
// Prefix: /api/share-capital
// Nominal value, issue price, whole-share allotments, members' share
// credit and refunds, returns of allotment, and dual-approved changes.
// Role checks for proposing/approving a change are ALSO enforced in
// shareCapitalService against the database (a Director or the
// Treasurer; two different people; at least one Director; Admin alone
// never approves) — the route guards below only keep other roles out.
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requireRoles, requireFinancialAccess } = require('../middleware/auth');
const c = require('../controllers/shareCapitalController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

const STAFF = c.STAFF_VIEW_ROLES;                        // see the whole register
const APPROVERS = ['Director', 'Treasurer'];              // propose / approve / reject changes
const CONVERTERS = ['Treasurer', 'Admin'];                // one-off opening conversion
const REFUND_MAKERS = ['Treasurer', 'Assistant Treasurer'];
const REFUND_CHECKERS = ['Treasurer', 'Assistant Treasurer', 'Director'];
const RETURN_FILERS = ['Secretary', 'Assistant Secretary', 'Treasurer', 'Director', 'Admin'];

// ---- overview & statements ---------------------------------
router.get('/overview', requireFinancialAccess('FINANCE_VIEW_ALL'), c.getOverview);
router.get('/me', c.getMyStatement);
router.get('/members/:userId/statement',
    requireRoles(STAFF),
    validators.idParam('userId'), validateRequest,
    c.getMemberStatement
);

// ---- registered values (nominal value + registered shares) --
// Editable by a Director or the Treasurer until the first allotment;
// the service enforces the lock and the roles against the database.
router.get('/registered-setup', requireFinancialAccess('FINANCE_VIEW_ALL'), c.getRegisteredSetup);
router.put('/registered-setup',
    requireRoles(APPROVERS),
    [
        body('rows').isArray({ min: 1 }).withMessage('Enter at least one row'),
        body('rows.*.effective_from').isISO8601().withMessage('Each row needs a start date'),
        body('rows.*.nominal_value').isFloat({ gt: 0 }).withMessage('Each row needs a positive nominal value'),
        body('rows.*.registered_shares').optional({ values: 'null' }).custom(v => v === '' || (Number.isInteger(Number(v)) && Number(v) > 0))
            .withMessage('Registered shares must be a whole number above 0, or empty'),
        body('currency_id').isInt({ min: 1 }).withMessage('Choose the currency'),
        body('notes').optional({ values: 'falsy' }).isString(),
    ],
    validateRequest,
    c.saveRegisteredSetup
);

// ---- opening conversion ------------------------------------
router.get('/opening-conversion/preview', requireRoles(CONVERTERS), c.previewOpeningConversion);
router.post('/opening-conversion', requireRoles(CONVERTERS), c.commitOpeningConversion);

// ---- allotments & returns of allotment ---------------------
router.get('/allotments',
    requireRoles(STAFF),
    [
        query('month').optional().matches(/^\d{4}-\d{2}$/).withMessage('month must be YYYY-MM'),
        query('user_id').optional().isInt({ min: 1 }),
        query('pending_returns').optional().isIn(['true', 'false']),
    ],
    validateRequest,
    c.getAllotments
);
router.post('/allotments/returns',
    requireRoles(RETURN_FILERS),
    [
        body('allotment_ids').isArray({ min: 1 }).withMessage('allotment_ids must be a non-empty array'),
        body('allotment_ids.*').isInt({ min: 1 }),
        body('filed_at').optional().isISO8601(),
        body('return_reference').optional().isString().isLength({ max: 100 }),
    ],
    validateRequest,
    c.markReturnsFiled
);

// ---- share capital change requests -------------------------
router.get('/change-requests', requireFinancialAccess('FINANCE_VIEW_ALL'), c.getChangeRequests);
router.get('/resolutions', requireRoles(APPROVERS), c.getEligibleResolutions);
router.post('/change-requests',
    requireRoles(APPROVERS),
    [
        body('change_type').isIn(['ISSUE_PRICE', 'NOMINAL_VALUE', 'REGISTERED_SHARES']).withMessage('Invalid change_type'),
        body('proposed_value').isFloat({ gt: 0 }).withMessage('proposed_value must be a positive number'),
        body('effective_date').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid effective_date'),
        body('resolution_document_id').isInt({ min: 1 }).withMessage('Link the approved board resolution'),
        body('reason').isString().trim().notEmpty().withMessage('A reason is required'),
    ],
    validateRequest,
    c.createChangeRequest
);
router.post('/change-requests/:id/approve',
    requireRoles(APPROVERS), validators.idParam('id'), validateRequest, c.approveChangeRequest);
router.post('/change-requests/:id/reject',
    requireRoles(APPROVERS), validators.idParam('id'), validateRequest, c.rejectChangeRequest);
router.post('/change-requests/:id/cancel',
    requireRoles(APPROVERS), validators.idParam('id'), validateRequest, c.cancelChangeRequest);

// ---- share credit refunds ----------------------------------
router.get('/refunds', requireRoles(STAFF), c.getRefunds);
router.post('/refunds',
    requireRoles(REFUND_MAKERS),
    [
        body('user_id').isInt({ min: 1 }),
        body('credit_amount').isFloat({ gt: 0 }),
        body('account_id').isInt({ min: 1 }),
        body('reason').isString().trim().notEmpty().withMessage('A reason is required'),
    ],
    validateRequest,
    c.createRefund
);
router.post('/refunds/:id/approve',
    requireRoles(REFUND_CHECKERS), validators.idParam('id'),
    [body('payout_date').optional({ values: 'falsy' }).isISO8601()],
    validateRequest, c.approveRefund);
router.post('/refunds/:id/reject',
    requireRoles(REFUND_CHECKERS), validators.idParam('id'), validateRequest, c.rejectRefund);
router.post('/refunds/:id/cancel',
    requireRoles(REFUND_MAKERS), validators.idParam('id'), validateRequest, c.cancelRefund);

// ---- v1.81.0 — each member's shares registered with URSB ----
// The register for the whole company (staff); one member (themselves or
// staff); entering / correcting a member's URSB figure (the same people
// who file returns of allotment).
router.get('/registered-by-member', requireRoles(STAFF), c.getRegisteredByMember);
router.get('/registered-by-member/:userId', validators.idParam('userId'), validateRequest, c.getRegisteredForMember);
router.put('/registered-by-member/:userId',
    requireRoles(RETURN_FILERS),
    validators.idParam('userId'),
    [
        body('shares').isInt({ min: 0 }).withMessage('Registered shares must be a whole number (0 or more)'),
        body('as_at').isISO8601().withMessage('Give the date the URSB figure is as at'),
        body('note').optional({ values: 'falsy' }).isString().isLength({ max: 300 }),
        body('document_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('change_reason').optional({ values: 'falsy' }).isString().isLength({ max: 500 }),
    ],
    validateRequest,
    c.setRegisteredForMember
);

module.exports = router;
