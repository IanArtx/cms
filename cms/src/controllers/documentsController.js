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
const documentLinks = require('../services/documentLinksService'); // v1.78.0
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const {
    ensureSignatureSlots, ensurePersonSignatureSlots, signSlot, getSignatureStatus, notifyPendingSignatories,
    getMyPendingSignatures: getMyPendingSignaturesService, SIGNABLE_DOCUMENT_TYPES,
} = require('../services/signatureService');

// ============================================================
// PERSON-SPECIFIC SIGNATORY TEMPLATE TYPES (v1.45.0, Section 33.8)
// Meeting Minutes, Meeting Agenda, and Resolutions let the person
// generating the document pick a Chairperson/Secretary from a
// dropdown of system users (stored as `${field}_user_id` +
// `${field}_name` in template_data) or just type a free-text name
// (stored as a plain string under the same key as before this
// version — no `_user_id` companion). Only the dropdown-selected
// case creates a required signature slot: a free-text name is purely
// cosmetic on the printed document and never blocks it from being
// finalised. See extractPersonSignatories() below.
// ============================================================
// v1.79.0 — the statutory meeting documents join the list: the notice
// (signed by the secretary "by order of the board"), the register of
// attendance (chairperson + secretary certify it), and the certified
// true copy of a resolution (secretary + a director).
const PERSON_SIGNATORY_DOCUMENT_TYPES = ['MEETING_MINUTES', 'MEETING_AGENDA', 'RESOLUTION',
    'NOTICE_OF_MEETING', 'ATTENDANCE_REGISTER', 'CERTIFIED_RESOLUTION'];
const PERSON_SIGNATORY_FIELDS = [
    { key: 'chairperson', positionTitle: 'Chairman' },
    { key: 'secretary',   positionTitle: 'Secretary' },
    { key: 'director',    positionTitle: 'Director' },   // v1.79.0 — certified copies
];

const extractPersonSignatories = (documentType, templateData) => {
    if (!PERSON_SIGNATORY_DOCUMENT_TYPES.includes(documentType) || !templateData) return [];
    return PERSON_SIGNATORY_FIELDS
        .map(({ key, positionTitle }) => {
            const userId = parseInt(templateData[`${key}_user_id`], 10);
            return Number.isInteger(userId) ? { userId, positionTitle } : null;
        })
        .filter(Boolean);
};
const { applyStamps, getAppliedStamps } = require('../services/stampService');
const { uploadBuffer, generateKey, sendFileDownload, toKey } = require('../services/storageService');
const { assertNotOwnRecord } = require('../services/approvalGuard'); // v1.72.0

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
// PERSONAL DOCUMENTS (v1.67.0)
// A document with owner_user_id set (today: a Share Purchase Receipt)
// belongs to ONE member. Only that member and Treasury may open it —
// holding DOCUMENT_VIEW is not enough, since that permission is held
// by roles (Secretary, Directors) who should never browse other
// members' personal receipts.
// ============================================================
// v1.81.0 — the kinds of Company Archive document (kept on documents.archive_type)
const ARCHIVE_TYPES = ['REGISTRATION', 'TAX_FILING', 'MOU', 'ACT', 'LICENSE', 'COMPLIANCE', 'LEGAL', 'OTHER'];
const TREASURY_ROLES = ['Treasurer', 'Assistant Treasurer', 'Admin'];
const isTreasury = (req) => (req.user.roles || []).some(r => TREASURY_ROLES.includes(r));

