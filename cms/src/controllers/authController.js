// ============================================================
// AUTHENTICATION CONTROLLER
// Handles: register, verify email, login, 2FA setup/verify,
//          refresh token, logout, password reset flow
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES, extractRequestContext } = require('../services/auditService');
const {
    hashPassword, comparePassword,
    generateTokens, generateTwoFactorVerifiedToken, verifyRefreshToken,
    generate2FASecret, verify2FAToken,
    generateEmailToken,
    sendVerificationEmail, sendPasswordResetEmail, sendRoleAssignedEmail,
} = require('../services/authService');
const access = require('../services/accessControlService'); // v1.86.0 — who may register

// ============================================================
// REGISTER
// POST /api/auth/register
// Any person can create an account. Role is requested here
// but must be approved by admin before it is active.
// ============================================================
const register = asyncHandler(async (req, res) => {
    const {
        email, password, first_name, last_name,
        date_of_birth, nationality, id_number,
        phone, address, emergency_contact_name,
        emergency_contact_phone, requested_role_id,
        role_request_reason,
        invite_token, // v1.86.0 — the invitation link's token
        website,      // v1.86.0 — invisible field: only programs fill it in
    } = req.body;

    let notifyNew = null;
    await withTransaction(async (client) => {
        // v1.86.0 — registration mode, invitation, fake / blocked addresses
        const { invitation, settings } = await access.checkRegistration(client, {
            email, inviteToken: invite_token, honeypot: website,
        });

        // Check email is not already registered
        const existing = await client.query(
            'SELECT id FROM users WHERE email = $1', [email.toLowerCase()]
        );
        if (existing.rows.length > 0) {
            throw createError.conflict('An account with this email already exists');
        }

        // Hash password
        const passwordHash = await hashPassword(password);

        // Generate email verification token
        const verificationToken = generateEmailToken();
        const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        // Create user
        const userResult = await client.query(`
            INSERT INTO users (
                email, password_hash, first_name, last_name,
                date_of_birth, nationality, id_number, phone, address,
                emergency_contact_name, emergency_contact_phone,
                email_verification_token, is_email_verified
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, FALSE)
            RETURNING id, uuid, email, first_name, last_name
        `, [
            email.toLowerCase(), passwordHash, first_name, last_name,
            date_of_birth || null, nationality || null, id_number || null,
            phone || null, address || null,
            emergency_contact_name || null, emergency_contact_phone || null,
            verificationToken,
        ]);

        const newUser = userResult.rows[0];

        // v1.86.0 — where it registered from, the invitation it used (the
        // invitation link proves the address, so it needs no second
        // verification email) and when the verification link expires.
        if (settings.ready) {
            await client.query(`
                UPDATE users SET registered_ip = $2, registered_user_agent = $3, invitation_id = $4,
                       email_verification_expires = CASE WHEN $4::int IS NULL THEN $5::timestamptz END,
                       is_email_verified = ($4::int IS NOT NULL),
                       email_verification_token = CASE WHEN $4::int IS NULL THEN email_verification_token END
                WHERE id = $1`,
            [newUser.id, String(req.ip || '').slice(0, 64), String(req.get ? (req.get('user-agent') || '') : '').slice(0, 500),
                invitation ? invitation.id : null, verificationExpiry]);
            if (invitation) {
                await client.query(`UPDATE account_invitations SET used_at = NOW(), used_by_user_id = $2 WHERE id = $1`, [invitation.id, newUser.id]);
            }
        }
        const roleToRequest = requested_role_id || (invitation && invitation.role_id) || null;

        // If a role was requested, create the role request
        if (roleToRequest) {
            const roleExists = await client.query(
                'SELECT id FROM roles WHERE id = $1 AND is_active = TRUE', [roleToRequest]
            );
            if (roleExists.rows.length > 0) {
                await client.query(`
                    INSERT INTO role_requests (user_id, role_id, reason)
                    VALUES ($1, $2, $3)
                `, [newUser.id, roleToRequest, role_request_reason || (invitation ? 'Invited' : null)]);
            }
        }

        // Audit log
        await logAction(newUser.id, ACTIONS.USER_REGISTER, MODULES.AUTH, {
            ipAddress:  req.ip,
            recordType: 'users',
            recordId:   newUser.id,
            newValues:  { email: newUser.email, first_name, last_name, invited: !!invitation },
            description: `New user registered: ${email}${invitation ? ' (with an invitation)' : ''}`,
            client,
        });

        // Send verification email (outside transaction — no DB dependency).
        // v1.86.0 — not for an invited person: the invitation proved the address.
        if (!invitation) await sendVerificationEmail(newUser, verificationToken);
        if (settings.ready && settings.notify_admins) notifyNew = { user: newUser, invited: !!invitation };

        if (invitation) {
            return sendCreated(res, {
                user: { id: newUser.id, uuid: newUser.uuid, email: newUser.email, first_name: newUser.first_name, last_name: newUser.last_name },
                invited: true,
            }, 'Account created. You can sign in now — an administrator will confirm your role.');
        }

        sendCreated(res, {
            user: {
                id:         newUser.id,
                uuid:       newUser.uuid,
                email:      newUser.email,
                first_name: newUser.first_name,
                last_name:  newUser.last_name,
            },
        }, 'Registration successful. Please check your email to verify your account.');
    });

    // v1.86.0 — tell the Admins someone registered (best effort)
    if (notifyNew) {
        try {
            const { notify } = require('../services/notificationService');
            const { wrapEmail } = require('../services/emailTemplates');
            const admins = await query(`
                SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                JOIN roles r ON r.id = ur.role_id WHERE r.name = 'Admin' AND u.is_active = TRUE`);
            const nu = notifyNew.user;
            const title = `New account: ${nu.first_name} ${nu.last_name} (${nu.email})`;
            const body = notifyNew.invited
                ? 'Registered with an invitation — assign the role under Members › Access requests.'
                : `Registered WITHOUT an invitation from ${req.ip}. If you do not know this person, decline the account under Members › Access requests.`;
            const html = await wrapEmail(`<p>${title}</p><p>${body}</p>`, { preheader: title });
            for (const a of admins.rows) {
                await notify({ userId: a.id, type: 'NEW_REGISTRATION', title, body, link: '/users?tab=access',
                    module: 'USERS', recordType: 'users', recordId: nu.id, email: { subject: title, html } });
            }
        } catch (_) { /* never block a registration on this */ }
    }
});

