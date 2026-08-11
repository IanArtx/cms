// ============================================================
// DOCUMENTS CONTROLLER
// Handles all document management — uploads, generation
// from templates, versioning, and access control.
//
// HANDLES:
//   - Uploading documents with references and category trails
//   - Generating documents from Handlebars templates
//   - Document versioning — new version links to previous
//   - Access control per document type and role
//   - Linking documents to any record in the system
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const { ensureSignatureSlots, signSlot, getSignatureStatus, notifyPendingSignatories, SIGNABLE_DOCUMENT_TYPES } = require('../services/signatureService');
const { applyStamps, getAppliedStamps } = require('../services/stampService');
const path = require('path');
const fs   = require('fs');

// ============================================================
// FINANCE DOCUMENT GATE (v1.21.0)
// The Administrative Officer role sees this whole module (Events
// too — see routes/documents.js and routes/events.js, which only
// block the Auditor, not this role) because most of what lives
// here — meeting minutes, correspondence, legal/compliance filings —
// is exactly what that role is hired to produce. The one carve-out
// is the "Financial" document category (and any of its
// sub-categories): those stay invisible to this role by default,
// with staff_document_grants (staffAccessController.js) as the one
// explicit, per-document exception an Admin can grant. Every other
// role is unaffected by this check.
// ============================================================
const isFinanceRestrictedStaffRole = (req) =>
    (req.user?.roles || []).includes('Administrative Officer');

const isFinanceCategoryAbbrev = (fullAbbreviation) =>
    !!fullAbbreviation && (fullAbbreviation === 'FIN' || fullAbbreviation.startsWith('FIN-'));

// Used by getDocumentById / downloadDocument, which fetch a single
// document by ID and need to check both the category and, if it's a
// Financial one, whether this specific user has an explicit grant.
const assertDocumentVisible = async (req, documentId, categoryFullAbbreviation) => {
    if (!isFinanceRestrictedStaffRole(req)) return;
    if (!isFinanceCategoryAbbrev(categoryFullAbbreviation)) return;

    const grant = await query(
        `SELECT 1 FROM staff_document_grants WHERE document_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [documentId, req.user.id]
    );
    if (grant.rows.length === 0) {
        throw createError.forbidden(
            'This is a financial document. Ask an Admin to grant you access to this specific document if you need it.'
        );
    }
};

// ============================================================
// UPLOAD A DOCUMENT
// POST /api/documents/upload
// Accepts a file upload and creates a document record.
// ============================================================
const uploadDocument = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw createError.badRequest('No file uploaded');
    }

    const {
        category_id,
        title,
        document_type,
        related_record_type,
        related_record_id,
        notes,
    } = req.body;

    await withTransaction(async (client) => {
        // Generate document reference: DOC-MIN-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.DOCUMENT,
            document_type.substring(0, 6),
            'DOCUMENT',
            req.user.id
        );

        // Create document record
        const result = await client.query(`
            INSERT INTO documents (
                reference_id,
                category_id,
                title,
                document_type,
                source,
                file_path,
                file_name,
                file_size_bytes,
                mime_type,
                version,
                related_record_type,
                related_record_id,
                status,
                created_by
            ) VALUES (
                $1, $2, $3, $4, 'UPLOADED',
                $5, $6, $7, $8, 1,
                $9, $10, 'DRAFT', $11
            )
            RETURNING id
        `, [
            referenceId,
            category_id,
            title.trim(),
            document_type,
            req.file.path,
            req.file.originalname,
            req.file.size,
            req.file.mimetype,
            related_record_type || null,
            related_record_id   || null,
            req.user.id,
        ]);

        const documentId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, documentId);

        await logAction(req.user.id, ACTIONS.DOCUMENT_UPLOADED, MODULES.DOCUMENTS, {
            ipAddress:   req.ip,
            recordType:  'documents',
            recordId:    documentId,
            newValues:   { referenceCode, title, document_type },
            description: `Document uploaded: ${referenceCode} — ${title}`,
            client,
        });

        sendCreated(res, {
            document_id: documentId,
            reference:   referenceCode,
            title,
            document_type,
            file_name:   req.file.originalname,
            file_size:   req.file.size,
            status:      'DRAFT',
        }, `Document uploaded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// GENERATE DOCUMENT FROM TEMPLATE
// POST /api/documents/generate
// Fills a Handlebars template with data and produces a record.
// PDF generation happens when the document is downloaded.
// ============================================================
const generateDocument = asyncHandler(async (req, res) => {
    const {
        template_id,
        category_id,
        title,
        document_type,
        template_data,
        related_record_type,
        related_record_id,
    } = req.body;

    await withTransaction(async (client) => {
        // Get the template
        const templateResult = await client.query(
            'SELECT * FROM document_templates WHERE id = $1 AND is_active = TRUE',
            [template_id]
        );

        if (templateResult.rows.length === 0) {
            throw createError.notFound('Document template not found');
        }

        const template = templateResult.rows[0];

        // Generate document reference
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.DOCUMENT,
            document_type.substring(0, 6),
            'DOCUMENT',
            req.user.id
        );

        // Create document record — no file yet, generated on demand.
        // template_data is persisted (v1.15.0) so this document can be
        // re-rendered later for preview/download — without it, a
        // generated document could only ever be seen once, in the
        // moment right after this request completed.
        const result = await client.query(`
            INSERT INTO documents (
                reference_id,
                category_id,
                title,
                document_type,
                source,
                template_id,
                template_data,
                version,
                related_record_type,
                related_record_id,
                status,
                created_by
            ) VALUES (
                $1, $2, $3, $4, 'SYSTEM_GENERATED',
                $5, $6, 1, $7, $8, 'DRAFT', $9
            )
            RETURNING id
        `, [
            referenceId,
            category_id,
            title.trim(),
            document_type,
            template_id,
            template_data ? JSON.stringify(template_data) : null,
            related_record_type || null,
            related_record_id   || null,
            req.user.id,
        ]);

        const documentId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, documentId);

        await logAction(req.user.id, ACTIONS.DOCUMENT_GENERATED, MODULES.DOCUMENTS, {
            ipAddress:   req.ip,
            recordType:  'documents',
            recordId:    documentId,
            newValues:   { referenceCode, title, template_id },
            description: `Document generated: ${referenceCode} — ${title}`,
            client,
        });

        sendCreated(res, {
            document_id:   documentId,
            reference:     referenceCode,
            title,
            document_type,
            template_name: template.name,
            status:        'DRAFT',
        }, `Document generated. Reference: ${referenceCode}`);
    });
});

