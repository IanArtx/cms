// ============================================================
// AUTHENTICATION & AUTHORISATION MIDDLEWARE
// These functions sit between the route definition and the
// route handler, intercepting every request to verify:
//   1. The user is logged in (authenticate)
//   2. The user has the right role or permission (authorize)
// ============================================================

const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES, extractRequestContext } = require('../services/auditService');

// ============================================================
// AUTHENTICATE
// Verifies the JWT token sent in the Authorization header.
// On success, attaches the full user object to req.user.
// Every protected route must use this middleware first.
//
// Expected header: Authorization: Bearer <token>
// ============================================================
const authenticate = async (req, res, next) => {
    try {
        // Extract token from header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return next(createError.unauthorized('No authentication token provided'));
        }

        const token = authHeader.split(' ')[1];

        // Verify token signature and expiry
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return next(err); // TokenExpiredError or JsonWebTokenError — handled globally
        }

        // Load the full user from DB (so we always have current data,
        // not stale data from when the token was issued)
        const result = await query(`
            SELECT
                u.id, u.uuid, u.email, u.first_name, u.last_name,
                u.is_active, u.two_factor_enabled, u.is_email_verified,
                u.signature_path,
                -- Aggregate all active roles into an array
                COALESCE(
                    array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL),
                    '{}'
                ) AS roles,
                -- Aggregate all permission codes into an array
                COALESCE(
                    json_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL),
                    '[]'
                ) AS permissions,
                -- v1.23.0 — one-time Membership Agreement consent
                -- (member_consents.user_id is UNIQUE, so this is a
                -- plain 1:1 join; bool_or is only needed because the
                -- roles/permissions joins above force a GROUP BY)
                bool_or(mc.id IS NOT NULL) AS has_consented
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            LEFT JOIN roles r       ON r.id = ur.role_id AND r.is_active = TRUE
            LEFT JOIN role_permissions rp ON rp.role_id = r.id
            LEFT JOIN permissions p ON p.id = rp.permission_id
            LEFT JOIN member_consents mc ON mc.user_id = u.id
            WHERE u.id = $1
            GROUP BY u.id
        `, [decoded.userId]);

        if (result.rows.length === 0) {
            return next(createError.unauthorized('User account not found'));
        }

        const user = result.rows[0];

        // Check account is still active
        if (!user.is_active) {
            return next(createError.unauthorized('Your account has been deactivated'));
        }

        // Attach user and session context to the request
        req.user = {
            ...user,
            sessionId: decoded.sessionId,
        };

        next();
    } catch (err) {
        next(err);
    }
};

// ============================================================
// REQUIRE EMAIL VERIFIED
// Some actions require a verified email address.
// Place after authenticate.
// ============================================================
const requireEmailVerified = (req, res, next) => {
    if (!req.user.is_email_verified) {
        return next(createError.forbidden('Please verify your email address to continue'));
    }
    next();
};

// ============================================================
// REQUIRE 2FA VERIFIED (for sensitive operations)
// For especially sensitive endpoints (e.g. approving large
// transfers), we can demand 2FA confirmation per-session.
// The frontend sends a verified 2FA flag in the JWT.
// ============================================================
const require2FA = (req, res, next) => {
    if (req.user.two_factor_enabled && !req.user.twoFactorVerified) {
        return next(createError.forbidden('Two-factor authentication required for this action'));
    }
    next();
};