// ============================================================
// VERIFY EMAIL
// GET /api/auth/verify-email?token=xxx
// ============================================================
const verifyEmail = asyncHandler(async (req, res) => {
    const { token } = req.query;
    if (!token) throw createError.badRequest('Verification token is required');

    // v1.86.0 — the link expires (unverified_expiry_days), and a declined
    // account cannot be verified. Before the v1.86.0 migration has run, the
    // old rule (no expiry) applies.
    const ready = (await access.getSettings()).ready;
    const result = await query(`
        UPDATE users
        SET    is_email_verified = TRUE, email_verification_token = NULL
        WHERE  email_verification_token = $1
        AND    is_email_verified = FALSE
        ${ready ? 'AND rejected_at IS NULL AND (email_verification_expires IS NULL OR email_verification_expires > NOW())' : ''}
        RETURNING id, email, first_name
    `, [token]);

    if (result.rows.length === 0) {
        throw createError.badRequest('This verification link is not valid or has expired. Register again, or ask the company administrator for an invitation.');
    }

    const user = result.rows[0];
    await logAction(user.id, ACTIONS.USER_EMAIL_VERIFIED, MODULES.AUTH, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    user.id,
        description: `Email verified for ${user.email}`,
    });

    sendSuccess(res, null, 'Email verified successfully. You can now log in.');
});

// ============================================================
// LOGIN
// POST /api/auth/login
// Returns tokens. If 2FA is enabled, a restricted token is
// returned — the client must complete 2FA to get full access.
// ============================================================
const login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Load user with password hash
    const result = await query(`
        SELECT id, uuid, email, first_name, last_name,
               password_hash, is_active, is_email_verified,
               two_factor_enabled, two_factor_secret,
               COALESCE((to_jsonb(users)->>'session_version')::int, 0) AS session_version,
               (to_jsonb(users)->>'rejected_at') IS NOT NULL AS declined
        FROM users WHERE email = $1
    `, [email.toLowerCase()]);

    const user = result.rows[0];

    // Use a generic error message — never reveal whether the email exists
    if (!user || !(await comparePassword(password, user.password_hash))) {
        if (user) {
            await logAction(user.id, ACTIONS.USER_LOGIN_FAILED, MODULES.AUTH, {
                ipAddress:   req.ip,
                recordType:  'users',
                recordId:    user.id,
                status:      'FAILURE',
                description: 'Invalid password',
            });
        }
        throw createError.unauthorized('Invalid email or password');
    }

    if (!user.is_active) {
        throw createError.unauthorized(user.declined
            ? 'Access for this account was declined. Contact the company administrator if you think this is a mistake.'
            : 'Your account has been deactivated. Contact an administrator.');
    }

    if (!user.is_email_verified) {
        throw createError.unauthorized('Please verify your email address before logging in.');
    }

    // v1.87.0 — only invited people and existing members may sign in
    // (unless registration is OPEN)
    const entry = await access.mayEnter(user.id);
    if (!entry.ok) throw createError.forbidden(entry.message);

    // Generate tokens
    const { accessToken, refreshToken, sessionId } = generateTokens(user);

    // Update last login timestamp
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    await logAction(user.id, ACTIONS.USER_LOGIN, MODULES.AUTH, {
        sessionId,
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    user.id,
        description: `User logged in: ${user.email}`,
    });

    sendSuccess(res, {
        accessToken,
        refreshToken,
        requiresTwoFactor: user.two_factor_enabled,
        user: {
            id:         user.id,
            uuid:       user.uuid,
            email:      user.email,
            first_name: user.first_name,
            last_name:  user.last_name,
        },
    }, user.two_factor_enabled
        ? 'Login successful. Please complete two-factor authentication.'
        : 'Login successful.'
    );
});