// ============================================================
// APPROVE DOCUMENT
// POST /api/documents/:id/approve
// Moves document from DRAFT to FINAL status.
//
// v1.23.0 (Section 4.29): for RESOLUTION/LOAN_AGREEMENT/
// GRANT_AGREEMENT documents, if an Admin has configured
// signature_requirements for that type, this call no longer
// finalises the document directly — instead it opens the required
// signature slots (idempotent — a second approve call on the same
// document just returns the current status rather than erroring) and
// the document only becomes FINAL once every required role signs via
// POST /documents/:id/sign. If nothing is configured for that type,
// behaviour is unchanged from before this feature existed.
// ============================================================
const approveDocument = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const docResult = await query('SELECT id, title, status, document_type FROM documents WHERE id = $1', [id]);
    if (docResult.rows.length === 0) {
        throw createError.notFound('Document not found');
    }
    const doc = docResult.rows[0];

    if (SIGNABLE_DOCUMENT_TYPES.includes(doc.document_type)) {
        // Checked BEFORE ensureSignatureSlots so we can tell "opening
        // for the first time" apart from "already open, Approve was
        // clicked again" — only the former should notify signatories,
        // otherwise every repeat click would re-email everyone.
        const alreadyHadSlots = (await getSignatureStatus('DOCUMENT', doc.id)).length > 0;

        const { hasRequirements, roles } = await withTransaction(async (client) =>
            ensureSignatureSlots(client, 'DOCUMENT', doc.id, doc.document_type)
        );

        if (hasRequirements) {
            if (!alreadyHadSlots) {
                await notifyPendingSignatories('DOCUMENT', doc.id, 'DOCUMENT_SIGNATURE_REQUESTED', {
                    title: `Signature needed: ${doc.title}`,
                    link: '/documents',
                    recordType: 'documents',
                    emailSubject: `Your signature is needed — ${doc.title}`,
                    buildEmailHtml: (recipient) => `<p>Dear ${recipient.first_name},</p>
                        <p>The document <strong>${doc.title}</strong> needs your signature (${recipient.roleNames.join(', ')}).
                        Please sign in to review and sign it.</p>`,
                });
            }

            const signatures = await getSignatureStatus('DOCUMENT', doc.id);
            if (doc.status !== 'DRAFT') {
                return sendSuccess(res, { ...doc, signatures }, 'This document requires multiple signatures — signing slots are open');
            }
            return sendSuccess(res, { ...doc, signatures },
                `Signature slots opened for: ${roles.map(r => r.role_name).join(', ')}. The document becomes final once everyone signs.`);
        }
    }

    const result = await query(`
        UPDATE documents
        SET    status      = 'FINAL',
               approved_by = $1,
               approved_at = NOW(),
               fully_signed = TRUE,
               fully_signed_at = NOW()
        WHERE  id = $2
        AND    status = 'DRAFT'
        RETURNING id, title, status
    `, [req.user.id, id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Document not found or already finalised');
    }

    await logAction(req.user.id, ACTIONS.DOCUMENT_APPROVED, MODULES.DOCUMENTS, {
        ipAddress:   req.ip,
        recordType:  'documents',
        recordId:    parseInt(id),
        description: `Document approved: ID ${id}`,
    });

    // v1.24.0 — apply whichever company stamp(s) are configured for
    // this document type, now that it is fully approved/finalised.
    // No-op (empty array) if nothing is configured for this type.
    await applyStamps('DOCUMENT', doc.id, doc.document_type).catch(() => {});

    sendSuccess(res, result.rows[0], 'Document approved and finalised');
});

