// ============================================================
// GOVERNANCE SERVICE (v1.79.0) — company meetings, the register of
// attendees and resolutions.
//
// Requested directly: "a very well defined template for the AGM and
// well organised register of attendees since this should be a fileable
// version on the URSB … for the normal minutes, board resolutions,
// special resolutions and other system generated documents".
// Confirmed: attendance is a system check-in that each attendee signs
// digitally; Table A defaults that an Admin can edit; show of hands.
//
// The rules, all read from governance_settings (Settings › Governance):
//   NOTICE   AGM: agm_notice_days (21). A meeting with special business:
//            special_resolution_notice_days (21). Other general meetings:
//            general_meeting_notice_days (14). Board: board_meeting_notice_days (7).
//            Days given = meeting date − date the notice was issued
//            (the day of issue is excluded, the meeting day included).
//            Shorter notice only with recorded consent.
//   QUORUM   General meetings: member_quorum members present in person,
//            online or by proxy. Board: board_quorum directors present.
//            People "in attendance" never count.
//   VOTING   Show of hands — one vote per person present. Proxies vote
//            only if proxy_votes_on_show_of_hands is on.
//            Ordinary / board: carried when FOR > AGAINST (chair's casting
//            vote decides a tie, if used).
//            Special: carried when FOR ÷ (FOR + AGAINST) ≥ 75%
//            (special_resolution_majority_pct); abstentions are not votes cast.
//            Written: carried when EVERY member / director entitled signs AGREE.
//   FILING   Special resolutions (and written resolutions in place of a
//            special one) must reach the Registrar within
//            resolution_filing_days (15) of being passed.
// ============================================================

const crypto = require('crypto');
const { createError } = require('../utils/errors');
const { copyObject, generateKey, toKey } = require('./storageService');

const MANAGER_ROLES = ['Admin', 'Secretary', 'Assistant Secretary', 'Director'];
const PRESENT_STATUSES = ['PRESENT', 'PRESENT_VIRTUAL', 'BY_PROXY'];