// ============================================================
// VERIFY 2FA
// POST /api/auth/2fa/verify
// Called after login when 2FA is enabled.
// Exchanges restricted token for a full-access token.
// ============================================================
const verifyTwoFactor = asyncHandler(async (req, res) => {
    const { token } = req.body;  // the 6-digit TOTP code
    const user = req.user;       // from authenticate middleware

    if (!user.two_factor_enabled) {
        throw createError.badRequest('Two-factor authentication is not enabled on this account');
    }

    // Load the 2FA secret from DB
    const secretResult = await query(
        'SELECT two_factor_secret FROM users WHERE id = $1', [user.id]
    );
    const secret = secretResult.rows[0]?.two_factor_secret;
    if (!secret) throw createError.internal('2FA configuration error');

    const isValid = verify2FAToken(secret, token);
    if (!isValid) {
        throw createError.unauthorized('Invalid or expired two-factor code');
    }

    // Issue a new token with twoFactorVerified = true
    const authHeader = req.headers.authorization;
    const existingToken = authHeader.split(' ')[1];
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(existingToken);
    const newToken = generateTwoFactorVerifiedToken(decoded);

    await logAction(user.id, ACTIONS.USER_2FA_VERIFIED, MODULES.AUTH, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    user.id,
        description: '2FA verification successful',
    });

    sendSuccess(res, { accessToken: newToken }, 'Two-factor authentication verified.');
});

// ============================================================
// SETUP 2FA
// POST /api/auth/2fa/setup
// Generates a secret and QR code. User must verify once
// before 2FA is activated on their account.
// ============================================================
const setupTwoFactor = asyncHandler(async (req, res) => {
    const user = req.user;

    if (user.two_factor_enabled) {
        throw createError.conflict('Two-factor authentication is already enabled');
    }

    const { secret, qrCode, manualKey } = await generate2FASecret(user);

    // Store the secret temporarily (not yet activated until verified)
    await query(
        'UPDATE users SET two_factor_secret = $1 WHERE id = $2',
        [secret, user.id]
    );

    sendSuccess(res, { qrCode, manualKey },
        'Scan the QR code with your authenticator app, then call /2fa/activate to complete setup.'
    );
});

// ============================================================
// ACTIVATE 2FA
// POST /api/auth/2fa/activate
// User scans QR code, enters the first code to confirm setup.
// ============================================================
const activateTwoFactor = asyncHandler(async (req, res) => {
    const { token } = req.body;
    const user = req.user;

    const secretResult = await query(
        'SELECT two_factor_secret FROM users WHERE id = $1', [user.id]
    );
    const secret = secretResult.rows[0]?.two_factor_secret;
    if (!secret) throw createError.badRequest('Please call /2fa/setup first');

    const isValid = verify2FAToken(secret, token);
    if (!isValid) throw createError.badRequest('Invalid code. Please try again.');

    await query(
        'UPDATE users SET two_factor_enabled = TRUE WHERE id = $1', [user.id]
    );

    await logAction(user.id, ACTIONS.USER_2FA_ENABLED, MODULES.AUTH, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    user.id,
        description: '2FA successfully activated',
    });

    sendSuccess(res, null, 'Two-factor authentication has been activated on your account.');
});

