// ============================================================
// ACCOUNT SECURITY CONTROLLER (v1.75.0)
// Password and email-address changes — see services/accountSecurityService.js
//
//   POST   /api/auth/change-password           signed in: { current_password, new_password }
//   POST   /api/auth/email-change/confirm      PUBLIC:    { token }  (link sent to the NEW address)
//   POST   /api/auth/email-change/cancel       PUBLIC:    { token }  (link sent to the OLD address)
//   GET    /api/users/me/email-change          the member's own waiting change
//   POST   /api/users/me/email-change          { new_email, current_password, two_factor_code? }
//   DELETE /api/users/me/email-change          cancel it
//   GET    /api/users/:id/email-change         Admin — a member's waiting change
//   POST   /api/users/:id/email-change         Admin — { new_email, reason }
//   DELETE /api/users/:id/email-change         Admin — cancel it
// ============================================================

const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const svc = require('../services/accountSecurityService');

const changePassword = asyncHandler(async (req, res) => {
    const { tokens } = await svc.changePassword({
        userId: req.user.id,
        currentPassword: req.body.current_password,
        newPassword: req.body.new_password,
    });
    await logAction(req.user.id, 'USER_PASSWORD_CHANGED', MODULES.AUTH, {
        ipAddress: req.ip, recordType: 'users', recordId: req.user.id,
        description: 'Password changed from the profile page — other devices signed out',
    }).catch(() => {});
    sendSuccess(res, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
        'Password changed. Every other device has been signed out; you stay signed in here.');
});

const getMyEmailChange = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.getPending(req.user.id));
});

const requestMyEmailChange = asyncHandler(async (req, res) => {
    const out = await svc.requestEmailChange({
        userId: req.user.id, newEmail: req.body.new_email, actor: req.user,
        currentPassword: req.body.current_password, twoFactorCode: req.body.two_factor_code,
    });
    await logAction(req.user.id, ACTIONS.USER_PROFILE_UPDATED, MODULES.USERS, {
        ipAddress: req.ip, recordType: 'email_change_requests', recordId: out.id,
        newValues: { new_email: out.new_email },
        description: `Asked to change email address to ${out.new_email} (waiting for confirmation from that address)`,
    }).catch(() => {});
    sendSuccess(res, await svc.getPending(req.user.id),
        `Almost done: we sent a confirmation link to ${out.new_email}. Your address changes when you click it (within ${svc.CONFIRM_HOURS} hours).`);
});

const cancelMyEmailChange = asyncHandler(async (req, res) => {
    await svc.cancelPending({ userId: req.user.id, actor: req.user });
    sendSuccess(res, null, 'Email change cancelled. Your address stays as it is.');
});

const adminGetEmailChange = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.getPending(parseInt(req.params.id, 10)));
});

const adminRequestEmailChange = asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (userId === req.user.id) throw createError.badRequest('To change your own email address, use your Profile › Security.');
    const reason = (req.body.reason || '').trim();
    if (!reason) throw createError.badRequest('Please give a reason (it is shown to the member and kept in the audit log).');
    const out = await svc.requestEmailChange({
        userId, newEmail: req.body.new_email, actor: req.user, byAdmin: true, adminReason: reason,
    });
    await logAction(req.user.id, ACTIONS.USER_PROFILE_UPDATED, MODULES.USERS, {
        ipAddress: req.ip, recordType: 'email_change_requests', recordId: out.id,
        newValues: { user_id: userId, new_email: out.new_email, reason },
        description: `Admin started an email change for user #${userId} to ${out.new_email} — waiting for the member to confirm. Reason: ${reason}`,
    }).catch(() => {});
    sendSuccess(res, await svc.getPending(userId),
        `Sent. ${out.new_email} must confirm with the link we emailed; the member's current address was told as well.`);
});

const adminCancelEmailChange = asyncHandler(async (req, res) => {
    await svc.cancelPending({ userId: parseInt(req.params.id, 10), actor: req.user });
    await logAction(req.user.id, ACTIONS.USER_PROFILE_UPDATED, MODULES.USERS, {
        ipAddress: req.ip, recordType: 'users', recordId: parseInt(req.params.id, 10),
        description: `Admin cancelled a waiting email change for user #${req.params.id}`,
    }).catch(() => {});
    sendSuccess(res, null, 'Email change cancelled.');
});

const confirmEmailChange = asyncHandler(async (req, res) => {
    const out = await svc.confirmEmailChange(req.body.token);
    sendSuccess(res, out, out.already
        ? `This address was already confirmed. Sign in with ${out.new_email}.`
        : `Your email address is now ${out.new_email}. Sign in with it from now on.`);
});

const cancelEmailChangeByLink = asyncHandler(async (req, res) => {
    const out = await svc.cancelByLink(req.body.token);
    const msg = out.outcome === 'reverted'
        ? `Done. Your account uses ${out.old_email} again, every device was signed out and your password was locked — check ${out.old_email} for a link to set a new password.`
        : out.outcome === 'cancelled'
            ? `Cancelled. Your account keeps using ${out.old_email}.`
            : 'This change had already been cancelled — nothing else to do.';
    sendSuccess(res, out, msg);
});

module.exports = {
    changePassword, getMyEmailChange, requestMyEmailChange, cancelMyEmailChange,
    adminGetEmailChange, adminRequestEmailChange, adminCancelEmailChange,
    confirmEmailChange, cancelEmailChangeByLink,
};
