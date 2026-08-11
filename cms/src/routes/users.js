// ============================================================
// USERS ROUTES
// Prefix: /api/users
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, blockFinanceRestricted, requirePermissions, requireRoles, isSelfOrHasPermission } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const usersController = require('../controllers/usersController');
const { asyncHandler } = require('../utils/errors');
const { query } = require('../config/database');
const { sendSuccess } = require('../utils/response');

// All routes require authentication
router.use(authenticate);

// --- PUBLIC TO ALL AUTHENTICATED USERS ---
// (deliberately NOT behind requireAssignedRole — a zero-role, pending
// account still needs to see/edit its own profile and check whether
// its role request has been reviewed yet)
router.get('/me',                   usersController.getMyProfile);
router.get('/roles',                usersController.getAllRoles);
// The requester's own most recent role request (or null) — feeds the
// pending-approval page a pending user is redirected to (Section 3).
router.get('/me/role-request',      usersController.getMyRoleRequest);
// Membership Agreement text + this user's consent status, and the
// consent submission itself — feeds the Consent page a role-assigned-
// but-not-yet-consented user is redirected to (Section 4.29). Also
// deliberately NOT behind requireAssignedRole/requireConsent — this
// is the one thing a not-yet-consented account most needs to reach.
router.get('/me/membership-agreement', usersController.getMembershipAgreement);
router.post('/me/consent',             usersController.giveConsent);
// Draw-and-save a personal signature — needed before consent can be
// given, and reusable later (Settings -> My Profile) to redraw it.
router.patch('/me/signature',
    [body('signature_data_url').notEmpty().withMessage('signature_data_url is required')],
    validateRequest,
    usersController.updateSignature
);
// Company-wide shareholding list — real member ownership data, not scoped
// to the requester. Every other role that can reach this point is an
// actual member; an Auditor is the one authenticated role that isn't, and
// a zero-role pending account is another, so both are excluded here
// rather than opened up to everyone.
router.get('/shareholding',         requireAssignedRole, requireConsent, blockFinanceRestricted, usersController.getShareholding);

router.patch('/me',
    [
        body('first_name').optional().trim().notEmpty().isLength({ max: 100 }),
        body('last_name').optional().trim().notEmpty().isLength({ max: 100 }),
        body('date_of_birth').optional().isISO8601(),
        body('phone').optional().isLength({ max: 30 }),
        body('gender').optional().isIn(['MALE', 'FEMALE', 'OTHER']),
        body('avatar_choice').optional().trim().isLength({ max: 30 }),
        body('auditor_company_name').optional().trim().isLength({ max: 200 }),
        body('auditor_company_initials').optional().trim().isLength({ max: 10 }),
        body('auditor_contact_phone').optional().trim().isLength({ max: 30 }),
    ],
    validateRequest,
    usersController.updateMyProfile
);

router.patch('/me/photo',
    ...uploadSingle('photo', 'profiles'),
    usersController.updateProfilePhoto
);

// --- ADMIN / PRIVILEGED ROUTES ---
// requireConsent added here too (v1.23.0) — these show/manage real
// member data, the same reasoning as /shareholding above. Not
// requireAssignedRole as well since requirePermissions already
// implies holding a role (permissions are role-granted) — but
// holding a role doesn't imply having consented, so that gate is
// still needed explicitly.
router.get('/',
    requireConsent,
    requirePermissions(['USER_VIEW_ALL']),
    usersController.getAllUsers
);

router.get('/role-requests',
    requireConsent,
    requirePermissions(['ROLE_ASSIGN']),
    usersController.getRoleRequests
);

// Get all shareholders — for contribution form dropdown
// NOTE: must stay above the '/:id' route below — otherwise Express treats
// "shareholders" as the ':id' value and 422s on the "must be an integer" check.
router.get('/shareholders',
    requireConsent,
    requirePermissions(['FINANCE_TRANSACTION_CREATE']),
    asyncHandler(async (req, res) => {
        const result = await query(`
            SELECT
                u.id,
                u.first_name,
                u.last_name,
                u.email,
                sr.shares_held,
                sr.percentage
            FROM   users u
            JOIN   shareholding_registry sr ON sr.user_id = u.id
            WHERE  sr.effective_to IS NULL
            AND    u.is_active = TRUE
            ORDER BY u.first_name, u.last_name
        `);
        sendSuccess(res, result.rows);
    })
);

router.get('/:id',
    validators.idParam('id'),
    validateRequest,
    isSelfOrHasPermission('USER_VIEW_ALL'),
    usersController.getUserById
);

router.patch('/:id/deactivate',
    validators.idParam('id'),
    validateRequest,
    requireConsent,
    requirePermissions(['USER_MANAGE']),
    usersController.deactivateUser
);

router.post('/:id/roles',
    validators.idParam('id'),
    [body('role_id').isInt({ min: 1 }).withMessage('Role ID required')],
    validateRequest,
    requireConsent,
    requirePermissions(['ROLE_ASSIGN']),
    usersController.assignRole
);

router.delete('/:id/roles/:roleId',
    validators.idParam('id'),
    validators.idParam('roleId'),
    validateRequest,
    requireConsent,
    requirePermissions(['ROLE_ASSIGN']),
    usersController.revokeRole
);

module.exports = router;
