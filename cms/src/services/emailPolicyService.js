// ============================================================
// EMAIL CONTROLS (v1.88.0)
//
// Requested: "I would also like I can regulate the notification emails
// rather than the system always sending emails ever time".
// Confirmed: the Admin sets company-wide rules per kind of email, and each
// member can then choose for the kinds the Admin lets them change; legal
// notices (meeting notices) and security emails always go.
//
// Every in-app (bell) notification is still created as before — only the
// EMAIL is regulated. For each email the decision is one of:
//   'SEND'   — sent now (as before)
//   'DIGEST' — held and included in one daily summary email
//   'SKIP'   — not emailed (the bell notification is still there)
//
// The rules, from strongest to weakest:
//   1. Kinds marked "always" (meeting notices, security) are always SENT.
//   2. The master switch: "Only essential emails" skips every other kind.
//   3. The Admin's rule for the kind: Off → SKIP; Daily summary → DIGEST;
//      Each time → SEND.
//   4. If the Admin lets members choose, the member's own choice for the
//      kind wins (Each time / Daily summary / Off).
// Settings are read at most once a minute (cached).
//
//   const { decide, kindOf } = require('./emailPolicyService');
//   const d = await decide(userId, 'REQUISITION_APPROVED');   // 'SEND' | 'DIGEST' | 'SKIP'
// ============================================================

const { query } = require('../config/database');

// The kinds of email. `types` = notification types (exact), `prefixes` =
// notification types that start with it. Anything not matched → OTHER.
const KINDS = [
    { key: 'MEETING_NOTICES', label: 'Meeting notices and cancellations', always: true,
        description: 'Notices of general and board meetings and their cancellation — a legal requirement, always sent.',
        types: ['MEETING_NOTICE', 'NOTICE_OF_MEETING', 'MEETING_CANCELLED'] },
    { key: 'SECURITY', label: 'Sign-in and security', always: true,
        description: 'Email verification, password resets, new-device and account-security alerts, invitations — always sent.',
        types: ['SECURITY', 'ACCOUNT_SECURITY', 'INVITATION', 'ACCESS_RULE_CHANGED'] }, // v1.89.0 — a change to one's own access
    { key: 'MEETINGS', label: 'Meetings and resolutions', description: 'Minutes, proxies, resolutions to sign or file, registers.',
        prefixes: ['MEETING_', 'RESOLUTION'], types: ['WRITTEN_RESOLUTION', 'PROXY_FORM', 'CERTIFIED_RESOLUTION', 'ATTENDANCE_REGISTER'] },
    { key: 'EVENTS', label: 'Events and reminders', description: 'Approved events and their changes.', prefixes: ['EVENT_'] },
    { key: 'REQUISITIONS', label: 'Requisitions', description: 'Requests, approvals, money released, receipts.', prefixes: ['REQUISITION_'] },
    { key: 'PAYMENTS', label: 'Payments, transfers and approvals of money', description: 'Transfers, payment confirmations and acknowledgements, reversals, money entries.',
        prefixes: ['TRANSFER', 'PAYMENT_', 'MONEY_ENTRY_', 'REVERSAL_'] },
    { key: 'CONTRIBUTIONS', label: 'Contributions, shares and dividends', description: 'Contributions, pledges and capital calls, deposits, shares, certificates, dividends.',
        prefixes: ['CONTRIBUTION', 'PLEDGE', 'CAPITAL_GOAL_', 'DEPOSIT_', 'SHARE_', 'CERTIFICATE', 'DIVIDEND_'] },
    { key: 'SAVINGS', label: 'Savings, side fund and fines', prefixes: ['SAVINGS', 'SIDE_FUND_', 'FINE_'], description: 'Savings movements, side-fund dues, fines.' },
    { key: 'SERVICE_FEES', label: 'Service fees', prefixes: ['SERVICE_'], description: 'Service-fee dues, requests, advances and reimbursements.' },
    { key: 'INVESTMENTS', label: 'Investments, loans and grants', prefixes: ['INVESTMENT_', 'LOAN_', 'GRANT_', 'MMF'], description: 'Investment operations and returns, loans, grants.' },
    { key: 'FX', label: 'Exchange rates', prefixes: ['FX_'], description: 'Bank of Uganda rates waiting for approval, failed checks.' },
    { key: 'TAX', label: 'Tax', prefixes: ['TAX_'], description: 'Tax deadlines and tax-agent status.' },
    { key: 'AUDIT', label: 'Audit', prefixes: ['AUDIT_'], description: 'Auditor access, submissions and reports.' },
    { key: 'REPORTS', label: 'Monthly reports', types: ['MONTHLY_REPORT', 'MONTHLY_REPORT_SENT', 'PERSONAL_REPORT', 'PERSONAL_REPORT_SENT'], description: 'The company report and your personal report each month (with the PDF).' },
    { key: 'ANNOUNCEMENTS', label: 'Announcements to all members', types: ['GENERAL_ANNOUNCEMENT'], description: 'Messages sent to everyone from Reports › Email all members.' },
    { key: 'ACCESS', label: 'New accounts and access requests', types: ['NEW_REGISTRATION', 'ROLE_REQUEST'], description: 'People asking for access (sent to Admins).' },
    { key: 'DOCUMENTS', label: 'Documents and signatures', prefixes: ['DOCUMENT'], description: 'Documents to approve or sign.' },
    { key: 'OTHER', label: 'Everything else', description: 'Any other notification.' },
];
const MODES = ['INSTANT', 'DIGEST', 'OFF'];