// ============================================================
// SIGN A DOCUMENT (v1.23.0, Section 4.29)
// POST /api/documents/:id/sign
// Fills the caller's role's pending signature slot (opened by
// approveDocument above). Once every required role has signed, the
// document flips to FINAL automatically.
// ============================================================
const signDocument = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const docResult = await query('SELECT id, title, status, document_type FROM documents WHERE id = $1', [id]);
    if (docResult.rows.length === 0) throw createError.notFound('Document not found');
    const doc = docResult.rows[0];

    const { allSigned, signerName } = await withTransaction(async (client) =>
        signSlot(client, { targetType: 'DOCUMENT', targetId: doc.id, userId: req.user.id })
    );

    await logAction(req.user.id, ACTIONS.DOCUMENT_SIGNED, MODULES.DOCUMENTS, {
        ipAddress:   req.ip,
        recordType:  'documents',
        recordId:    doc.id,
        description: `${signerName} signed document "${doc.title}"`,
    }).catch(() => {});

    if (allSigned) {
        await query(`
            UPDATE documents
            SET    status = 'FINAL', approved_by = $1, approved_at = NOW(),
                   fully_signed = TRUE, fully_signed_at = NOW()
            WHERE  id = $2
        `, [req.user.id, doc.id]);

        await logAction(req.user.id, ACTIONS.DOCUMENT_FULLY_SIGNED, MODULES.DOCUMENTS, {
            ipAddress:   req.ip,
            recordType:  'documents',
            recordId:    doc.id,
            description: `Document "${doc.title}" fully signed and finalised`,
        }).catch(() => {});

        // v1.24.0 — apply whichever company stamp(s) are configured
        // for this document type now that every required signature
        // is in.
        await applyStamps('DOCUMENT', doc.id, doc.document_type).catch(() => {});
    }

    const signatures = await getSignatureStatus('DOCUMENT', doc.id);
    sendSuccess(res, { fully_signed: allSigned, signatures },
        allSigned ? 'Document fully signed and finalised' : 'Signature recorded');
});

// ============================================================
// GET DOCUMENT SIGNATURE STATUS
// GET /api/documents/:id/signatures
// ============================================================
const getDocumentSignatures = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const signatures = await getSignatureStatus('DOCUMENT', id);
    sendSuccess(res, signatures);
});

// ============================================================
// GET APPLIED STAMPS (v1.24.0, Section 4.30)
// GET /api/documents/:id/stamps
// Whichever company stamp(s) were actually baked onto this document
// once it became fully approved/signed. Empty array for a draft, or
// for a finalised document whose type has no stamp configured.
// ============================================================
const getDocumentStamps = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const stamps = await getAppliedStamps('DOCUMENT', id);
    sendSuccess(res, stamps);
});

