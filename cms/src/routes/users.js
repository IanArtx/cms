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
const accountSecurity = require('../controllers/accountSecurityController'); // v1.75.0
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

// This member's own unified payment ledger (v1.56.0) — every kind of
// payment they've personally made into the company. Self-scoped (no
// :id, always req.user.id), but still gated the same as the rest of
// this file's financial data since it's money information.
router.get('/me/payment-ledger',    requireAssignedRole, requireConsent, blockFinanceRestricted, usersController.getMyPaymentLedger);

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
        // v1.70.0
        body('tin').optional({ values: 'null' }).trim().isLength({ max: 20 }),
        body('tax_residency').optional({ values: 'falsy' }).isIn(['RESIDENT', 'NON_RESIDENT']),
    ],
    validateRequest,
    usersController.updateMyProfile
);

// v1.75.0 — change my email address (confirmed from the new address)
router.get('/me/email-change', accountSecurity.getMyEmailChange);
router.post('/me/email-change',
    [
        body('new_email').trim().isEmail().withMessage('Please enter a valid email address'),
        body('current_password').notEmpty().withMessage('Enter your current password'),
        body('two_factor_code').optional({ values: 'falsy' }).isLength({ min: 6, max: 6 }),
    ],
    validateRequest,
    accountSecurity.requestMyEmailChange
);
router.delete('/me/email-change', accountSecurity.cancelMyEmailChange);

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
//
// Fixed (v1.27.3): this used to INNER JOIN shareholding_registry, which
// only has a row for a member AFTER their first contribution has already
// been recorded — so a brand-new Shareholder with zero contributions so
// far could never appear in the dropdown used to record their very first
// one. Now driven off holding the Shareholder role itself (the actual
// eligibility rule), with shareholding_registry LEFT JOINed in just to
// show existing shares_held/percentage when there is any — NULL for
// someone who hasn't contributed yet, which the frontend already
// handles (it only appends the "— X% shareholding" suffix when present).
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
            JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            JOIN   roles r       ON r.id = ur.role_id AND r.name = 'Shareholder' AND r.is_active = TRUE
            LEFT JOIN shareholding_registry sr ON sr.user_id = u.id AND sr.effective_to IS NULL
            WHERE  u.is_active = TRUE
            ORDER BY u.first_name, u.last_name
        `);
        sendSuccess(res, result.rows);
    })
);

// ============================================================
// MEMBER DIRECTORY (v1.69.1) — names only.
// GET /api/users/directory
// Feeds the person pickers on Generate Document (attendees, chairperson,
// secretary, members present) and Events (people to notify). Those
// pages used the full member list (GET /users), which needs
// USER_VIEW_ALL — a Secretary or Director with DOCUMENT_GENERATE /
// EVENT_CREATE but not USER_VIEW_ALL got a refused request, and on
// Generate Document that one refusal also blanked the template list.
// This returns only id + first/last name of active members (no email,
// phone, roles or finances) to anyone who can generate documents or
// create events.
// ============================================================
router.get('/directory',
    requireAssignedRole,
    requireConsent,
    (req, res, next) => {
        const perms = req.user.permissions || [];
        if (['DOCUMENT_GENERATE', 'EVENT_CREATE', 'USER_VIEW_ALL'].some(p => perms.includes(p))) return next();
        return res.status(403).json({ success: false, message: 'Your role cannot list members.' });
    },
    asyncHandler(async (req, res) => {
        const result = await query(`
            SELECT id, first_name, last_name
            FROM   users
            WHERE  is_active = TRUE
            ORDER  BY first_name, last_name
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

// v1.34.0 — full "Member Portfolio" snapshot (Section 6.x). Same
// self-or-permitted gate as the plain profile lookup above.
// v1.75.0 — Admin starts an email change for a member (the member must
// still confirm from the new address; both addresses are told).
router.get('/:id/email-change',
    requireConsent, requireRoles(['Admin']),
    [param('id').isInt({ min: 1 })], validateRequest,
    accountSecurity.adminGetEmailChange
);
router.post('/:id/email-change',
    requireConsent, requireRoles(['Admin']),
    [
        param('id').isInt({ min: 1 }),
        body('new_email').trim().isEmail().withMessage('Please enter a valid email address'),
        body('reason').trim().notEmpty().withMessage('Please give a reason').isLength({ max: 500 }),
    ],
    validateRequest,
    accountSecurity.adminRequestEmailChange
);
router.delete('/:id/email-change',
    requireConsent, requireRoles(['Admin']),
    [param('id').isInt({ min: 1 })], validateRequest,
    accountSecurity.adminCancelEmailChange
);

router.get('/:id/portfolio',
    validators.idParam('id'),
    validateRequest,
    isSelfOrHasPermission('USER_VIEW_ALL'),
    usersController.getMemberPortfolio
);

router.patch('/:id/deactivate',
    validators.idParam('id'),
    validateRequest,
    requireConsent,
    requirePermissions(['USER_MANAGE']),
    usersController.deactivateUser
);

// v1.35.0 — permanent deletion, for duplicate/unused registrations
// only. Same USER_MANAGE gate as deactivate; getDeletionCheck is
// read-only (safe to call freely to see whether an account qualifies),
// the DELETE itself re-validates before doing anything irreversible.
// See userDeletionService.js for the full explanation.
router.get('/:id/deletion-check',
    validators.idParam('id'),
    validateRequest,
    requirePermissions(['USER_MANAGE']),
    usersController.getDeletionCheck
);

router.delete('/:id',
    validators.idParam('id'),
    validateRequest,
    requireConsent,
    requirePermissions(['USER_MANAGE']),
    usersController.deleteUserPermanently
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
