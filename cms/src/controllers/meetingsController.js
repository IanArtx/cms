// ============================================================
// MEETINGS CONTROLLER (v1.79.0)
// Prefix: /api/meetings
//
// Statutory company meetings — Annual General Meetings (AGM),
// Extraordinary General Meetings (EGM) and Board meetings — with:
//   • the notice (period checked against Settings › Governance,
//     short-notice consent recorded when the period is too short)
//   • the register of attendees, built automatically from the
//     register of members (general meetings) or the directors
//     (board meetings); the secretary marks each person and every
//     attendee confirms digitally from their own account
//   • the quorum, checked live
//   • resolutions (ordinary, special, board) voted on a show of
//     hands, and written resolutions signed by everyone entitled
//   • the minutes, written per agenda item
//   • the URSB filing deadline of special resolutions
//
// The documents themselves (notice, proxy form, register, minutes,
// resolutions, certified copies) are rendered by the frontend
// (exportUtils.js) from what this controller returns, and saved
// through POST /api/documents/generate with related_record_type
// 'company_meetings' or 'meeting_resolutions'.
//
// All rules live in services/governanceService.js.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord } = require('../services/referenceService');
const { notifyMany, notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const logger = require('../config/logger');
const gov = require('../services/governanceService');
const { getOrCreateCategory, getOrCreateChildCategory } = require('../services/categoryService');

const MEETING_TYPE_LABEL = { AGM: 'Annual General Meeting', EGM: 'Extraordinary General Meeting', BOARD: 'Board Meeting' };
const KIND_LABEL = {
    ORDINARY: 'Ordinary Resolution', SPECIAL: 'Special Resolution', BOARD: 'Board Resolution',
    WRITTEN_MEMBERS: 'Written Resolution of the Members', WRITTEN_BOARD: 'Written Resolution of the Directors',
};
const ATTENDANCE_STATUSES = ['PENDING', 'PRESENT', 'PRESENT_VIRTUAL', 'BY_PROXY', 'APOLOGY', 'ABSENT'];

const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const trimOrNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const isInt = (v) => Number.isInteger(Number(v)) && String(v).trim() !== '';
const prettyDate = (d) => {
    const s = gov.dateStr(d);
    if (!s) return '';
    const dt = new Date(`${s}T00:00:00Z`);
    return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const ordinal = (n) => {
    const v = n % 100;
    const suf = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return `${n}${suf}`;
};

// DATE columns come back from pg as JS Dates — send plain YYYY-MM-DD
// strings so the browser never shifts them across a timezone.
const normMeeting = (m) => (m ? { ...m, meeting_date: gov.dateStr(m.meeting_date) } : m);
const normResolution = (r) => (r ? {
    ...r,
    passed_on: gov.dateStr(r.passed_on),
    filing_due_date: gov.dateStr(r.filing_due_date),
    filed_on: gov.dateStr(r.filed_on),
    meeting_date: r.meeting_date ? gov.dateStr(r.meeting_date) : r.meeting_date,
    majority_required_pct: r.majority_required_pct === null || r.majority_required_pct === undefined ? null : Number(r.majority_required_pct),
} : r);
const normAttendance = (a) => ({ ...a, shares_held: a.shares_held === null ? null : Number(a.shares_held) });

// The filing position of a carried resolution that must go to the Registrar.
const filingState = (r) => {
    if (!r.filing_required || r.result !== 'CARRIED') return null;
    if (r.filed_on) return 'FILED';
    if (!r.filing_due_date) return 'DUE';
    return gov.todayStr() > gov.dateStr(r.filing_due_date) ? 'OVERDUE' : 'DUE';
};

const requireManager = (user) => {
    if (!gov.canManage(user)) {
        throw createError.forbidden('Only the Company Secretary, a Director or an Admin can do this.');
    }
};

const userName = async (db, id) => {
    if (!id) return null;
    const r = await db.query(`SELECT first_name || ' ' || last_name AS name FROM users WHERE id = $1 AND is_active = TRUE`, [id]);
    if (!r.rows.length) throw createError.badRequest(`User ${id} was not found or is not active.`);
    return r.rows[0].name;
};

// ------------------------------------------------------------
// Visibility
//   Managers see everything.
//   Board meetings / board resolutions: directors, plus anyone on
//   that meeting's register.
//   General meetings / members' resolutions: anyone holding
//   MEETING_VIEW, any Shareholder, plus anyone on the register.
// ------------------------------------------------------------
const canViewGeneral = (user) =>
    gov.canManage(user) || (user.permissions || []).includes('MEETING_VIEW') || (user.roles || []).includes('Shareholder');

const assertCanView = async (db, user, meeting) => {
    if (gov.canManage(user)) return;
    const onRegister = await db.query(
        'SELECT 1 FROM meeting_attendance WHERE meeting_id = $1 AND user_id = $2', [meeting.id, user.id]);
    if (onRegister.rows.length) return;
    if (meeting.meeting_type === 'BOARD') {
        if (gov.isDirector(user)) return;
        throw createError.forbidden('Board meetings are visible to the directors and the company secretary only.');
    }
    if (!canViewGeneral(user)) throw createError.forbidden('You do not have access to company meetings.');
};

const loadMeeting = async (db, id, { lock = false } = {}) => {
    if (!isInt(id)) throw createError.badRequest('Invalid meeting id.');
    const r = await db.query(`
        SELECT m.*, rr.reference_code
        FROM   company_meetings m
        JOIN   references_registry rr ON rr.id = m.reference_id
        WHERE  m.id = $1 ${lock ? 'FOR UPDATE OF m' : ''}`, [id]);
    if (!r.rows.length) throw createError.notFound('Meeting not found.');
    return r.rows[0];
};

const loadAttendance = async (db, meetingId) => {
    const r = await db.query(`
        SELECT a.*, mk.first_name || ' ' || mk.last_name AS marked_by_name
        FROM   meeting_attendance a
        LEFT JOIN users mk ON mk.id = a.marked_by
        WHERE  a.meeting_id = $1
        ORDER  BY CASE a.capacity WHEN 'DIRECTOR' THEN 0 WHEN 'MEMBER' THEN 0 ELSE 1 END, a.sort_order, a.name`, [meetingId]);
    return r.rows.map(normAttendance);
};

const loadResolution = async (db, id, { lock = false } = {}) => {
    if (!isInt(id)) throw createError.badRequest('Invalid resolution id.');
    const r = await db.query(`
        SELECT res.*, rr.reference_code, m.meeting_type, m.meeting_date, m.title AS meeting_title, m.status AS meeting_status
        FROM   meeting_resolutions res
        JOIN   references_registry rr ON rr.id = res.reference_id
        LEFT JOIN company_meetings m ON m.id = res.meeting_id
        WHERE  res.id = $1 ${lock ? 'FOR UPDATE OF res' : ''}`, [id]);
    if (!r.rows.length) throw createError.notFound('Resolution not found.');
    return r.rows[0];
};

const isBoardKind = (kind) => kind === 'BOARD' || kind === 'WRITTEN_BOARD';

const assertCanViewResolution = async (db, user, res) => {
    if (gov.canManage(user)) return;
    if (res.meeting_id) {
        await assertCanView(db, user, { id: res.meeting_id, meeting_type: res.meeting_type });
        return;
    }
    const signer = await db.query('SELECT 1 FROM resolution_signatories WHERE resolution_id = $1 AND user_id = $2', [res.id, user.id]);
    if (signer.rows.length) return;
    if (isBoardKind(res.kind)) {
        if (gov.isDirector(user)) return;
        throw createError.forbidden('Board resolutions are visible to the directors and the company secretary only.');
    }
    if (!canViewGeneral(user)) throw createError.forbidden('You do not have access to company resolutions.');
};

const meetingDocuments = async (db, meetingId, resolutionIds) => {
    const r = await db.query(`
        SELECT d.id, d.title, d.document_type, d.status, d.created_at, d.related_record_type, d.related_record_id,
               rr.reference_code
        FROM   documents d
        LEFT JOIN references_registry rr ON rr.id = d.reference_id
        WHERE  d.status NOT IN ('SUPERSEDED', 'DELETED')
        AND   ((d.related_record_type = 'company_meetings' AND d.related_record_id = $1)
            OR (d.related_record_type = 'meeting_resolutions' AND d.related_record_id = ANY($2::int[])))
        ORDER  BY d.created_at DESC`, [meetingId, resolutionIds]);
    return r.rows;
};

// ============================================================
// SETTINGS — GET /api/meetings/settings, PATCH (Admin / Secretary)
// ============================================================
const getGovernanceSettings = asyncHandler(async (req, res) => {
    const settings = await gov.getSettings({ query });
    sendSuccess(res, settings);
});

const INT_SETTINGS = {
    agm_notice_days: [0, 365], special_resolution_notice_days: [0, 365], general_meeting_notice_days: [0, 365],
    board_meeting_notice_days: [0, 365], member_quorum: [1, 1000], board_quorum: [1, 100],
    resolution_filing_days: [0, 365], agm_max_interval_months: [1, 36],
};
const PCT_SETTINGS = { special_resolution_majority_pct: [50.01, 100], short_notice_consent_pct: [50.01, 100] };
const LEGAL_KEYS = ['agm', 'notice', 'quorum', 'proxy', 'special_resolution', 'filing', 'minutes', 'annual_return', 'register_of_members'];

const updateGovernanceSettings = asyncHandler(async (req, res) => {
    const roles = req.user.roles || [];
    if (!roles.includes('Admin') && !roles.includes('Secretary')) {
        throw createError.forbidden('Only an Admin or the Company Secretary can change the governance settings.');
    }
    const sets = [];
    const params = [];
    const changes = {};
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); changes[col] = val; };

    for (const [k, [min, max]] of Object.entries(INT_SETTINGS)) {
        if (req.body[k] === undefined) continue;
        const v = Number(req.body[k]);
        if (!Number.isInteger(v) || v < min || v > max) throw createError.badRequest(`${k.replace(/_/g, ' ')} must be a whole number from ${min} to ${max}.`);
        add(k, v);
    }
    for (const [k, [min, max]] of Object.entries(PCT_SETTINGS)) {
        if (req.body[k] === undefined) continue;
        const v = Number(req.body[k]);
        if (!Number.isFinite(v) || v < min || v > max) throw createError.badRequest(`${k.replace(/_/g, ' ')} must be more than 50 and at most 100.`);
        add(k, Math.round(v * 100) / 100);
    }
    if (req.body.proxy_votes_on_show_of_hands !== undefined) add('proxy_votes_on_show_of_hands', !!req.body.proxy_votes_on_show_of_hands);
    if (req.body.act_name !== undefined) {
        const v = trimOrNull(req.body.act_name);
        if (!v || v.length > 200) throw createError.badRequest('The name of the Act is required (at most 200 characters).');
        add('act_name', v);
    }
    if (req.body.company_type !== undefined) {
        const v = trimOrNull(req.body.company_type);
        if (!v || v.length > 120) throw createError.badRequest('The company type is required (at most 120 characters), e.g. "Private Company Limited by Shares".');
        add('company_type', v);
    }
    if (req.body.articles_note !== undefined) add('articles_note', trimOrNull(req.body.articles_note));
    if (req.body.legal_references !== undefined) {
        const lr = req.body.legal_references;
        if (!lr || typeof lr !== 'object' || Array.isArray(lr)) throw createError.badRequest('legal_references must be an object.');
        const clean = {};
        for (const key of LEGAL_KEYS) {
            if (lr[key] === undefined) continue;
            const v = trimOrNull(lr[key]);
            if (v && v.length > 40) throw createError.badRequest(`The reference for "${key}" is too long (40 characters at most).`);
            clean[key] = v || '';
        }
        params.push(JSON.stringify(clean));
        sets.push(`legal_references = legal_references || $${params.length}::jsonb`);
        changes.legal_references = clean;
    }
    if (!sets.length) throw createError.badRequest('Nothing to update.');
    params.push(req.user.id);
    sets.push(`updated_by = $${params.length}`, 'updated_at = NOW()');

    await withTransaction(async (client) => {
        await client.query('INSERT INTO governance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
        await client.query(`UPDATE governance_settings SET ${sets.join(', ')} WHERE id = 1`, params);
        await logAction(req.user.id, ACTIONS.GOVERNANCE_SETTINGS_UPDATED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'governance_settings', recordId: 1, newValues: changes,
            description: 'Updated the governance settings (notice periods, quorum, majorities, legal references)', client,
        });
    });
    sendSuccess(res, await gov.getSettings({ query }), 'Governance settings saved');
});