const DEFAULT_SETTINGS = {
    agm_notice_days: 21,
    special_resolution_notice_days: 21,
    general_meeting_notice_days: 14,
    board_meeting_notice_days: 7,
    member_quorum: 2,
    board_quorum: 2,
    special_resolution_majority_pct: 75,
    short_notice_consent_pct: 95,
    resolution_filing_days: 15,
    proxy_votes_on_show_of_hands: false,
    agm_max_interval_months: 15,
    act_name: 'Companies Act, 2012',
    company_type: 'Private Company Limited by Shares',
    legal_references: {
        agm: 's.138', notice: 's.140', quorum: 's.141', proxy: 's.143',
        special_resolution: 's.148', filing: 's.150', minutes: 's.152',
    },
    articles_note: null,
};

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const dateStr = (d) => {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const todayStr = () => dateStr(new Date());
const daysBetween = (a, b) => Math.round((Date.parse(`${dateStr(b)}T00:00:00Z`) - Date.parse(`${dateStr(a)}T00:00:00Z`)) / 86400000);
const addDays = (d, n) => {
    const x = new Date(`${dateStr(d)}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
};

// ------------------------------------------------------------
// Who may run meetings
// ------------------------------------------------------------
const canManage = (user) =>
    (user.permissions || []).includes('MEETING_MANAGE') || (user.roles || []).some(r => MANAGER_ROLES.includes(r));

const isDirector = (user) => (user.roles || []).includes('Director');

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------
const getSettings = async (db) => {
    try {
        const r = await db.query('SELECT * FROM governance_settings WHERE id = 1');
        if (!r.rows.length) return { ...DEFAULT_SETTINGS };
        const row = r.rows[0];
        return {
            ...DEFAULT_SETTINGS,
            ...row,
            special_resolution_majority_pct: num(row.special_resolution_majority_pct),
            short_notice_consent_pct: num(row.short_notice_consent_pct),
            legal_references: { ...DEFAULT_SETTINGS.legal_references, ...(row.legal_references || {}) },
        };
    } catch (_) {
        return { ...DEFAULT_SETTINGS, ready: false };
    }
};

const requiredNoticeDays = (settings, meeting) => {
    if (meeting.meeting_type === 'BOARD') return settings.board_meeting_notice_days;
    const base = meeting.meeting_type === 'AGM' ? settings.agm_notice_days : settings.general_meeting_notice_days;
    return meeting.has_special_business ? Math.max(base, settings.special_resolution_notice_days) : base;
};

const quorumRequired = (settings, meeting) =>
    (meeting.meeting_type === 'BOARD' ? settings.board_quorum : settings.member_quorum);

// ------------------------------------------------------------
// Who is entitled to attend
// ------------------------------------------------------------
// Members: everyone with shares on the register, plus every active
// Shareholder (even with no shares yet). Shares from the open row of
// the shareholding register.
// v1.80.0 — `asOf` (a past meeting's date): shares from the register
// row in force on that date instead of today's.
const loadMembers = async (db, asOf = null) => {
    const shareJoin = asOf
        ? `LEFT JOIN LATERAL (
               SELECT s.shares_held FROM shareholding_registry s
               WHERE  s.user_id = u.id AND s.effective_from <= $1::date
               AND   (s.effective_to IS NULL OR s.effective_to > $1::date)
               ORDER  BY s.effective_from DESC, s.id DESC LIMIT 1) sr ON TRUE`
        : 'LEFT JOIN shareholding_registry sr ON sr.user_id = u.id AND sr.effective_to IS NULL';
    const r = await db.query(`
        SELECT u.id AS user_id, u.first_name || ' ' || u.last_name AS name,
               COALESCE(sr.shares_held, 0) AS shares_held
        FROM   users u
        ${shareJoin}
        WHERE  u.is_active = TRUE
        AND   (COALESCE(sr.shares_held, 0) > 0
               OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                          WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND ro.name = 'Shareholder'))
        ORDER  BY COALESCE(sr.shares_held, 0) DESC, u.first_name, u.last_name
    `, asOf ? [asOf] : []);
    return r.rows.map(x => ({ ...x, shares_held: num(x.shares_held) }));
};

const loadDirectors = async (db) => {
    const r = await db.query(`
        SELECT DISTINCT u.id AS user_id, u.first_name || ' ' || u.last_name AS name, u.first_name, u.last_name
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles ro ON ro.id = ur.role_id AND ro.name = 'Director'
        WHERE  u.is_active = TRUE
        ORDER  BY u.first_name, u.last_name
    `);
    return r.rows;
};

// Build (or refresh, before the meeting opens) the list of people
// entitled to attend. Existing rows keep their status and confirmation.
const buildRegister = async (client, meeting) => {
    const capacity = meeting.meeting_type === 'BOARD' ? 'DIRECTOR' : 'MEMBER';
    const past = meeting.recorded_after_event && meeting.meeting_date ? dateStr(meeting.meeting_date) : null;
    const people = capacity === 'DIRECTOR' ? await loadDirectors(client) : await loadMembers(client, past);
    const existing = await client.query(
        `SELECT id, user_id, capacity FROM meeting_attendance WHERE meeting_id = $1`, [meeting.id]);
    const byUser = new Map(existing.rows.filter(r => r.capacity === capacity && r.user_id).map(r => [r.user_id, r]));
    let order = 0;
    for (const p of people) {
        order += 1;
        const designation = p.user_id === meeting.chairperson_user_id ? 'Chairperson'
            : capacity === 'DIRECTOR' ? 'Director' : 'Member';
        const ex = byUser.get(p.user_id);
        if (ex) {
            await client.query(`
                UPDATE meeting_attendance SET name = $2, shares_held = $3, designation = $4, sort_order = $5 WHERE id = $1`,
            [ex.id, p.name, capacity === 'MEMBER' ? p.shares_held : null, designation, order]);
            byUser.delete(p.user_id);
        } else {
            await client.query(`
                INSERT INTO meeting_attendance (meeting_id, user_id, name, capacity, designation, shares_held, sort_order)
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [meeting.id, p.user_id, p.name, capacity, designation, capacity === 'MEMBER' ? p.shares_held : null, order]);
        }
    }
    // People no longer entitled (e.g. sold all shares) are removed only
    // if nothing was recorded for them yet.
    for (const gone of byUser.values()) {
        await client.query(`
            DELETE FROM meeting_attendance WHERE id = $1 AND status = 'PENDING' AND confirmed_at IS NULL`, [gone.id]);
    }
    // The company secretary, when not entitled in their own right, is
    // recorded "in attendance".
    if (meeting.secretary_user_id) {
        const already = await client.query(`
            SELECT 1 FROM meeting_attendance WHERE meeting_id = $1 AND user_id = $2`, [meeting.id, meeting.secretary_user_id]);
        if (!already.rows.length) {
            await client.query(`
                INSERT INTO meeting_attendance (meeting_id, user_id, name, capacity, designation, sort_order)
                VALUES ($1, $2, $3, 'IN_ATTENDANCE', 'Company Secretary', 9000)`,
            [meeting.id, meeting.secretary_user_id, meeting.secretary_name || 'Company Secretary']);
        }
    }
};