const assertPersonalDocumentAccess = (req, ownerUserId) => {
    if (ownerUserId === null || ownerUserId === undefined) return;
    if (ownerUserId === req.user.id || isTreasury(req)) return;
    throw createError.forbidden('This is a personal document. Only its owner and Treasury can open it.');
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

    // v1.29.1 — file bytes go to storageService (R2 in production)
    // before the DB row is created, same as every other upload in this
    // system now. The key (not a raw disk path) is what's stored.
    const key = generateKey('documents', req.file.originalname);
    await uploadBuffer(req.file.buffer, key, req.file.mimetype);

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
            key,
            req.file.originalname,
            req.file.size,
            req.file.mimetype,
            related_record_type || null,
            related_record_id   || null,
            req.user.id,
        ]);

        const documentId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, documentId);

        // v1.81.0 — the archive type chosen when uploading into the Company
        // Archive (registration, tax filing, licence …) is now kept.
        if (related_record_type === 'COMPANY_ARCHIVE' && (await archiveColumnsReady())) {
            const at = ARCHIVE_TYPES.includes(String(req.body.archive_type || '').toUpperCase())
                ? String(req.body.archive_type).toUpperCase() : 'OTHER';
            await client.query(`UPDATE documents SET archive_type = $1, archived_at = NOW(), archived_by = $2 WHERE id = $3`,
                [at, req.user.id, documentId]);
        }

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
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'documents', req.params.id, ['created_by', 'owner_user_id'], 'document');
    const { id } = req.params;

    const docResult = await query('SELECT id, title, status, document_type, template_data FROM documents WHERE id = $1', [id]);
    if (docResult.rows.length === 0) {
        throw createError.notFound('Document not found');
    }
    const doc = docResult.rows[0];

    // v1.45.0 — a document can need signatures for either or both of
    // two independent reasons: role-based requirements configured in
    // Settings -> Signatories (SIGNABLE_DOCUMENT_TYPES), and/or a
    // specific named Chairman/Secretary picked when the document was
    // generated (personSignatories). Both open PENDING slots on the
    // same target and the document only becomes FINAL once every slot
    // of either kind is signed.
    const personSignatories = extractPersonSignatories(doc.document_type, doc.template_data);
    const isRoleSignable = SIGNABLE_DOCUMENT_TYPES.includes(doc.document_type);

    if (isRoleSignable || personSignatories.length > 0) {
        // Checked BEFORE opening slots so we can tell "opening for the
        // first time" apart from "already open, Approve was clicked
        // again" — only the former should notify signatories,
        // otherwise every repeat click would re-email everyone.
        const alreadyHadSlots = (await getSignatureStatus('DOCUMENT', doc.id)).length > 0;

        const { hasRequirements, roles } = await withTransaction(async (client) => {
            const roleResult = isRoleSignable
                ? await ensureSignatureSlots(client, 'DOCUMENT', doc.id, doc.document_type)
                : { hasRequirements: false, roles: [] };

            if (personSignatories.length > 0) {
                await ensurePersonSignatureSlots(client, 'DOCUMENT', doc.id, personSignatories);
            }

            return roleResult;
        });

        const hasAnyRequirements = hasRequirements || personSignatories.length > 0;

        if (hasAnyRequirements) {
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
            const labels = [
                ...roles.map(r => r.role_name),
                ...personSignatories.map(p => p.positionTitle),
            ];
            return sendSuccess(res, { ...doc, signatures },
                `Signature slots opened for: ${labels.join(', ')}. The document becomes final once everyone signs.`);
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

    // v1.29.1 — same storageService pattern as the initial upload
    const newVersionKey = generateKey('documents', req.file.originalname);
    await uploadBuffer(req.file.buffer, newVersionKey, req.file.mimetype);

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
            newVersionKey,
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
    // v1.81.0 — remember what the document was (Draft / Final) so it can
    // go back to exactly that if it is taken out of the archive later, and
    // keep the archive type (optional, body.archive_type).
    const ready = await archiveColumnsReady();
    const archiveType = ARCHIVE_TYPES.includes(String(req.body?.archive_type || '').toUpperCase())
        ? String(req.body.archive_type).toUpperCase() : null;

    const result = await query(ready ? `
        UPDATE documents
        SET    archived_from_status = status,
               status = 'ARCHIVED',
               archived_at = NOW(),
               archived_by = $2,
               archive_type = COALESCE($3, archive_type, 'OTHER')
        WHERE  id = $1
        AND    status IN ('DRAFT', 'FINAL')
        RETURNING id, title, status, archived_from_status
    ` : `
        UPDATE documents
        SET    status = 'ARCHIVED'
        WHERE  id = $1
        AND    status IN ('DRAFT', 'FINAL')
        RETURNING id, title, status
    `, ready ? [id, req.user.id, archiveType] : [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Document not found or cannot be archived');
    }

    await logAction(req.user.id, ACTIONS.DOCUMENT_ARCHIVED, MODULES.DOCUMENTS, {
        ipAddress:   req.ip,
        recordType:  'documents',
        recordId:    parseInt(id),
        newValues:   { status: 'ARCHIVED', was: result.rows[0].archived_from_status || null, archive_type: archiveType },
        description: `Document archived: ID ${id} (${result.rows[0].title})`,
    });

    sendSuccess(res, null, 'Document archived successfully');
});

// ============================================================
// TAKE A DOCUMENT OUT OF THE ARCHIVE (v1.81.0)
// POST /api/documents/:id/unarchive  { reason }
//
// Requested: "documents in archives can be removed and put among the
// regular documents". Confirmed: it goes back to what it was before —
// Draft or Final as it was when archived; a document uploaded straight
// into the archive becomes Final (unless it is still waiting for
// signatures, then it stays a Draft). A reason is required and logged.
// Same permission as archiving (DOCUMENT_ARCHIVE).
// ============================================================
const unarchiveDocument = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) throw createError.badRequest('Give a short reason for taking this document out of the archive.');
    if (!(await archiveColumnsReady())) throw createError.badRequest('Taking documents out of the archive needs the v1.81.0 database update.');

    const out = await withTransaction(async (client) => {
        const r = await client.query(`
            SELECT id, title, status, related_record_type, archived_from_status, approved_at, fully_signed
            FROM documents WHERE id = $1 AND status NOT IN ('DELETED', 'SUPERSEDED') FOR UPDATE`, [id]);
        if (!r.rows.length) throw createError.notFound('Document not found');
        const d = r.rows[0];
        const inArchive = d.status === 'ARCHIVED' || d.related_record_type === 'COMPANY_ARCHIVE';
        if (!inArchive) throw createError.badRequest('This document is not in the archive.');

        let next = d.status;
        if (d.status === 'ARCHIVED') {
            next = d.archived_from_status || ((d.approved_at || d.fully_signed) ? 'FINAL' : 'DRAFT');
        } else if (d.status === 'DRAFT') {
            const pend = await client.query(`SELECT 1 FROM document_signatures
                WHERE target_type = 'DOCUMENT' AND target_id = $1 AND status = 'PENDING' LIMIT 1`, [id]);
            if (!pend.rows.length) next = 'FINAL';
        }
        await client.query(`
            UPDATE documents
            SET    status = $2,
                   related_record_type = CASE WHEN related_record_type = 'COMPANY_ARCHIVE' THEN NULL ELSE related_record_type END,
                   related_record_id   = CASE WHEN related_record_type = 'COMPANY_ARCHIVE' THEN NULL ELSE related_record_id END,
                   archived_from_status = NULL,
                   archived_at = NULL,
                   archived_by = NULL,
                   unarchived_at = NOW(),
                   unarchived_by = $3,
                   unarchive_reason = $4
            WHERE  id = $1`, [id, next, req.user.id, reason]);
        await logAction(req.user.id, ACTIONS.DOCUMENT_UNARCHIVED, MODULES.DOCUMENTS, {
            ipAddress:   req.ip,
            recordType:  'documents',
            recordId:    parseInt(id),
            oldValues:   { status: d.status, in_company_archive: d.related_record_type === 'COMPANY_ARCHIVE' },
            newValues:   { status: next, reason },
            description: `Document taken out of the archive: ID ${id} (${d.title}) — back to ${next}. Reason: ${reason}`,
            client,
        });
        return { id: parseInt(id), status: next };
    });
    sendSuccess(res, out, `Taken out of the archive — the document is ${out.status === 'FINAL' ? 'Final' : 'a Draft'} again and back among the regular documents.`);
});

