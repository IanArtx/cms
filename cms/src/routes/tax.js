// ============================================================
// TAX ROUTES (v1.70.0)
// Prefix: /api/tax
// Withholding tax (deducted from the company and withheld by it),
// corporate income tax years, payments to URA, deadlines. Who may do
// what is ALSO checked in taxService against the database:
//   see                  Treasurer, Assistant Treasurer, Director, Admin, Secretary
//   record / prepare     Treasurer, Assistant Treasurer
//   approve computation  Director (not the preparer)
//   registration details Admin, Director, Treasurer
//   WHT agent switch     Director, Treasurer
// Everyone can see their OWN withholdings (/my-withholdings).
// ============================================================

const router = require('express').Router();
const { body, query } = require('express-validator');
const { validateRequest, validators, notFutureDate } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requireRoles } = require('../middleware/auth');
const c = require('../controllers/taxController');
const { holdMoneyEntry } = require('../middleware/holdMoneyEntry'); // v1.73.0
const { ROLES } = require('../services/taxService');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

// A member's own withholdings (their certificates are in My Documents).
router.get('/my-withholdings', c.getMyWithholdings);

router.use(blockFinanceRestricted);

const VIEW = ROLES.VIEW;
const PREPARE = ROLES.PREPARE;
const APPROVE = ROLES.APPROVE;

// ---- overview, registration, agent status ------------------
router.get('/overview', requireRoles(VIEW), c.getOverview);
router.get('/registration', requireRoles(VIEW), c.getRegistration);
router.put('/registration',
    requireRoles(ROLES.SETTINGS),
    [
        body('tin').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
        body('registration_number').optional({ values: 'falsy' }).trim().isLength({ max: 50 }),
        body('incorporation_date').optional({ values: 'falsy' }).isISO8601().withMessage('Invalid incorporation date').custom(notFutureDate),
        body('tax_office').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
    ],
    validateRequest,
    c.saveRegistration
);
router.post('/agent-status',
    requireRoles(ROLES.AGENT),
    [
        body('designated').isBoolean().withMessage('Say whether the company is designated'),
        body('effective_date').isISO8601().withMessage('The date it takes effect is required'),
        body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }),
    ],
    validateRequest,
    c.setAgentStatus
);

// ---- rates -------------------------------------------------
router.get('/rates', requireRoles(VIEW), c.getRates);
router.post('/rates',
    requireRoles(PREPARE.concat(APPROVE)),
    [
        body('code').isString().trim().notEmpty(),
        body('rate').isFloat({ min: 0, max: 100 }).withMessage('Rate is a percentage between 0 and 100'),
        body('treatment').optional({ values: 'null' }).isIn(['', 'FINAL', 'CREDITABLE']),
        body('threshold_amount').optional({ values: 'null' }).custom(v => v === '' || !Number.isNaN(parseFloat(v))),
        body('effective_from').isISO8601().withMessage('The date the rate starts is required'),
        body('legal_reference').optional({ values: 'falsy' }).trim(),
        body('notes').optional({ values: 'falsy' }).trim(),
    ],
    validateRequest,
    c.addRate
);

// ---- tax the company withholds ------------------------------
router.get('/withholdings',
    requireRoles(VIEW),
    [
        query('status').optional().isIn(['PENDING', 'REMITTED', 'SHADOW', 'REVERSED']),
        query('month').optional().matches(/^\d{4}-\d{2}$/),
        query('payment_type').optional().isIn(['DIVIDEND', 'SAVINGS_INTEREST', 'LOAN_INTEREST', 'SERVICE_FEE', 'SUPPLIER', 'NON_RESIDENT_SERVICE', 'OTHER']),
    ],
    validateRequest,
    c.getWithholdings
);
router.get('/withholding-preview',
    requireRoles(VIEW),
    [
        query('payment_type').isIn(['DIVIDEND', 'SAVINGS_INTEREST', 'LOAN_INTEREST', 'SERVICE_FEE', 'SUPPLIER', 'NON_RESIDENT_SERVICE']),
        query('gross').isFloat({ gt: 0 }),
        query('currency_id').optional().isInt({ min: 1 }),
        query('currency_code').optional().isLength({ min: 3, max: 3 }),
        query('date').optional().isISO8601(),
        query('residency').optional().isIn(['RESIDENT', 'NON_RESIDENT']),
    ],
    validateRequest,
    c.previewWithholding
);
router.get('/remittances', requireRoles(VIEW), c.getRemittances);
router.post('/remittances',
    requireRoles(PREPARE),
    [
        body('month').matches(/^\d{4}-\d{2}$/).withMessage('Choose the month (YYYY-MM)'),
        body('account_id').isInt({ min: 1 }).withMessage('Choose the account it was paid from'),
        body('paid_date').isISO8601().withMessage('The payment date is required').custom(notFutureDate),
        body('prn').optional({ values: 'falsy' }).trim().isLength({ max: 40 }),
        body('return_reference').optional({ values: 'falsy' }).trim().isLength({ max: 60 }),
        body('notes').optional({ values: 'falsy' }).trim(),
    ],
    validateRequest,
    holdMoneyEntry('tax.remittance', c.remitMonth, { label: 'Withholding tax paid to URA (month)', account: b => b.account_id }), // v1.73.0 — held for approval unless Treasurer/Admin
    c.remitMonth
);

