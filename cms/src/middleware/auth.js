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
                -- Aggregate all active roles into an array
                COALESCE(
                    array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL),
                    '{}'
                ) AS roles,
                -- Aggregate all permission codes into an array
                COALESCE(
                    json_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL),
                    '[]'
                ) AS permissions
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            LEFT JOIN roles r       ON r.id = ur.role_id AND r.is_active = TRUE
            LEFT JOIN role_permissions rp ON rp.role_id = r.id
            LEFT JOIN permissions p ON p.id = rp.permission_id
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
    requireRoles,
    requirePermissions,
    requireAnyPermission,
    isSelfOrHasPermission,
};
