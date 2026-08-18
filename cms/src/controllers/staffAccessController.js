// ============================================================
// STAFF ACCESS CONTROLLER (v1.21.0)
//
// The document-access half of the Administrative Officer role
// (see middleware/auth.js's blockFinanceRestricted and the
// "Administrative Officer" role migration for the full picture).
//
// That role sees every non-Financial-category document through the
// ordinary Documents module (documentsController.js's own
// isFinanceDocumentBlocked check handles that side). This file is
// specifically the exception mechanism: an Admin explicitly grants
// one Financial-category document at a time to one specific user —
// the exact same "attach individually, no blanket access" pattern
// already built and proven for the External Audit Portal's
// audit_engagement_documents, just without an "engagement" wrapper,
// since a standing staff relationship has no fixed time period to
// scope against the way an audit does.
//
// Grants are soft-revoked (revoked_at set, row kept) rather than
// deleted, so there's a permanent record of who could see what and
// when — consistent with this system's "corrections are new state,
// not erased history" philosophy used everywhere else (transaction
// reversals, floor-limit history, exchange-rate history).
// ============================================================

const { query } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { sendFileDownload, toKey } = require('../services/storageService');

// ============================================================
// ADMIN — GRANT A DOCUMENT TO A USER
// POST /api/staff-access/grants
// ============================================================
const grantDocument = asyncHandler(async (req, res) => {
    const { document_id, user_id } = req.body;

    const docResult = await query('SELECT id, title FROM documents WHERE id = $1', [document_id]);
    if (docResult.rows.length === 0) throw createError.notFound('Document not found');

    const userResult = await query('SELECT id, first_name, last_name FROM users WHERE id = $1', [user_id]);
    if (userResult.rows.length === 0) throw createError.notFound('User not found');

    const existing = await query(
        `SELECT id, revoked_at FROM staff_document_grants WHERE document_id = $1 AND user_id = $2`,
        [document_id, user_id]
    );

    let grantId;
    if (existing.rows.length > 0) {
        if (existing.rows[0].revoked_at === null) {
            throw createError.conflict('This document is already granted to this user');
        }
        // Re-grant a previously revoked exception rather than insert a
        // second row — UNIQUE (document_id, user_id) means there can
        // only ever be one grant row per pair; its current state
        // (revoked or not) is what actually governs access.
        const reGranted = await query(`
            UPDATE staff_document_grants
            SET    granted_by = $1, granted_at = NOW(), revoked_at = NULL, revoked_by = NULL
            WHERE  id = $2
            RETURNING id
        `, [req.user.id, existing.rows[0].id]);
        grantId = reGranted.rows[0].id;
    } else {
        const created = await query(`
            INSERT INTO staff_document_grants (document_id, user_id, granted_by)
            VALUES ($1, $2, $3)
            RETURNING id
        `, [document_id, user_id, req.user.id]);
        grantId = created.rows[0].id;
    }

    await logAction(req.user.id, ACTIONS.STAFF_DOCUMENT_GRANTED, MODULES.STAFF, {
        ipAddress:   req.ip,
        recordType:  'staff_document_grants',
        recordId:    grantId,
        newValues:   { document_id, user_id },
        description: `Document "${docResult.rows[0].title}" granted to ${userResult.rows[0].first_name} ${userResult.rows[0].last_name}`,
    });

    sendCreated(res, { id: grantId }, 'Document access granted');
});