// ============================================================
// LIST MEETINGS — GET /api/meetings?type=&status=&year=
// ============================================================
const listMeetings = asyncHandler(async (req, res) => {
    const { type, status, year } = req.query;
    const where = [];
    const params = [];
    if (type) { params.push(type); where.push(`m.meeting_type = $${params.length}`); }
    if (status) { params.push(status); where.push(`m.status = $${params.length}`); }
    if (year && isInt(year)) { params.push(Number(year)); where.push(`EXTRACT(YEAR FROM m.meeting_date) = $${params.length}`); }

    if (!gov.canManage(req.user)) {
        params.push(req.user.id);
        const me = `$${params.length}`;
        const onRegister = `EXISTS (SELECT 1 FROM meeting_attendance a WHERE a.meeting_id = m.id AND a.user_id = ${me})`;
        const board = gov.isDirector(req.user) ? 'TRUE' : onRegister;
        const general = canViewGeneral(req.user) ? 'TRUE' : onRegister;
        where.push(`(CASE WHEN m.meeting_type = 'BOARD' THEN ${board} ELSE ${general} END)`);
    }

    const r = await query(`
        SELECT m.id, m.meeting_type, m.sequence_number, m.title, m.financial_year, m.meeting_date, m.start_time,
               m.venue, m.mode, m.status, m.chairperson_name, m.secretary_name, m.notice_issued_at,
               m.has_special_business, m.opened_at, m.closed_at, rr.reference_code,
               (SELECT COUNT(*)::int FROM meeting_attendance a WHERE a.meeting_id = m.id
                    AND a.capacity <> 'IN_ATTENDANCE' AND a.status IN ('PRESENT','PRESENT_VIRTUAL','BY_PROXY')) AS present_count,
               (SELECT COUNT(*)::int FROM meeting_attendance a WHERE a.meeting_id = m.id AND a.capacity <> 'IN_ATTENDANCE') AS entitled_count,
               (SELECT COUNT(*)::int FROM meeting_resolutions x WHERE x.meeting_id = m.id AND x.result <> 'WITHDRAWN') AS resolution_count
        FROM   company_meetings m
        JOIN   references_registry rr ON rr.id = m.reference_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER  BY m.meeting_date DESC, m.start_time DESC
        LIMIT  500`, params);
    sendSuccess(res, { meetings: r.rows.map(normMeeting), can_manage: gov.canManage(req.user) });
});

// ============================================================
// CREATE MEETING — POST /api/meetings
// ============================================================
const validateAgenda = (agenda) => {
    if (agenda === undefined) return undefined;
    if (!Array.isArray(agenda)) throw createError.badRequest('The agenda must be a list of items.');
    if (agenda.length > 60) throw createError.badRequest('The agenda can have at most 60 items.');
    return agenda.map((it, i) => {
        const title = trimOrNull(it && it.title);
        if (!title) throw createError.badRequest(`Agenda item ${i + 1} needs a title.`);
        const business = ['ORDINARY', 'SPECIAL', 'BOARD', 'ROUTINE'].includes(it.business) ? it.business : 'ROUTINE';
        return { no: i + 1, title: title.slice(0, 300), description: trimOrNull(it.description), business };
    });
};

const validateMeetingFields = (b, { partial }) => {
    const out = {};
    if (!partial || b.meeting_type !== undefined) {
        if (!['AGM', 'EGM', 'BOARD'].includes(b.meeting_type)) throw createError.badRequest('Meeting type must be AGM, EGM or BOARD.');
        out.meeting_type = b.meeting_type;
    }
    if (!partial || b.meeting_date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.meeting_date || '')) || Number.isNaN(Date.parse(b.meeting_date))) {
            throw createError.badRequest('A valid meeting date (YYYY-MM-DD) is required.');
        }
        out.meeting_date = b.meeting_date;
    }
    if (!partial || b.start_time !== undefined) {
        if (!/^\d{2}:\d{2}(:\d{2})?$/.test(String(b.start_time || ''))) throw createError.badRequest('A valid start time (HH:MM) is required.');
        out.start_time = b.start_time;
    }
    if (b.end_time !== undefined) {
        if (b.end_time && !/^\d{2}:\d{2}(:\d{2})?$/.test(String(b.end_time))) throw createError.badRequest('End time must be HH:MM.');
        out.end_time = b.end_time || null;
    }
    if (b.title !== undefined) out.title = trimOrNull(b.title);
    if (b.financial_year !== undefined) out.financial_year = trimOrNull(b.financial_year);
    if (b.venue !== undefined) out.venue = trimOrNull(b.venue);
    if (b.mode !== undefined) {
        if (!['PHYSICAL', 'VIRTUAL', 'HYBRID'].includes(b.mode)) throw createError.badRequest('Mode must be PHYSICAL, VIRTUAL or HYBRID.');
        out.mode = b.mode;
    }
    if (b.virtual_link !== undefined) out.virtual_link = trimOrNull(b.virtual_link);
    if (b.chairperson_user_id !== undefined) out.chairperson_user_id = b.chairperson_user_id ? Number(b.chairperson_user_id) : null;
    if (b.secretary_user_id !== undefined) out.secretary_user_id = b.secretary_user_id ? Number(b.secretary_user_id) : null;
    if (b.has_special_business !== undefined) out.has_special_business = !!b.has_special_business;
    if (b.agenda !== undefined) out.agenda = validateAgenda(b.agenda);
    if (b.short_notice_consent !== undefined) out.short_notice_consent = !!b.short_notice_consent;
    if (b.short_notice_note !== undefined) out.short_notice_note = trimOrNull(b.short_notice_note);
    return out;
};

const defaultTitle = (type, seq) => (type === 'BOARD'
    ? `${ordinal(seq)} Meeting of the Board of Directors`
    : `${ordinal(seq)} ${MEETING_TYPE_LABEL[type]}`);

// The agenda of a new AGM, following the ordinary business under
// Table A. Editable before the notice is issued.
const DEFAULT_AGENDA = {
    AGM: [
        { title: 'Opening, confirmation of notice and quorum', business: 'ROUTINE' },
        { title: 'Confirmation of the minutes of the previous general meeting', business: 'ROUTINE' },
        { title: 'Receipt and adoption of the financial statements and the reports of the directors and the auditors', business: 'ORDINARY' },
        { title: 'Declaration of dividend', business: 'ORDINARY' },
        { title: 'Election / re-election of directors', business: 'ORDINARY' },
        { title: 'Appointment of auditors and fixing of their remuneration', business: 'ORDINARY' },
        { title: 'Any other business of which due notice has been given', business: 'ROUTINE' },
        { title: 'Closure', business: 'ROUTINE' },
    ],
    EGM: [
        { title: 'Opening, confirmation of notice and quorum', business: 'ROUTINE' },
        { title: 'Special business', business: 'SPECIAL' },
        { title: 'Closure', business: 'ROUTINE' },
    ],
    BOARD: [
        { title: 'Opening and confirmation of quorum', business: 'ROUTINE' },
        { title: 'Declaration of interests', business: 'ROUTINE' },
        { title: 'Confirmation of the minutes of the previous board meeting', business: 'ROUTINE' },
        { title: 'Matters arising', business: 'ROUTINE' },
        { title: 'Any other business', business: 'ROUTINE' },
        { title: 'Closure', business: 'ROUTINE' },
    ],
};

const createMeeting = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const f = validateMeetingFields(req.body, { partial: false });
    const settings = await gov.getSettings({ query });
    if (settings.ready === false) throw createError.conflict('The meetings module is not set up yet — run the v1.79.0 database update first.');

    // v1.80.0 — a meeting dated before today is being recorded after it
    // took place (the secretary enters the notice date, attendance, votes
    // and minutes; attendees may confirm afterwards).
    const past = f.meeting_date < gov.todayStr();
    const canRecordPast = await gov.v180Ready({ query });
    if (past && !canRecordPast) throw createError.conflict('Recording a past meeting needs the v1.80.0 database update — ask the Admin to run it.');
    const meeting = await withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`meeting-sequence-${f.meeting_type}`]);
        const seq = await gov.nextMeetingSequence(client, f.meeting_type);
        const chairName = await userName(client, f.chairperson_user_id);
        const secName = await userName(client, f.secretary_user_id);
        const agenda = f.agenda && f.agenda.length ? f.agenda
            : validateAgenda(DEFAULT_AGENDA[f.meeting_type].map(x => ({ ...x })));
        const hasSpecial = f.has_special_business !== undefined ? f.has_special_business
            : agenda.some(a => a.business === 'SPECIAL');

        const { referenceId, referenceCode } = await generateReference(client, 'MTG', f.meeting_type, 'COMPANY_MEETING', req.user.id);
        const ins = await client.query(`
            INSERT INTO company_meetings (
                reference_id, meeting_type, sequence_number, title, financial_year, meeting_date, start_time, end_time,
                venue, mode, virtual_link, chairperson_user_id, chairperson_name, secretary_user_id, secretary_name,
                agenda, has_special_business, short_notice_consent, short_notice_note, quorum_required, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21)
            RETURNING *`,
        [referenceId, f.meeting_type, seq, f.title || defaultTitle(f.meeting_type, seq), f.financial_year || null,
            f.meeting_date, f.start_time, f.end_time || null, f.venue || null, f.mode || 'PHYSICAL', f.virtual_link || null,
            f.chairperson_user_id || null, chairName, f.secretary_user_id || null, secName,
            JSON.stringify(agenda), hasSpecial, !!f.short_notice_consent, f.short_notice_note || null,
            gov.quorumRequired(settings, f), req.user.id]);
        let m = ins.rows[0];
        await linkReferenceToRecord(client, referenceId, m.id);
        if (past) {
            m = (await client.query('UPDATE company_meetings SET recorded_after_event = TRUE WHERE id = $1 RETURNING *', [m.id])).rows[0];
        }
        await gov.buildRegister(client, m);
        await logAction(req.user.id, ACTIONS.MEETING_CREATED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id,
            newValues: { reference: referenceCode, type: m.meeting_type, date: f.meeting_date, title: m.title },
            description: `${past ? 'Recorded past meeting' : 'Created'} ${m.title} (${referenceCode}) for ${f.meeting_date}`, client,
        });
        return m;
    });
    sendCreated(res, normMeeting(meeting), 'Meeting created');
});