// ============================================================
// DELETE (REMOVE FROM ARCHIVE) DOCUMENT (v1.46.0)
// DELETE /api/documents/:id
//
// Requested directly: there was no way to remove something from the
// Company Archive once it landed there — archiveDocument (above) is
// a one-way DRAFT/FINAL -> ARCHIVED move with no counterpart. This
// adds the missing "take it back out" action.
//
// Eligibility deliberately mirrors getAllDocuments' own "is this in
// the Company Archive view" condition, not just `status = 'ARCHIVED'`
// on its own — a document uploaded directly INTO the archive
// (UploadModal's isArchive flag, related_record_type =
// 'COMPANY_ARCHIVE') starts life as an ordinary DRAFT/FINAL document
// and never goes through the separate Archive action at all, so
// requiring status = 'ARCHIVED' first would make most archive uploads
// permanently undeletable. Either condition being true means "this is
// something currently sitting in the archive," which is exactly what
// was asked to be removable.
//
// This is a SOFT removal, same pattern as archiveDocument itself —
// the row is never actually deleted from the database. A real
// DELETE FROM documents would either be blocked outright (grants,
// grant_conditions, loans_received/given, staff_document_grants,
// audit_engagement_documents, report_log all hold real foreign keys
// into documents.id with no ON DELETE clause) or, worse, silently
// orphan document_signatures/document_stamps_applied history (those
// two link to documents via a polymorphic target_type/target_id
// pair, not an enforced FK, so a hard delete wouldn't even error —
// it would just quietly corrupt the audit trail of who signed/
// stamped a now-vanished document). Flipping status to DELETED and
// excluding it from every list view (getAllDocuments, same as the
// existing SUPERSEDED exclusion) gets the same practical outcome —
// gone from the archive, gone from the general list — with none of
// that risk, and matches this codebase's own established convention
// of soft-deactivating referenced records rather than hard-deleting
// them (see e.g. users.is_active, company_stamps.is_active).
// ============================================================
const deleteDocument = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE documents
        SET    status = 'DELETED'
        WHERE  id = $1
        AND    (status = 'ARCHIVED' OR related_record_type = 'COMPANY_ARCHIVE')
        AND    status != 'DELETED'
        RETURNING id, title, status
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest(
            'Document not found or not in the archive — only a document currently in the Company Archive (or archived elsewhere) can be removed.'
        );
    }

    await logAction(req.user.id, ACTIONS.DOCUMENT_DELETED, MODULES.DOCUMENTS, {
        ipAddress:   req.ip,
        recordType:  'documents',
        recordId:    parseInt(id),
        description: `Document removed from archive: ID ${id} (${result.rows[0].title})`,
    });

    sendSuccess(res, null, 'Document permanently removed from the archive');
});

