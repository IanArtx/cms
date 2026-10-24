// ============================================================
// ACCESS CONTROL CONTROLLER (v1.86.0) — prefix /api/access
// See services/accessControlService.js for the rules.
//   GET  /settings                   USER_MANAGE (read) — PUT: Admin
//   GET  /requests?view=pending|declined     accounts waiting for a role / declined
//   POST /decline   { user_ids[], reason, block_email, remove }
//   POST /restore   { user_id, unblock }
//   GET  /invitations · POST /invitations · POST /invitations/:id/resend · POST /invitations/:id/revoke
//   GET  /blocked-emails · DELETE /blocked-emails/:id
// Public (in /api/auth): GET /registration-info?invite=…
// ============================================================

const crypto = require('crypto');
const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { sendEmail } = require('../config/email');
const { wrapEmail, getBranding } = require('../services/emailTemplates');
const access = require('../services/accessControlService');

const MODES = ['INVITE_ONLY', 'OPEN', 'CLOSED'];

// ---------------- settings ----------------
const getSettings = asyncHandler(async (req, res) => {
    const s = await access.getSettings();
    sendSuccess(res, { ...s, reserved_tlds: access.RESERVED_TLDS });
});

const updateSettings = asyncHandler(async (req, res) => {
    const b = req.body;
    const cur = await access.getSettings();
    if (!cur.ready) throw createError.badRequest('Run the v1.86.0 database update first.');
    const next = {
        registration_mode: b.registration_mode !== undefined ? b.registration_mode : cur.registration_mode,
        unverified_expiry_days: b.unverified_expiry_days !== undefined ? parseInt(b.unverified_expiry_days, 10) : cur.unverified_expiry_days,
        pending_expiry_days: b.pending_expiry_days !== undefined ? parseInt(b.pending_expiry_days, 10) : cur.pending_expiry_days,
        invite_valid_days: b.invite_valid_days !== undefined ? parseInt(b.invite_valid_days, 10) : cur.invite_valid_days,
        notify_admins: b.notify_admins !== undefined ? !!b.notify_admins : cur.notify_admins,
        blocked_domains: Array.isArray(b.blocked_domains)
            ? [...new Set(b.blocked_domains.map(d => String(d || '').trim().toLowerCase().replace(/^@/, '')).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))]
            : cur.blocked_domains,
    };
    if (!MODES.includes(next.registration_mode)) throw createError.badRequest('Invalid registration mode.');
    // v1.87.0 — accounts that never became members are removed after N days
    const hasAutoRemove = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'access_control_settings' AND column_name = 'auto_remove_days'`)).rows.length > 0;
    if (hasAutoRemove && b.auto_remove_days !== undefined) {
        const d = parseInt(b.auto_remove_days, 10);
        if (!Number.isInteger(d) || d < 0 || d > 60) throw createError.badRequest('Remove after: 0 to 60 days (0 = never).');
        next.auto_remove_days = d;
        await query('UPDATE access_control_settings SET auto_remove_days = $1 WHERE id = 1', [d]);
    }
    await query(`
        UPDATE access_control_settings SET registration_mode = $1, unverified_expiry_days = $2, pending_expiry_days = $3,
               invite_valid_days = $4, notify_admins = $5, blocked_domains = $6, updated_at = NOW(), updated_by = $7
        WHERE id = 1`,
    [next.registration_mode, next.unverified_expiry_days, next.pending_expiry_days, next.invite_valid_days,
        next.notify_admins, next.blocked_domains, req.user.id]);
    await logAction(req.user.id, ACTIONS.ACCESS_SETTINGS_UPDATED, MODULES.USERS, {
        ipAddress: req.ip, recordType: 'access_control_settings', recordId: 1,
        oldValues: { registration_mode: cur.registration_mode, unverified_expiry_days: cur.unverified_expiry_days, pending_expiry_days: cur.pending_expiry_days, auto_remove_days: cur.auto_remove_days, blocked_domains: cur.blocked_domains },
        newValues: next, description: `Access settings changed — new accounts: ${next.registration_mode}`,
    });
    sendSuccess(res, next, 'Access settings saved.');
});

// ---------------- accounts waiting / declined ----------------
const listRequests = asyncHandler(async (req, res) => {
    const view = req.query.view === 'declined' ? 'declined' : 'pending';
    const settings = await access.getSettings();
    const r = await query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.is_active, u.is_email_verified, u.created_at, u.last_login_at,
               u.registered_ip, u.registered_user_agent, u.invitation_id, u.rejected_at, u.rejection_reason,
               rb.first_name || ' ' || rb.last_name AS rejected_by_name,
               ib.first_name || ' ' || ib.last_name AS invited_by_name,
               (SELECT json_agg(json_build_object('role', ro.name, 'reason', rq.reason, 'status', rq.status) ORDER BY rq.created_at DESC)
                FROM role_requests rq JOIN roles ro ON ro.id = rq.role_id WHERE rq.user_id = u.id) AS role_requests,
               EXISTS (SELECT 1 FROM blocked_emails be WHERE lower(be.email) = lower(u.email)) AS email_blocked
        FROM   users u
        LEFT JOIN users rb ON rb.id = u.rejected_by
        LEFT JOIN account_invitations inv ON inv.id = u.invitation_id
        LEFT JOIN users ib ON ib.id = inv.invited_by
        WHERE  ${view === 'declined'
        ? 'u.rejected_at IS NOT NULL'
        // waiting = never held any role and not declined (a former member whose
        // role was revoked is not a new request; they stay under Members)
        : 'u.rejected_at IS NULL AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)'}
        ORDER  BY ${view === 'declined' ? 'u.rejected_at DESC' : 'u.created_at DESC'}
        LIMIT  500`);
    const rows = r.rows.map(u => ({ ...u, flags: view === 'pending' ? access.flagsFor(u, settings) : [] }));
    sendSuccess(res, { view, mode: settings.registration_mode, rows });
});

