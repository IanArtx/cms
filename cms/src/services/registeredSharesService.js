// ============================================================
// EACH SHAREHOLDER'S SHARES REGISTERED WITH URSB (v1.81.0)
//
// Requested: "the registered shares for each shareholder can be recorded
// and the excess also tracked in individual portfolio and generally by
// the administration and treasury".
// Confirmed: entered once from the URSB register (as at a date); after
// that, every allotment whose return of allotment is marked as filed at
// URSB is added automatically. Excess = shares held in the system minus
// shares registered.
//
//   registered = URSB figure as at its date
//              + shares of later allotments whose return was filed
//              + later splits / consolidations (no return of allotment)
//   excess     = shares held now − registered        (> 0: still to be
//                registered with URSB; < 0: URSB shows more than the
//                company's own register — to be checked)
//
// A member with no URSB figure entered yet starts from 0 — every filed
// allotment counts — and is flagged "URSB figure not entered".
//
// v1.84.0 — "covered by the URSB figure" now means: allotted on or
// before the figure's date AND already in the system when the figure was
// entered. An allotment added later (e.g. by the v1.84.0 share-register
// correction, dated back to the contribution) is NOT assumed to be in the
// URSB figure: it counts as registered only once its return is filed.
// Certificates and meeting registers now use the REGISTERED shares
// (registeredAsOf below); the shares allotted inside the company stay the
// basis of ownership, dividends and the books, and the difference is the
// overflow still to be registered.
// The figures are records of what URSB holds; they never change anyone's
// shares, money or the books.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES } = require('./auditService');

