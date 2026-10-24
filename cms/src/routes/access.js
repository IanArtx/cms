// ============================================================
// ACCESS CONTROL ROUTES (v1.86.0) — prefix /api/access
// Everyone who manages members (USER_MANAGE) can decline, restore and
// invite; only an Admin changes the access settings.
// ============================================================

const router = require('express').Router();
const { body } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requirePermissions, requireRoles } = require('../middleware/auth');
const c = require('../controllers/accessControlController');

router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

router.get('/settings', requirePermissions(['USER_MANAGE']), c.getSettings);
router.put('/settings',
    requireRoles(['Admin']),
    [
        body('registration_mode').optional().isIn(['INVITE_ONLY', 'OPEN', 'CLOSED']),
        body('unverified_expiry_days').optional().isInt({ min: 1, max: 60 }),
        body('pending_expiry_days').optional().isInt({ min: 0, max: 365 }),
        body('auto_remove_days').optional().isInt({ min: 0, max: 60 }), // v1.87.0
        body('invite_valid_days').optional().isInt({ min: 1, max: 60 }),
        body('notify_admins').optional().isBoolean(),
        body('blocked_domains').optional().isArray({ max: 200 }),
    ],
    validateRequest,
    c.updateSettings
);

router.get('/requests', requirePermissions(['USER_MANAGE']), c.listRequests);
router.post('/decline',
    requirePermissions(['USER_MANAGE']),
    [
        body('user_ids').isArray({ min: 1, max: 500 }).withMessage('Choose at least one account'),
        body('user_ids.*').isInt({ min: 1 }),
        body('reason').trim().isLength({ min: 3, max: 500 }).withMessage('Give a short reason (3–500 characters)'),
        body('block_email').optional().isBoolean(),
        body('remove').optional().isBoolean(),
    ],
    validateRequest,
    c.decline
);
router.post('/restore',
    requirePermissions(['USER_MANAGE']),
    [body('user_id').isInt({ min: 1 }), body('unblock').optional().isBoolean()],
    validateRequest,
    c.restore
);

router.get('/invitations', requirePermissions(['USER_MANAGE']), c.listInvitations);
router.post('/invitations',
    requirePermissions(['USER_MANAGE']),
    [
        body('email').isEmail().withMessage('A valid email address is required').normalizeEmail() /* same normalisation as /auth/register, so the addresses match */,
        body('first_name').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
        body('last_name').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
        body('role_id').optional({ values: 'falsy' }).isInt({ min: 1 }),
        body('note').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
    ],
    validateRequest,
    c.createInvitation
);
router.post('/invitations/:id/resend', requirePermissions(['USER_MANAGE']), validators.idParam('id'), validateRequest, c.resendInvitation);
router.post('/invitations/:id/revoke', requirePermissions(['USER_MANAGE']), validators.idParam('id'), validateRequest, c.revokeInvitation);

router.get('/blocked-emails', requirePermissions(['USER_MANAGE']), c.listBlocked);
router.delete('/blocked-emails/:id', requirePermissions(['USER_MANAGE']), validators.idParam('id'), validateRequest, c.unblock);

module.exports = router;