// ============================================================
// CREATE NEW VERSION OF A DOCUMENT
// POST /api/documents/:id/new-version
// Supersedes the old version and creates a new one.
// ============================================================
const createNewVersion = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw createError.badRequest('No file uploaded for new version');
    }

    const { id } = req.params;
    const { notes } = req.body;

    await withTransaction(async (client) => {
        // Get the original document
        const original = await client.query(
            'SELECT * FROM documents WHERE id = $1',
            [id]
        );

        if (original.rows.length === 0) {
            throw createError.notFound('Original document not found');
        }

        const orig = original.rows[0];

        // Mark original as superseded
        await client.query(
            `UPDATE documents SET status = 'SUPERSEDED' WHERE id = $1`,
            [id]
        );

        // Generate new reference for new version
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.DOCUMENT,
            orig.document_type.substring(0, 6),
            'DOCUMENT',
            req.user.id
        );

        // Create new version
        const result = await client.query(`
            INSERT INTO documents (
                reference_id,
                category_id,
                title,
                document_type,
                source,
                file_path,
                file_name,
                file_size_bytes,
                mime_type,
                version,
                parent_document_id,
                related_record_type,
                related_record_id,
                status,
                created_by
            ) VALUES (
                $1, $2, $3, $4, 'UPLOADED',
                $5, $6, $7, $8,
                $9, $10, $11, $12,
                'DRAFT', $13
            )
            RETURNING id
        `, [
            referenceId,
            orig.category_id,
            orig.title,
            orig.document_type,
            req.file.path,
            req.file.originalname,
            req.file.size,
            req.file.mimetype,
            orig.version + 1,
            id,
            orig.related_record_type,
            orig.related_record_id,
            req.user.id,
        ]);

        const newDocId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, newDocId);

        sendCreated(res, {
            document_id:      newDocId,
            reference:        referenceCode,
            version:          orig.version + 1,
            supersedes:       id,
        }, `New version created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// ARCHIVE DOCUMENT
// POST /api/documents/:id/archive
// ============================================================
const archiveDocument = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE documents
        SET    status = 'ARCHIVED'
        WHERE  id = $1
        AND    status IN ('DRAFT', 'FINAL')
        RETURNING id, title, status
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Document not found or cannot be archived');
    }

    await logAction(req.user.id, ACTIONS.DOCUMENT_ARCHIVED, MODULES.DOCUMENTS, {
        ipAddress:   req.ip,
        recordType:  'documents',
        recordId:    parseInt(id),
        description: `Document archived: ID ${id}`,
    });

    sendSuccess(res, null, 'Document archived successfully');
});

// ============================================================
// GET ALL DOCUMENTS
// GET /api/documents?document_type=MEETING_MINUTES&status=FINAL
// ============================================================
const getAllDocuments = asyncHandler(async (req, res) => {
    const { document_type, status, related_record_type, related_record_id } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = ['d.status != \'SUPERSEDED\''];
    const params = [];
    let p = 0;

    if (document_type) {
        p++; conditions.push(`d.document_type = $${p}`);
        params.push(document_type.toUpperCase());
    }
    if (status) {
        p++; conditions.push(`d.status = $${p}`);
        params.push(status.toUpperCase());
    }
    if (related_record_type) {
        if (related_record_type === 'COMPANY_ARCHIVE') {
            // The Company Archive view shows both documents uploaded
            // directly into it AND any regular document that's since
            // been archived via the "Archive" action elsewhere in the
            // system — otherwise archiving a document just makes it
            // vanish from the main list without ever landing anywhere
            // the user can find it again.
            p++; conditions.push(`(d.related_record_type = $${p} OR d.status = 'ARCHIVED')`);
            params.push(related_record_type);
        } else {
            p++; conditions.push(`d.related_record_type = $${p}`);
            params.push(related_record_type);
        }
    }
    if (related_record_id) {
        p++; conditions.push(`d.related_record_id = $${p}`);
        params.push(related_record_id);
    }

    // Finance-restricted staff (Administrative Officer): hide Financial-
    // category documents (and sub-categories) unless individually
    // granted via staff_document_grants. Joined against category_paths'
    // full_abbreviation, which is already joined into this query below.
    if (isFinanceRestrictedStaffRole(req)) {
        p++; conditions.push(`(
            NOT (cp.full_abbreviation = 'FIN' OR cp.full_abbreviation LIKE 'FIN-%')
            OR d.id IN (SELECT document_id FROM staff_document_grants WHERE user_id = $${p} AND revoked_at IS NULL)
        )`);
        params.push(req.user.id);
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    const countResult = await query(`
        SELECT COUNT(*) AS total
        FROM   documents d
        JOIN   categories cat    ON cat.id = d.category_id
        JOIN   category_paths cp ON cp.category_id = d.category_id
        ${where}
    `, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            d.id,
            d.title,
            d.document_type,
            d.source,
            d.file_name,
            d.file_size_bytes,
            d.version,
            d.status,
            d.fully_signed,
            d.created_at,
            d.related_record_type,
            d.related_record_id,
            r.reference_code,
            r.public_id,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name
        FROM  documents d
        JOIN  references_registry r ON r.id  = d.reference_id
        JOIN  categories cat        ON cat.id = d.category_id
        JOIN  category_paths cp     ON cp.category_id = d.category_id
        JOIN  users u               ON u.id  = d.created_by
        LEFT JOIN users approver    ON approver.id = d.approved_by
        ${where}
        ORDER BY d.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE DOCUMENT
// GET /api/documents/:id
// ============================================================
const getDocumentById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            d.*,
            r.reference_code,
            r.public_id,
            cat.name             AS category_name,
            cp.full_path         AS category_trail,
            cp.full_abbreviation AS category_full_abbreviation,
            u.first_name  || ' ' || u.last_name AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name,
            -- Version history
            (
                SELECT json_agg(v_data ORDER BY v_data.version ASC)
                FROM (
                    SELECT
                        dv.id, dv.version, dv.status,
                        dv.created_at, dv.file_name,
                        rv.reference_code AS version_reference
                    FROM documents dv
                    JOIN references_registry rv ON rv.id = dv.reference_id
                    WHERE dv.parent_document_id = d.id
                    OR    dv.id = d.parent_document_id
                ) v_data
            ) AS version_history
        FROM  documents d
        JOIN  references_registry r ON r.id  = d.reference_id
        JOIN  categories cat        ON cat.id = d.category_id
        JOIN  category_paths cp     ON cp.category_id = d.category_id
        JOIN  users u               ON u.id  = d.created_by
        LEFT JOIN users approver    ON approver.id = d.approved_by
        WHERE d.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Document not found');
    }

    await assertDocumentVisible(req, id, result.rows[0].category_full_abbreviation);

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// DOWNLOAD / PREVIEW A DOCUMENT
// GET /api/documents/:id/download
//
// UPLOADED documents: streams the real file straight from disk.
// SYSTEM_GENERATED documents have no file on disk — they're
// rendered on demand in the browser (same client-side template
// function used at generation time), so this returns the saved
// template_data as JSON instead of a binary stream. The frontend
// tells the two apart by response content-type.
// ============================================================
const downloadDocument = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(
        `SELECT d.id, d.title, d.source, d.document_type, d.template_data,
                d.file_path, d.file_name, d.mime_type,
                cp.full_abbreviation AS category_full_abbreviation
         FROM   documents d
         JOIN   category_paths cp ON cp.category_id = d.category_id
         WHERE  d.id = $1`,
        [id]
    );

    if (result.rows.length === 0) {
        throw createError.notFound('Document not found');
    }
    const doc = result.rows[0];

    await assertDocumentVisible(req, id, doc.category_full_abbreviation);

    if (doc.source === 'UPLOADED') {
        if (!doc.file_path || !fs.existsSync(doc.file_path)) {
            throw createError.notFound(
                'The uploaded file could not be found on the server. It may have been moved or deleted outside the app.'
            );
        }
        return res.download(path.resolve(doc.file_path), doc.file_name || `document-${doc.id}`);
    }

    // SYSTEM_GENERATED
    if (!doc.template_data) {
        throw createError.badRequest(
            'This document was generated before template data was saved and cannot be reconstructed. ' +
            'Only documents generated after this feature was added can be previewed or downloaded.'
        );
    }

    sendSuccess(res, {
        source:        'SYSTEM_GENERATED',
        document_type: doc.document_type,
        title:         doc.title,
        template_data: doc.template_data,
    });
});

// ============================================================
// GET ALL DOCUMENT TEMPLATES
// GET /api/documents/templates
// ============================================================
const getTemplates = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, name, template_type, description, version
        FROM   document_templates
        WHERE  is_active = TRUE
        ORDER  BY name
    `);
    sendSuccess(res, result.rows);
});

// ============================================================
// CREATE DOCUMENT TEMPLATE (Admin only)
// POST /api/documents/templates
// ============================================================
const createTemplate = asyncHandler(async (req, res) => {
    const { name, template_type, description, template_body } = req.body;

    const result = await query(`
        INSERT INTO document_templates
            (name, template_type, description, template_body, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, template_type, version
    `, [name.trim(), template_type, description || null, template_body, req.user.id]);

    sendCreated(res, result.rows[0], 'Template created successfully');
});

module.exports = {
    uploadDocument,
    generateDocument,
    approveDocument,
    signDocument,
    getDocumentSignatures,
    getDocumentStamps,
    createNewVersion,
    archiveDocument,
    getAllDocuments,
    getDocumentById,
    downloadDocument,
    getTemplates,
    createTemplate,
};