// ============================================================
// GET MY PENDING SIGNATURES (v1.44.0, Section 4.29)
// GET /api/documents/pending-signatures
// Everything currently awaiting the caller's own signature, spanning
// both regular documents and share-certificate signing rounds — see
// signatureService.getMyPendingSignatures for the query itself.
// Registered before GET /:id in routes/documents.js — "pending-
// signatures" would otherwise be swallowed as an :id value.
// ============================================================
const getMyPendingSignatures = asyncHandler(async (req, res) => {
    const items = await getMyPendingSignaturesService(req.user.id);
    sendSuccess(res, items);
});

// ============================================================
// GET MY DOCUMENTS (v1.65.0)
// GET /api/documents/mine
// Every document personally about the caller — for now, just their
// own Share Purchase Receipts (documents with related_record_type
// 'shareholder_contributions' whose contribution belongs to them; see
// transactionsController.issueSharePurchaseReceipt). Deliberately a
// SEPARATE, narrower endpoint from GET / (getAllDocuments) rather
// than a related_record_id filter a caller could set to someone
// else's — that one is gated behind DOCUMENT_VIEW-style permissions a
// plain Shareholder doesn't hold; this one is open to any
// authenticated user, but only ever returns rows this specific join
// proves belong to them. Registered before GET /:id in
// routes/documents.js for the same reason pending-signatures is.
// ============================================================
const getMyDocuments = asyncHandler(async (req, res) => {
    const { document_type } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    // v1.67.0 — ownership is now explicit (documents.owner_user_id),
    // not inferred through a join to shareholder_contributions.
    // v1.69.0 — plus company notices addressed to every shareholder
    // (documents.audience = 'ALL_SHAREHOLDERS', e.g. the auto-generated
    // notice of a share value change), for anyone on the register.
    const conditions = [
        `d.status NOT IN ('SUPERSEDED', 'DELETED')`,
        // v1.70.0 — plus notices to EVERY member (audience 'ALL_MEMBERS',
        // e.g. a change of the company's withholding tax agent status).
        `(d.owner_user_id = $1 OR d.audience = 'ALL_MEMBERS' OR (d.audience = 'ALL_SHAREHOLDERS' AND EXISTS (
            SELECT 1 FROM shareholding_registry sr WHERE sr.user_id = $1 AND sr.effective_to IS NULL)))`,
    ];
    const params = [req.user.id];
    let p = 1;

    if (document_type) {
        p++; conditions.push(`d.document_type = $${p}`);
        params.push(document_type.toUpperCase());
    }
    const where = 'WHERE ' + conditions.join(' AND ');

    const countResult = await query(`
        SELECT COUNT(*) AS total
        FROM   documents d
        ${where}
    `, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            d.id, d.title, d.document_type, d.source, d.template_data,
            d.version, d.status, d.fully_signed, d.created_at,
            d.related_record_type, d.related_record_id, d.audience,
            r.reference_code, r.public_id,
            cat.name AS category_name, cp.full_path AS category_trail
        FROM   documents d
        JOIN   references_registry r ON r.id = d.reference_id
        JOIN   categories cat        ON cat.id = d.category_id
        LEFT JOIN category_paths cp  ON cp.category_id = d.category_id
        ${where}
        ORDER BY d.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SHARE PURCHASE RECEIPTS — Treasury view (v1.67.0)
// GET /api/documents/share-receipts?month=YYYY-MM&user_id=
// Every member's Share Purchase Receipt, newest contribution first,
// each row carrying its contribution month (YYYY-MM) so the page can
// group them by month. Treasury only (Treasurer / Assistant Treasurer
// / Admin — enforced in routes/documents.js). Returns template_data
// directly, like GET /mine, so preview/print needs no second call.
// ============================================================
const getShareReceipts = asyncHandler(async (req, res) => {
    const { month, user_id } = req.query;
    const conditions = [
        `d.status NOT IN ('SUPERSEDED', 'DELETED')`,
        `d.owner_user_id IS NOT NULL`,
        `d.template_data ->> 'receipt_kind' = 'SHARE_PURCHASE'`,
    ];
    const params = [];
    if (month) {
        params.push(month);
        conditions.push(`to_char(COALESCE(sc.contribution_date, d.created_at::date), 'YYYY-MM') = $${params.length}`);
    }
    if (user_id) {
        params.push(parseInt(user_id));
        conditions.push(`d.owner_user_id = $${params.length}`);
    }

    const result = await query(`
        SELECT
            d.id, d.title, d.document_type, d.source, d.template_data,
            d.status, d.fully_signed, d.created_at,
            d.related_record_type, d.related_record_id, d.owner_user_id,
            r.reference_code, r.public_id,
            o.first_name || ' ' || o.last_name AS owner_name,
            COALESCE(sc.contribution_date, d.created_at::date)::text AS contribution_date,
            to_char(COALESCE(sc.contribution_date, d.created_at::date), 'YYYY-MM') AS month
        FROM   documents d
        JOIN   references_registry r ON r.id = d.reference_id
        JOIN   users o               ON o.id = d.owner_user_id
        LEFT JOIN shareholder_contributions sc
               ON d.related_record_type = 'shareholder_contributions' AND sc.id = d.related_record_id
        WHERE  ${conditions.join(' AND ')}
        ORDER  BY COALESCE(sc.contribution_date, d.created_at::date) DESC, d.id DESC
        LIMIT  1000
    `, params);

    sendSuccess(res, result.rows);
});

// ============================================================
// WHO MAY SEE WHICH DOCUMENT IN A LIST (shared, v1.81.0)
// Appends the always-on visibility rules to `conditions` / `params` and
// returns the new parameter count. Used by GET /documents and by the
// category tiles (GET /documents/category-summary), so a tile's count is
// always exactly what that person will find when they open it. Expects
// the query to join `category_paths cp` on d.category_id.
// ============================================================
const appendVisibility = (req, conditions, params) => {
    let p = params.length;
    // v1.46.0 — DELETED (soft-removed) and SUPERSEDED versions never show.
    conditions.push(`d.status NOT IN ('SUPERSEDED', 'DELETED')`);
    // v1.67.0 — personal documents (a member's own Share Purchase
    // Receipts) never appear in the shared list; they live in
    // GET /mine (owner) and GET /share-receipts (Treasury) only.
    conditions.push('d.owner_user_id IS NULL');
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

    // v1.44.0 — a document with any still-OPEN signature slot (i.e.
    // signature_requirements were configured for its type and at
    // least one required role hasn't signed yet) is kept out of the
    // general list for anyone except: its own creator, an Admin, or
    // someone currently holding one of the still-pending required
    // roles. It becomes visible to everyone the moment every required
    // signature is in — same as a document whose type never had a
    // signature requirement configured, which was never affected by
    // this at all (the NOT EXISTS branch below covers both that case
    // and the "already fully signed" case identically).
    {
        const myRoleNames = req.user.roles || [];
        const isAdmin = myRoleNames.includes('Admin');
        p++; const meParam = p; params.push(req.user.id);
        p++; const adminParam = p; params.push(isAdmin);
        p++; const rolesParam = p; params.push(myRoleNames);
        conditions.push(`(
            NOT EXISTS (
                SELECT 1 FROM document_signatures dsv
                WHERE dsv.target_type = 'DOCUMENT' AND dsv.target_id = d.id AND dsv.status = 'PENDING'
            )
            OR d.created_by = $${meParam}
            OR $${adminParam}::boolean
            OR EXISTS (
                SELECT 1 FROM document_signatures dsv2
                JOIN roles rv2 ON rv2.id = dsv2.required_role_id
                WHERE dsv2.target_type = 'DOCUMENT' AND dsv2.target_id = d.id AND dsv2.status = 'PENDING'
                AND rv2.name = ANY($${rolesParam}::text[])
            )
            -- v1.81.0 — or someone asked to sign by name (a person slot)
            OR EXISTS (
                SELECT 1 FROM document_signatures dsv3
                WHERE dsv3.target_type = 'DOCUMENT' AND dsv3.target_id = d.id AND dsv3.status = 'PENDING'
                AND dsv3.required_user_id = $${meParam}
            )
        )`);
    }
    return p;
};

// v1.81.0 — the archive columns exist once migration v1.81.0 has run.
let archiveColsReady = false;
const archiveColumnsReady = async () => {
    if (archiveColsReady) return true;
    const r = await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'archived_from_status'`);
    archiveColsReady = r.rows.length > 0;
    return archiveColsReady;
};

// ============================================================
// CATEGORY TILES (v1.81.0)
// GET /api/documents/category-summary
// Every document category with how many documents the caller can see in
// it (and in its sub-categories), the latest one added, and how many are
// in the Company Archive. Uses exactly the list's visibility rules.
// Archived documents are counted in the archive, not in a category.
// ============================================================
const getCategorySummary = asyncHandler(async (req, res) => {
    const conditions = [];
    const params = [];
    appendVisibility(req, conditions, params);
    const where = conditions.join(' AND ');
    const live = `d.status <> 'ARCHIVED' AND COALESCE(d.related_record_type, '') <> 'COMPANY_ARCHIVE'`;

    const counts = await query(`
        SELECT d.category_id, COUNT(*)::int AS n, MAX(d.created_at) AS last_added,
               COUNT(*) FILTER (WHERE d.status = 'DRAFT')::int AS drafts
        FROM   documents d
        JOIN   category_paths cp ON cp.category_id = d.category_id
        WHERE  ${where} AND ${live}
        GROUP  BY d.category_id`, params);
    const archived = await query(`
        SELECT COUNT(*)::int AS n
        FROM   documents d
        JOIN   category_paths cp ON cp.category_id = d.category_id
        WHERE  ${where} AND NOT (${live})`, params);
    const cats = await query(`
        SELECT c.id, c.parent_id, c.name, c.abbreviation, c.description,
               cp.full_path, cp.full_abbreviation
        FROM   categories c
        JOIN   category_paths cp ON cp.category_id = c.id
        WHERE  c.module = 'DOCUMENT' AND c.is_active = TRUE
        ORDER  BY cp.full_path`);

    const byId = new Map(cats.rows.map(c => [c.id, { ...c, own_count: 0, total_count: 0, drafts: 0, last_added: null, children: [] }]));
    for (const r of counts.rows) {
        const c = byId.get(r.category_id);
        if (c) { c.own_count = r.n; c.drafts = r.drafts; c.last_added = r.last_added; }
    }
    // Add each category's documents to every ancestor's total.
    for (const c of byId.values()) {
        let cur = c;
        const seen = new Set();
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            cur.total_count += c.own_count;
            if (c.last_added && (!cur.last_added || c.last_added > cur.last_added)) cur.last_added = c.last_added;
            cur = cur.parent_id ? byId.get(cur.parent_id) : null;
        }
        if (c.parent_id && byId.has(c.parent_id)) byId.get(c.parent_id).children.push(c.id);
    }
    // Finance-restricted staff: a Financial tile is only shown when something in it was shared with them.
    const restricted = isFinanceRestrictedStaffRole(req);
    const list = [...byId.values()].filter(c => !restricted || !isFinanceCategoryAbbrev(c.full_abbreviation) || c.total_count > 0);
    sendSuccess(res, {
        categories: list,
        archive_count: archived.rows[0]?.n || 0,
        total: counts.rows.reduce((a, r) => a + r.n, 0),
    });
});

// ============================================================
// GET ALL DOCUMENTS
// GET /api/documents?document_type=MEETING_MINUTES&status=FINAL
// ============================================================
const getAllDocuments = asyncHandler(async (req, res) => {
    const { document_type, status, related_record_type, related_record_id } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    // v1.46.0 — DELETED (soft-removed from the archive) is excluded
    // here the same way SUPERSEDED always was, so a removed document
    // disappears from every list view (both the plain "All Documents"
    // list and the Company Archive tab's OR-in-ARCHIVED condition
    // below, since a DELETED document is no longer ARCHIVED either).
    // The always-on rules (DELETED / SUPERSEDED hidden, personal documents
    // hidden, Financial documents for finance-restricted staff, documents
    // still awaiting signatures) are in appendVisibility() below — shared
    // with the category tiles (v1.81.0) so the counts match the lists.
    const conditions = [];
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
    // v1.81.0 — one category (and, unless include_sub=0, everything filed
    // under its sub-categories) — the category pages.
    if (req.query.category_id !== undefined && req.query.category_id !== '') {
        const catId = parseInt(req.query.category_id, 10);
        if (!Number.isInteger(catId) || catId < 1) throw createError.badRequest('Invalid category');
        p++;
        if (String(req.query.include_sub) === '0') {
            conditions.push(`d.category_id = $${p}`);
        } else {
            conditions.push(`d.category_id IN (WITH RECURSIVE sub AS (
                SELECT id FROM categories WHERE id = $${p}
                UNION ALL SELECT c.id FROM categories c JOIN sub ON c.parent_id = sub.id)
                SELECT id FROM sub)`);
        }
        params.push(catId);
    }
    // v1.81.0 — archived=exclude hides everything in the Company Archive
    // (uploaded into it or archived later); archived=only shows just those.
    if (req.query.archived === 'exclude') {
        conditions.push(`d.status <> 'ARCHIVED' AND COALESCE(d.related_record_type, '') <> 'COMPANY_ARCHIVE'`);
    } else if (req.query.archived === 'only') {
        conditions.push(`(d.status = 'ARCHIVED' OR d.related_record_type = 'COMPANY_ARCHIVE')`);
    }
    // v1.78.0 — free-text search (title, reference, public ID) for the
    // document picker on the transaction forms.
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 80) : '';
    if (search) {
        p++; conditions.push(`(d.title ILIKE $${p} OR EXISTS (
            SELECT 1 FROM references_registry sr WHERE sr.id = d.reference_id
            AND (sr.reference_code ILIKE $${p} OR sr.public_id ILIKE $${p})))`);
        params.push(`%${search.replace(/[%_\\]/g, ch => '\\' + ch)}%`);
    }

    p = appendVisibility(req, conditions, params);

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
    // v1.78.0 — how many transactions each document is connected to
    const txCountSql = await documentLinks.documentCountSql('d');
    // v1.81.0 — archive type / when and why it left the archive
    const archiveColsSql = (await archiveColumnsReady())
        ? 'd.archive_type, d.archived_at, d.archived_from_status,'
        : '';
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
            d.category_id,
            ${archiveColsSql}
            ${txCountSql} AS transaction_count,
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

    assertPersonalDocumentAccess(req, result.rows[0].owner_user_id);
    await assertDocumentVisible(req, id, result.rows[0].category_full_abbreviation);

    // v1.78.0 — connected transactions (details only for people with
    // access to company finances; everyone else gets the count).
    const connected = await documentLinks.listTransactionsForDocument(result.rows[0].id, req.user);
    sendSuccess(res, {
        ...result.rows[0],
        transactions: connected.transactions,
        transaction_count: connected.count,
        transactions_restricted: !!connected.restricted,
    });
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
                d.file_path, d.file_name, d.mime_type, d.owner_user_id,
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

    assertPersonalDocumentAccess(req, doc.owner_user_id);
    await assertDocumentVisible(req, id, doc.category_full_abbreviation);

    if (doc.source === 'UPLOADED') {
        // v1.29.1 — bytes come from storageService (R2 in production,
        // local-disk fallback in dev) instead of a raw fs/path read.
        // sendFileDownload() throws createError.notFound() itself if
        // the file is missing, same message as before.
        return sendFileDownload(res, toKey(doc.file_path), doc.file_name || `document-${doc.id}`);
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
    getMyPendingSignatures,
    getDocumentSignatures,
    getDocumentStamps,
    createNewVersion,
    archiveDocument,
    unarchiveDocument,   // v1.81.0
    getCategorySummary,  // v1.81.0
    deleteDocument,
    getMyDocuments,
    getShareReceipts,
    getAllDocuments,
    getDocumentById,
    downloadDocument,
    getTemplates,
    createTemplate,
};