const decline = asyncHandler(async (req, res) => {
    const ids = (req.body.user_ids || []).map(Number).filter(Boolean);
    if (!ids.length) throw createError.badRequest('Choose at least one account.');
    if (ids.includes(Number(req.user.id))) throw createError.badRequest('You cannot decline your own account.');
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) throw createError.badRequest('Give a short reason (it is kept with the account).');
    const result = await access.declineAccess({
        userIds: ids, reason, blockEmail: !!req.body.block_email, remove: !!req.body.remove, byUserId: req.user.id,
    });
    const parts = [`${result.declined} account(s) declined`];
    if (result.removed.length) parts.push(`${result.removed.length} removed completely (no activity)`);
    if (result.alreadyDeclined) parts.push(`${result.alreadyDeclined} were already declined`);
    if (result.problems.length) parts.push(`${result.problems.length} not changed: ${result.problems.map(p => p.message.replace(/\.$/, '')).join('; ')}`);
    sendSuccess(res, result, `${parts.join(' · ')}.`);
});

const restore = asyncHandler(async (req, res) => {
    const r = await access.restoreAccess({ userId: parseInt(req.body.user_id, 10), unblock: !!req.body.unblock, byUserId: req.user.id });
    sendSuccess(res, r, `${r.email} can sign in again (it still has no role until one is assigned).`);
});

// ---------------- invitations ----------------
const inviteLink = (token) => `${process.env.FRONTEND_URL}/register?invite=${encodeURIComponent(token)}`;

const sendInvitationEmail = async ({ inv, token, byName }) => {
    const branding = await getBranding();
    const url = inviteLink(token);
    const html = await wrapEmail(`
        <h2 style="margin-top:0;">You are invited to ${branding.company_name}</h2>
        <p>Hello${inv.first_name ? ` ${inv.first_name}` : ''},</p>
        <p>${byName} has invited you to create your account on the ${branding.company_name} system.
           ${inv.role_name ? `It is for the role <strong>${inv.role_name}</strong>, which an administrator confirms once your account exists.` : ''}</p>
        ${inv.note ? `<p><em>${String(inv.note).replace(/</g, '&lt;')}</em></p>` : ''}
        <a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;margin:16px 0;">
            Create my account</a>
        <p>The link works only for this email address (${inv.email}) and expires on ${new Date(inv.expires_at).toUTCString().slice(0, 16)}.</p>
        <p>If you were not expecting this, ignore this email — nothing happens without the link.</p>
    `, { preheader: `Your invitation to ${branding.company_name}` });
    await sendEmail({ to: inv.email, subject: `Your invitation — ${branding.company_name}`, html });
};

