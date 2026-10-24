// ============================================================
// ACCESS CONTROL (v1.86.0)
// Requested: "there are some accounts that are demanding access and i
// don't recognise them at all. I need a standard way to reject access
// and keep the system secure".
//
//   • settings          — how new accounts are made: INVITE_ONLY
//                         (default), OPEN (anyone, an Admin assigns or
//                         declines), CLOSED; clean-up limits; blocked
//                         email domains.
//   • checkRegistration — every sign-up passes here first: the mode,
//                         the invitation, addresses that can never
//                         receive email (.invalid, .test, example.com …),
//                         blocked domains and blocked addresses.
//   • declineAccess     — THE standard way to refuse an account that has
//                         no role: inactive, signed out everywhere, its
//                         open role requests closed, the reason recorded,
//                         optionally the address blocked and — when the
//                         account has no activity at all — removed.
//   • restoreAccess     — undo a decline made by mistake.
//   • runCleanup        — the daily job: declines accounts not verified
//                         within N days, and accounts verified but still
//                         without a role after M days (0 = never).
//   • flagsFor          — why an account looks suspicious.
//
// v1.87.0 — "if a person has no roles, unverified for long or flagged
// for suspicious activities by the system, they don't appear in dropdowns
// anywhere in the system and automatically their accounts deleted after
// 7 days. … only people with an invite or existing members should be able
// to access the system."
//   • runCleanup also REMOVES accounts that never held a role once they
//     are auto_remove_days (7) old — unless they came with an invitation
//     and are still waiting for an Admin's decision (those are kept). An
//     account that has any record is declined and kept instead.
//   • mayEnter — sign-in (and staying signed in) needs an invitation or a
//     role held at some time, unless registration is OPEN.
// ============================================================

const crypto = require('crypto');
const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES } = require('./auditService');

// Domains that can never receive email (RFC 2606 / 6761) — scanners and
// test tools register with these.
const RESERVED_TLDS = ['invalid', 'test', 'example', 'localhost', 'local'];
const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'];

const DEFAULTS = {
    registration_mode: 'INVITE_ONLY', unverified_expiry_days: 3, pending_expiry_days: 30,
    invite_valid_days: 7, blocked_domains: [], notify_admins: true, auto_remove_days: 7,
};

const ready = async (db = { query }) => {
    const r = await db.query(`SELECT to_regclass('public.access_control_settings') IS NOT NULL AS ok`);
    return r.rows[0].ok;
};

const getSettings = async (db = { query }) => {
    if (!(await ready(db))) return { ...DEFAULTS, registration_mode: 'OPEN', ready: false };
    const r = await db.query('SELECT * FROM access_control_settings WHERE id = 1');
    return { ...DEFAULTS, ...(r.rows[0] || {}), ready: true };
};

const normEmail = (e) => String(e || '').trim().toLowerCase();
const domainOf = (e) => normEmail(e).split('@')[1] || '';
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

const reservedDomain = (email) => {
    const d = domainOf(email);
    if (!d) return true;
    const tld = d.split('.').pop();
    return RESERVED_TLDS.includes(tld) || RESERVED_DOMAINS.includes(d);
};

const domainBlocked = (email, settings) => {
    const d = domainOf(email);
    return (settings.blocked_domains || []).some(b => {
        const x = String(b || '').trim().toLowerCase().replace(/^@/, '');
        return x && (d === x || d.endsWith(`.${x}`));
    });
};

const emailBlocked = async (db, email) => {
    const r = await db.query(`SELECT reason FROM blocked_emails WHERE lower(email) = $1 LIMIT 1`, [normEmail(email)]);
    return r.rows[0] || null;
};

// ------------------------------------------------------------
// The invitation behind a token (valid or not, and why)
// ------------------------------------------------------------
const findInvitation = async (db, token) => {
    if (!token) return null;
    const r = await db.query(`
        SELECT i.*, r.name AS role_name FROM account_invitations i
        LEFT JOIN roles r ON r.id = i.role_id
        WHERE i.token_hash = $1`, [hashToken(token)]);
    const inv = r.rows[0];
    if (!inv) return { valid: false, reason: 'This invitation link is not valid.' };
    if (inv.revoked_at) return { valid: false, reason: 'This invitation was withdrawn. Ask the administrator for a new one.', inv };
    if (inv.used_at) return { valid: false, reason: 'This invitation has already been used. Sign in instead.', inv };
    if (new Date(inv.expires_at) < new Date()) return { valid: false, reason: 'This invitation has expired. Ask the administrator to send it again.', inv };
    return { valid: true, inv };
};