// ---- tax deducted from the company --------------------------
router.get('/at-source', requireRoles(VIEW), c.getAtSource);
router.post('/at-source',
    requireRoles(PREPARE),
    [
        body('account_id').isInt({ min: 1 }),
        body('source_type').optional({ values: 'falsy' })
            .isIn(['BANK_INTEREST', 'MMF', 'DIVIDEND_RECEIVED', 'OTHER_INCOME', 'OTHER', 'INVESTMENT_RETURN', 'BOND_COUPON', 'TREASURY_BILL']),
        body('payer_name').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
        body('payer_tin').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
        body('gross_amount').isFloat({ gt: 0 }).withMessage('Enter the gross income the tax was taken from'),
        body('tax_amount').isFloat({ gt: 0 }).withMessage('Enter the tax deducted'),
        body('treatment').isIn(['FINAL', 'CREDITABLE']),
        body('deduction_date').isISO8601().custom(notFutureDate),
        body('certificate_number').optional({ values: 'falsy' }).trim().isLength({ max: 60 }),
        body('income_transaction_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('notes').optional({ values: 'falsy' }).trim(),
    ],
    validateRequest,
    holdMoneyEntry('tax.atSource', c.recordAtSource, { label: 'Tax deducted at source', account: b => b.account_id }), // v1.73.0 — held for approval unless Treasurer/Admin
    c.recordAtSource
);
router.patch('/at-source/:id',
    requireRoles(PREPARE),
    validators.idParam('id'),
    [
        body('treatment').optional({ values: 'falsy' }).isIn(['FINAL', 'CREDITABLE']),
        body('certificate_number').optional({ values: 'falsy' }).trim().isLength({ max: 60 }),
        body('certificate_received_at').optional({ values: 'falsy' }).isISO8601(),
        body('payer_tin').optional({ values: 'falsy' }).trim().isLength({ max: 20 }),
        body('payer_name').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
        body('notes').optional({ values: 'falsy' }).trim(),
    ],
    validateRequest,
    c.updateAtSource
);

// ---- corporate income tax years -----------------------------
router.get('/years', requireRoles(VIEW), c.getYears);
router.get('/years/:id/worksheet', requireRoles(VIEW), validators.idParam('id'), validateRequest, c.getWorksheet);
router.patch('/years/:id/options',
    requireRoles(PREPARE), validators.idParam('id'),
    [
        body('include_pre_incorporation').optional().isBoolean(),
        body('fx_revaluation_taxable').optional().isBoolean(),
        body('notes').optional({ values: 'null' }).isString(),
    ],
    validateRequest, c.updateYearOptions);
router.put('/years/:id/provisional',
    requireRoles(PREPARE), validators.idParam('id'),
    [body('estimate').isFloat({ min: 0 }).withMessage('Enter the estimated chargeable income (0 or more)')],
    validateRequest, c.setProvisional);
router.post('/years/:id/adjustments',
    requireRoles(PREPARE), validators.idParam('id'),
    [
        body('kind').isIn(['ADD_BACK', 'DEDUCTION']),
        body('description').trim().notEmpty().withMessage('Describe the adjustment'),
        body('amount').isFloat({ gt: 0 }).withMessage('Amount must be above 0 (UGX)'),
        body('legal_reference').optional({ values: 'falsy' }).trim(),
    ],
    validateRequest, c.addAdjustment);
router.delete('/adjustments/:id', requireRoles(PREPARE), validators.idParam('id'), validateRequest, c.removeAdjustment);
router.post('/years/:id/prepare', requireRoles(PREPARE), validators.idParam('id'), validateRequest, c.prepareYear);
router.post('/years/:id/return',
    requireRoles(APPROVE.concat(PREPARE)), validators.idParam('id'),
    [body('reason').optional({ values: 'falsy' }).trim()], validateRequest, c.returnYear);
router.post('/years/:id/approve', requireRoles(APPROVE), validators.idParam('id'), validateRequest, c.approveYear);
router.post('/years/:id/file',
    requireRoles(PREPARE.concat(APPROVE)), validators.idParam('id'),
    [
        body('filing_date').isISO8601().withMessage('The date the return was filed is required').custom(notFutureDate),
        body('return_reference').optional({ values: 'falsy' }).trim().isLength({ max: 60 }),
    ],
    validateRequest, c.fileYear);

// ---- payments to / from URA ---------------------------------
router.post('/payments',
    requireRoles(PREPARE),
    [
        body('kind').isIn(['PROVISIONAL', 'INCOME_TAX_BALANCE', 'LATE_INTEREST', 'REFUND_RECEIVED']),
        body('tax_year_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('instalment_no').optional({ values: 'falsy' }).isInt({ min: 1, max: 2 }),
        body('amount').isFloat({ gt: 0 }),
        body('account_id').isInt({ min: 1 }),
        body('paid_date').isISO8601().custom(notFutureDate),
        body('prn').optional({ values: 'falsy' }).trim().isLength({ max: 40 }),
        body('notes').optional({ values: 'falsy' }).trim(),
    ],
    validateRequest,
    holdMoneyEntry('tax.payment', c.recordPayment, { label: 'Tax payment / refund', account: b => b.account_id }), // v1.73.0 — held for approval unless Treasurer/Admin
    c.recordPayment
);

router.get('/calendar', requireRoles(VIEW), c.getCalendar);

module.exports = router;