// ============================================================
// GET MEETING — GET /api/meetings/:id
// Everything the meeting page and the documents need.
// ============================================================
const buildMeetingView = async (db, user, meeting) => {
    const settings = await gov.getSettings(db);
    const attendance = await loadAttendance(db, meeting.id);
    const resR = await db.query(`
        SELECT res.*, rr.reference_code
        FROM   meeting_resolutions res
        JOIN   references_registry rr ON rr.id = res.reference_id
        WHERE  res.meeting_id = $1
        ORDER  BY COALESCE(res.agenda_no, 9999), res.id`, [meeting.id]);
    const resolutions = resR.rows.map(r => ({ ...normResolution(r), filing_state: filingState(r) }));
    const documents = await meetingDocuments(db, meeting.id, resolutions.map(r => r.id));
    const tally = gov.tally(meeting, attendance, settings);
    const notice = gov.noticeStatus(meeting, settings);

    const warnings = [];
    if (meeting.meeting_type === 'AGM') {
        const prev = await db.query(`
            SELECT meeting_date FROM company_meetings
            WHERE meeting_type = 'AGM' AND status <> 'CANCELLED' AND id <> $1 AND meeting_date < $2
            ORDER BY meeting_date DESC LIMIT 1`, [meeting.id, meeting.meeting_date]);
        if (prev.rows.length) {
            const a = new Date(`${gov.dateStr(prev.rows[0].meeting_date)}T00:00:00Z`);
            const b = new Date(`${gov.dateStr(meeting.meeting_date)}T00:00:00Z`);
            const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
                - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
            if (months >= settings.agm_max_interval_months) {
                warnings.push(`More than ${settings.agm_max_interval_months} months will have passed since the previous AGM (${prettyDate(prev.rows[0].meeting_date)}). The Act requires an AGM every calendar year and not more than ${settings.agm_max_interval_months} months after the last one (${settings.legal_references.agm || ''}).`);
            }
        }
    }
    if (['DRAFT', 'NOTICE_ISSUED'].includes(meeting.status) && !notice.compliant) {
        warnings.push(`Notice of ${notice.required} clear days is required${meeting.status === 'DRAFT' ? `; it must go out on or before ${prettyDate(notice.latest_issue_date)}` : ''}. ${notice.issued ? `Only ${notice.given} days were given.` : ''} Record the members' consent to short notice if it was agreed.`.replace(/\s+/g, ' ').trim());
    }
    if (!meeting.chairperson_user_id && !meeting.chairperson_name) warnings.push('No chairperson has been chosen yet.');
    if (!meeting.secretary_user_id && !meeting.secretary_name) warnings.push('No secretary has been chosen to take the minutes.');
    const overdue = resolutions.filter(r => r.filing_state === 'OVERDUE');
    if (overdue.length) warnings.push(`${overdue.length} special resolution(s) are past their URSB filing deadline.`);

    const company = await db.query(`
        SELECT company_name, registration_number, tin, incorporation_date,
               registered_office, postal_address, company_email, company_phone
        FROM company_settings ORDER BY id LIMIT 1`).catch(() => ({ rows: [] }));

    return {
        meeting: normMeeting(meeting),
        attendance,
        resolutions,
        documents,
        tally,
        notice,
        settings,
        company: company.rows[0] || null,
        my_attendance: attendance.filter(a => a.user_id === user.id),
        can_manage: gov.canManage(user),
        warnings,
    };
};

const getMeeting = asyncHandler(async (req, res) => {
    const meeting = await loadMeeting({ query }, req.params.id);
    await assertCanView({ query }, req.user, meeting);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting));
});

// ============================================================
// UPDATE MEETING — PATCH /api/meetings/:id
// Allowed until the meeting opens. Changing the date, time, venue,
// mode, agenda or special business after the notice went out sends
// the meeting back to DRAFT: a fresh notice must be issued.
// ============================================================
const NOTICE_FIELDS = ['meeting_date', 'start_time', 'venue', 'mode', 'agenda', 'has_special_business', 'virtual_link'];

const updateMeeting = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const f = validateMeetingFields(req.body, { partial: true });
    if (f.meeting_type !== undefined) throw createError.badRequest('The meeting type cannot be changed — cancel this meeting and create a new one.');
    let renoticed = false;
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (!['DRAFT', 'NOTICE_ISSUED'].includes(m.status)) {
            throw createError.conflict('The meeting details can only be changed before the meeting opens.');
        }
        const sets = [];
        const params = [];
        const add = (col, val, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
        for (const [k, v] of Object.entries(f)) {
            if (k === 'agenda') add('agenda', JSON.stringify(v), '::jsonb');
            else if (k === 'chairperson_user_id') { add(k, v); add('chairperson_name', await userName(client, v)); }
            else if (k === 'secretary_user_id') { add(k, v); add('secretary_name', await userName(client, v)); }
            else if (k === 'title') { if (v) add(k, v); }
            else add(k, v);
        }
        if (f.agenda && f.has_special_business === undefined && f.agenda.some(a => a.business === 'SPECIAL')) {
            add('has_special_business', true);
        }
        if (m.status === 'NOTICE_ISSUED') {
            const changed = NOTICE_FIELDS.some(k => f[k] !== undefined
                && JSON.stringify(k === 'meeting_date' ? gov.dateStr(m[k]) : m[k]) !== JSON.stringify(f[k]));
            if (changed) {
                renoticed = true;
                sets.push(`status = 'DRAFT'`, 'notice_issued_at = NULL', 'notice_issued_by = NULL', 'notice_days_given = NULL');
            }
        }
        if (f.meeting_date !== undefined && m.status === 'DRAFT' && await gov.v180Ready(client)) {
            params.push(f.meeting_date < gov.todayStr());
            sets.push(`recorded_after_event = $${params.length}`);
        }
        if (!sets.length) throw createError.badRequest('Nothing to update.');
        sets.push('updated_at = NOW()');
        params.push(m.id);
        await client.query(`UPDATE company_meetings SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        const fresh = await loadMeeting(client, m.id);
        const settings = await gov.getSettings(client);
        await client.query('UPDATE company_meetings SET quorum_required = $2 WHERE id = $1', [m.id, gov.quorumRequired(settings, fresh)]);
        if (f.chairperson_user_id !== undefined || f.secretary_user_id !== undefined) await gov.buildRegister(client, fresh);
        await logAction(req.user.id, ACTIONS.MEETING_UPDATED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id, newValues: f,
            description: `Updated ${m.title}${renoticed ? ' — notice must be re-issued' : ''}`, client,
        });
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, { ...(await buildMeetingView({ query }, req.user, meeting)), renoticed },
        renoticed ? 'Saved. The meeting details changed after the notice went out — issue a fresh notice.' : 'Meeting updated');
});

// ============================================================
// REFRESH THE REGISTER — POST /api/meetings/:id/register/refresh
// ============================================================
const refreshRegister = asyncHandler(async (req, res) => {
    requireManager(req.user);
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (!['DRAFT', 'NOTICE_ISSUED'].includes(m.status)) {
            throw createError.conflict('The register can only be rebuilt before the meeting opens.');
        }
        await gov.buildRegister(client, m);
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting), 'Register refreshed from the current share register / directors');
});

// ============================================================
// PEOPLE "IN ATTENDANCE" (auditor, advisers, guests)
// POST /api/meetings/:id/attendees     DELETE /:id/attendees/:aid
// ============================================================
const addAttendee = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const name = trimOrNull(req.body.name);
    const userId = req.body.user_id ? Number(req.body.user_id) : null;
    let designation = trimOrNull(req.body.designation) || 'In attendance';
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (['CLOSED', 'CANCELLED'].includes(m.status)) throw createError.conflict('This meeting is closed.');
        // v1.80.0 — for a meeting recorded after the event the secretary
        // may also add a member / director the registers did not list.
        let capacity = 'IN_ATTENDANCE';
        let sharesHeld = null;
        if (['MEMBER', 'DIRECTOR'].includes(req.body.capacity)) {
            if (!m.recorded_after_event) throw createError.badRequest('Members and directors come from the registers automatically — refresh the register instead.');
            if (!userId) throw createError.badRequest('Choose the person from the list of users.');
            const want = m.meeting_type === 'BOARD' ? 'DIRECTOR' : 'MEMBER';
            if (req.body.capacity !== want) throw createError.badRequest(`A ${m.meeting_type === 'BOARD' ? 'board meeting' : 'general meeting'} lists ${want === 'DIRECTOR' ? 'directors' : 'members'}.`);
            capacity = want;
            if (want === 'MEMBER') {
                sharesHeld = req.body.shares_held === undefined || req.body.shares_held === '' ? 0 : Number(req.body.shares_held);
                if (!Number.isFinite(sharesHeld) || sharesHeld < 0) throw createError.badRequest('Shares held must be 0 or more.');
            }
            designation = trimOrNull(req.body.designation) || (want === 'DIRECTOR' ? 'Director' : 'Member');
        }
        const finalName = userId ? await userName(client, userId) : name;
        if (!finalName) throw createError.badRequest('Give the person\'s name or choose a user.');
        if (userId) {
            const dup = await client.query('SELECT 1 FROM meeting_attendance WHERE meeting_id = $1 AND user_id = $2', [m.id, userId]);
            if (dup.rows.length) throw createError.conflict(`${finalName} is already on this register.`);
        }
        await client.query(`
            INSERT INTO meeting_attendance (meeting_id, user_id, name, capacity, designation, shares_held, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m.id, userId, finalName.slice(0, 200), capacity, designation.slice(0, 120), sharesHeld, capacity === 'IN_ATTENDANCE' ? 9500 : 5000]);
        await logAction(req.user.id, ACTIONS.MEETING_ATTENDANCE_MARKED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id,
            description: `Added ${finalName} (${designation}) as in attendance at ${m.title}`, client,
        });
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendCreated(res, await buildMeetingView({ query }, req.user, meeting), 'Added to the register');
});

const removeAttendee = asyncHandler(async (req, res) => {
    requireManager(req.user);
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (['CLOSED', 'CANCELLED'].includes(m.status)) throw createError.conflict('This meeting is closed.');
        const r = await client.query('SELECT * FROM meeting_attendance WHERE id = $1 AND meeting_id = $2', [req.params.aid, m.id]);
        if (!r.rows.length) throw createError.notFound('Attendee not found.');
        const a = r.rows[0];
        if (a.capacity !== 'IN_ATTENDANCE' && !m.recorded_after_event) throw createError.conflict('Members and directors come from the registers and cannot be removed — mark them absent or with apologies instead.');
        if (a.confirmed_at) throw createError.conflict('This person has already confirmed their attendance.');
        await client.query('DELETE FROM meeting_attendance WHERE id = $1', [a.id]);
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting), 'Removed from the register');
});

// ============================================================
// MARK ATTENDANCE — PATCH /api/meetings/:id/attendees/:aid
// body: { status, proxy_name?, proxy_user_id? }
// ============================================================
const markAttendance = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const { status } = req.body;
    if (!ATTENDANCE_STATUSES.includes(status)) throw createError.badRequest(`Status must be one of ${ATTENDANCE_STATUSES.join(', ')}.`);
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (!['NOTICE_ISSUED', 'IN_PROGRESS'].includes(m.status)) {
            throw createError.conflict(m.status === 'DRAFT'
                ? 'Issue the notice first — attendance is taken once the meeting has been called.'
                : 'Attendance can no longer be changed for this meeting.');
        }
        const r = await client.query('SELECT * FROM meeting_attendance WHERE id = $1 AND meeting_id = $2 FOR UPDATE', [req.params.aid, m.id]);
        if (!r.rows.length) throw createError.notFound('Attendee not found.');
        const a = r.rows[0];
        let proxyName = null;
        let proxyUserId = null;
        if (status === 'BY_PROXY') {
            if (m.meeting_type === 'BOARD' || a.capacity !== 'MEMBER') throw createError.badRequest('Only members can attend a general meeting by proxy.');
            proxyUserId = req.body.proxy_user_id ? Number(req.body.proxy_user_id) : null;
            proxyName = proxyUserId ? await userName(client, proxyUserId) : trimOrNull(req.body.proxy_name);
            if (!proxyName) throw createError.badRequest('Give the name of the proxy.');
        }
        if (a.confirmed_at && !['PRESENT', 'PRESENT_VIRTUAL'].includes(status)) {
            throw createError.conflict(`${a.name} confirmed their own attendance — they can only be marked present (in person or online).`);
        }
        await client.query(`
            UPDATE meeting_attendance
            SET status = $2, proxy_name = $3, proxy_user_id = $4, marked_at = NOW(), marked_by = $5
            WHERE id = $1`, [a.id, status, proxyName, proxyUserId, req.user.id]);
        // v1.80.0 — a past meeting: the shares held on that day may be corrected.
        if (m.recorded_after_event && a.capacity === 'MEMBER' && req.body.shares_held !== undefined && req.body.shares_held !== '') {
            const sh = Number(req.body.shares_held);
            if (!Number.isFinite(sh) || sh < 0) throw createError.badRequest('Shares held must be 0 or more.');
            await client.query('UPDATE meeting_attendance SET shares_held = $2 WHERE id = $1', [a.id, sh]);
        }
        await logAction(req.user.id, ACTIONS.MEETING_ATTENDANCE_MARKED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id,
            newValues: { attendee: a.name, status, proxy: proxyName },
            description: `Marked ${a.name} as ${status}${proxyName ? ` (proxy: ${proxyName})` : ''} at ${m.title}`, client,
        });
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting), 'Attendance updated');
});