const listInvitations = asyncHandler(async (req, res) => {
    const r = await query(`
        SELECT i.id, i.email, i.first_name, i.last_name, i.note, i.expires_at, i.created_at, i.sent_count, i.last_sent_at,
               i.used_at, i.revoked_at, ro.name AS role_name,
               ib.first_name || ' ' || ib.last_name AS invited_by_name,
               uu.first_name || ' ' || uu.last_name AS used_by_name,
               CASE WHEN i.revoked_at IS NOT NULL THEN 'REVOKED' WHEN i.used_at IS NOT NULL THEN 'USED'
                    WHEN i.expires_at < NOW() THEN 'EXPIRED' ELSE 'OPEN' END AS state
        FROM   account_invitations i
        LEFT JOIN roles ro ON ro.id = i.role_id
        LEFT JOIN users ib ON ib.id = i.invited_by
        LEFT JOIN users uu ON uu.id = i.used_by_user_id
        ORDER  BY i.created_at DESC LIMIT 300`);
    sendSuccess(res, r.rows);
});

const createInvitation = asyncHandler(async (req, res) => {
    const email = access.normEmail(req.body.email);
    if (access.reservedDomain(email)) throw createError.badRequest('That address cannot receive email.');
    const settings = await access.getSettings();
    const exists = await query(`SELECT id, rejected_at FROM users WHERE lower(email) = $1`, [email]);
    if (exists.rows.length) {
        throw createError.badRequest(exists.rows[0].rejected_at
            ? 'An account with this email exists and was declined — restore it under Access requests › Declined instead.'
            : 'An account with this email already exists.');
    }
    const blocked = await query(`SELECT 1 FROM blocked_emails WHERE lower(email) = $1`, [email]);
    if (blocked.rows.length) throw createError.badRequest('This address is blocked — unblock it first (Access requests › Blocked addresses).');
    let roleName = null;
    if (req.body.role_id) {
        const ro = await query(`SELECT name FROM roles WHERE id = $1 AND is_active = TRUE`, [req.body.role_id]);
        if (!ro.rows.length) throw createError.badRequest('Role not found.');
        roleName = ro.rows[0].name;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const inv = await withTransaction(async (client) => {
        // an earlier open invitation to the same address is replaced
        await client.query(`UPDATE account_invitations SET revoked_at = NOW(), revoked_by = $2
                            WHERE lower(email) = $1 AND used_at IS NULL AND revoked_at IS NULL`, [email, req.user.id]);
        const r = await client.query(`
            INSERT INTO account_invitations (email, first_name, last_name, role_id, note, token_hash, expires_at, invited_by)
            VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(days => $7), $8) RETURNING *`,
        [email, req.body.first_name || null, req.body.last_name || null, req.body.role_id || null, req.body.note || null,
            access.hashToken(token), settings.invite_valid_days, req.user.id]);
        await logAction(req.user.id, ACTIONS.USER_INVITED, MODULES.USERS, {
            ipAddress: req.ip, recordType: 'account_invitations', recordId: r.rows[0].id,
            newValues: { email, role: roleName }, description: `Invitation sent to ${email}${roleName ? ` (${roleName})` : ''}`, client,
        });
        return r.rows[0];
    });
    let emailed = true;
    try {
        await sendInvitationEmail({ inv: { ...inv, role_name: roleName }, token, byName: `${req.user.first_name} ${req.user.last_name}` });
    } catch (_) { emailed = false; }
    sendCreated(res, { id: inv.id, email, link: inviteLink(token), emailed },
        emailed ? `Invitation emailed to ${email}. It expires in ${settings.invite_valid_days} day(s).`
            : `Invitation made, but the email could not be sent — copy the link and send it to ${email} yourself.`);
});

const resendInvitation = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const settings = await access.getSettings();
    const token = crypto.randomBytes(32).toString('hex');
    const r = await query(`
        UPDATE account_invitations SET token_hash = $2, expires_at = NOW() + make_interval(days => $3),
               sent_count = sent_count + 1, last_sent_at = NOW()
        WHERE  id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING *`, [id, access.hashToken(token), settings.invite_valid_days]);
    if (!r.rows.length) throw createError.badRequest('Only an invitation that is not used or withdrawn can be sent again.');
    const ro = r.rows[0].role_id ? (await query('SELECT name FROM roles WHERE id = $1', [r.rows[0].role_id])).rows[0] : null;
    let emailed = true;
    try { await sendInvitationEmail({ inv: { ...r.rows[0], role_name: ro?.name }, token, byName: `${req.user.first_name} ${req.user.last_name}` }); } catch (_) { emailed = false; }
    sendSuccess(res, { link: inviteLink(token), emailed }, emailed ? 'Invitation sent again with a new link (the old link no longer works).' : 'New link made, but the email could not be sent — copy the link.');
});

