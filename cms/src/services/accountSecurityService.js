// ============================================================
// ACCOUNT SECURITY (v1.75.0) — changing a password or an email address
//
// Requested directly: "I would like to enable people change their
// email addresses and passwords more smoothly now".
// Confirmed decisions:
//   • Password: signed-in members change it with their CURRENT password
//     (no email round-trip). Every OTHER signed-in device is signed out
//     (users.session_version + 1); the device used stays signed in with
//     fresh tokens. A "forgot password" reset signs out every device.
//     A notice email goes to the account's address.
//   • Email: self-service. The member asks for the change (current
//     password, plus their 2FA code if 2FA is on); a confirmation link
//     goes to the NEW address and nothing changes until it is clicked
//     (48 h). The OLD address is told at once, with a "this wasn't me"
//     link that cancels a waiting change — or, for 7 days, UNDOES a
//     confirmed one (email put back, every device signed out, password
//     locked, reset link sent to the old address).
//   • An Admin can start an email change for a member (lost inbox); the
//     member must still confirm from the new address; both addresses
//     are told; audit-logged.
//
// Link tokens are random 32-byte values; only their SHA-256 hashes are
// stored (email_change_requests), so the database alone can't be used
// to confirm or undo anything.
// ============================================================

const crypto = require('crypto');
const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const { sendEmail } = require('../config/email');
const { wrapEmail, getBranding } = require('./emailTemplates');
const { hashPassword, comparePassword, generateTokens, verify2FAToken } = require('./authService');
const logger = require('../config/logger');

const CONFIRM_HOURS = 48;
const UNDO_DAYS = 7;

const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const frontend = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Same rules as registration (routes/auth.js).
const passwordProblems = (pw) => {
    const p = String(pw || '');
    const out = [];
    if (p.length < 8) out.push('at least 8 characters');
    if (!/[A-Z]/.test(p)) out.push('an uppercase letter');
    if (!/[0-9]/.test(p)) out.push('a number');
    if (!/[^A-Za-z0-9]/.test(p)) out.push('a special character');
    return out;
};

const button = (url, label, color = '#1D4ED8') => `
    <a href="${url}" style="display:inline-block;padding:12px 24px;background:${color};color:#ffffff;
       text-decoration:none;border-radius:6px;margin:16px 0;font-weight:600;">${label}</a>
    <p style="font-size:12px;color:#6b7280;">Or copy this link into your browser:<br>${url}</p>`;

const mail = async (to, subject, inner, preheader) => {
    try {
        const html = await wrapEmail(inner, { preheader: preheader || subject });
        await sendEmail({ to, subject, html });
    } catch (err) {
        logger.error('Account security email failed', { to, subject, error: err.message });
    }
};

// ---- password -------------------------------------------------------------
const changePassword = async ({ userId, currentPassword, newPassword }) => {
    const r = await query(`SELECT id, uuid, email, first_name, last_name, password_hash, is_active FROM users WHERE id = $1`, [userId]);
    const user = r.rows[0];
    if (!user || !user.is_active) throw createError.unauthorized('Account not found or deactivated');
    if (!(await comparePassword(currentPassword || '', user.password_hash))) {
        throw createError.badRequest('Your current password is not correct.');
    }
    const problems = passwordProblems(newPassword);
    if (problems.length) throw createError.badRequest(`The new password needs ${problems.join(', ')}.`);
    if (await comparePassword(newPassword, user.password_hash)) {
        throw createError.badRequest('The new password must be different from the current one.');
    }
    const hash = await hashPassword(newPassword);
    const upd = await query(`
        UPDATE users
        SET    password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL,
               session_version = session_version + 1, password_changed_at = NOW(), updated_at = NOW()
        WHERE  id = $2
        RETURNING id, uuid, email, first_name, last_name, session_version
    `, [hash, userId]);
    const fresh = upd.rows[0];
    const tokens = generateTokens(fresh);   // this device stays signed in

    const b = await getBranding();
    await mail(fresh.email, `Your password was changed — ${b.company_name}`, `
        <h2 style="margin-top:0;">Your password was changed</h2>
        <p>Hello ${esc(fresh.first_name)},</p>
        <p>The password for your ${esc(b.company_name)} account was changed just now.
           For your safety, every other device signed in to your account has been signed out.</p>
        <p><strong>If this wasn't you</strong>, reset your password straight away and tell an administrator:</p>
        ${button(`${frontend()}/forgot-password`, 'Reset my password', '#dc2626')}
    `);
    return { tokens, user: fresh };
};