const kindOf = (type) => {
    const t = String(type || '').toUpperCase();
    for (const k of KINDS) {
        if ((k.types || []).includes(t)) return k.key;
    }
    let best = null;
    for (const k of KINDS) {
        for (const p of (k.prefixes || [])) {
            if (t.startsWith(p) && (!best || p.length > best.len)) best = { key: k.key, len: p.length };
        }
    }
    return best ? best.key : 'OTHER';
};
const kindInfo = (key) => KINDS.find(k => k.key === key) || KINDS[KINDS.length - 1];

// ---- settings (cached for a minute) ---------------------------------
let cache = null;
let cacheAt = 0;
const invalidate = () => { cache = null; };

const ready = async (db = { query }) => {
    const r = await db.query(`SELECT to_regclass('public.email_settings') IS NOT NULL AS ok`);
    return !!r.rows[0].ok;
};

const loadSettings = async (db = { query }) => {
    if (cache && Date.now() - cacheAt < 60 * 1000) return cache;
    if (!(await ready(db))) {
        cache = { ready: false, essentialOnly: false, digestHour: 18, kinds: new Map() };
        cacheAt = Date.now();
        return cache;
    }
    const g = (await db.query('SELECT * FROM email_settings WHERE id = 1')).rows[0] || {};
    const kinds = new Map();
    for (const r of (await db.query('SELECT kind, mode, members_may_change FROM email_kind_settings')).rows) {
        kinds.set(r.kind, { mode: r.mode, membersMayChange: r.members_may_change });
    }
    cache = { ready: true, essentialOnly: !!g.essential_only, digestHour: g.digest_hour ?? 18, kinds };
    cacheAt = Date.now();
    return cache;
};

// The Admin's rule for a kind (defaults: each time, members may change).
const ruleFor = (settings, kind) => settings.kinds.get(kind) || { mode: 'INSTANT', membersMayChange: true };

/**
 * What to do with one email to one person.
 * @returns 'SEND' | 'DIGEST' | 'SKIP'
 */