// ============================================================
// ISSUE THE NOTICE — POST /api/meetings/:id/notice
// body: { short_notice_consent?, short_notice_note? }
// ============================================================
const issueNotice = asyncHandler(async (req, res) => {
    requireManager(req.user);
    let recipients = [];
    let meetingAfter = null;
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (m.status !== 'DRAFT') throw createError.conflict('The notice has already been issued for this meeting.');
        if (!Array.isArray(m.agenda) || !m.agenda.length) throw createError.badRequest('Add the agenda before issuing the notice.');
        if (!m.venue && m.mode !== 'VIRTUAL') throw createError.badRequest('Give the venue before issuing the notice.');
        if (m.mode !== 'PHYSICAL' && !m.virtual_link) throw createError.badRequest('Give the online meeting link before issuing the notice.');
        // v1.80.0 — a meeting recorded after the event: the notice went out
        // on a date the secretary enters; nobody is emailed now.
        let issueDate = gov.todayStr();
        if (m.recorded_after_event) {
            issueDate = trimOrNull(req.body.notice_date);
            if (!issueDate || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw createError.badRequest('Enter the date the notice was given (YYYY-MM-DD).');
            if (issueDate > gov.dateStr(m.meeting_date)) throw createError.badRequest('The notice date cannot be after the meeting date.');
        } else if (gov.todayStr() > gov.dateStr(m.meeting_date)) {
            throw createError.badRequest('The meeting date has already passed — change the date first.');
        }
        const consent = req.body.short_notice_consent !== undefined ? !!req.body.short_notice_consent : m.short_notice_consent;
        const note = req.body.short_notice_note !== undefined ? trimOrNull(req.body.short_notice_note) : m.short_notice_note;
        const settings = await gov.getSettings(client);
        const ns = gov.noticeStatus({ ...m, short_notice_consent: consent }, settings, issueDate);
        if (!ns.sufficient && !consent) {
            const err = createError.conflict(m.recorded_after_event
                ? `This meeting needed ${ns.required} days' notice but the notice was given only ${ns.given} days before it. Record the consent to short notice that was given (members holding at least ${settings.short_notice_consent_pct}% of the voting rights${m.meeting_type === 'BOARD' ? ' — for a board meeting, all the directors' : ''}).`
                : `This meeting needs ${ns.required} days' notice but only ${ns.given} days remain. Move the meeting to ${prettyDate(gov.addDays(gov.todayStr(), ns.required))} or later, or record the consent to short notice (members holding at least ${settings.short_notice_consent_pct}% of the voting rights${m.meeting_type === 'BOARD' ? ' — for a board meeting, all the directors' : ''}).`);
            err.details = ns;
            throw err;
        }
        if (!ns.sufficient && consent && !note) {
            throw createError.badRequest('Describe how the consent to short notice was given (who agreed and when).');
        }
        await client.query(`
            UPDATE company_meetings
            SET status = 'NOTICE_ISSUED', notice_issued_at = CASE WHEN $8::boolean THEN $9::date::timestamptz ELSE NOW() END, notice_issued_by = $2,
                notice_days_required = $3, notice_days_given = $4, short_notice_consent = $5, short_notice_note = $6,
                quorum_required = $7, updated_at = NOW()
            WHERE id = $1`, [m.id, req.user.id, ns.required, ns.given, consent, note, gov.quorumRequired(settings, m), !!m.recorded_after_event, issueDate]);
        const fresh = await loadMeeting(client, m.id);
        await gov.buildRegister(client, fresh);
        const rec = await client.query(`
            SELECT DISTINCT u.id, u.email, u.first_name
            FROM meeting_attendance a JOIN users u ON u.id = a.user_id
            WHERE a.meeting_id = $1 AND u.is_active = TRUE`, [m.id]);
        recipients = m.recorded_after_event ? [] : rec.rows;
        meetingAfter = fresh;
        await logAction(req.user.id, ACTIONS.MEETING_NOTICE_ISSUED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id,
            newValues: { days_required: ns.required, days_given: ns.given, short_notice_consent: consent },
            description: `Issued the notice of ${m.title} (${ns.given} days' notice, ${ns.required} required${!ns.sufficient ? ', short notice by consent' : ''})`, client,
        });
    });

    // Tell everyone on the register — after the commit, never blocking.
    (async () => {
        if (!recipients.length) return;
        try {
            const m = meetingAfter;
            const when = `${prettyDate(m.meeting_date)} at ${String(m.start_time).slice(0, 5)}`;
            const where = m.mode === 'VIRTUAL' ? 'online' : (m.venue || '');
            const items = (m.agenda || []).map(a => `<li>${esc(a.title)}${a.business === 'SPECIAL' ? ' <em>(special business)</em>' : ''}</li>`).join('');
            const html = await wrapEmail(`
                <p>NOTICE IS HEREBY GIVEN that the <strong>${esc(m.title)}</strong> will be held on <strong>${esc(when)}</strong>${where ? ` at <strong>${esc(where)}</strong>` : ''}.</p>
                ${m.virtual_link ? `<p>Online link: <a href="${esc(m.virtual_link)}">${esc(m.virtual_link)}</a></p>` : ''}
                <p><strong>Agenda</strong></p><ol>${items}</ol>
                ${m.meeting_type !== 'BOARD' ? '<p>A member entitled to attend and vote may appoint a proxy to attend and vote instead of him or her. A proxy need not be a member.</p>' : ''}
                <p>The full notice is in the system under Meetings. On the day, open the meeting and press <strong>Confirm my attendance</strong>.</p>
            `, { preheader: `Notice: ${m.title} on ${when}` });
            await notifyMany(recipients, 'MEETING_NOTICE', () => ({
                title: `Notice: ${m.title}`,
                body: `${m.title} — ${when}${where ? `, ${where}` : ''}.`,
                link: `/meetings/${m.id}`,
                module: 'GOVERNANCE',
                recordType: 'company_meetings',
                recordId: m.id,
                email: { subject: `Notice of ${m.title} — ${prettyDate(m.meeting_date)}`, html },
            }));
        } catch (err) { logger.warn(`Meeting notice notifications failed: ${err.message}`); }
    })();

    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting),
        meeting.recorded_after_event ? `Notice recorded as given on ${prettyDate(meeting.notice_issued_at)}` : `Notice issued to ${recipients.length} people`);
});

// ============================================================
// OPEN — POST /api/meetings/:id/open
// The chair declares the meeting open once the quorum is present.
// ============================================================
const openMeeting = asyncHandler(async (req, res) => {
    requireManager(req.user);
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (m.status !== 'NOTICE_ISSUED') {
            throw createError.conflict(m.status === 'DRAFT' ? 'Issue the notice before opening the meeting.' : 'This meeting cannot be opened.');
        }
        if (gov.todayStr() < gov.dateStr(m.meeting_date)) {
            throw createError.conflict(`The meeting is scheduled for ${prettyDate(m.meeting_date)} — it can only be opened on or after that day.`);
        }
        const settings = await gov.getSettings(client);
        const t = gov.tally(m, await loadAttendance(client, m.id), settings);
        if (!t.quorum_met) {
            throw createError.conflict(`There is no quorum: ${t.present} of the ${t.quorum_required} ${m.meeting_type === 'BOARD' ? 'directors' : 'members'} required are present. Mark the attendance first. Under Table A a meeting without a quorum half an hour after the time set stands adjourned.`);
        }
        await client.query(`
            UPDATE company_meetings SET status = 'IN_PROGRESS', opened_at = NOW(), opened_by = $2, quorum_at_opening = $3, updated_at = NOW()
            WHERE id = $1`, [m.id, req.user.id, t.present]);
        // The secretary taking the minutes is, by definition, there.
        if (m.secretary_user_id) {
            await client.query(`
                UPDATE meeting_attendance SET status = 'PRESENT', marked_at = NOW(), marked_by = $3
                WHERE meeting_id = $1 AND user_id = $2 AND capacity = 'IN_ATTENDANCE' AND status = 'PENDING'`,
            [m.id, m.secretary_user_id, req.user.id]);
        }
        await logAction(req.user.id, ACTIONS.MEETING_OPENED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id, newValues: { quorum_at_opening: t.present },
            description: `Opened ${m.title} with ${t.present} present (quorum ${t.quorum_required})`, client,
        });
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting), 'Meeting opened — the quorum is present');
});

// ============================================================
// CONFIRM MY ATTENDANCE — POST /api/meetings/:id/confirm
// body: { attendance: 'IN_PERSON' | 'ONLINE' }
// The attendee's own digital signature on the register.
//   • on the meeting day once the notice is out, or while it is open
//   • after it closes, only to confirm a presence the secretary
//     already recorded
// ============================================================
const confirmAttendance = asyncHandler(async (req, res) => {
    const how = req.body.attendance === 'ONLINE' ? 'PRESENT_VIRTUAL' : 'PRESENT';
    let code = null;
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        const rows = await client.query(`
            SELECT * FROM meeting_attendance WHERE meeting_id = $1 AND user_id = $2
            ORDER BY CASE capacity WHEN 'IN_ATTENDANCE' THEN 1 ELSE 0 END LIMIT 1 FOR UPDATE`, [m.id, req.user.id]);
        if (!rows.rows.length) throw createError.forbidden('You are not on the register of this meeting.');
        const a = rows.rows[0];
        if (a.confirmed_at) throw createError.conflict(`You already confirmed your attendance on ${new Date(a.confirmed_at).toLocaleString('en-GB')}.`);
        if (a.status === 'BY_PROXY') throw createError.conflict('You were represented by a proxy at this meeting.');
        const today = gov.todayStr();
        const day = gov.dateStr(m.meeting_date);
        const marked = ['PRESENT', 'PRESENT_VIRTUAL'].includes(a.status);
        // v1.80.0 — a meeting recorded after the event: people confirm only
        // the attendance the secretary recorded for them.
        const open = !m.recorded_after_event && (m.status === 'IN_PROGRESS' || (m.status === 'NOTICE_ISSUED' && today === day));
        const lateConfirm = marked && (m.status === 'CLOSED' || (m.recorded_after_event && ['IN_PROGRESS', 'NOTICE_ISSUED'].includes(m.status)));
        if (!open && !lateConfirm) {
            if (m.recorded_after_event) throw createError.conflict('This meeting was recorded after it took place and the secretary did not record you as present.');
            if (m.status === 'NOTICE_ISSUED') throw createError.conflict(`Check-in opens on the day of the meeting (${prettyDate(day)}).`);
            if (m.status === 'CLOSED') throw createError.conflict('This meeting is closed and you were not recorded as present.');
            throw createError.conflict('Check-in is not open for this meeting.');
        }
        const status = lateConfirm && !open ? a.status : how;
        const now = new Date();
        code = gov.confirmationCode(['ATTENDANCE', m.id, a.id, req.user.id, now.toISOString()]);
        // v1.80.0 — the person's captured signature goes on the register.
        const sig = (await gov.v180Ready(client)) ? await gov.captureSignature(client, req.user.id, `attendance-${m.id}-${a.id}`) : null;
        await client.query(`
            UPDATE meeting_attendance
            SET status = $2, confirmed_at = $3, confirmation_code = $4, confirmed_ip = $5,
                marked_at = COALESCE(marked_at, $3), marked_by = COALESCE(marked_by, $6)
            WHERE id = $1`, [a.id, status, now, code, String(req.ip || '').slice(0, 64), req.user.id]);
        if (sig) await client.query('UPDATE meeting_attendance SET signature_snapshot_path = $2 WHERE id = $1', [a.id, sig]);
        await logAction(req.user.id, ACTIONS.MEETING_ATTENDANCE_CONFIRMED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id, newValues: { status, code },
            description: `${a.name} confirmed attendance at ${m.title} (${status === 'PRESENT' ? 'in person' : 'online'}), code ${code}`, client,
        });
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, { ...(await buildMeetingView({ query }, req.user, meeting)), confirmation_code: code }, `Attendance confirmed — code ${code}`);
});

// ============================================================
// MINUTES — PUT /api/meetings/:id/minutes
// body: { opening, previous_minutes, items:[{ no, title, discussion, decision }], aob, closing, next_meeting }
// ============================================================
const MINUTE_TEXT_FIELDS = ['opening', 'previous_minutes', 'apologies_note', 'aob', 'closing', 'next_meeting', 'declarations'];