// ------------------------------------------------------------
// Quorum and voters
// ------------------------------------------------------------
const countingCapacity = (meeting) => (meeting.meeting_type === 'BOARD' ? 'DIRECTOR' : 'MEMBER');

const tally = (meeting, attendance, settings) => {
    const cap = countingCapacity(meeting);
    const entitled = attendance.filter(a => a.capacity === cap);
    const count = (st) => entitled.filter(a => a.status === st).length;
    const present = entitled.filter(a => PRESENT_STATUSES.includes(a.status));
    const sharesPresent = present.reduce((s, a) => s + num(a.shares_held), 0);
    const sharesTotal = entitled.reduce((s, a) => s + num(a.shares_held), 0);
    const voters = present.filter(a => a.status !== 'BY_PROXY' || settings.proxy_votes_on_show_of_hands).length;
    const required = meeting.quorum_required || quorumRequired(settings, meeting);
    return {
        entitled: entitled.length,
        in_person: count('PRESENT'),
        online: count('PRESENT_VIRTUAL'),
        by_proxy: count('BY_PROXY'),
        apologies: count('APOLOGY'),
        absent: count('ABSENT'),
        not_marked: count('PENDING'),
        present: present.length,
        confirmed: entitled.filter(a => a.confirmed_at).length,
        in_attendance: attendance.filter(a => a.capacity === 'IN_ATTENDANCE' && PRESENT_STATUSES.includes(a.status)).length,
        shares_present: sharesPresent,
        shares_total: sharesTotal,
        shares_present_pct: sharesTotal > 0 ? Math.round((sharesPresent / sharesTotal) * 10000) / 100 : 0,
        voters,
        quorum_required: required,
        quorum_met: present.length >= required,
    };
};

// ------------------------------------------------------------
// Notice compliance
// ------------------------------------------------------------
const noticeStatus = (meeting, settings, issueDate = null) => {
    const required = requiredNoticeDays(settings, meeting);
    const issued = issueDate || meeting.notice_issued_at;
    const given = issued ? daysBetween(issued, meeting.meeting_date) : daysBetween(todayStr(), meeting.meeting_date);
    return {
        required,
        given,
        issued: !!meeting.notice_issued_at,
        sufficient: given >= required,
        short_notice_consent: !!meeting.short_notice_consent,
        compliant: given >= required || !!meeting.short_notice_consent,
        latest_issue_date: addDays(meeting.meeting_date, -required),
    };
};