const decide = async (userId, type, db = { query }) => {
    try {
        const s = await loadSettings(db);
        if (!s.ready) return 'SEND';
        const kind = kindOf(type);
        if (kindInfo(kind).always) return 'SEND';
        if (s.essentialOnly) return 'SKIP';
        const rule = ruleFor(s, kind);
        let mode = rule.mode;
        if (mode !== 'OFF' && rule.membersMayChange && userId) {
            const p = await db.query('SELECT mode FROM user_email_preferences WHERE user_id = $1 AND kind = $2', [userId, kind]);
            if (p.rows.length && MODES.includes(p.rows[0].mode)) mode = p.rows[0].mode;
        }
        return mode === 'OFF' ? 'SKIP' : mode === 'DIGEST' ? 'DIGEST' : 'SEND';
    } catch {
        return 'SEND'; // never lose an email because the rules could not be read
    }
};

// Hold an email for the daily summary.
const queueForDigest = async ({ userId, type, notificationId = null, subject, title, body = null, link = null }) => {
    await query(`
        INSERT INTO email_digest_queue (user_id, kind, notification_id, subject, title, body, link)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, kindOf(type), notificationId, String(subject || title || '').slice(0, 300), String(title || subject || '').slice(0, 300), body, link]);
};

// ---- what the pages show ------------------------------------------------
const adminView = async () => {
    const s = await loadSettings();
    return {
        ready: s.ready,
        essential_only: s.essentialOnly,
        digest_hour: s.digestHour,
        kinds: KINDS.map(k => {
            const r = ruleFor(s, k.key);
            return { key: k.key, label: k.label, description: k.description, always: !!k.always, mode: k.always ? 'INSTANT' : r.mode, members_may_change: k.always ? false : r.membersMayChange };
        }),
    };
};

const userView = async (userId) => {
    const s = await loadSettings();
    const mine = new Map();
    if (s.ready) {
        for (const r of (await query('SELECT kind, mode FROM user_email_preferences WHERE user_id = $1', [userId])).rows) mine.set(r.kind, r.mode);
    }
    return {
        ready: s.ready,
        essential_only: s.essentialOnly,
        digest_hour: s.digestHour,
        kinds: KINDS.map(k => {
            const r = ruleFor(s, k.key);
            const locked = !!k.always || s.essentialOnly || r.mode === 'OFF' || !r.membersMayChange;
            const company = k.always ? 'INSTANT' : (s.essentialOnly ? 'OFF' : r.mode);
            return {
                key: k.key, label: k.label, description: k.description, always: !!k.always,
                company_mode: company, my_mode: mine.get(k.key) || null,
                effective: k.always ? 'INSTANT' : (locked ? company : (mine.get(k.key) || company)),
                can_change: !locked,
                why_locked: k.always ? 'Always sent' : s.essentialOnly ? 'The Admin has paused all but essential emails'
                    : r.mode === 'OFF' ? 'Switched off by the Admin for everyone' : !r.membersMayChange ? 'Set by the Admin for everyone' : null,
            };
        }),
    };
};

const saveAdmin = async ({ essentialOnly, digestHour, kinds }, userId) => {
    if (!(await ready())) throw Object.assign(new Error('Email controls need the v1.88.0 database update.'), { statusCode: 409 });
    if (essentialOnly !== undefined || digestHour !== undefined) {
        await query(`UPDATE email_settings SET essential_only = COALESCE($1, essential_only), digest_hour = COALESCE($2, digest_hour),
                     updated_by = $3, updated_at = NOW() WHERE id = 1`,
        [essentialOnly === undefined ? null : !!essentialOnly, digestHour === undefined ? null : digestHour, userId]);
    }
    for (const k of kinds || []) {
        const info = KINDS.find(x => x.key === k.key);
        if (!info || info.always) continue;
        if (!MODES.includes(k.mode)) throw Object.assign(new Error(`Unknown email mode ${k.mode}.`), { statusCode: 400 });
        await query(`
            INSERT INTO email_kind_settings (kind, mode, members_may_change, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (kind) DO UPDATE SET mode = EXCLUDED.mode, members_may_change = EXCLUDED.members_may_change,
                updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [k.key, k.mode, k.members_may_change !== false, userId]);
    }
    invalidate();
};