// ============================================================
// REFRESH TOKEN
// POST /api/auth/refresh
// ============================================================
const refreshToken = asyncHandler(async (req, res) => {
    const { refreshToken: token } = req.body;
    if (!token) throw createError.badRequest('Refresh token is required');

    let decoded;
    try {
        decoded = verifyRefreshToken(token);
    } catch {
        throw createError.unauthorized('Invalid or expired refresh token');
    }

    const result = await query(
        `SELECT id, uuid, email, first_name, last_name, is_active,
                COALESCE((to_jsonb(users)->>'session_version')::int, 0) AS session_version
         FROM users WHERE id = $1`,
        [decoded.userId]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) throw createError.unauthorized('Account not found or deactivated');
    // v1.87.0 — a session of someone who is neither invited nor a member ends here
    const entry = await access.mayEnter(user.id);
    if (!entry.ok) throw createError.unauthorized(entry.message);
    // v1.75.0 — refused once the password has been changed since this sign-in.
    if ((parseInt(decoded.sv, 10) || 0) !== (parseInt(user.session_version, 10) || 0)) {
        const e = createError.unauthorized('You were signed out because the password on this account was changed. Please sign in again.');
        e.error = 'SESSION_REVOKED';
        throw e;
    }

    const { accessToken, refreshToken: newRefresh } = generateTokens(user);
    sendSuccess(res, { accessToken, refreshToken: newRefresh });
});

// ============================================================
// FORGOT PASSWORD
// POST /api/auth/forgot-password
// ============================================================
const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;

    const result = await query(
        'SELECT id, email, first_name FROM users WHERE email = $1 AND is_active = TRUE',
        [email.toLowerCase()]
    );

    // Always respond with success — don't reveal whether email exists
    if (result.rows.length > 0) {
        const user = result.rows[0];
        const resetToken  = generateEmailToken();
        const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await query(`
            UPDATE users
            SET password_reset_token = $1, password_reset_expires = $2
            WHERE id = $3
        `, [resetToken, resetExpiry, user.id]);

        await sendPasswordResetEmail(user, resetToken);
    }

    sendSuccess(res, null,
        'If an account with that email exists, a password reset link has been sent.'
    );
});

// ============================================================
// RESET PASSWORD
// POST /api/auth/reset-password
// ============================================================
const resetPassword = asyncHandler(async (req, res) => {
    const { token, password } = req.body;

    const result = await query(`
        SELECT id, email FROM users
        WHERE  password_reset_token   = $1
        AND    password_reset_expires > NOW()
        AND    is_active = TRUE
    `, [token]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Invalid or expired password reset link');
    }

    const user = result.rows[0];
    const passwordHash = await hashPassword(password);

    await query(`
        UPDATE users
        SET    password_hash          = $1,
               password_reset_token   = NULL,
               password_reset_expires = NULL
        WHERE  id = $2
    `, [passwordHash, user.id]);
    // v1.75.0 — a reset signs out every device that was signed in.
    await require('../services/accountSecurityService').endAllSessions(user.id);

    await logAction(user.id, ACTIONS.USER_PASSWORD_RESET, MODULES.AUTH, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    user.id,
        description: `Password reset for ${user.email}`,
    });

    sendSuccess(res, null, 'Password reset successful. Every device was signed out — sign in with your new password.');
});

// ============================================================
// LOGOUT
// POST /api/auth/logout
// JWT is stateless so we just log the action.
// The frontend discards the token.
// ============================================================
const logout = asyncHandler(async (req, res) => {
    await logAction(req.user.id, ACTIONS.USER_LOGOUT, MODULES.AUTH, {
        sessionId:   req.user.sessionId,
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    req.user.id,
        description: `User logged out: ${req.user.email}`,
    });
    sendSuccess(res, null, 'Logged out successfully.');
});

// ============================================================
// GET PUBLIC ROLES
// GET /api/auth/roles
// Unauthenticated on purpose — the Register page needs this list
// to populate its "Request a Role" dropdown, and a person filling
// out that form by definition has no account/token yet. Only
// non-sensitive fields are returned (same query as the protected
// GET /api/users/roles used everywhere else in the app).
// ============================================================
const getPublicRoles = asyncHandler(async (req, res) => {
    const result = await query(
        `SELECT id, name, description, is_system_role, is_active
         FROM roles WHERE is_active = TRUE ORDER BY name`
    );
    sendSuccess(res, result.rows);
});

module.exports = {
    register, verifyEmail, login,
    setupTwoFactor, activateTwoFactor, verifyTwoFactor,
    refreshToken, forgotPassword, resetPassword, logout,
    getPublicRoles,
};