let ready = null;
const tableReady = async () => {
    if (ready) return true;
    const r = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'member_registered_shares'`);
    ready = r.rows.length > 0;
    return ready;
};
const assertReady = async () => {
    if (!(await tableReady())) throw createError.badRequest('Registered shares per member need the v1.81.0 database update.');
};

const int = (v) => (v === null || v === undefined ? 0 : parseInt(Math.round(parseFloat(v)), 10));

// One row per member (or just `userId`).
const memberRows = async ({ userId = null } = {}) => {
    await assertReady();
    const params = [];
    let only = '';
    if (userId) { params.push(userId); only = `AND u.id = $1`; }
    const r = await query(`
        WITH members AS (
            SELECT DISTINCT user_id FROM shareholding_registry WHERE effective_to IS NULL AND shares_held > 0
            UNION SELECT user_id FROM member_registered_shares WHERE superseded_at IS NULL
            UNION SELECT user_id FROM share_allotments WHERE status = 'ACTIVE'
        ),
        opening AS (
            SELECT m.user_id, m.id AS opening_id, m.shares AS opening_shares, m.as_at, m.note, m.document_id,
                   m.recorded_at, m.created_seen_at, rb.first_name || ' ' || rb.last_name AS recorded_by_name
            FROM   (SELECT mm.*, (SELECT MIN(x.recorded_at) FROM member_registered_shares x
                                      WHERE x.user_id = mm.user_id) AS created_seen_at
                    FROM member_registered_shares mm) m
            LEFT JOIN users rb ON rb.id = m.recorded_by
            WHERE  m.superseded_at IS NULL
        )
        SELECT u.id AS user_id, u.first_name || ' ' || u.last_name AS name, u.is_active,
               COALESCE(h.shares_held, 0) AS shares_held,
               o.opening_id, o.opening_shares, o.as_at::text AS as_at, o.note, o.document_id,
               o.recorded_at, o.recorded_by_name,
               COALESCE((SELECT SUM(a.shares) FROM share_allotments a
                   WHERE a.user_id = u.id AND a.status = 'ACTIVE'
                   AND NOT (o.as_at IS NOT NULL AND a.allotment_date <= o.as_at AND a.created_at <= o.created_seen_at)
                   AND (a.return_due_date IS NULL OR a.return_filed_at IS NOT NULL)), 0) AS added_since,
               COALESCE((SELECT SUM(a.shares) FROM share_allotments a
                   WHERE a.user_id = u.id AND a.status = 'ACTIVE'
                   AND NOT (o.as_at IS NOT NULL AND a.allotment_date <= o.as_at AND a.created_at <= o.created_seen_at)
                   AND a.return_due_date IS NOT NULL AND a.return_filed_at IS NULL), 0) AS awaiting_filing,
               (SELECT COUNT(*) FROM share_allotments a
                   WHERE a.user_id = u.id AND a.status = 'ACTIVE'
                   AND NOT (o.as_at IS NOT NULL AND a.allotment_date <= o.as_at AND a.created_at <= o.created_seen_at)
                   AND a.return_due_date IS NOT NULL AND a.return_filed_at IS NULL
                   AND a.return_due_date < CURRENT_DATE) AS overdue_returns,
               (SELECT MIN(a.return_due_date) FROM share_allotments a
                   WHERE a.user_id = u.id AND a.status = 'ACTIVE'
                   AND NOT (o.as_at IS NOT NULL AND a.allotment_date <= o.as_at AND a.created_at <= o.created_seen_at)
                   AND a.return_due_date IS NOT NULL AND a.return_filed_at IS NULL)::text AS next_return_due
        FROM   members mm
        JOIN   users u ON u.id = mm.user_id
        LEFT JOIN shareholding_registry h ON h.user_id = u.id AND h.effective_to IS NULL
        LEFT JOIN opening o ON o.user_id = u.id
        WHERE  TRUE ${only}
        ORDER  BY u.first_name, u.last_name`, params);
    return r.rows.map(x => {
        const held = int(x.shares_held);
        const registered = int(x.opening_shares) + int(x.added_since);
        return {
            user_id: x.user_id,
            name: x.name,
            is_active: x.is_active,
            shares_held: held,
            opening_recorded: !!x.opening_id,
            opening: x.opening_id ? {
                shares: int(x.opening_shares), as_at: x.as_at, note: x.note, document_id: x.document_id,
                recorded_at: x.recorded_at, recorded_by_name: x.recorded_by_name,
            } : null,
            added_since: int(x.added_since),
            registered,
            excess: held - registered,
            awaiting_filing: int(x.awaiting_filing),
            overdue_returns: parseInt(x.overdue_returns, 10) || 0,
            next_return_due: x.next_return_due,
        };
    });
};

// The whole company: every member, totals, and the company-level figure
// set under Share capital › Registered values.
const getRegister = async () => {
    const rows = await memberRows();
    const company = await query(`
        SELECT registered_shares FROM share_nominal_history
        WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`).catch(() => ({ rows: [] }));
    const companyRegistered = company.rows[0]?.registered_shares != null ? parseInt(company.rows[0].registered_shares, 10) : null;
    const totals = rows.reduce((t, r) => ({
        held: t.held + r.shares_held,
        registered: t.registered + r.registered,
        excess: t.excess + Math.max(0, r.excess),
        short: t.short + Math.max(0, -r.excess),
        awaiting_filing: t.awaiting_filing + r.awaiting_filing,
        overdue_returns: t.overdue_returns + r.overdue_returns,
        missing_opening: t.missing_opening + (r.opening_recorded ? 0 : 1),
    }), { held: 0, registered: 0, excess: 0, short: 0, awaiting_filing: 0, overdue_returns: 0, missing_opening: 0 });
    return {
        members: rows,
        totals,
        company_registered: companyRegistered,
        // Members' registered shares should add up to the company's registered shares.
        company_difference: companyRegistered == null ? null : totals.registered - companyRegistered,
    };
};

const getMember = async (userId) => {
    const rows = await memberRows({ userId });
    const history = await query(`
        SELECT m.id, m.shares, m.as_at::text AS as_at, m.note, m.document_id, m.recorded_at, m.superseded_at, m.change_reason,
               rb.first_name || ' ' || rb.last_name AS recorded_by_name
        FROM   member_registered_shares m
        LEFT JOIN users rb ON rb.id = m.recorded_by
        WHERE  m.user_id = $1
        ORDER  BY m.recorded_at DESC, m.id DESC`, [userId]);
    const allotments = await query(`
        SELECT a.id, a.allotment_date::text AS allotment_date, a.shares, a.source,
               a.return_due_date::text AS return_due_date, a.return_filed_at::text AS return_filed_at, a.return_reference
        FROM   share_allotments a
        WHERE  a.user_id = $1 AND a.status = 'ACTIVE'
        ORDER  BY a.allotment_date DESC, a.id DESC`, [userId]);
    return {
        ...(rows[0] || { user_id: userId, shares_held: 0, opening_recorded: false, opening: null, added_since: 0, registered: 0, excess: 0, awaiting_filing: 0, overdue_returns: 0 }),
        history: history.rows,
        allotments: allotments.rows,
    };
};

// Enter / correct a member's URSB figure. The previous figure is kept as history.
const setOpening = async (client, { userId, shares, asAt, note, documentId, changeReason, by, ipAddress }) => {
    await assertReady();
    const n = Number(shares);
    if (!Number.isInteger(n) || n < 0) throw createError.badRequest('The registered shares must be a whole number (0 or more).');
    const today = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asAt || '')) || asAt > today) throw createError.badRequest('Give the date the URSB figure is as at (not in the future).');
    const u = await client.query(`SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id = $1`, [userId]);
    if (!u.rows.length) throw createError.notFound('Member not found');
    if (documentId) {
        const d = await client.query(`SELECT 1 FROM documents WHERE id = $1 AND status NOT IN ('DELETED', 'SUPERSEDED')`, [documentId]);
        if (!d.rows.length) throw createError.badRequest('The supporting document was not found.');
    }
    const prev = await client.query(`SELECT id, shares, as_at::text AS as_at FROM member_registered_shares
        WHERE user_id = $1 AND superseded_at IS NULL FOR UPDATE`, [userId]);
    if (prev.rows.length && !String(changeReason || '').trim()) {
        throw createError.badRequest('This member already has a URSB figure — say why it is being changed.');
    }
    if (prev.rows.length) {
        await client.query(`UPDATE member_registered_shares SET superseded_at = NOW(), superseded_by = $2 WHERE id = $1`, [prev.rows[0].id, by]);
    }
    const ins = await client.query(`
        INSERT INTO member_registered_shares (user_id, shares, as_at, note, document_id, change_reason, recorded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [userId, n, asAt, String(note || '').trim() || null, documentId || null, String(changeReason || '').trim() || null, by]);
    await logAction(by, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        ipAddress,
        recordType: 'member_registered_shares',
        recordId: ins.rows[0].id,
        oldValues: prev.rows[0] || null,
        newValues: { user_id: userId, shares: n, as_at: asAt, note: note || null, reason: changeReason || null },
        description: `URSB-registered shares for ${u.rows[0].name}: ${n} as at ${asAt}${prev.rows.length ? ` (was ${prev.rows[0].shares} as at ${prev.rows[0].as_at}; reason: ${changeReason})` : ''}`,
        client,
    });
    return { id: ins.rows[0].id };
};

