// ============================================================
// MONEY APPROVALS (v1.73.0) — held money entries
// Prefix: /api/money-approvals
//
//   GET  /                 list (Treasurer/Admin: everyone's; others: their own)
//   POST /:id/approve      Treasurer or Admin — posts it (runs the original action)
//   POST /:id/reject       Treasurer or Admin refuse (note required);
//                          the person who recorded it may withdraw it
//
// See middleware/holdMoneyEntry.js for how entries get here.
// ============================================================

const { query } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { notify } = require('../services/notificationService');
const { registry, FREE_ROLES } = require('../middleware/holdMoneyEntry');
const { assertNotOwnApproval } = require('../services/approvalGuard');
const moneyApprovalContext = require('../services/moneyApprovalContext');

const isApprover = (req) => (req.user?.roles || []).some(r => FREE_ROLES.includes(r));

// Same shape as middleware/auth.js › authenticate builds for req.user,
// loaded fresh at approval time (so a person who has since lost the
// role or been deactivated can't have entries posted in their name).
const loadUser = async (id) => {
    const r = await query(`
        SELECT u.id, u.uuid, u.email, u.first_name, u.last_name, u.is_active,
               u.two_factor_enabled, u.is_email_verified, u.signature_path,
               COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
               COALESCE(json_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '[]') AS permissions,
               bool_or(mc.id IS NOT NULL) AS has_consented
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r ON r.id = ur.role_id AND r.is_active = TRUE
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p ON p.id = rp.permission_id
        LEFT JOIN member_consents mc ON mc.user_id = u.id
        WHERE u.id = $1
        GROUP BY u.id
    `, [id]);
    return r.rows[0] || null;
};

// Run the original action again, on behalf of the person who recorded it.
const replay = async (entry, approverReq) => {
    const def = registry.get(entry.route_key);
    if (!def) throw createError.badRequest(`This kind of entry (${entry.route_key}) can no longer be posted automatically — refuse it and record it again.`);

    const user = await loadUser(entry.created_by);
    if (!user || !user.is_active) {
        throw createError.badRequest('The person who recorded this entry is no longer active — refuse it and record it again.');
    }

    const req = {
        user: { ...user, sessionId: null },
        params: entry.params || {},
        body: entry.body || {},
        query: entry.query_params || {},
        method: entry.method,
        originalUrl: entry.path,
        ip: approverReq.ip,
        headers: {},
        get: () => undefined,
        heldEntry: { id: entry.id, approvedBy: approverReq.user.id },
    };
    let captured = null;
    let nextErr = null;
    const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { captured = { status: this.statusCode, body: b }; return this; },
        send(b) { captured = { status: this.statusCode, body: b }; return this; },
        end() { captured = captured || { status: this.statusCode, body: null }; return this; },
        set() { return this; },
        setHeader() { return this; },
    };
    const ctx = { approvedBy: approverReq.user.id, heldEntryId: entry.id, postedIds: [] };
    const fn = def.controller.__inner || def.controller;

    await moneyApprovalContext.run(ctx, async () => {
        await fn(req, res, (err) => { if (err) nextErr = err; });
    });

    if (nextErr) throw nextErr;
    if (!captured) throw createError.badRequest('The entry could not be completed (no result was returned).');
    if (captured.status >= 400) {
        throw createError.badRequest(captured.body?.message || 'The entry was refused when it was posted.');
    }
    return { response: captured.body, postedIds: ctx.postedIds };
};

// GET /api/money-approvals?status=PENDING
const listHeld = asyncHandler(async (req, res) => {
    const status = (req.query.status || '').toUpperCase();
    const params = [];
    const where = [];
    if (['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXECUTING'].includes(status)) {
        params.push(status); where.push(`h.status = $${params.length}`);
    }
    if (!isApprover(req)) { params.push(req.user.id); where.push(`h.created_by = $${params.length}`); }
    const r = await query(`
        SELECT h.id, h.route_key, h.label, h.subject, h.account_name, h.amount, h.currency_code, h.note,
               h.status, h.created_by, h.created_at, h.decided_by, h.decided_at, h.decision_note,
               h.last_error, h.last_error_at, h.result_message, h.posted_transaction_ids, h.body,
               cu.first_name || ' ' || cu.last_name AS created_by_name,
               du.first_name || ' ' || du.last_name AS decided_by_name,
               (SELECT array_agg(rr.reference_code ORDER BY t.id)
                FROM transactions t JOIN references_registry rr ON rr.id = t.reference_id
                WHERE t.id = ANY(h.posted_transaction_ids)) AS posted_references
        FROM   held_money_entries h
        JOIN   users cu ON cu.id = h.created_by
        LEFT JOIN users du ON du.id = h.decided_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY (h.status = 'PENDING') DESC, h.created_at DESC
        LIMIT 300
    `, params);
    sendSuccess(res, r.rows, 'Held money entries', 200, { can_approve: isApprover(req) });
});