const saveMinutes = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const b = req.body || {};
    const minutes = {};
    for (const k of MINUTE_TEXT_FIELDS) {
        if (b[k] !== undefined) minutes[k] = trimOrNull(b[k]);
    }
    if (b.items !== undefined) {
        if (!Array.isArray(b.items) || b.items.length > 80) throw createError.badRequest('Minute items must be a list (at most 80).');
        minutes.items = b.items.map((it, i) => ({
            no: isInt(it.no) ? Number(it.no) : i + 1,
            title: trimOrNull(it.title) || `Item ${i + 1}`,
            discussion: trimOrNull(it.discussion),
            decision: trimOrNull(it.decision),
            action_by: trimOrNull(it.action_by),
            action_due: trimOrNull(it.action_due),
        }));
    }
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (!['IN_PROGRESS', 'CLOSED'].includes(m.status)) throw createError.conflict('Minutes are written once the meeting has opened.');
        await client.query(`UPDATE company_meetings SET minutes = minutes || $2::jsonb, updated_at = NOW() WHERE id = $1`,
            [m.id, JSON.stringify(minutes)]);
        await logAction(req.user.id, ACTIONS.MEETING_MINUTES_SAVED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id,
            description: `Saved the minutes of ${m.title}`, client,
        });
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting), 'Minutes saved');
});

// ============================================================
// CLOSE — POST /api/meetings/:id/close
// Anyone not marked becomes ABSENT; every resolution must have a result.
// ============================================================
const closeMeeting = asyncHandler(async (req, res) => {
    requireManager(req.user);
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (m.status !== 'IN_PROGRESS') throw createError.conflict('Only an open meeting can be closed.');
        const pending = await client.query(`SELECT resolution_number FROM meeting_resolutions WHERE meeting_id = $1 AND result = 'PENDING'`, [m.id]);
        if (pending.rows.length) {
            throw createError.conflict(`Record the vote on (or withdraw) ${pending.rows.map(r => r.resolution_number).join(', ')} before closing the meeting.`);
        }
        await client.query(`UPDATE meeting_attendance SET status = 'ABSENT', marked_at = NOW(), marked_by = $2 WHERE meeting_id = $1 AND status = 'PENDING'`, [m.id, req.user.id]);
        const closing = trimOrNull(req.body.closing_time);
        await client.query(`
            UPDATE company_meetings SET status = 'CLOSED', closed_at = NOW(), closed_by = $2,
                end_time = COALESCE($3::time, end_time, LOCALTIME(0)), updated_at = NOW()
            WHERE id = $1`, [m.id, req.user.id, closing]);
        await logAction(req.user.id, ACTIONS.MEETING_CLOSED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id,
            description: `Closed ${m.title}`, client,
        });
    });
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting), 'Meeting closed');
});

// ============================================================
// CANCEL — POST /api/meetings/:id/cancel   body: { reason }
// ============================================================
const cancelMeeting = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const reason = trimOrNull(req.body.reason);
    if (!reason) throw createError.badRequest('Give the reason for cancelling.');
    let recipients = [];
    let mt = null;
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (!['DRAFT', 'NOTICE_ISSUED'].includes(m.status)) throw createError.conflict('Only a meeting that has not opened can be cancelled.');
        await client.query(`UPDATE company_meetings SET status = 'CANCELLED', cancelled_reason = $2, updated_at = NOW() WHERE id = $1`, [m.id, reason]);
        await client.query(`UPDATE meeting_resolutions SET result = 'WITHDRAWN', updated_at = NOW() WHERE meeting_id = $1 AND result = 'PENDING'`, [m.id]);
        if (m.status === 'NOTICE_ISSUED') {
            const rec = await client.query(`
                SELECT DISTINCT u.id, u.email, u.first_name FROM meeting_attendance a JOIN users u ON u.id = a.user_id
                WHERE a.meeting_id = $1 AND u.is_active = TRUE`, [m.id]);
            recipients = rec.rows;
        }
        mt = m;
        await logAction(req.user.id, ACTIONS.MEETING_CANCELLED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'company_meetings', recordId: m.id, newValues: { reason },
            description: `Cancelled ${m.title}: ${reason}`, client,
        });
    });
    if (recipients.length) {
        notifyMany(recipients, 'MEETING_CANCELLED', () => ({
            title: `Cancelled: ${mt.title}`,
            body: `${mt.title} on ${prettyDate(mt.meeting_date)} has been cancelled. Reason: ${reason}`,
            link: `/meetings/${mt.id}`, module: 'GOVERNANCE', recordType: 'company_meetings', recordId: mt.id,
        })).catch(err => logger.warn(`Meeting cancellation notifications failed: ${err.message}`));
    }
    const meeting = await loadMeeting({ query }, req.params.id);
    sendSuccess(res, await buildMeetingView({ query }, req.user, meeting), 'Meeting cancelled');
});

// ============================================================
// RESOLUTIONS
// ============================================================
const validateResolutionBody = (b, { partial }) => {
    const out = {};
    if (!partial || b.title !== undefined) {
        const t = trimOrNull(b.title);
        if (!t) throw createError.badRequest('The resolution needs a title.');
        out.title = t.slice(0, 255);
    }
    if (b.preamble !== undefined) out.preamble = trimOrNull(b.preamble);
    if (!partial || b.clauses !== undefined) {
        const c = Array.isArray(b.clauses) ? b.clauses.map(trimOrNull).filter(Boolean) : [];
        if (!c.length) throw createError.badRequest('Write at least one clause ("THAT …").');
        if (c.length > 40) throw createError.badRequest('At most 40 clauses.');
        out.clauses = c;
    }
    if (b.agenda_no !== undefined) out.agenda_no = b.agenda_no === null || b.agenda_no === '' ? null : Number(b.agenda_no);
    if (b.proposed_by_user_id !== undefined) out.proposed_by_user_id = b.proposed_by_user_id ? Number(b.proposed_by_user_id) : null;
    if (b.seconded_by_user_id !== undefined) out.seconded_by_user_id = b.seconded_by_user_id ? Number(b.seconded_by_user_id) : null;
    if (b.proposed_by_name !== undefined) out.proposed_by_name = trimOrNull(b.proposed_by_name);
    if (b.seconded_by_name !== undefined) out.seconded_by_name = trimOrNull(b.seconded_by_name);
    return out;
};

const resolveMovers = async (client, f) => {
    if (f.proposed_by_user_id) f.proposed_by_name = await userName(client, f.proposed_by_user_id);
    if (f.seconded_by_user_id) f.seconded_by_name = await userName(client, f.seconded_by_user_id);
    if (f.proposed_by_user_id && f.proposed_by_user_id === f.seconded_by_user_id) {
        throw createError.badRequest('The proposer and the seconder must be different people.');
    }
};

// POST /api/meetings/:id/resolutions   body: { kind, title, preamble, clauses[], agenda_no, proposed_by_user_id, seconded_by_user_id }
const createMeetingResolution = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const f = validateResolutionBody(req.body, { partial: false });
    let created = null;
    await withTransaction(async (client) => {
        const m = await loadMeeting(client, req.params.id, { lock: true });
        if (!['DRAFT', 'NOTICE_ISSUED', 'IN_PROGRESS'].includes(m.status)) throw createError.conflict('Resolutions can only be added before or during the meeting.');
        const kind = m.meeting_type === 'BOARD' ? 'BOARD' : (req.body.kind || 'ORDINARY');
        if (m.meeting_type === 'BOARD' && req.body.kind && req.body.kind !== 'BOARD') throw createError.badRequest('A board meeting passes board resolutions only.');
        if (m.meeting_type !== 'BOARD' && !['ORDINARY', 'SPECIAL'].includes(kind)) throw createError.badRequest('A general meeting passes ordinary or special resolutions.');
        if (kind === 'SPECIAL' && !m.has_special_business) {
            if (m.status !== 'DRAFT') {
                throw createError.conflict('A special resolution can only be proposed if the notice of the meeting stated the intention to propose it. The notice of this meeting did not — change the meeting (it will need a fresh notice) or call another meeting.');
            }
            await client.query('UPDATE company_meetings SET has_special_business = TRUE, updated_at = NOW() WHERE id = $1', [m.id]);
        }
        await resolveMovers(client, f);
        const year = Number(gov.dateStr(m.meeting_date).slice(0, 4));
        const number = await gov.nextResolutionNumber(client, kind, year);
        const { referenceId, referenceCode } = await generateReference(client, 'RES', gov.RESOLUTION_PREFIX[kind], 'RESOLUTION', req.user.id);
        const ins = await client.query(`
            INSERT INTO meeting_resolutions (reference_id, meeting_id, kind, resolution_number, agenda_no, title, preamble, clauses,
                proposed_by_user_id, proposed_by_name, seconded_by_user_id, seconded_by_name, filing_required, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [referenceId, m.id, kind, number, f.agenda_no || null, f.title, f.preamble || null, JSON.stringify(f.clauses),
            f.proposed_by_user_id || null, f.proposed_by_name || null, f.seconded_by_user_id || null, f.seconded_by_name || null,
            gov.filingRequiredFor(kind, false), req.user.id]);
        created = { ...ins.rows[0], reference_code: referenceCode };
        await linkReferenceToRecord(client, referenceId, created.id);
        await logAction(req.user.id, ACTIONS.RESOLUTION_CREATED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'meeting_resolutions', recordId: created.id,
            newValues: { number, kind, title: f.title, meeting: m.title },
            description: `Proposed ${KIND_LABEL[kind]} ${number} "${f.title}" for ${m.title}`, client,
        });
    });
    sendCreated(res, normResolution(created), `${KIND_LABEL[created.kind]} ${created.resolution_number} added`);
});

// PATCH /api/meetings/resolutions/:rid
const updateResolution = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const f = validateResolutionBody(req.body, { partial: true });
    await withTransaction(async (client) => {
        const r = await loadResolution(client, req.params.rid, { lock: true });
        if (r.result !== 'PENDING') throw createError.conflict('Only a resolution that has not been decided can be edited.');
        if (r.meeting_id && !['DRAFT', 'NOTICE_ISSUED', 'IN_PROGRESS'].includes(r.meeting_status)) throw createError.conflict('The meeting is closed.');
        if (!r.meeting_id) {
            const signed = await client.query('SELECT 1 FROM resolution_signatories WHERE resolution_id = $1 AND signed_at IS NOT NULL LIMIT 1', [r.id]);
            if (signed.rows.length) throw createError.conflict('Someone has already signed this written resolution — it can no longer be changed. Withdraw it and create a new one.');
        }
        await resolveMovers(client, f);
        if (r.kind === 'WRITTEN_MEMBERS' && req.body.treated_as_special !== undefined) f.treated_as_special = !!req.body.treated_as_special;
        const sets = [];
        const params = [];
        for (const [k, v] of Object.entries(f)) {
            params.push(k === 'clauses' ? JSON.stringify(v) : v);
            sets.push(`${k} = $${params.length}${k === 'clauses' ? '::jsonb' : ''}`);
        }
        if (f.treated_as_special !== undefined) { params.push(gov.filingRequiredFor(r.kind, f.treated_as_special)); sets.push(`filing_required = $${params.length}`); }
        if (!sets.length) throw createError.badRequest('Nothing to update.');
        params.push(r.id);
        await client.query(`UPDATE meeting_resolutions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
        await logAction(req.user.id, ACTIONS.RESOLUTION_UPDATED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'meeting_resolutions', recordId: r.id, newValues: f,
            description: `Edited ${r.resolution_number}`, client,
        });
    });
    sendSuccess(res, await resolutionView({ query }, req.params.rid), 'Resolution updated');
});