// ============================================================
// ADMIN — REVOKE A GRANT
// DELETE /api/staff-access/grants/:id
// ============================================================
const revokeGrant = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE staff_document_grants
        SET    revoked_at = NOW(), revoked_by = $1
        WHERE  id = $2 AND revoked_at IS NULL
        RETURNING id, document_id, user_id
    `, [req.user.id, id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Grant not found or already revoked');
    }

    await logAction(req.user.id, ACTIONS.STAFF_DOCUMENT_REVOKED, MODULES.STAFF, {
        ipAddress:   req.ip,
        recordType:  'staff_document_grants',
        recordId:    parseInt(id),
        description: `Document access grant ID ${id} revoked`,
    });

    sendSuccess(res, null, 'Document access revoked');
});

// ============================================================
// ADMIN — LIST GRANTS
// GET /api/staff-access/grants?user_id=&document_id=&include_revoked=
// By default only active (non-revoked) grants are returned — this
// is what the Documents page's "Grant Document Access" modal uses
// to show who currently has access to one specific document.
// Pass include_revoked=true to see the full history for a user or
// document instead (revoked rows are kept, never deleted).
// ============================================================
const listGrants = asyncHandler(async (req, res) => {
    const { user_id, document_id, include_revoked } = req.query;
    const conditions = [];
    const params = [];
    if (user_id)     { params.push(user_id);     conditions.push(`g.user_id = $${params.length}`); }
    if (document_id) { params.push(document_id); conditions.push(`g.document_id = $${params.length}`); }
    if (include_revoked !== 'true') { conditions.push(`g.revoked_at IS NULL`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(`
        SELECT g.id, g.document_id, g.user_id, g.granted_at, g.revoked_at,
               d.title AS document_title,
               u.first_name || ' ' || u.last_name AS user_name,
               u.email AS user_email,
               granter.first_name || ' ' || granter.last_name AS granted_by_name
        FROM   staff_document_grants g
        JOIN   documents d ON d.id = g.document_id
        JOIN   users u     ON u.id = g.user_id
        JOIN   users granter ON granter.id = g.granted_by
        ${where}
        ORDER BY g.granted_at DESC
    `, params);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET MY GRANTED DOCUMENTS
// GET /api/staff-access/my-documents
// Open to any authenticated user — for most roles this simply
// returns an empty list, since grants are the exception mechanism
// specifically for finance-restricted roles.
// ============================================================
const getMyGrantedDocuments = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT d.id, d.title, d.document_type, d.source, d.created_at,
               r.reference_code, r.public_id,
               cat.name AS category_name, cp.full_path AS category_trail,
               g.granted_at
        FROM   staff_document_grants g
        JOIN   documents d          ON d.id = g.document_id
        JOIN   references_registry r ON r.id = d.reference_id
        JOIN   categories cat        ON cat.id = d.category_id
        JOIN   category_paths cp     ON cp.category_id = d.category_id
        WHERE  g.user_id = $1 AND g.revoked_at IS NULL
        ORDER BY g.granted_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// PREVIEW/DOWNLOAD A GRANTED DOCUMENT
// GET /api/staff-access/my-documents/:documentId
// Mirrors documentsController's UPLOADED vs SYSTEM_GENERATED split
// (and auditController's identical pattern for engagement documents)
// — access here is governed entirely by having an active grant, not
// by the ordinary DOCUMENT_VIEW permission.
// ============================================================
const previewGrantedDocument = asyncHandler(async (req, res) => {
    const { documentId } = req.params;

    const grant = await query(
        `SELECT 1 FROM staff_document_grants WHERE document_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [documentId, req.user.id]
    );
    if (grant.rows.length === 0) {
        throw createError.forbidden('This document has not been shared with you');
    }

    const result = await query(
        `SELECT id, title, source, document_type, template_data, file_path, file_name, mime_type
         FROM   documents WHERE id = $1`,
        [documentId]
    );
    if (result.rows.length === 0) throw createError.notFound('Document not found');
    const doc = result.rows[0];

    if (doc.source === 'UPLOADED') {
        return sendFileDownload(res, toKey(doc.file_path), doc.file_name || `document-${doc.id}`);
    }

    if (!doc.template_data) {
        throw createError.badRequest('This document has no content to preview');
    }
    sendSuccess(res, {
        source:        'SYSTEM_GENERATED',
        title:         doc.title,
        document_type: doc.document_type,
        template_data: doc.template_data,
    });
});

module.exports = {
    grantDocument,
    revokeGrant,
    listGrants,
    getMyGrantedDocuments,
    previewGrantedDocument,
};