// ============================================================
// REQUIRE ASSIGNED ROLE
// Blocks any request from an authenticated user holding ZERO
// active roles — i.e. someone who has registered and verified
// their email but has not yet been assigned a role by an Admin.
//
// This exists because "any authenticated user" was, throughout
// this codebase, historically used to mean "any actual member" —
// dozens of read-only endpoints (account balances, reports,
// savings/side-fund summaries, category lists, and more) check
// only `authenticate` with no further permission/role gate,
// on the assumption that reaching them at all implied holding
// at least one real role. `blockFinanceRestricted` narrowed that
// gap for two *specific* known roles (Auditor, Administrative
// Officer) but is a deny-list, not an allow-list — it does
// nothing to stop a brand-new, role-less account from sailing
// straight through and seeing the exact same data. This
// middleware is the allow-list half of that fix: apply it
// wherever blockFinanceRestricted (or an equivalent per-route
// permission check) already assumes "some role exists".
//
// Deliberately NOT applied to: the handful of self-service /me
// endpoints in users.js (a pending user must still be able to
// see/edit their own profile and check their role-request
// status), notifications.js (scoped to the caller, nothing to
// leak), and settings.js's company-branding GET (needed to
// render the pending-approval page itself, same as the login
// page needs it pre-authentication).
//
// Usage:
//   router.use(authenticate);
//   router.use(requireAssignedRole);
// ============================================================
const requireAssignedRole = (req, res, next) => {
    const userRoles = req.user?.roles || [];
    if (userRoles.length === 0) {
        return next(createError.forbidden(
            'Your account has been verified but no role has been assigned yet. An Administrator needs to approve your account before you can access this.'
        ));
    }
    next();
};

// ============================================================
// REQUIRE CONSENT (v1.23.0, Section 4.29)
// Blocks any request from a role-assigned user who has not yet
// consented to the Membership Agreement (and, as part of the same
// one-time step, drawn their personal signature). This is the gate
// that runs immediately AFTER requireAssignedRole — a brand-new
// member's journey is: verify email -> get a role assigned by an
// Admin -> consent + sign -> full access. Same allow-list reasoning
// as requireAssignedRole: apply it to the same route files, right
// below it.
//
// Deliberately NOT applied to: the self-service /me endpoints in
// users.js (the consent screen itself needs GET /users/me,
// GET /users/me/membership-agreement, PATCH /users/me/signature,
// and POST /users/me/consent to actually work), notifications.js,
// and settings.js's company-branding GET — same carve-outs as
// requireAssignedRole, for the same reason (the consent page needs
// to render before consent exists, same as the pending-approval
// page needs to render before a role exists).
//
// Usage:
//   router.use(authenticate);
//   router.use(requireAssignedRole);
//   router.use(requireConsent);
// ============================================================
const requireConsent = (req, res, next) => {
    if (!req.user?.has_consented) {
        return next(createError.forbidden(
            'You need to review and consent to the Membership Agreement, and set up your signature, before you can access this.'
        ));
    }
    next();
};

// ============================================================
// REQUIRE ROLES
// Checks that the authenticated user holds at least one of
// the specified roles.
//
// Usage:
//   router.post('/transfer', authenticate, requireRoles(['Treasurer', 'Director']), handler);
// ============================================================
const requireRoles = (allowedRoles) => (req, res, next) => {
    if (!req.user) {
        return next(createError.unauthorized());
    }

    const userRoles = req.user.roles || [];
    const hasRole = allowedRoles.some(role => userRoles.includes(role));

    if (!hasRole) {
        return next(createError.forbidden(
            `This action requires one of the following roles: ${allowedRoles.join(', ')}`
        ));
    }

    next();
};

// ============================================================
// BLOCK ROLES (factory)
// Generic building block behind blockAuditor and
// blockFinanceRestricted below: rejects any request from a user
// holding ANY of the given role names, with a caller-supplied
// message. Kept generic (rather than one bespoke function per role)
// specifically so the NEXT restricted-access role added to this
// system — and there will be a next one — doesn't require inventing
// a new near-duplicate function, just a new call to this factory.
// ============================================================
const blockRoles = (roleNames, message) => (req, res, next) => {
    const userRoles = req.user?.roles || [];
    if (roleNames.some(role => userRoles.includes(role))) {
        return next(createError.forbidden(message));
    }
    next();
};