// Called by the "forgot password" reset: signs out every device.
// Written to keep working on a database without migration v1.75.0.
const endAllSessions = async (userId) => {
    try {
        await query(`UPDATE users SET session_version = session_version + 1, password_changed_at = NOW() WHERE id = $1`, [userId]);
    } catch (err) {
        if (err.code !== '42703') throw err;   // column missing → migration not run yet
    }
};

// ---- email change ---------------------------------------------------------
const normaliseEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const expireOld = async () => {
    await query(`UPDATE email_change_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < NOW()`);
};

const getPending = async (userId) => {
    await expireOld();
    const r = await query(`
        SELECT id, old_email, new_email, requested_by_admin, admin_reason, created_at, expires_at,
               (SELECT first_name || ' ' || last_name FROM users WHERE id = e.requested_by) AS requested_by_name
        FROM   email_change_requests e
        WHERE  user_id = $1 AND status = 'PENDING'
    `, [userId]);
    return r.rows[0] || null;
};

// Starts an email change. actor = the person asking (the member, or an Admin).
const requestEmailChange = async ({ userId, newEmail, actor, byAdmin = false, adminReason = null, currentPassword, twoFactorCode }) => {
    const email = normaliseEmail(newEmail);
    if (!EMAIL_RX.test(email) || email.length > 255) throw createError.badRequest('Please enter a valid email address.');

    const u = (await query(`SELECT id, email, first_name, last_name, password_hash, is_active, two_factor_enabled, two_factor_secret FROM users WHERE id = $1`, [userId])).rows[0];
    if (!u || !u.is_active) throw createError.notFound('Member not found or deactivated');
    if (email === normaliseEmail(u.email)) throw createError.badRequest('That is already the email address on this account.');

    if (!byAdmin) {
        if (!(await comparePassword(currentPassword || '', u.password_hash))) {
            throw createError.badRequest('Your current password is not correct.');
        }
        if (u.two_factor_enabled) {
            if (!twoFactorCode) throw createError.badRequest('Enter the 6-digit code from your authenticator app.');
            if (!verify2FAToken(u.two_factor_secret, String(twoFactorCode))) throw createError.badRequest('That two-factor code is not correct or has expired.');
        }
    }
    const taken = await query(`SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2`, [email, userId]);
    if (taken.rows.length) throw createError.conflict('Another account already uses that email address.');

    const confirmToken = newToken();
    const cancelToken = newToken();
    const created = await withTransaction(async (client) => {
        await client.query(`UPDATE email_change_requests SET status = 'SUPERSEDED' WHERE user_id = $1 AND status = 'PENDING'`, [userId]);
        const ins = await client.query(`
            INSERT INTO email_change_requests
                (user_id, old_email, new_email, confirm_token_hash, cancel_token_hash,
                 requested_by, requested_by_admin, admin_reason, expires_at, undo_until)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                    NOW() + INTERVAL '${CONFIRM_HOURS} hours', NOW() + INTERVAL '${UNDO_DAYS} days')
            RETURNING id, expires_at
        `, [userId, u.email, email, sha256(confirmToken), sha256(cancelToken), actor.id, byAdmin, adminReason || null]);
        return ins.rows[0];
    });

    const b = await getBranding();
    const who = byAdmin ? `An administrator (${esc(actor.first_name)} ${esc(actor.last_name)})` : 'You';
    await mail(email, `Confirm your new email address — ${b.company_name}`, `
        <h2 style="margin-top:0;">Confirm your new email address</h2>
        <p>Hello ${esc(u.first_name)},</p>
        <p>${who} asked to change the email address of your ${esc(b.company_name)} account to
           <strong>${esc(email)}</strong>. Click below to confirm. Until you do, nothing changes and you
           keep signing in with your current address. This link expires in ${CONFIRM_HOURS} hours.</p>
        ${button(`${frontend()}/confirm-email-change?token=${confirmToken}`, 'Confirm my new email address')}
        <p>If you didn't ask for this, just ignore this email.</p>
    `);
    await mail(u.email, `Email change requested on your account — ${b.company_name}`, `
        <h2 style="margin-top:0;">A change of email address was requested</h2>
        <p>Hello ${esc(u.first_name)},</p>
        <p>${who} asked to change the email address of your ${esc(b.company_name)} account
           from <strong>${esc(u.email)}</strong> to <strong>${esc(email)}</strong>.
           ${byAdmin && adminReason ? `Reason given: <em>${esc(adminReason)}</em>.` : ''}
           It only takes effect once the new address is confirmed.</p>
        <p><strong>If this wasn't you</strong>, click below. It cancels the change — and if it has already
           been confirmed, it puts your address back and signs everyone out (valid for ${UNDO_DAYS} days).</p>
        ${button(`${frontend()}/cancel-email-change?token=${cancelToken}`, "This wasn't me — cancel it", '#dc2626')}
    `);
    return { id: created.id, new_email: email, expires_at: created.expires_at };
};