// ------------------------------------------------------------
// Registered shares of every member AS AT a date (v1.84.0) — for
// certificates and meeting registers. `db` is a client or { query }.
//   URSB figure (if dated on/before the date)
// + allotments not covered by it whose return was filed by the date
// + splits / consolidations (no return) dated by the date.
// Before a member's URSB figure date, the allotments that figure covers
// are counted by their own dates (best estimate of the register then).
// Returns { byUser: Map(user_id -> shares), total, ready }.
// ------------------------------------------------------------
const registeredAsOf = async (db, date = null) => {
    const runner = db || { query };
    if (!(await tableReady())) return { byUser: new Map(), total: 0, ready: false };
    const d = date || new Date().toISOString().slice(0, 10);
    const r = await runner.query(`
        WITH opening AS (
            SELECT m.user_id, m.shares, m.as_at,
                   (SELECT MIN(x.recorded_at) FROM member_registered_shares x WHERE x.user_id = m.user_id) AS created_seen_at
            FROM   member_registered_shares m WHERE m.superseded_at IS NULL
        ),
        people AS (
            SELECT user_id FROM opening UNION SELECT user_id FROM share_allotments WHERE status = 'ACTIVE'
        )
        SELECT p.user_id,
               CASE WHEN o.as_at IS NOT NULL AND o.as_at <= $1::date THEN o.shares ELSE 0 END
             + COALESCE((SELECT SUM(a.shares) FROM share_allotments a
                   WHERE a.user_id = p.user_id AND a.status = 'ACTIVE'
                   AND NOT (o.as_at IS NOT NULL AND a.allotment_date <= o.as_at AND a.created_at <= o.created_seen_at)
                   AND ((a.return_filed_at IS NOT NULL AND a.return_filed_at <= $1::date)
                        OR (a.return_due_date IS NULL AND a.allotment_date <= $1::date))), 0)
             + CASE WHEN o.as_at IS NOT NULL AND o.as_at > $1::date THEN
                   COALESCE((SELECT SUM(a.shares) FROM share_allotments a
                       WHERE a.user_id = p.user_id AND a.status = 'ACTIVE'
                       AND a.allotment_date <= $1::date AND a.allotment_date <= o.as_at
                       AND a.created_at <= o.created_seen_at), 0)
               ELSE 0 END AS registered
        FROM   people p LEFT JOIN opening o ON o.user_id = p.user_id
    `, [d]);
    const byUser = new Map();
    let total = 0;
    for (const x of r.rows) {
        const n = int(x.registered);
        if (n !== 0) { byUser.set(x.user_id, n); total += n; }
    }
    return { byUser, total, ready: true };
};

// The latest date a member's registered shares changed on or before
// `date`: their URSB figure date or the last filed return.
const lastRegistrationDate = async (db, userId, date = null) => {
    const runner = db || { query };
    const d = date || new Date().toISOString().slice(0, 10);
    const r = await runner.query(`
        SELECT GREATEST(
            (SELECT MAX(as_at) FROM member_registered_shares WHERE user_id = $1 AND superseded_at IS NULL AND as_at <= $2::date),
            (SELECT MAX(return_filed_at) FROM share_allotments WHERE user_id = $1 AND status = 'ACTIVE' AND return_filed_at <= $2::date)
        )::text AS d`, [userId, d]);
    return r.rows[0].d || null;
};

module.exports = { tableReady, getRegister, getMember, setOpening, registeredAsOf, lastRegistrationDate };