// ============================================================
// BLOCK FINANCE-RESTRICTED ROLES
// The system has two (and, by design, potentially more in future)
// role types that are deliberately NOT full internal members:
//   - Auditor: the system's only external, non-member account
//     type. Zero permissions by design; everything it can legitimately
//     do lives under /api/audit, scoped to whichever engagement(s) an
//     Admin explicitly attached it to (auditController.js's
//     assertEngagementAccess).
//   - Administrative Officer: a hired, contracted staff role (ground
//     work, meeting minutes, correspondence with authorities) that is
//     explicitly NOT a shareholder and must never see company finances
//     — except individual documents an Admin explicitly grants via
//     staff_document_grants (see staffAccessController.js). Unlike the
//     Auditor, this role keeps a normal multi-page sidebar (Events,
//     Documents, its own Service Fees records) rather than being
//     redirected to one single portal page.
//
// Many route files were written before either of these roles existed
// and only gate individual actions behind requirePermissions/
// requireRoles — but several read-only, dashboard-style endpoints
// (account balances, upcoming events, and others like them) were
// deliberately left open to "any authenticated user" so ordinary
// members without a specific permission could still see them. Both
// restricted roles are also "any authenticated user", so without this
// check either could see full company balances and internal financial
// detail outside what they're actually supposed to have — exactly the
// class of leak the Auditor-visibility fix (v1.20.1) addressed, now
// generalised so the same mistake isn't repeated for every future
// restricted role one at a time.
//
// Apply this immediately after router.use(authenticate) in every
// finance-adjacent route file EXCEPT audit.js and staffAccess.js/
// serviceFees.js themselves, and the couple of self-service routes
// every authenticated user legitimately needs (their own profile,
// their own notifications, public company branding).
//
// Usage:
//   router.use(authenticate);
//   router.use(blockFinanceRestricted);
// ============================================================
const blockFinanceRestricted = blockRoles(
    ['Auditor', 'Administrative Officer'],
    'Your role does not have access to company financial data.'
);

// Kept as a distinct, differently-worded alias for the one place
// (audit.js's own routes are naturally exempt already, so this only
// matters for readability at call sites and in error messages) where
// code specifically means "block the Auditor" rather than "block any
// finance-restricted role" — currently unused directly since
// blockFinanceRestricted covers every route blockAuditor used to,
// but kept so a future finance-restricted-only route can still be
// precise about which role it means.
const blockAuditor = blockRoles(
    ['Auditor'],
    'The Auditor role only has access to the External Audit portal.'
);

// ============================================================
// REQUIRE PERMISSIONS
// Checks that the authenticated user has ALL of the specified
// permissions (not just any one of them).
//
// Usage:
//   router.post('/transactions', authenticate, requirePermissions(['FINANCE_TRANSACTION_CREATE']), handler);
// ============================================================
const requirePermissions = (requiredPermissions) => (req, res, next) => {
    if (!req.user) {
        return next(createError.unauthorized());
    }

    const userPermissions = req.user.permissions || [];
    const missingPermissions = requiredPermissions.filter(
        perm => !userPermissions.includes(perm)
    );

    if (missingPermissions.length > 0) {
        return next(createError.forbidden(
            `Missing required permissions: ${missingPermissions.join(', ')}`
        ));
    }

    next();
};

// ============================================================
// REQUIRE ANY PERMISSION
// Like requirePermissions but only needs ONE of the list.
// ============================================================
const requireAnyPermission = (permissions) => (req, res, next) => {
    if (!req.user) {
        return next(createError.unauthorized());
    }

    const userPermissions = req.user.permissions || [];
    const hasAny = permissions.some(perm => userPermissions.includes(perm));

    if (!hasAny) {
        return next(createError.forbidden('You do not have permission to perform this action'));
    }

    next();
};

// ============================================================
// IS SELF OR HAS PERMISSION
// Allows a user to access their OWN data, OR allows users
// with a specific permission to access anyone's data.
//
// Usage: for endpoints like GET /users/:id
// ============================================================
const isSelfOrHasPermission = (permission) => (req, res, next) => {
    if (!req.user) {
        return next(createError.unauthorized());
    }

    const isSelf = String(req.user.id) === String(req.params.id || req.params.userId);
    const hasPerm = (req.user.permissions || []).includes(permission);

    if (isSelf || hasPerm) {
        return next();
    }

    return next(createError.forbidden('You can only access your own data'));
};

module.exports = {
    authenticate,
    requireEmailVerified,
    require2FA,
    requireAssignedRole,
    requireConsent,
    requireRoles,
    blockRoles,
    blockAuditor,
    blockFinanceRestricted,
    requirePermissions,
    requireAnyPermission,
    isSelfOrHasPermission,
};