// POST /api/money-approvals/:id/approve
const approveHeld = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!isApprover(req)) throw createError.forbidden('Only the Treasurer or an Admin can approve money entries.');

    const cur = await query('SELECT * FROM held_money_entries WHERE id = $1', [id]);
    if (!cur.rows.length) throw createError.notFound('Held entry not found');
    assertNotOwnApproval(req, [cur.rows[0].created_by], 'money entry');

    // Claim it, so two approvers clicking at once can't post it twice.
    const claim = await query(`
        UPDATE held_money_entries SET status = 'EXECUTING', decided_by = $1, decided_at = NOW()
        WHERE id = $2 AND status = 'PENDING' RETURNING *
    `, [req.user.id, id]);
    if (!claim.rows.length) throw createError.badRequest('This entry is no longer waiting for approval.');
    const entry = claim.rows[0];

    let result;
    try {
        result = await replay(entry, req);
    } catch (err) {
        await query(`
            UPDATE held_money_entries
            SET status = 'PENDING', decided_by = NULL, decided_at = NULL,
                last_error = $1, last_error_at = NOW()
            WHERE id = $2
        `, [err.message, id]);
        throw createError.badRequest(`Not posted: ${err.message} — the entry is still waiting; you can try again later or refuse it.`);
    }

    await query(`
        UPDATE held_money_entries
        SET status = 'APPROVED', result_message = $1, posted_transaction_ids = $2,
            last_error = NULL
        WHERE id = $3
    `, [result.response?.message || null, result.postedIds, id]);

    await logAction(req.user.id, ACTIONS.TRANSACTION_APPROVED, MODULES.FINANCE, {
        ipAddress: req.ip, recordType: 'held_money_entries', recordId: id,
        newValues: { route: entry.route_key, posted_transaction_ids: result.postedIds },
        description: `Held money entry #${id} (${entry.label}) recorded by user #${entry.created_by} approved and posted`,
    });
    notify({
        userId: entry.created_by, type: 'MONEY_ENTRY_APPROVED',
        title: 'Your money entry was approved',
        body: `${entry.label}${entry.amount ? ` — ${entry.currency_code || ''} ${Number(entry.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : ''} has been posted.`,
        link: '/money-approvals', module: 'FINANCE', recordType: 'held_money_entries', recordId: id,
    });

    sendSuccess(res, {
        id, posted_transaction_ids: result.postedIds, result: result.response?.data ?? null,
    }, `Approved and posted: ${entry.label}. ${result.response?.message || ''}`.trim());
});

// POST /api/money-approvals/:id/reject   body: { note }
const rejectHeld = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const note = (req.body?.note || '').trim();
    const cur = await query('SELECT * FROM held_money_entries WHERE id = $1', [id]);
    if (!cur.rows.length) throw createError.notFound('Held entry not found');
    const entry = cur.rows[0];
    const own = Number(entry.created_by) === Number(req.user.id);
    if (!own && !isApprover(req)) throw createError.forbidden('Only the Treasurer, an Admin or the person who recorded it can do this.');
    if (!own && !note) throw createError.badRequest('Please give a reason for refusing it.');

    const upd = await query(`
        UPDATE held_money_entries
        SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3
        WHERE id = $4 AND status = 'PENDING' RETURNING id
    `, [own ? 'WITHDRAWN' : 'REJECTED', req.user.id, note || null, id]);
    if (!upd.rows.length) throw createError.badRequest('This entry is no longer waiting for approval.');

    await logAction(req.user.id, ACTIONS.TRANSACTION_REJECTED, MODULES.FINANCE, {
        ipAddress: req.ip, recordType: 'held_money_entries', recordId: id,
        description: `Held money entry #${id} (${entry.label}) ${own ? 'withdrawn' : 'refused'}${note ? ` — ${note}` : ''}`,
    });
    if (!own) {
        notify({
            userId: entry.created_by, type: 'MONEY_ENTRY_REJECTED',
            title: 'Your money entry was refused',
            body: `${entry.label}: ${note}`,
            link: '/money-approvals', module: 'FINANCE', recordType: 'held_money_entries', recordId: id,
        });
    }
    sendSuccess(res, null, own ? 'Entry withdrawn — nothing was posted.' : 'Entry refused — nothing was posted.');
});

module.exports = { listHeld, approveHeld, rejectHeld, replay };