// ------------------------------------------------------------
// Every sign-up: may this address register now?
// Returns { invitation } (null when none was needed / given).
// ------------------------------------------------------------
// A brand-new installation: nobody holds a role yet, so nobody could send
// an invitation — the first person may register (an Admin is then made
// from the database, as before). Never true on a working system.
const isFirstSetup = async (db) => {
    const r = await db.query(`SELECT NOT EXISTS (SELECT 1 FROM user_roles WHERE revoked_at IS NULL) AS first`);
    return r.rows[0].first === true;
};

const checkRegistration = async (db, { email, inviteToken, honeypot }) => {
    // the invisible field people never see — only programs fill it in
    if (honeypot && String(honeypot).trim()) {
        throw createError.badRequest('Registration could not be completed.');
    }
    const settings = await getSettings(db);
    if (!settings.ready) return { invitation: null, settings }; // database not at v1.86.0 yet
    if (settings.registration_mode !== 'OPEN' && !inviteToken && await isFirstSetup(db)) {
        if (reservedDomain(email)) throw createError.badRequest('This email address cannot receive email. Use your real email address.');
        return { invitation: null, settings };
    }
    if (settings.registration_mode === 'CLOSED') {
        throw createError.forbidden('New accounts are not being accepted at the moment. Contact the company administrator.');
    }
    let invitation = null;
    if (inviteToken) {
        const found = await findInvitation(db, inviteToken);
        if (!found.valid) throw createError.badRequest(found.reason);
        if (normEmail(found.inv.email) !== normEmail(email)) {
            throw createError.badRequest('This invitation was sent to a different email address — register with the address the invitation was sent to.');
        }
        invitation = found.inv;
    } else if (settings.registration_mode === 'INVITE_ONLY') {
        throw createError.forbidden('Accounts are by invitation only. Ask the company administrator to send you an invitation by email, then use the link in it.');
    }
    if (reservedDomain(email)) {
        throw createError.badRequest('This email address cannot receive email. Use your real email address.');
    }
    if (!invitation && domainBlocked(email, settings)) {
        throw createError.badRequest('Registrations from this email domain are not accepted.');
    }
    if (await emailBlocked(db, email)) {
        throw createError.forbidden('This email address may not register. Contact the company administrator.');
    }
    return { invitation, settings };
};

// ------------------------------------------------------------
// Why an account waiting for access looks suspicious
// ------------------------------------------------------------
const flagsFor = (u, settings) => {
    const flags = [];
    const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 86400000;
    if (reservedDomain(u.email)) flags.push({ code: 'FAKE_DOMAIN', label: 'Address cannot receive email (test / scanner domain)' });
    if (domainBlocked(u.email, settings)) flags.push({ code: 'BLOCKED_DOMAIN', label: 'Email domain is on the blocked list' });
    if (/^scan[-_.]/i.test(u.email) || /^scan\s/i.test(`${u.first_name || ''}`)) flags.push({ code: 'AUTOMATED', label: 'Looks like an automated scanner' });
    if (!u.is_email_verified) flags.push({ code: 'UNVERIFIED', label: `Email not verified (${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? '' : 's'})` });
    if (!u.invitation_id) flags.push({ code: 'NOT_INVITED', label: 'Registered without an invitation' });
    if (!u.is_active) flags.push({ code: 'INACTIVE', label: 'Already deactivated' });
    return flags;
};