// ------------------------------------------------------------
// Votes (show of hands)
// ------------------------------------------------------------
const evaluateVote = ({ kind, votesFor, votesAgainst, votesAbstain, casting, settings, voters }) => {
    const f = num(votesFor), a = num(votesAgainst), ab = num(votesAbstain);
    if ([f, a, ab].some(x => !Number.isInteger(x) || x < 0)) throw createError.badRequest('Votes must be whole numbers of 0 or more.');
    if (f + a + ab > voters) {
        throw createError.badRequest(`${f + a + ab} hands counted, but only ${voters} people present may vote on a show of hands.`);
    }
    if (f + a === 0) throw createError.badRequest('No votes were cast for or against — record at least one vote.');
    if (kind === 'SPECIAL') {
        const pct = settings.special_resolution_majority_pct;
        const share = (f / (f + a)) * 100;
        return { result: share + 1e-9 >= pct ? 'CARRIED' : 'LOST', majority_required_pct: pct, share_for_pct: Math.round(share * 100) / 100, casting: null };
    }
    if (f === a) {
        if (!casting) throw createError.badRequest('The votes are equal. Record the chairperson\'s casting vote (for or against).');
        return { result: casting === 'FOR' ? 'CARRIED' : 'LOST', majority_required_pct: 50, share_for_pct: 50, casting };
    }
    return { result: f > a ? 'CARRIED' : 'LOST', majority_required_pct: 50, share_for_pct: Math.round((f / (f + a)) * 10000) / 100, casting: null };
};

// Filing with the Registrar
const filingRequiredFor = (kind, treatedAsSpecial) => kind === 'SPECIAL' || (kind === 'WRITTEN_MEMBERS' && !!treatedAsSpecial);

// ------------------------------------------------------------
// Numbers and codes
// ------------------------------------------------------------
const RESOLUTION_PREFIX = { ORDINARY: 'OR', SPECIAL: 'SR', BOARD: 'BR', WRITTEN_MEMBERS: 'WMR', WRITTEN_BOARD: 'WBR' };

const nextResolutionNumber = async (client, kind, year) => {
    const prefix = RESOLUTION_PREFIX[kind];
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`resolution-number-${prefix}-${year}`]);
    const r = await client.query(`
        SELECT COUNT(*)::int AS n FROM meeting_resolutions WHERE resolution_number LIKE $1`, [`${prefix} %/${year}`]);
    return `${prefix} ${r.rows[0].n + 1}/${year}`;
};

const nextMeetingSequence = async (client, type) => {
    const r = await client.query(`
        SELECT COUNT(*)::int AS n FROM company_meetings WHERE meeting_type = $1 AND status <> 'CANCELLED'`, [type]);
    return r.rows[0].n + 1;
};

// A short verification code printed beside a digital signature. It is
// a keyed hash of what was signed, so a code on a printed register can
// be checked against the system.
const confirmationCode = (parts) => {
    const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'cms';
    const h = crypto.createHmac('sha256', secret).update(parts.join('|')).digest('hex').toUpperCase();
    return `${h.slice(0, 5)}-${h.slice(5, 10)}`;
};

// ------------------------------------------------------------
// v1.80.0 — the person's CAPTURED signature (the one saved on their
// profile), copied at the moment they confirm / sign so a later change
// of signature never alters what was signed. Refused when none is saved.
// ------------------------------------------------------------
const captureSignature = async (client, userId, label) => {
    const r = await client.query('SELECT signature_path FROM users WHERE id = $1', [userId]);
    const path = r.rows[0] && r.rows[0].signature_path;
    if (!path) {
        throw createError.badRequest('Your signature is not set up yet. Draw or upload it under My Profile › Signature, then try again — it is printed on the register and on resolutions.');
    }
    const key = generateKey('signature-snapshots', `${label}.png`);
    try {
        await copyObject(toKey(path), key);
        return `/uploads/${key}`;
    } catch (_) {
        return path;
    }
};

// Is the v1.80.0 migration in? (cached once true)
let v180 = false;
const v180Ready = async (db) => {
    if (v180) return true;
    const r = await db.query(`SELECT 1 FROM information_schema.columns
                              WHERE table_name = 'company_meetings' AND column_name = 'recorded_after_event'`);
    v180 = r.rows.length > 0;
    return v180;
};

module.exports = {
    MANAGER_ROLES, PRESENT_STATUSES, DEFAULT_SETTINGS, RESOLUTION_PREFIX,
    canManage, isDirector, getSettings, requiredNoticeDays, quorumRequired,
    loadMembers, loadDirectors, buildRegister, tally, noticeStatus, evaluateVote,
    filingRequiredFor, nextResolutionNumber, nextMeetingSequence, confirmationCode,
    dateStr, todayStr, daysBetween, addDays, num, captureSignature, v180Ready,
};