const saveMine = async (userId, prefs) => {
    if (!(await ready())) throw Object.assign(new Error('Email controls need the v1.88.0 database update.'), { statusCode: 409 });
    const s = await loadSettings();
    for (const p of prefs || []) {
        const info = KINDS.find(x => x.key === p.key);
        if (!info || info.always) continue;
        const r = ruleFor(s, p.key);
        if (r.mode === 'OFF' || !r.membersMayChange) continue; // the Admin decides this one
        if (p.mode === null || p.mode === '' || p.mode === undefined) {
            await query('DELETE FROM user_email_preferences WHERE user_id = $1 AND kind = $2', [userId, p.key]);
            continue;
        }
        if (!MODES.includes(p.mode)) throw Object.assign(new Error(`Unknown email mode ${p.mode}.`), { statusCode: 400 });
        await query(`
            INSERT INTO user_email_preferences (user_id, kind, mode, updated_at) VALUES ($1, $2, $3, NOW())
            ON CONFLICT (user_id, kind) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()`, [userId, p.key, p.mode]);
    }
};

// ---- the daily summary --------------------------------------------------
// One email per person with everything held for them since the last
// summary, grouped by kind, each with its link. Run by the scheduler at
// email_settings.digest_hour (Kampala).
const sendDigests = async () => {
    if (!(await ready())) return { skipped: true };
    const { sendEmail } = require('../config/email');
    const { wrapEmail } = require('./emailTemplates');
    const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const users = (await query(`
        SELECT DISTINCT q.user_id, u.email, u.first_name
        FROM   email_digest_queue q JOIN users u ON u.id = q.user_id
        WHERE  q.sent_at IS NULL AND u.is_active = TRUE AND u.email IS NOT NULL`)).rows;
    let sent = 0; let failed = 0;
    const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    for (const u of users) {
        const items = (await query(`
            SELECT id, kind, title, body, link, created_at FROM email_digest_queue
            WHERE user_id = $1 AND sent_at IS NULL ORDER BY kind, created_at`, [u.user_id])).rows;
        if (!items.length) continue;
        const groups = new Map();
        for (const it of items) { if (!groups.has(it.kind)) groups.set(it.kind, []); groups.get(it.kind).push(it); }
        let html = `<p style="margin:0 0 12px 0;">Dear ${esc(u.first_name)},</p><p style="margin:0 0 16px 0;">Here is your summary of ${items.length} update${items.length === 1 ? '' : 's'} since the last one.</p>`;
        for (const [kind, list] of groups) {
            html += `<p style="margin:16px 0 6px 0; font-weight:700; color:#374151;">${esc(kindInfo(kind).label)}</p><ul style="margin:0; padding-left:18px;">`;
            for (const it of list) {
                const link = it.link ? `${base}${it.link.startsWith('/') ? '' : '/'}${it.link}` : null;
                html += `<li style="margin:0 0 6px 0;">${link ? `<a href="${esc(link)}" style="color:#2563eb;">${esc(it.title)}</a>` : esc(it.title)}${it.body ? `<br><span style="color:#6b7280; font-size:12px;">${esc(String(it.body).slice(0, 300))}</span>` : ''}</li>`;
            }
            html += '</ul>';
        }
        html += '<p style="margin:20px 0 0 0; font-size:12px; color:#6b7280;">You receive these as a daily summary. Change it under My Profile › Email notifications.</p>';
        const r = await sendEmail({ to: u.email, subject: `Your daily summary — ${items.length} update${items.length === 1 ? '' : 's'}`, html: await wrapEmail(html) });
        if (r.success) {
            await query('UPDATE email_digest_queue SET sent_at = NOW() WHERE id = ANY($1::int[])', [items.map(i => i.id)]);
            sent += 1;
        } else failed += 1;
    }
    return { sent, failed };
};

module.exports = {
    KINDS, MODES, kindOf, decide, queueForDigest, adminView, userView, saveAdmin, saveMine, sendDigests, invalidate, loadSettings,
};