// POST /api/meetings/resolutions/:rid/vote
// body: { votes_for, votes_against, votes_abstain, chair_casting_vote? }
const recordVote = asyncHandler(async (req, res) => {
    requireManager(req.user);
    let outcome = null;
    let notifySecretary = null;
    await withTransaction(async (client) => {
        const r = await loadResolution(client, req.params.rid, { lock: true });
        if (!r.meeting_id) throw createError.badRequest('Written resolutions are decided by signature, not by a vote.');
        if (r.result !== 'PENDING') throw createError.conflict(`${r.resolution_number} has already been decided (${r.result}).`);
        const m = await loadMeeting(client, r.meeting_id, { lock: true });
        if (m.status !== 'IN_PROGRESS') throw createError.conflict('Votes are taken only while the meeting is open.');
        const settings = await gov.getSettings(client);
        const t = gov.tally(m, await loadAttendance(client, m.id), settings);
        if (!t.quorum_met) throw createError.conflict(`The quorum is no longer present (${t.present} of ${t.quorum_required}). No business can be done.`);
        if (r.kind === 'SPECIAL') {
            const ns = gov.noticeStatus({ ...m, has_special_business: true }, settings);
            if (!m.has_special_business || !ns.compliant) {
                throw createError.conflict(`A special resolution needs ${ns.required} days' notice stating the intention to propose it (or consent to short notice). This meeting's notice does not meet that.`);
            }
        }
        const casting = req.body.chair_casting_vote || null;
        if (casting && !['FOR', 'AGAINST'].includes(casting)) throw createError.badRequest('The casting vote must be FOR or AGAINST.');
        const v = gov.evaluateVote({
            kind: r.kind, votesFor: req.body.votes_for, votesAgainst: req.body.votes_against,
            votesAbstain: req.body.votes_abstain || 0, casting, settings, voters: t.voters,
        });
        const passedOn = gov.dateStr(m.meeting_date); // v1.80.0 — passed on the day of the meeting (also for a meeting recorded afterwards)
        const filingRequired = gov.filingRequiredFor(r.kind, r.treated_as_special);
        const due = v.result === 'CARRIED' && filingRequired ? gov.addDays(passedOn, settings.resolution_filing_days) : null;
        await client.query(`
            UPDATE meeting_resolutions
            SET votes_for = $2, votes_against = $3, votes_abstain = $4, voters_present = $5, chair_casting_vote = $6,
                majority_required_pct = $7, result = $8, passed_on = $9, recorded_at = NOW(), recorded_by = $10,
                filing_required = $11, filing_due_date = $12, updated_at = NOW()
            WHERE id = $1`,
        [r.id, Number(req.body.votes_for), Number(req.body.votes_against), Number(req.body.votes_abstain || 0), t.voters, v.casting,
            v.majority_required_pct, v.result, v.result === 'CARRIED' ? passedOn : null, req.user.id, filingRequired, due]);
        outcome = { ...v, filing_due_date: due };
        if (due) notifySecretary = { m, r, due };
        await logAction(req.user.id, ACTIONS.RESOLUTION_VOTED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'meeting_resolutions', recordId: r.id,
            newValues: { for: req.body.votes_for, against: req.body.votes_against, abstain: req.body.votes_abstain || 0, voters: t.voters, casting: v.casting, result: v.result },
            description: `${r.resolution_number} ${v.result} on a show of hands (${req.body.votes_for} for, ${req.body.votes_against} against, ${req.body.votes_abstain || 0} abstaining)`, client,
        });
    });
    if (notifySecretary) {
        const { m, r, due } = notifySecretary;
        const sec = await query(`
            SELECT DISTINCT u.id, u.email, u.first_name FROM users u
            WHERE u.is_active = TRUE AND (u.id = $1 OR EXISTS (
                SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND ro.name = 'Secretary'))`, [m.secretary_user_id || 0]);
        notifyMany(sec.rows, 'RESOLUTION_FILING_DUE', () => ({
            title: `File ${r.resolution_number} with URSB by ${prettyDate(due)}`,
            body: `Special resolution ${r.resolution_number} "${r.title}" was passed at ${m.title}. A certified copy must be filed with the Registrar by ${prettyDate(due)}.`,
            link: '/meetings/resolutions', module: 'GOVERNANCE', recordType: 'meeting_resolutions', recordId: r.id,
        })).catch(err => logger.warn(`Filing reminder failed: ${err.message}`));
    }
    sendSuccess(res, { ...(await resolutionView({ query }, req.params.rid)), outcome },
        `Resolution ${outcome.result === 'CARRIED' ? 'carried' : 'lost'}${outcome.filing_due_date ? ` — file with URSB by ${prettyDate(outcome.filing_due_date)}` : ''}`);
});

// POST /api/meetings/resolutions/:rid/withdraw
const withdrawResolution = asyncHandler(async (req, res) => {
    requireManager(req.user);
    await withTransaction(async (client) => {
        const r = await loadResolution(client, req.params.rid, { lock: true });
        if (r.result !== 'PENDING') throw createError.conflict('Only a resolution that has not been decided can be withdrawn.');
        await client.query(`UPDATE meeting_resolutions SET result = 'WITHDRAWN', recorded_at = NOW(), recorded_by = $2, updated_at = NOW() WHERE id = $1`, [r.id, req.user.id]);
        await logAction(req.user.id, ACTIONS.RESOLUTION_WITHDRAWN, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'meeting_resolutions', recordId: r.id,
            description: `Withdrew ${r.resolution_number} "${r.title}"`, client,
        });
    });
    sendSuccess(res, await resolutionView({ query }, req.params.rid), 'Resolution withdrawn');
});

// POST /api/meetings/resolutions/:rid/filed   body: { filed_on, filing_reference }
const markFiled = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const filedOn = trimOrNull(req.body.filed_on) || gov.todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filedOn)) throw createError.badRequest('Filing date must be YYYY-MM-DD.');
    if (filedOn > gov.todayStr()) throw createError.badRequest('The filing date cannot be in the future.');
    const ref = trimOrNull(req.body.filing_reference);
    await withTransaction(async (client) => {
        const r = await loadResolution(client, req.params.rid, { lock: true });
        if (r.result !== 'CARRIED' || !r.filing_required) throw createError.conflict('Only a carried resolution that must be filed can be marked as filed.');
        if (filedOn < gov.dateStr(r.passed_on)) throw createError.badRequest('The filing date cannot be before the resolution was passed.');
        await client.query(`UPDATE meeting_resolutions SET filed_on = $2, filing_reference = $3, filed_by = $4, updated_at = NOW() WHERE id = $1`,
            [r.id, filedOn, ref ? ref.slice(0, 120) : null, req.user.id]);
        await logAction(req.user.id, ACTIONS.RESOLUTION_FILED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'meeting_resolutions', recordId: r.id, newValues: { filed_on: filedOn, filing_reference: ref },
            description: `Recorded ${r.resolution_number} as filed with the Registrar on ${filedOn}${ref ? ` (${ref})` : ''}`, client,
        });
    });
    sendSuccess(res, await resolutionView({ query }, req.params.rid), 'Filing recorded');
});

// ------------------------------------------------------------
// Written resolutions
// ------------------------------------------------------------
const resolutionView = async (db, id) => {
    const r = await loadResolution(db, id);
    const signatories = await db.query(`
        SELECT * FROM resolution_signatories WHERE resolution_id = $1 ORDER BY COALESCE(shares_held, 0) DESC, name`, [r.id]);
    const docs = await db.query(`
        SELECT d.id, d.title, d.document_type, d.status, d.created_at, rr.reference_code
        FROM documents d LEFT JOIN references_registry rr ON rr.id = d.reference_id
        WHERE d.related_record_type = 'meeting_resolutions' AND d.related_record_id = $1 AND d.status NOT IN ('SUPERSEDED','DELETED')
        ORDER BY d.created_at DESC`, [r.id]);
    return {
        ...normResolution(r),
        filing_state: filingState(r),
        signatories: signatories.rows.map(s => ({ ...s, shares_held: s.shares_held === null ? null : Number(s.shares_held) })),
        documents: docs.rows,
    };
};

// POST /api/meetings/resolutions/written
// body: { kind: WRITTEN_MEMBERS|WRITTEN_BOARD, treated_as_special?, title, preamble, clauses[] }
const createWrittenResolution = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const kind = req.body.kind;
    if (!['WRITTEN_MEMBERS', 'WRITTEN_BOARD'].includes(kind)) throw createError.badRequest('kind must be WRITTEN_MEMBERS or WRITTEN_BOARD.');
    const f = validateResolutionBody(req.body, { partial: false });
    const special = kind === 'WRITTEN_MEMBERS' && !!req.body.treated_as_special;
    let created = null;
    let signers = [];
    await withTransaction(async (client) => {
        let people;
        if (kind === 'WRITTEN_BOARD') {
            people = (await gov.loadDirectors(client)).map(p => ({ ...p, capacity: 'DIRECTOR', shares_held: null }));
        } else {
            const members = await gov.loadMembers(client);
            const withShares = members.filter(p => p.shares_held > 0);
            people = (withShares.length ? withShares : members).map(p => ({ ...p, capacity: 'MEMBER' }));
        }
        if (!people.length) throw createError.conflict(kind === 'WRITTEN_BOARD' ? 'There are no active directors to sign.' : 'There are no members on the register to sign.');
        const year = Number(gov.todayStr().slice(0, 4));
        const number = await gov.nextResolutionNumber(client, kind, year);
        const { referenceId, referenceCode } = await generateReference(client, 'RES', gov.RESOLUTION_PREFIX[kind], 'RESOLUTION', req.user.id);
        const ins = await client.query(`
            INSERT INTO meeting_resolutions (reference_id, kind, treated_as_special, resolution_number, title, preamble, clauses,
                filing_required, majority_required_pct, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,100,$9) RETURNING *`,
        [referenceId, kind, special, number, f.title, f.preamble || null, JSON.stringify(f.clauses),
            gov.filingRequiredFor(kind, special), req.user.id]);
        created = { ...ins.rows[0], reference_code: referenceCode };
        await linkReferenceToRecord(client, referenceId, created.id);
        for (const p of people) {
            await client.query(`
                INSERT INTO resolution_signatories (resolution_id, user_id, name, capacity, shares_held)
                VALUES ($1,$2,$3,$4,$5)`, [created.id, p.user_id, p.name, p.capacity, p.shares_held]);
        }
        const rec = await client.query(`SELECT id, email, first_name FROM users WHERE id = ANY($1::int[]) AND is_active = TRUE`, [people.map(p => p.user_id)]);
        signers = rec.rows;
        await logAction(req.user.id, ACTIONS.RESOLUTION_CREATED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'meeting_resolutions', recordId: created.id,
            newValues: { number, kind, title: f.title, signatories: people.length, treated_as_special: special },
            description: `Circulated ${KIND_LABEL[kind]} ${number} "${f.title}" to ${people.length} signatories`, client,
        });
    });
    (async () => {
        try {
            const html = await wrapEmail(`
                <p>A <strong>${esc(KIND_LABEL[kind].toLowerCase())}</strong> has been circulated for your signature:</p>
                <p><strong>${esc(created.resolution_number)} — ${esc(created.title)}</strong></p>
                <ol>${f.clauses.map(c => `<li>${esc(c)}</li>`).join('')}</ol>
                <p>It is passed only when everyone entitled has signed in agreement. Open it in the system under Meetings › Resolutions and choose <strong>Agree</strong> or <strong>Disagree</strong>.</p>
            `, { preheader: `Please sign ${created.resolution_number}` });
            await notifyMany(signers, 'RESOLUTION_SIGNATURE', () => ({
                title: `Please sign ${created.resolution_number}`,
                body: `${KIND_LABEL[kind]}: "${created.title}" needs your signature.`,
                link: `/meetings/resolutions/${created.id}`, module: 'GOVERNANCE', recordType: 'meeting_resolutions', recordId: created.id,
                email: { subject: `Signature needed: ${created.resolution_number} — ${created.title}`, html },
            }));
        } catch (err) { logger.warn(`Written resolution notifications failed: ${err.message}`); }
    })();
    sendCreated(res, await resolutionView({ query }, created.id), `${created.resolution_number} circulated to ${signers.length} signatories`);
});