const cancelPending = async ({ userId, actor }) => {
    const r = await query(`
        UPDATE email_change_requests SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2
        WHERE  user_id = $1 AND status = 'PENDING' RETURNING id
    `, [userId, actor.id]);
    if (!r.rows.length) throw createError.badRequest('There is no email change waiting.');
    return { id: r.rows[0].id };
};

// Public — the link in the email to the NEW address.
const confirmEmailChange = async (token) => {
    if (!token) throw createError.badRequest('The confirmation link is incomplete.');
    await expireOld();
    return withTransaction(async (client) => {
        const r = await client.query(`
            SELECT e.*, u.first_name, u.email AS current_email
            FROM   email_change_requests e JOIN users u ON u.id = e.user_id
            WHERE  e.confirm_token_hash = $1 FOR UPDATE OF e
        `, [sha256(token)]);
        const req = r.rows[0];
        if (!req) throw createError.badRequest('This confirmation link is not valid.');
        if (req.status === 'CONFIRMED') return { already: true, new_email: req.new_email };
        if (req.status === 'EXPIRED') throw createError.badRequest('This link has expired. Please ask for the change again from your profile.');
        if (req.status !== 'PENDING') throw createError.badRequest('This email change was cancelled or replaced by a newer request.');
        const taken = await client.query(`SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2`, [req.new_email, req.user_id]);
        if (taken.rows.length) throw createError.conflict('Another account started using that email address in the meantime.');

        await client.query(`
            UPDATE users SET email = $1, is_email_verified = TRUE, email_verification_token = NULL,
                             email_changed_at = NOW(), updated_at = NOW()
            WHERE id = $2
        `, [req.new_email, req.user_id]);
        await client.query(`UPDATE email_change_requests SET status = 'CONFIRMED', confirmed_at = NOW() WHERE id = $1`, [req.id]);
        return { request: req };
    }).then(async (out) => {
        if (out.already) return { new_email: out.new_email, already: true };
        const req = out.request;
        const { logAction, ACTIONS, MODULES } = require('./auditService');
        await logAction(req.user_id, ACTIONS.USER_PROFILE_UPDATED, MODULES.USERS, {
            recordType: 'users', recordId: req.user_id,
            oldValues: { email: req.old_email }, newValues: { email: req.new_email },
            description: `Email address changed from ${req.old_email} to ${req.new_email}${req.requested_by_admin ? ' (started by an administrator, confirmed by the member)' : ''}`,
        }).catch(() => {});
        const b = await getBranding();
        await mail(req.old_email, `Your email address was changed — ${b.company_name}`, `
            <h2 style="margin-top:0;">Your email address was changed</h2>
            <p>Hello ${esc(req.first_name)},</p>
            <p>Your ${esc(b.company_name)} account now uses <strong>${esc(req.new_email)}</strong>.
               From now on, sign in with that address. Emails from the system will go there.</p>
            <p><strong>If this wasn't you</strong>, use the "This wasn't me" button in the earlier email
               (valid for ${UNDO_DAYS} days) or tell an administrator immediately.</p>
        `);
        await mail(req.new_email, `Email address confirmed — ${b.company_name}`, `
            <h2 style="margin-top:0;">You're all set</h2>
            <p>Hello ${esc(req.first_name)},</p>
            <p>This is now the email address of your ${esc(b.company_name)} account. Sign in with
               <strong>${esc(req.new_email)}</strong> and your usual password.</p>
        `);
        return { new_email: req.new_email };
    });
};

