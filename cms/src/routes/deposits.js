// ============================================================
// DEPOSITS ROUTES (v1.38.0)
// Prefix: /api/deposits
// PERMISSION LEVELS:
//   - /me, /settings (GET): any authenticated, role-assigned,
//     consented member (excluding Auditor/Administrative Officer)
//   - Everything else: DEPOSIT_VIEW / DEPOSIT_MANAGE
// ============================================================

const router = require('express').Router();
const { body, param, query: queryValidator } = require('express-validator');
const { validateRequest, notFutureDate } = require('../middleware/validate');
const {
    authenticate, requireAssignedRole, requireConsent,
    blockFinanceRestricted, requirePermissions,
} = require('../middleware/auth');
const depositsController = require('../controllers/depositsController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);
router.use(blockFinanceRestricted);

// ------------------------------------------------------------
// SETTINGS / TARGET
// ------------------------------------------------------------
router.get('/settings', depositsController.getDepositConfig);

router.patch('/settings',
    requirePermissions(['DEPOSIT_MANAGE']),
    [
        body('target_amount').optional().isFloat({ min: 0 }),
        body('currency_id').optional().isInt({ min: 1 }),
    ],
    validateRequest,
    depositsController.updateDepositConfig
);

// ------------------------------------------------------------
// MY DEPOSIT — self-scoped
// ------------------------------------------------------------
router.get('/me', depositsController.getMyDeposit);

// ------------------------------------------------------------
// ALL DEPOSITS — Treasury oversight
// ------------------------------------------------------------
router.get('/', requirePermissions(['DEPOSIT_VIEW']), depositsController.getAllDeposits);

// ------------------------------------------------------------
// STANDALONE DEPOSIT ENTRY
// ------------------------------------------------------------
router.post('/',
    requirePermissions(['DEPOSIT_MANAGE']),
    [
        body('user_id').isInt({ min: 1 }).withMessage('user_id is required'),
        body('account_id').isInt({ min: 1 }).withMessage('account_id is required'),
        body('amount').isFloat({ gt: 0 }).withMessage('A positive amount is required'),
        body('entry_date').optional().isISO8601().withMessage('Invalid date').custom(notFutureDate),
        body('description').optional().isString(),
    ],
    validateRequest,
    depositsController.createStandaloneDeposit
);

// ------------------------------------------------------------
// EXCUSALS
// ------------------------------------------------------------
router.get('/excusals', requirePermissions(['DEPOSIT_MANAGE']), depositsController.getExcusals);

router.put('/excusals/:userId',
    requirePermissions(['DEPOSIT_MANAGE']),
    [
        param('userId').isInt({ min: 1 }),
        body('reason').optional().isString(),
    ],
    validateRequest,
    depositsController.setExcusal
);

router.delete('/excusals/:userId',
    requirePermissions(['DEPOSIT_MANAGE']),
    [param('userId').isInt({ min: 1 })],
    validateRequest,
    depositsController.clearExcusal
);

// ------------------------------------------------------------
// EXIT REFUND
// ------------------------------------------------------------
router.get('/:userId/exit-preview',
    requirePermissions(['DEPOSIT_MANAGE']),
    [
        param('userId').isInt({ min: 1 }),
        queryValidator('exit_type').optional().isIn(['MUTUAL_AGREEMENT', 'FORCED']),
        queryValidator('deduction_percentage').optional().isFloat({ min: 0, max: 100 }),
    ],
    validateRequest,
    depositsController.getExitRefundPreview
);

router.patch('/:userId/exit-refund',
    requirePermissions(['DEPOSIT_MANAGE']),
    [
        param('userId').isInt({ min: 1 }),
        body('exit_type').isIn(['MUTUAL_AGREEMENT', 'FORCED']).withMessage('exit_type must be MUTUAL_AGREEMENT or FORCED'),
        body('deduction_percentage').optional().isFloat({ min: 50, max: 100 })
            .withMessage('deduction_percentage must be between 50 and 100'),
        body('source_account_id').optional().isInt({ min: 1 }),
        body('exchange_rate').optional().isFloat({ min: 0.000001 }),
        body('notes').optional().isString(),
    ],
    validateRequest,
    depositsController.processExitRefundHandler
);

module.exports = router;
