// ============================================================
// AUTH SERVICE
// Handles JWT generation, 2FA setup, and auth-related emails.
// Keeps all crypto logic out of the controller.
// ============================================================

const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode   = require('qrcode');
const crypto   = require('crypto');
const { sendEmail } = require('../config/email');
const { wrapEmail, getBranding } = require('./emailTemplates');

// ============================================================
// PASSWORD HASHING
// ============================================================
const hashPassword = async (plaintext) => {
    const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    return bcrypt.hash(plaintext, rounds);
};

const comparePassword = async (plaintext, hash) => {
    return bcrypt.compare(plaintext, hash);
};

// ============================================================
// JWT TOKEN GENERATION
// Two tokens are issued on login:
//   accessToken  — short-lived (8h), used on every request
//   refreshToken — long-lived (7d), used only to get a new access token
// ============================================================
const generateTokens = (user) => {
    const sessionId = crypto.randomUUID();

    const accessToken = jwt.sign(
        {
            userId:    user.id,
            uuid:      user.uuid,
            email:     user.email,
            sessionId,
            twoFactorVerified: false, // must complete 2FA separately if enabled
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    const refreshToken = jwt.sign(
        { userId: user.id, sessionId },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );

    return { accessToken, refreshToken, sessionId };
};

// Upgrade access token after 2FA verification
const generateTwoFactorVerifiedToken = (existingDecoded) => {
    return jwt.sign(
        { ...existingDecoded, twoFactorVerified: true },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
};

const verifyRefreshToken = (token) => {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
};

// ============================================================
// 2FA — TOTP SETUP
// Generates a secret key and a QR code image the user scans
// into their authenticator app (Google Authenticator, Authy).
// ============================================================
const generate2FASecret = async (user) => {
    const secret = speakeasy.generateSecret({
        name:   `${process.env.TOTP_APP_NAME || 'CompanyMS'} (${user.email})`,
        length: 20,
    });

    // Generate a QR code as a data URL (embeddable in HTML/img tag)
    const qrCodeDataURL = await qrcode.toDataURL(secret.otpauth_url);

    return {
        secret:    secret.base32,  // store this encrypted in DB
        qrCode:    qrCodeDataURL,  // send this to the frontend
        manualKey: secret.base32,  // fallback if QR doesn't scan
    };
};

// Verify a TOTP token against the stored secret
const verify2FAToken = (secret, token) => {
    return speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token:    String(token),
        window:   1, // allow 1 period (30s) of drift to account for clock skew
    });
};

// ============================================================
// EMAIL VERIFICATION TOKEN
// A random token sent in the verification email.
// Expires after 24 hours (enforced in the DB column).
// ============================================================
const generateEmailToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

// ============================================================
// AUTH EMAILS
// ============================================================

const sendVerificationEmail = async (user, token) => {
    const url = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
    const branding = await getBranding();
    const html = await wrapEmail(`
        <h2 style="margin-top:0;">Welcome to ${branding.company_name}</h2>
        <p>Hello ${user.first_name},</p>
        <p>Please verify your email address by clicking the button below.
           This link expires in 24 hours.</p>
        <a href="${url}" style="
            display: inline-block; padding: 12px 24px;
            background: #2563eb; color: white;
            text-decoration: none; border-radius: 6px; margin: 16px 0;">
            Verify Email Address
        </a>
        <p>Or copy this link into your browser:<br>
           <small>${url}</small></p>
        <p>If you did not create an account, please ignore this email.</p>
    `, { preheader: `Verify your email — ${branding.company_name}` });

    await sendEmail({
        to:      user.email,
        subject: `Verify your email — ${branding.company_name}`,
        html,
    });
};

const sendPasswordResetEmail = async (user, token) => {
    const url = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    const branding = await getBranding();
    const html = await wrapEmail(`
        <h2 style="margin-top:0;">Password Reset</h2>
        <p>Hello ${user.first_name},</p>
        <p>We received a request to reset your password.
           Click the button below to set a new password.
           This link expires in 1 hour.</p>
        <a href="${url}" style="
            display: inline-block; padding: 12px 24px;
            background: #dc2626; color: white;
            text-decoration: none; border-radius: 6px; margin: 16px 0;">
            Reset My Password
        </a>
        <p>Or copy this link into your browser:<br>
           <small>${url}</small></p>
        <p><strong>If you did not request a password reset, please contact
           the system administrator immediately.</strong></p>
    `, { preheader: `Password reset request — ${branding.company_name}` });

    await sendEmail({
        to:      user.email,
        subject: `Password Reset Request — ${branding.company_name}`,
        html,
    });
};

const sendRoleAssignedEmail = async (user, roleName, assignedByName) => {
    const branding = await getBranding();
    const html = await wrapEmail(`
        <h2 style="margin-top:0;">Role Assignment Notification</h2>
        <p>Hello ${user.first_name},</p>
        <p>You have been assigned the <strong>${roleName}</strong> role
           by <strong>${assignedByName}</strong>.</p>
        <p>This role is now active on your account. Please log in to
           see your updated access.</p>
    `, { preheader: `Role assigned — ${roleName}` });

    await sendEmail({
        to:      user.email,
        subject: `Role Assigned — ${branding.company_name}`,
        html,
    });
};

module.exports = {
    hashPassword,
    comparePassword,
    generateTokens,
    generateTwoFactorVerifiedToken,
    verifyRefreshToken,
    generate2FASecret,
    verify2FAToken,
    generateEmailToken,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendRoleAssignedEmail,
};