// ------------------------------------------------------------
// Decline access — one account (inside the caller's transaction)
// ------------------------------------------------------------
const declineOne = async (client, { userId, reason, blockEmail, byUserId, automatic = false }) => {
    const r = await client.query(`
        SELECT u.id, u.email, u.first_name, u.last_name, u.rejected_at,
               (SELECT COUNT(*) FROM user_roles ur WHERE ur.user_id = u.id AND ur.revoked_at IS NULL)::int AS roles
        FROM users u WHERE u.id = $1 FOR UPDATE OF u`, [userId]);
    const u = r.rows[0];
    if (!u) throw createError.notFound('Account not found');
    if (byUserId && Number(byUserId) === Number(u.id)) throw createError.badRequest('You cannot decline your own account.');
    if (u.roles > 0) {
        throw createError.badRequest(`${u.first_name} ${u.last_name} already holds a role — remove the roles first (Manage Roles), or use Deactivate.`);
    }
    if (u.rejected_at) return { id: u.id, email: u.email, already: true };
    await client.query(`
        UPDATE users SET is_active = FALSE, rejected_at = NOW(), rejected_by = $2, rejection_reason = $3,
               email_verification_token = NULL, password_reset_token = NULL, password_reset_expires = NULL,
               session_version = COALESCE(session_version, 0) + 1, updated_at = NOW()
        WHERE  id = $1`, [u.id, byUserId || null, reason]);
    await client.query(`
        UPDATE role_requests SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(),
               review_notes = COALESCE(review_notes || ' — ', '') || $3
        WHERE  user_id = $1 AND status = 'PENDING'`, [u.id, byUserId || null, `Access declined: ${reason}`]);
    if (blockEmail) {
        await client.query(`
            INSERT INTO blocked_emails (email, reason, blocked_by) VALUES (lower($1), $2, $3)
            ON CONFLICT DO NOTHING`, [u.email, reason, byUserId || null]);
    }
    await logAction(byUserId || null, ACTIONS.USER_ACCESS_DECLINED || 'USER_ACCESS_DECLINED', MODULES.USERS, {
        recordType: 'users', recordId: u.id,
        newValues: { reason, block_email: !!blockEmail, automatic },
        description: `${automatic ? 'Automatically declined' : 'Access declined'}: ${u.email} — ${reason}${blockEmail ? ' (address blocked)' : ''}`,
        client,
    });
    return { id: u.id, email: u.email, name: `${u.first_name} ${u.last_name}` };
};

// many accounts; each in its own transaction so one problem does not
// stop the others. remove = delete completely when it has no activity.
const declineAccess = async ({ userIds, reason, blockEmail, remove, byUserId }) => {
    const { getUserFootprint, hardDeleteUser } = require('./userDeletionService');
    const done = []; const problems = []; const removed = [];
    for (const id of [...new Set(userIds.map(Number))]) {
        try {
            const r = await withTransaction((client) => declineOne(client, { userId: id, reason, blockEmail, byUserId }));
            done.push(r);
            if (remove) {
                const fp = await getUserFootprint(id);
                if (fp.clean) {
                    const del = await hardDeleteUser(id);
                    removed.push(del.email);
                    await logAction(byUserId, ACTIONS.USER_DELETED || 'USER_DELETED', MODULES.USERS, {
                        recordType: 'users', recordId: id,
                        description: `Declined account removed completely (no activity): ${del.email}`,
                    }).catch(() => {});
                }
            }
        } catch (err) {
            problems.push({ id, message: err.message });
        }
    }
    return { declined: done.filter(d => !d.already).length, alreadyDeclined: done.filter(d => d.already).length, removed, problems };
};