const revokeInvitation = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await query(`UPDATE account_invitations SET revoked_at = NOW(), revoked_by = $2
                           WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING email`, [id, req.user.id]);
    if (!r.rows.length) throw createError.badRequest('This invitation is already used or withdrawn.');
    await logAction(req.user.id, ACTIONS.USER_INVITATION_REVOKED, MODULES.USERS, {
        ipAddress: req.ip, recordType: 'account_invitations', recordId: id, description: `Invitation withdrawn: ${r.rows[0].email}`,
    });
    sendSuccess(res, null, 'Invitation withdrawn — its link no longer works.');
});

// ---------------- blocked addresses ----------------
const listBlocked = asyncHandler(async (req, res) => {
    const r = await query(`
        SELECT b.id, b.email, b.reason, b.blocked_at, u.first_name || ' ' || u.last_name AS blocked_by_name
        FROM blocked_emails b LEFT JOIN users u ON u.id = b.blocked_by ORDER BY b.blocked_at DESC LIMIT 500`);
    sendSuccess(res, r.rows);
});
const unblock = asyncHandler(async (req, res) => {
    const r = await query(`DELETE FROM blocked_emails WHERE id = $1 RETURNING email`, [parseInt(req.params.id, 10)]);
    if (!r.rows.length) throw createError.notFound('Not found');
    await logAction(req.user.id, ACTIONS.USER_ACCESS_RESTORED, MODULES.USERS, {
        ipAddress: req.ip, recordType: 'blocked_emails', description: `Address unblocked: ${r.rows[0].email}`,
    });
    sendSuccess(res, null, `${r.rows[0].email} may register again.`);
});

// ---------------- public: what the register page should show ----------------
const registrationInfo = asyncHandler(async (req, res) => {
    const s = await access.getSettings();
    let invite = null;
    if (req.query.invite) {
        const f = await access.findInvitation({ query }, String(req.query.invite));
        invite = f && f.valid
            ? { valid: true, email: f.inv.email, first_name: f.inv.first_name, last_name: f.inv.last_name, role_id: f.inv.role_id, role_name: f.inv.role_name }
            : { valid: false, reason: f ? f.reason : 'This invitation link is not valid.' };
    }
    // a brand-new installation (nobody holds a role yet): the first person may register
    const mode = (s.ready && s.registration_mode !== 'OPEN' && !invite && await access.isFirstSetup({ query })) ? 'OPEN' : s.registration_mode;
    sendSuccess(res, { mode, invite });
});

module.exports = {
    getSettings, updateSettings, listRequests, decline, restore,
    listInvitations, createInvitation, resendInvitation, revokeInvitation,
    listBlocked, unblock, registrationInfo,
};