// Public — the "This wasn't me" link sent to the OLD address.
const cancelByLink = async (token) => {
    if (!token) throw createError.badRequest('The link is incomplete.');
    const result = await withTransaction(async (client) => {
        const r = await client.query(`
            SELECT e.*, u.email AS current_email, u.first_name
            FROM   email_change_requests e JOIN users u ON u.id = e.user_id
            WHERE  e.cancel_token_hash = $1 FOR UPDATE OF e
        `, [sha256(token)]);
        const req = r.rows[0];
        if (!req) throw createError.badRequest('This link is not valid.');
        if (['CANCELLED', 'REVERTED'].includes(req.status)) return { outcome: 'already', req };
        if (req.status === 'PENDING' || req.status === 'EXPIRED' || req.status === 'SUPERSEDED') {
            if (req.status === 'PENDING') {
                await client.query(`UPDATE email_change_requests SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = user_id WHERE id = $1`, [req.id]);
            }
            return { outcome: 'cancelled', req };
        }
        // CONFIRMED — undo, if still within the window and nothing changed since.
        if (req.undo_until && new Date(req.undo_until) < new Date()) {
            throw createError.badRequest('It is too late to undo this change with this link. Please contact an administrator.');
        }
        if (String(req.current_email).toLowerCase() !== String(req.new_email).toLowerCase()) {
            throw createError.badRequest('The email address has changed again since then. Please contact an administrator.');
        }
        const taken = await client.query(`SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2`, [req.old_email, req.user_id]);
        if (taken.rows.length) throw createError.badRequest('Your old address is now used by another account. Please contact an administrator.');
        // Put the old address back, sign everyone out and lock the password
        // (whoever made the change knew it) — a reset link goes to the old address.
        const resetToken = crypto.randomBytes(32).toString('hex');
        const lockedHash = await hashPassword(crypto.randomBytes(24).toString('hex') + 'Aa1!');
        await client.query(`
            UPDATE users SET email = $1, is_email_verified = TRUE, email_changed_at = NOW(),
                   password_hash = $2, session_version = session_version + 1, password_changed_at = NOW(),
                   password_reset_token = $3, password_reset_expires = NOW() + INTERVAL '24 hours', updated_at = NOW()
            WHERE id = $4
        `, [req.old_email, lockedHash, resetToken, req.user_id]);
        await client.query(`UPDATE email_change_requests SET status = 'REVERTED', cancelled_at = NOW(), cancelled_by = user_id WHERE id = $1`, [req.id]);
        return { outcome: 'reverted', req, resetToken };
    });

    const { req } = result;
    const b = await getBranding();
    const { logAction, ACTIONS, MODULES } = require('./auditService');
    if (result.outcome === 'cancelled') {
        await logAction(req.user_id, ACTIONS.USER_PROFILE_UPDATED, MODULES.USERS, {
            recordType: 'email_change_requests', recordId: req.id,
            description: `Email change to ${req.new_email} cancelled from the link sent to ${req.old_email}`,
        }).catch(() => {});
    }
    if (result.outcome === 'reverted') {
        await logAction(req.user_id, ACTIONS.USER_PROFILE_UPDATED, MODULES.USERS, {
            recordType: 'users', recordId: req.user_id,
            oldValues: { email: req.new_email }, newValues: { email: req.old_email },
            description: `Email change UNDONE by the owner of ${req.old_email} ("this wasn't me"): address restored, all devices signed out, password locked and a reset link sent`,
        }).catch(() => {});
        await mail(req.old_email, `Your account is back — set a new password — ${b.company_name}`, `
            <h2 style="margin-top:0;">Your email address has been restored</h2>
            <p>Hello ${esc(req.first_name)},</p>
            <p>Your ${esc(b.company_name)} account uses <strong>${esc(req.old_email)}</strong> again.
               Because someone else may know your password, every device has been signed out and your
               password has been locked. Set a new one now (link valid for 24 hours):</p>
            ${button(`${frontend()}/reset-password?token=${result.resetToken}`, 'Set a new password', '#dc2626')}
            <p>Please also tell an administrator what happened.</p>
        `);
    }
    return { outcome: result.outcome, old_email: req.old_email, new_email: req.new_email };
};

module.exports = {
    passwordProblems, changePassword, endAllSessions,
    getPending, requestEmailChange, cancelPending, confirmEmailChange, cancelByLink,
    CONFIRM_HOURS, UNDO_DAYS,
};