const restoreAccess = async ({ userId, unblock, byUserId }) => withTransaction(async (client) => {
    const r = await client.query(`SELECT id, email, rejected_at FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const u = r.rows[0];
    if (!u) throw createError.notFound('Account not found');
    if (!u.rejected_at) throw createError.badRequest('This account was not declined.');
    await client.query(`
        UPDATE users SET is_active = TRUE, rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL, updated_at = NOW()
        WHERE id = $1`, [userId]);
    if (unblock) await client.query(`DELETE FROM blocked_emails WHERE lower(email) = lower($1)`, [u.email]);
    await logAction(byUserId, ACTIONS.USER_ACCESS_RESTORED || 'USER_ACCESS_RESTORED', MODULES.USERS, {
        recordType: 'users', recordId: u.id, description: `Access restored (decline undone): ${u.email}${unblock ? ' — address unblocked' : ''}`, client,
    });
    return { id: u.id, email: u.email };
});

// ------------------------------------------------------------
// May this account sign in? (v1.87.0)
// Invitation-only / closed: only people who came with an invitation, or
// who hold (or once held) a role. Old accounts made before invitations
// existed and never given a role are kept out — an Admin who recognises
// one can still give it a role from Users › Waiting for access.
// ------------------------------------------------------------
const mayEnter = async (userId, db = { query }) => {
    if (!(await ready(db))) return { ok: true };
    const s = await getSettings(db);
    if (s.registration_mode === 'OPEN') return { ok: true };
    const r = await db.query(`
        SELECT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id) AS had_role,
               (to_jsonb(u)->>'invitation_id') IS NOT NULL AS invited
        FROM users u WHERE u.id = $1`, [userId]);
    const u = r.rows[0];
    if (!u) return { ok: false, message: 'Account not found' };
    if (u.had_role || u.invited) return { ok: true };
    if (await isFirstSetup(db)) return { ok: true };
    return {
        ok: false,
        message: 'This system is open only to invited people and existing members. Ask the company administrator for an invitation or to approve your account.',
    };
};

// ------------------------------------------------------------
// Daily clean-up
// ------------------------------------------------------------
const runCleanup = async () => {
    if (!(await ready())) return { skipped: true };
    const s = await getSettings();
    // Only accounts that are active and NEVER held a role: a former
    // officer or member whose role was revoked is never swept up here.
    const noRole = `u.is_active = TRUE AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`;
    const unverified = await query(`
        SELECT u.id FROM users u
        WHERE  u.rejected_at IS NULL AND u.is_email_verified = FALSE AND ${noRole}
        AND    u.created_at < NOW() - make_interval(days => $1)`, [s.unverified_expiry_days]);
    let waiting = { rows: [] };
    if (s.pending_expiry_days > 0) {
        // v1.87.0 — invited accounts waiting for their role are kept
        waiting = await query(`
            SELECT u.id FROM users u
            WHERE  u.rejected_at IS NULL AND u.is_email_verified = TRUE AND ${noRole}
            AND    u.invitation_id IS NULL
            AND    u.created_at < NOW() - make_interval(days => $1)`, [s.pending_expiry_days]);
    }
    let declined = 0;
    for (const [rows, reason] of [
        [unverified.rows, `Email not verified within ${s.unverified_expiry_days} day(s)`],
        [waiting.rows, `No role assigned within ${s.pending_expiry_days} day(s)`],
    ]) {
        for (const r of rows) {
            try {
                await withTransaction((client) => declineOne(client, { userId: r.id, reason: `Automatic: ${reason}`, blockEmail: false, byUserId: null, automatic: true }));
                declined += 1;
            } catch (_) { /* next */ }
        }
    }

    // v1.87.0 — remove accounts that never became members
    const removed = []; let keptWithRecords = 0;
    const days = s.auto_remove_days === undefined || s.auto_remove_days === null ? 7 : Number(s.auto_remove_days);
    if (days > 0) {
        const { getUserFootprint, hardDeleteUser } = require('./userDeletionService');
        // never held a role; older than the limit; not an invited person
        // still waiting for a decision (declined invited accounts do go)
        const gone = await query(`
            SELECT u.id, u.email, u.rejected_at FROM users u
            WHERE  NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)
            AND    u.created_at < NOW() - make_interval(days => $1)
            AND    (u.invitation_id IS NULL OR u.rejected_at IS NOT NULL OR u.is_email_verified = FALSE)
            ORDER  BY u.id`, [days]);
        for (const u of gone.rows) {
            try {
                const fp = await getUserFootprint(u.id);
                if (!fp.clean) {
                    // something real is recorded against it: decline (keeps the history) and leave it
                    if (!u.rejected_at) {
                        await withTransaction((client) => declineOne(client, {
                            userId: u.id, reason: `Automatic: no role within ${days} day(s) — kept because it has records`,
                            blockEmail: false, byUserId: null, automatic: true,
                        }));
                    }
                    keptWithRecords += 1;
                    continue;
                }
                const del = await hardDeleteUser(u.id);
                removed.push(del.email);
                await logAction(null, ACTIONS.USER_PERMANENTLY_DELETED || 'USER_PERMANENTLY_DELETED', MODULES.USERS, {
                    recordType: 'users', recordId: u.id, newValues: { automatic: true, days },
                    description: `Automatic: account removed — no role within ${days} day(s) of registering (${del.email})`,
                }).catch(() => {});
            } catch (_) { /* next */ }
        }
    }
    return { declined, removed: removed.length, keptWithRecords };
};

module.exports = {
    RESERVED_TLDS, getSettings, ready, normEmail, hashToken, reservedDomain, domainBlocked,
    findInvitation, isFirstSetup, checkRegistration, flagsFor, declineOne, declineAccess, restoreAccess, runCleanup, mayEnter,
};