// POST /api/meetings/resolutions/:rid/sign   body: { decision: AGREE|DISAGREE }
const signWrittenResolution = asyncHandler(async (req, res) => {
    const decision = req.body.decision;
    if (!['AGREE', 'DISAGREE'].includes(decision)) throw createError.badRequest('Choose AGREE or DISAGREE.');
    let code = null;
    let finished = null;
    await withTransaction(async (client) => {
        const r = await loadResolution(client, req.params.rid, { lock: true });
        if (r.meeting_id) throw createError.badRequest('This resolution is decided at a meeting, not by signature.');
        if (r.result !== 'PENDING') throw createError.conflict(`${r.resolution_number} is already ${r.result.toLowerCase()}.`);
        const s = await client.query('SELECT * FROM resolution_signatories WHERE resolution_id = $1 AND user_id = $2 FOR UPDATE', [r.id, req.user.id]);
        if (!s.rows.length) throw createError.forbidden('You are not one of the signatories of this resolution.');
        if (s.rows[0].signed_at) throw createError.conflict('You have already signed this resolution.');
        const now = new Date();
        code = gov.confirmationCode(['RESOLUTION', r.id, req.user.id, decision, now.toISOString()]);
        await client.query(`
            UPDATE resolution_signatories SET decision = $2, signed_at = $3, confirmation_code = $4, signed_ip = $5 WHERE id = $1`,
        [s.rows[0].id, decision, now, code, String(req.ip || '').slice(0, 64)]);
        // v1.80.0 — the signatory's captured signature is kept with the decision.
        if (await gov.v180Ready(client)) {
            const sig = await gov.captureSignature(client, req.user.id, `resolution-${r.id}-${s.rows[0].id}`);
            await client.query('UPDATE resolution_signatories SET signature_snapshot_path = $2 WHERE id = $1', [s.rows[0].id, sig]);
        }
        const all = await client.query('SELECT decision FROM resolution_signatories WHERE resolution_id = $1', [r.id]);
        const anyNo = all.rows.some(x => x.decision === 'DISAGREE');
        const allYes = all.rows.every(x => x.decision === 'AGREE');
        if (anyNo || allYes) {
            const settings = await gov.getSettings(client);
            const result = allYes ? 'CARRIED' : 'LOST';
            const passedOn = gov.todayStr();
            const due = result === 'CARRIED' && r.filing_required ? gov.addDays(passedOn, settings.resolution_filing_days) : null;
            await client.query(`
                UPDATE meeting_resolutions SET result = $2, passed_on = $3, recorded_at = NOW(), filing_due_date = $4,
                    votes_for = $5, votes_against = $6, votes_abstain = 0, voters_present = $7, updated_at = NOW()
                WHERE id = $1`,
            [r.id, result, result === 'CARRIED' ? passedOn : null, due,
                all.rows.filter(x => x.decision === 'AGREE').length, all.rows.filter(x => x.decision === 'DISAGREE').length, all.rows.length]);
            finished = { result, due, r };
        }
        await logAction(req.user.id, ACTIONS.RESOLUTION_SIGNED, MODULES.GOVERNANCE, {
            ipAddress: req.ip, recordType: 'meeting_resolutions', recordId: r.id, newValues: { decision, code },
            description: `Signed ${r.resolution_number}: ${decision} (code ${code})${finished ? ` — resolution ${finished.result}` : ''}`, client,
        });
    });
    if (finished && finished.r.created_by) {
        notify({
            userId: finished.r.created_by, type: 'RESOLUTION_DECIDED',
            title: `${finished.r.resolution_number} ${finished.result === 'CARRIED' ? 'passed' : 'not passed'}`,
            body: finished.result === 'CARRIED'
                ? `Every signatory agreed to "${finished.r.title}".${finished.due ? ` File it with URSB by ${prettyDate(finished.due)}.` : ''}`
                : `A signatory disagreed with "${finished.r.title}", so the written resolution is not passed.`,
            link: `/meetings/resolutions/${finished.r.id}`, module: 'GOVERNANCE', recordType: 'meeting_resolutions', recordId: finished.r.id,
        }).catch(() => {});
    }
    sendSuccess(res, { ...(await resolutionView({ query }, req.params.rid)), confirmation_code: code },
        `Signed (${decision.toLowerCase()}) — code ${code}${finished ? `. The resolution is ${finished.result.toLowerCase()}.` : ''}`);
});

// GET /api/meetings/resolutions/:rid
const getResolution = asyncHandler(async (req, res) => {
    const r = await loadResolution({ query }, req.params.rid);
    await assertCanViewResolution({ query }, req.user, r);
    const view = await resolutionView({ query }, r.id);
    let meeting = null;
    if (r.meeting_id) {
        const m = await loadMeeting({ query }, r.meeting_id);
        meeting = normMeeting(m);
    }
    const company = await query(`
        SELECT company_name, registration_number, tin, registered_office, postal_address
        FROM company_settings ORDER BY id LIMIT 1`).catch(() => ({ rows: [] }));
    sendSuccess(res, {
        ...view, meeting, company: company.rows[0] || null,
        settings: await gov.getSettings({ query }),
        can_manage: gov.canManage(req.user),
        my_signature: view.signatories.find(s => s.user_id === req.user.id) || null,
    });
});

// GET /api/meetings/resolutions?kind=&result=&year=&filing=due|overdue|filed
// The register of resolutions.
const listResolutions = asyncHandler(async (req, res) => {
    const { kind, result, year, filing } = req.query;
    const where = [];
    const params = [];
    if (kind) { params.push(kind); where.push(`res.kind = $${params.length}`); }
    if (result) { params.push(result); where.push(`res.result = $${params.length}`); }
    if (year && isInt(year)) { params.push(Number(year)); where.push(`EXTRACT(YEAR FROM COALESCE(res.passed_on, m.meeting_date, res.created_at::date)) = $${params.length}`); }
    if (filing === 'filed') where.push(`res.filing_required AND res.result = 'CARRIED' AND res.filed_on IS NOT NULL`);
    if (filing === 'due') where.push(`res.filing_required AND res.result = 'CARRIED' AND res.filed_on IS NULL`);
    if (filing === 'overdue') where.push(`res.filing_required AND res.result = 'CARRIED' AND res.filed_on IS NULL AND res.filing_due_date < CURRENT_DATE`);
    if (!gov.canManage(req.user)) {
        params.push(req.user.id);
        const me = `$${params.length}`;
        const mine = `(EXISTS (SELECT 1 FROM resolution_signatories s WHERE s.resolution_id = res.id AND s.user_id = ${me})
                    OR EXISTS (SELECT 1 FROM meeting_attendance a WHERE a.meeting_id = res.meeting_id AND a.user_id = ${me}))`;
        const board = gov.isDirector(req.user) ? 'TRUE' : mine;
        const general = canViewGeneral(req.user) ? 'TRUE' : mine;
        where.push(`(CASE WHEN res.kind IN ('BOARD','WRITTEN_BOARD') THEN ${board} ELSE ${general} END)`);
    }
    const r = await query(`
        SELECT res.id, res.kind, res.treated_as_special, res.resolution_number, res.title, res.result, res.passed_on,
               res.votes_for, res.votes_against, res.votes_abstain, res.filing_required, res.filing_due_date, res.filed_on,
               res.filing_reference, res.meeting_id, res.created_at, rr.reference_code,
               m.title AS meeting_title, m.meeting_type, m.meeting_date,
               (SELECT COUNT(*)::int FROM resolution_signatories s WHERE s.resolution_id = res.id) AS signatories_total,
               (SELECT COUNT(*)::int FROM resolution_signatories s WHERE s.resolution_id = res.id AND s.signed_at IS NOT NULL) AS signatories_signed
        FROM   meeting_resolutions res
        JOIN   references_registry rr ON rr.id = res.reference_id
        LEFT JOIN company_meetings m ON m.id = res.meeting_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER  BY COALESCE(res.passed_on, m.meeting_date, res.created_at::date) DESC, res.id DESC
        LIMIT  1000`, params);
    sendSuccess(res, {
        resolutions: r.rows.map(x => ({ ...normResolution(x), filing_state: filingState(x) })),
        can_manage: gov.canManage(req.user),
    });
});

// ============================================================
// MY ACTIONS — GET /api/meetings/my-actions
// For the dashboard: attendance to confirm, resolutions to sign,
// upcoming meetings I am called to.
// ============================================================
const myActions = asyncHandler(async (req, res) => {
    const settings = await gov.getSettings({ query });
    if (settings.ready === false) return sendSuccess(res, { ready: false, confirm_attendance: [], sign_resolutions: [], upcoming: [], filings_due: [] });
    const confirm = await query(`
        SELECT m.id, m.title, m.meeting_type, m.meeting_date, m.start_time, m.status, a.status AS my_status
        FROM   meeting_attendance a JOIN company_meetings m ON m.id = a.meeting_id
        WHERE  a.user_id = $1 AND a.confirmed_at IS NULL AND a.status <> 'BY_PROXY'
        AND  ((m.status = 'IN_PROGRESS')
           OR (m.status = 'NOTICE_ISSUED' AND m.meeting_date = CURRENT_DATE)
           OR (m.status = 'CLOSED' AND a.status IN ('PRESENT','PRESENT_VIRTUAL') AND m.closed_at > NOW() - INTERVAL '30 days'))
        ORDER BY m.meeting_date`, [req.user.id]);
    const sign = await query(`
        SELECT res.id, res.resolution_number, res.title, res.kind, res.created_at
        FROM   resolution_signatories s JOIN meeting_resolutions res ON res.id = s.resolution_id
        WHERE  s.user_id = $1 AND s.signed_at IS NULL AND res.result = 'PENDING'
        ORDER BY res.created_at`, [req.user.id]);
    const upcoming = await query(`
        SELECT DISTINCT m.id, m.title, m.meeting_type, m.meeting_date, m.start_time, m.venue, m.mode
        FROM   meeting_attendance a JOIN company_meetings m ON m.id = a.meeting_id
        WHERE  a.user_id = $1 AND m.status = 'NOTICE_ISSUED' AND m.meeting_date >= CURRENT_DATE
        ORDER BY m.meeting_date LIMIT 5`, [req.user.id]);
    let filings = { rows: [] };
    if (gov.canManage(req.user)) {
        filings = await query(`
            SELECT id, resolution_number, title, filing_due_date FROM meeting_resolutions
            WHERE filing_required AND result = 'CARRIED' AND filed_on IS NULL ORDER BY filing_due_date`);
    }
    sendSuccess(res, {
        confirm_attendance: confirm.rows.map(normMeeting),
        sign_resolutions: sign.rows,
        upcoming: upcoming.rows.map(normMeeting),
        filings_due: filings.rows.map(r => ({ ...normResolution(r), overdue: gov.dateStr(r.filing_due_date) < gov.todayStr() })),
    });
});

// ============================================================
// DOCUMENT CATEGORIES — GET /api/meetings/document-categories
// Every document generated from a meeting is filed under
//   Statutory Records › General Meetings | Board Meetings | Resolutions
// (created the first time they are needed), so it carries a full
// category trail like every other record.
// ============================================================
const documentCategories = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const ids = await withTransaction(async (client) => {
        const parentId = await getOrCreateCategory(client, {
            module: 'DOCUMENT', name: 'Statutory Records', abbreviation: 'STAT',
            description: 'Notices, registers of attendance, minutes and resolutions of company meetings (v1.79.0).', createdBy: req.user.id,
        });
        const child = (name, abbreviation, description) => getOrCreateChildCategory(client, {
            parentId, module: 'DOCUMENT', name, abbreviation, description, createdBy: req.user.id,
        });
        return {
            general: await child('General Meetings', 'GMTG', 'AGM / EGM notices, proxy forms, registers and minutes.'),
            board: await child('Board Meetings', 'BMTG', 'Board meeting notices, registers and minutes.'),
            resolutions: await child('Resolutions', 'RESN', 'Ordinary, special, board and written resolutions, and certified copies for filing.'),
        };
    });
    sendSuccess(res, ids);
});

// ============================================================
// SAVE A STATUTORY DOCUMENT — POST /api/meetings/documents
// body: { doc_kind, meeting_id?, resolution_id?, director_user_id?, member_user_id? }
//
// The server builds the document's content itself (a snapshot of the
// meeting / resolution exactly as recorded in the database) — the
// browser only says WHICH document to make. The snapshot is saved as
// the document's template_data; the frontend renders it with
// governanceTemplates.js. The document then follows the normal
// documents flow (DRAFT → approve → signatures → stamp → FINAL): the
// chairperson / secretary / director named in it become its required
// signatories.
// ============================================================
const DOC_KINDS = {
    NOTICE:     { type: 'NOTICE_OF_MEETING',    needs: 'meeting',    label: 'Notice', code: 'NOTM' },
    PROXY:      { type: 'PROXY_FORM',           needs: 'meeting',    label: 'Form of Proxy', code: 'PRXY' },
    REGISTER:   { type: 'ATTENDANCE_REGISTER',  needs: 'meeting',    label: 'Register of Attendance', code: 'ATTR' },
    MINUTES:    { type: 'MEETING_MINUTES',      needs: 'meeting',    label: 'Minutes', code: 'MINS' },
    RESOLUTION: { type: 'RESOLUTION',           needs: 'resolution', label: 'Resolution', code: 'RESN' },
    WRITTEN:    { type: 'WRITTEN_RESOLUTION',   needs: 'resolution', label: 'Written Resolution', code: 'WRES' },
    CERTIFIED:  { type: 'CERTIFIED_RESOLUTION', needs: 'resolution', label: 'Certified Copy', code: 'CTC' },
};

const saveStatutoryDocument = asyncHandler(async (req, res) => {
    requireManager(req.user);
    const kind = DOC_KINDS[req.body.doc_kind];
    if (!kind) throw createError.badRequest(`doc_kind must be one of ${Object.keys(DOC_KINDS).join(', ')}.`);
    const db = { query };
    let meeting = null;
    let view = null;
    let resolution = null;
    if (kind.needs === 'resolution') {
        resolution = await resolutionView(db, req.body.resolution_id);
        if (req.body.doc_kind === 'WRITTEN' && resolution.meeting_id) throw createError.badRequest('This resolution was passed at a meeting — use RESOLUTION or CERTIFIED.');
        if (req.body.doc_kind === 'RESOLUTION' && !resolution.meeting_id) throw createError.badRequest('A written resolution uses doc_kind WRITTEN.');
        if (req.body.doc_kind === 'CERTIFIED' && resolution.result !== 'CARRIED') throw createError.conflict('Only a resolution that was passed can be certified.');
        if (resolution.meeting_id) meeting = await loadMeeting(db, resolution.meeting_id);
    } else {
        meeting = await loadMeeting(db, req.body.meeting_id);
        if (meeting.status === 'CANCELLED') throw createError.conflict('This meeting was cancelled.');
        if (req.body.doc_kind === 'PROXY' && meeting.meeting_type === 'BOARD') throw createError.badRequest('Proxy forms are for general meetings only.');
        if (['REGISTER', 'MINUTES'].includes(req.body.doc_kind) && !['IN_PROGRESS', 'CLOSED'].includes(meeting.status)) {
            throw createError.conflict('The register and the minutes are produced once the meeting has been held.');
        }
        if (req.body.doc_kind === 'NOTICE' && meeting.status === 'DRAFT') throw createError.conflict('Issue the notice first.');
    }
    if (meeting) view = await buildMeetingView(db, req.user, meeting);
    const settings = view ? view.settings : await gov.getSettings(db);
    const company = (await query(`SELECT to_jsonb(cs) AS row FROM company_settings cs WHERE id = 1`)).rows[0]?.row || {};
    const statutory = {
        company_name: company.company_name || null, registration_number: company.registration_number || null,
        tin: company.tin || null, registered_office: company.registered_office || null, postal_address: company.postal_address || null,
        company_email: company.company_email || null, company_phone: company.company_phone || null,
    };

    const data = {
        doc_kind: req.body.doc_kind,
        meeting: view ? view.meeting : null,
        attendance: view ? view.attendance : [],
        resolutions: view ? view.resolutions : [],
        tally: view ? view.tally : null,
        notice: view ? view.notice : null,
        settings,
        company: statutory,
        generated_date: new Date().toISOString(),
        prepared_by: `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim(),
    };
    if (meeting) {
        if (meeting.chairperson_user_id) data.chairperson_user_id = meeting.chairperson_user_id;
        data.chairperson_name = meeting.chairperson_name || null;
        if (meeting.secretary_user_id) data.secretary_user_id = meeting.secretary_user_id;
        data.secretary_name = meeting.secretary_name || null;
    }
    // Who signs what
    if (req.body.doc_kind === 'NOTICE') delete data.chairperson_user_id;     // "by order of the board": the secretary
    if (req.body.doc_kind === 'PROXY') { delete data.chairperson_user_id; delete data.secretary_user_id; }
    if (resolution) {
        data.resolution = resolution;
        data.signatories = resolution.signatories || [];
        if (req.body.doc_kind === 'WRITTEN') delete data.chairperson_user_id;
        if (req.body.doc_kind === 'CERTIFIED') {
            delete data.chairperson_user_id;
            if (!req.body.director_user_id) throw createError.badRequest('Choose the director who certifies the copy.');
        }
        if (!resolution.meeting_id) {
            // A written resolution has no meeting: the company secretary
            // (if one is assigned the role) countersigns the record.
            const sec = await query(`
                SELECT u.id, u.first_name || ' ' || u.last_name AS name FROM users u
                JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
                JOIN roles ro ON ro.id = ur.role_id AND ro.name = 'Secretary'
                WHERE u.is_active = TRUE ORDER BY u.id LIMIT 1`);
            if (sec.rows.length) { data.secretary_user_id = sec.rows[0].id; data.secretary_name = sec.rows[0].name; }
        }
    }
    // v1.80.0 — the person generating the document may pick who signs it
    // (defaults: the meeting's chairperson / secretary) …
    const pickSigner = async (key, allowed) => {
        const raw = req.body[`${key}_user_id`];
        if (raw === undefined || raw === null || raw === '') return;
        if (!allowed) throw createError.badRequest(`A ${key} does not sign this document.`);
        const uid = Number(raw);
        const u = await query(`SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id = $1 AND is_active = TRUE`, [uid]);
        if (!u.rows.length) throw createError.badRequest(`The ${key} chosen is not an active user.`);
        if (key === 'director') {
            const isDir = await query(`
                SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
                WHERE ur.user_id = $1 AND ur.revoked_at IS NULL AND ro.name = 'Director'`, [uid]);
            if (!isDir.rows.length) throw createError.badRequest('The person certifying must be an active director.');
        }
        data[`${key}_user_id`] = uid;
        data[`${key}_name`] = u.rows[0].name;
    };
    const k = req.body.doc_kind;
    await pickSigner('chairperson', ['REGISTER', 'MINUTES', 'RESOLUTION'].includes(k));
    await pickSigner('secretary', k !== 'PROXY');
    await pickSigner('director', k === 'CERTIFIED');
    // … and the date the document carries ("Dated this … day of …").
    const docDateDefault = (() => {
        if (k === 'NOTICE') return gov.dateStr(meeting.notice_issued_at) || gov.todayStr();
        if (['REGISTER', 'MINUTES'].includes(k)) return gov.dateStr(meeting.meeting_date);
        if (k === 'RESOLUTION') return gov.dateStr(resolution.passed_on) || gov.dateStr(meeting.meeting_date);
        if (k === 'WRITTEN') return gov.dateStr(resolution.passed_on) || gov.todayStr();
        return gov.todayStr();
    })();
    let docDate = trimOrNull(req.body.document_date) || docDateDefault;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate)) throw createError.badRequest('The document date must be YYYY-MM-DD.');
    if (docDate > gov.todayStr()) throw createError.badRequest('The document date cannot be in the future.');
    if (meeting && k === 'NOTICE' && docDate > gov.dateStr(meeting.meeting_date)) throw createError.badRequest('A notice cannot be dated after the meeting.');
    if (meeting && ['REGISTER', 'MINUTES', 'RESOLUTION'].includes(k) && docDate < gov.dateStr(meeting.meeting_date)) {
        throw createError.badRequest('This document cannot be dated before the meeting was held.');
    }
    if (resolution && k === 'CERTIFIED' && resolution.passed_on && docDate < gov.dateStr(resolution.passed_on)) {
        throw createError.badRequest('A certified copy cannot be dated before the resolution was passed.');
    }
    data.document_date = docDate;

    if (req.body.doc_kind === 'PROXY' && req.body.member_user_id) {
        const mem = (view.attendance || []).find(a => a.user_id === Number(req.body.member_user_id) && a.capacity === 'MEMBER');
        if (!mem) throw createError.badRequest('That person is not a member on this meeting\'s register.');
        data.member = { user_id: mem.user_id, name: mem.name, shares_held: mem.shares_held };
    }

    // Preview: hand back the snapshot without saving anything.
    if (req.body.preview) return sendSuccess(res, { template_data: data, document_type: kind.type });

    const mName = meeting ? meeting.title : null;
    const title = (() => {
        switch (req.body.doc_kind) {
        case 'NOTICE': return `Notice of ${mName} — ${gov.dateStr(meeting.meeting_date)}`;
        case 'PROXY': return `Form of Proxy — ${mName}${data.member ? ` — ${data.member.name}` : ''}`;
        case 'REGISTER': return `Register of Attendance — ${mName} — ${gov.dateStr(meeting.meeting_date)}`;
        case 'MINUTES': return `Minutes of ${mName} — ${gov.dateStr(meeting.meeting_date)}`;
        case 'CERTIFIED': return `Certified copy — ${resolution.resolution_number} — ${resolution.title}`;
        default: return `${KIND_LABEL[resolution.kind]} ${resolution.resolution_number} — ${resolution.title}`;
        }
    })().slice(0, 255);

    const saved = await withTransaction(async (client) => {
        const tpl = await client.query(`SELECT id FROM document_templates WHERE template_type = $1 AND is_active = TRUE ORDER BY id LIMIT 1`, [kind.type]);
        if (!tpl.rows.length) throw createError.conflict(`No active "${kind.type}" template — run the v1.79.0 database update.`);
        const parentId = await getOrCreateCategory(client, {
            module: 'DOCUMENT', name: 'Statutory Records', abbreviation: 'STAT',
            description: 'Notices, registers of attendance, minutes and resolutions of company meetings (v1.79.0).', createdBy: req.user.id,
        });
        const boardish = (meeting && meeting.meeting_type === 'BOARD');
        const catName = resolution ? ['Resolutions', 'RESN', 'Ordinary, special, board and written resolutions, and certified copies for filing.']
            : boardish ? ['Board Meetings', 'BMTG', 'Board meeting notices, registers and minutes.']
                : ['General Meetings', 'GMTG', 'AGM / EGM notices, proxy forms, registers and minutes.'];
        const categoryId = await getOrCreateChildCategory(client, {
            parentId, module: 'DOCUMENT', name: catName[0], abbreviation: catName[1], description: catName[2], createdBy: req.user.id,
        });
        const { referenceId, referenceCode } = await generateReference(client, 'DOC', kind.code, 'DOCUMENT', req.user.id);
        const ins = await client.query(`
            INSERT INTO documents (reference_id, category_id, title, document_type, source, template_id, template_data,
                version, related_record_type, related_record_id, status, created_by)
            VALUES ($1,$2,$3,$4,'SYSTEM_GENERATED',$5,$6,1,$7,$8,'DRAFT',$9) RETURNING id`,
        [referenceId, categoryId, title, kind.type, tpl.rows[0].id, JSON.stringify(data),
            resolution ? 'meeting_resolutions' : 'company_meetings', resolution ? resolution.id : meeting.id, req.user.id]);
        await linkReferenceToRecord(client, referenceId, ins.rows[0].id);
        await logAction(req.user.id, ACTIONS.DOCUMENT_GENERATED, MODULES.DOCUMENTS, {
            ipAddress: req.ip, recordType: 'documents', recordId: ins.rows[0].id,
            newValues: { referenceCode, title, doc_kind: req.body.doc_kind },
            description: `Statutory document generated: ${referenceCode} — ${title}`, client,
        });
        return { document_id: ins.rows[0].id, reference: referenceCode, title, document_type: kind.type, status: 'DRAFT' };
    });
    sendCreated(res, { ...saved, template_data: data }, `${kind.label} saved to Documents (${saved.reference}) as a draft — approve it in Documents to collect the signatures.`);
});

module.exports = {
    getGovernanceSettings, updateGovernanceSettings,
    listMeetings, createMeeting, getMeeting, updateMeeting, refreshRegister,
    addAttendee, removeAttendee, markAttendance, issueNotice, openMeeting, confirmAttendance,
    saveMinutes, closeMeeting, cancelMeeting,
    createMeetingResolution, updateResolution, recordVote, withdrawResolution, markFiled,
    createWrittenResolution, signWrittenResolution, getResolution, listResolutions, myActions,
    documentCategories, saveStatutoryDocument,
};
