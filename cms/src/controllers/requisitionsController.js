// ============================================================
// REQUISITIONS CONTROLLER
// Any member can request money for a specific purpose.
// Treasurer or Director approves or rejects.
// On approval, a transaction is automatically posted.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction, creditShareholderContribution, creditSideFundContribution } = require('./transactionsController');
const { createPendingFlexibleDeposit } = require('./savingsController');
const { clearFine } = require('../services/finesService');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { assertNotOwnRecord } = require('../services/approvalGuard'); // v1.72.0
// v1.80.0 — documents before payment, investments, reversal
const investmentCost = require('../services/investmentCostService');
const documentLinks = require('../services/documentLinksService');
const { uploadBuffer, generateKey } = require('../services/storageService');
const { getOrCreateCategory } = require('../services/categoryService');

// ============================================================
// v1.80.0 — REQUISITIONS: DOCUMENTS FIRST, INVESTMENTS, REVERSAL
// Requested: "requisitions have a functional reversal functionality and
// before a requisition is approved fully to make a transactional post a
// few prerequisites like linking / connecting to a document and or an
// investment". Confirmed:
//   • a money-out (EXPENSE) requisition needs at least one supporting
//     document (quotation, invoice, receipt …) before it can be approved;
//   • when it is FOR AN INVESTMENT, the investment and what the money is
//     for (buying / running / maintenance) are required too, and the
//     payment is booked as that investment's funding (buying) or expense
//     (running / maintenance) — see investmentCostService.js;
//   • documents connected to the requisition are connected to the
//     transaction when it is paid;
//   • a paid requisition is reversed through the normal second-person
//     reversal of its transaction; once approved it is marked REVERSED
//     (to pay again, a new requisition is raised).
// ============================================================
let reqV180 = false;
const requisitionsV180Ready = async (db) => {
    if (reqV180) return true;
    const r = await db.query(`SELECT to_regclass('public.requisition_document_links') IS NOT NULL AS ok`);
    reqV180 = !!r.rows[0].ok;
    return reqV180;
};
const TREASURY = ['Treasurer', 'Assistant Treasurer', 'Admin'];
const isTreasury = (user) => (user.roles || []).some(r => TREASURY.includes(r));

// Validate an investment chosen for a requisition.
const checkInvestmentChoice = async (client, investmentId, purpose) => {
    if (!investmentId) return null;
    const inv = await client.query(`
        SELECT i.id, i.name, i.status, i.currency_id, rr.reference_code
        FROM investments i JOIN references_registry rr ON rr.id = i.reference_id WHERE i.id = $1`, [investmentId]);
    if (!inv.rows.length) throw createError.notFound('Investment not found');
    if (['COMPLETED', 'TERMINATED', 'REJECTED', 'CANCELLED', 'CLOSED'].includes(inv.rows[0].status)) {
        throw createError.badRequest(`${inv.rows[0].name} is ${inv.rows[0].status.toLowerCase()} — money can no longer be requested for it.`);
    }
    investmentCost.assertCostType(purpose, { required: true });
    return inv.rows[0];
};

const liveDocumentIds = async (db, requisitionId) => {
    const r = await db.query(`
        SELECT l.document_id FROM requisition_document_links l
        JOIN documents d ON d.id = l.document_id
        WHERE l.requisition_id = $1 AND l.removed_at IS NULL AND d.status <> 'DELETED'
        ORDER BY l.linked_at, l.id`, [requisitionId]);
    return r.rows.map(x => x.document_id);
};

const linkDocumentsToRequisition = async (client, requisitionId, documentIds, userId, ip) => {
    const ids = [...new Set((Array.isArray(documentIds) ? documentIds : [documentIds]).map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0))];
    if (!ids.length) return 0;
    const docs = await client.query(`
        SELECT d.id, d.status, rr.reference_code FROM documents d JOIN references_registry rr ON rr.id = d.reference_id
        WHERE d.id = ANY($1::int[])`, [ids]);
    if (docs.rows.length !== ids.length) throw createError.notFound('One of the documents was not found.');
    const deleted = docs.rows.find(d => d.status === 'DELETED');
    if (deleted) throw createError.badRequest(`${deleted.reference_code} has been deleted and can't be connected.`);
    let n = 0;
    for (const d of docs.rows) {
        const r = await client.query(`
            INSERT INTO requisition_document_links (requisition_id, document_id, linked_by)
            SELECT $1, $2, $3
            WHERE NOT EXISTS (SELECT 1 FROM requisition_document_links WHERE requisition_id = $1 AND document_id = $2 AND removed_at IS NULL)
            RETURNING id`, [requisitionId, d.id, userId]);
        if (r.rows.length) {
            n++;
            await logAction(userId, ACTIONS.REQUISITION_UPDATED, MODULES.FINANCE, {
                ipAddress: ip, recordType: 'requisitions', recordId: requisitionId, newValues: { document: d.reference_code },
                description: `Document ${d.reference_code} connected to requisition #${requisitionId}`, client,
            });
        }
    }
    return n;
};

// Who may connect / remove documents: the requester while it is pending
// (only documents they can see — their own uploads), or Treasury.
const loadRequisitionForDocs = async (client, id, user, { forWrite = false } = {}) => {
    const r = await client.query(`SELECT * FROM requisitions WHERE id = $1 ${forWrite ? 'FOR UPDATE' : ''}`, [id]);
    if (!r.rows.length) throw createError.notFound('Requisition not found');
    const q = r.rows[0];
    const own = q.requested_by === user.id;
    const canView = own || isTreasury(user) || (user.permissions || []).includes('FINANCE_VIEW_ALL');
    if (!canView) throw createError.forbidden('You cannot see this requisition.');
    if (forWrite) {
        if (q.status !== 'PENDING') throw createError.badRequest('Documents can only be connected or removed while the requisition is pending.');
        if (!own && !isTreasury(user)) throw createError.forbidden('Only the person who made the requisition, or Treasury, can change its documents.');
    }
    return q;
};

// GET /api/requisitions/investment-options — names of the investments a
// requisition can be for (any member raising a requisition; no figures).
const getInvestmentOptions = asyncHandler(async (req, res) => {
    const r = await query(`
        SELECT i.id, i.name, i.status, i.investment_type, rr.reference_code, c.code AS currency_code, i.currency_id
        FROM investments i
        JOIN references_registry rr ON rr.id = i.reference_id
        JOIN currencies c ON c.id = i.currency_id
        WHERE i.status IN ('ACTIVE', 'PENDING_TERMINATION', 'PENDING', 'PROPOSED', 'PENDING_APPROVAL')
        ORDER BY i.name`);
    sendSuccess(res, r.rows);
});

// GET /api/requisitions/:id/documents
const getRequisitionDocuments = asyncHandler(async (req, res) => {
    if (!(await requisitionsV180Ready({ query }))) return sendSuccess(res, []);
    await loadRequisitionForDocs({ query }, req.params.id, req.user);
    const r = await query(`
        SELECT l.id AS link_id, l.linked_at, lu.first_name || ' ' || lu.last_name AS linked_by_name,
               d.id AS document_id, d.title, d.document_type, d.status, d.file_name, d.mime_type, rr.reference_code
        FROM   requisition_document_links l
        JOIN   documents d ON d.id = l.document_id
        JOIN   references_registry rr ON rr.id = d.reference_id
        JOIN   users lu ON lu.id = l.linked_by
        WHERE  l.requisition_id = $1 AND l.removed_at IS NULL AND d.status <> 'DELETED'
        ORDER  BY l.linked_at, l.id`, [req.params.id]);
    sendSuccess(res, r.rows);
});

// POST /api/requisitions/:id/documents   { document_ids: [] }  (Treasury: pick existing)
const linkRequisitionDocuments = asyncHandler(async (req, res) => {
    if (!(await requisitionsV180Ready({ query }))) throw createError.conflict('Connecting documents to requisitions needs the v1.80.0 database update.');
    let n = 0;
    await withTransaction(async (client) => {
        await loadRequisitionForDocs(client, req.params.id, req.user, { forWrite: true });
        if (!isTreasury(req.user)) {
            // A requester may only connect documents they uploaded themselves.
            const mine = await client.query(`SELECT COUNT(*)::int AS n FROM documents WHERE id = ANY($1::int[]) AND created_by = $2`,
                [(req.body.document_ids || []).map(Number), req.user.id]);
            if (mine.rows[0].n !== (req.body.document_ids || []).length) throw createError.forbidden('You can connect only documents you uploaded — upload the file here instead.');
        }
        n = await linkDocumentsToRequisition(client, req.params.id, req.body.document_ids, req.user.id, req.ip);
    });
    sendSuccess(res, { connected: n }, n ? `${n} document(s) connected` : 'Already connected');
});

// POST /api/requisitions/:id/documents/upload  (multipart: document, title, document_type)
// Anyone who can change the requisition's documents — the file is saved
// in Documents (Finance › Requisition documents) and connected here.
const uploadRequisitionDocument = asyncHandler(async (req, res) => {
    if (!req.file) throw createError.badRequest('Choose a file to upload.');
    if (!(await requisitionsV180Ready({ query }))) throw createError.conflict('Attaching documents to requisitions needs the v1.80.0 database update.');
    const docType = ['RECEIPT', 'CONTRACT', 'INVESTMENT_PROPOSAL', 'OTHER'].includes(req.body.document_type) ? req.body.document_type : 'OTHER';
    const title = (req.body.title || req.file.originalname || 'Supporting document').toString().trim().slice(0, 255);
    const key = generateKey('documents', req.file.originalname);
    let out = null;
    await withTransaction(async (client) => {
        const q = await loadRequisitionForDocs(client, req.params.id, req.user, { forWrite: true });
        await uploadBuffer(req.file.buffer, key, req.file.mimetype);
        const categoryId = await getOrCreateCategory(client, {
            module: 'DOCUMENT', name: 'Requisition documents', abbreviation: 'REQD',
            description: 'Quotations, invoices and receipts supporting requisitions (v1.80.0).', createdBy: req.user.id,
        });
        const { referenceId, referenceCode } = await generateReference(client, MODULE_CODES.DOCUMENT, docType.substring(0, 6), 'DOCUMENT', req.user.id);
        const d = await client.query(`
            INSERT INTO documents (reference_id, category_id, title, document_type, source, file_path, file_name, file_size_bytes, mime_type,
                                   version, related_record_type, related_record_id, status, created_by)
            VALUES ($1,$2,$3,$4,'UPLOADED',$5,$6,$7,$8,1,'requisitions',$9,'DRAFT',$10) RETURNING id`,
        [referenceId, categoryId, title, docType, key, req.file.originalname, req.file.size, req.file.mimetype, q.id, req.user.id]);
        await linkReferenceToRecord(client, referenceId, d.rows[0].id);
        await logAction(req.user.id, ACTIONS.DOCUMENT_UPLOADED, MODULES.DOCUMENTS, {
            ipAddress: req.ip, recordType: 'documents', recordId: d.rows[0].id, newValues: { referenceCode, title, requisition_id: q.id },
            description: `Document uploaded for a requisition: ${referenceCode} — ${title}`, client,
        });
        await linkDocumentsToRequisition(client, q.id, [d.rows[0].id], req.user.id, req.ip);
        out = { document_id: d.rows[0].id, reference: referenceCode, title };
    });
    sendCreated(res, out, `Document ${out.reference} attached`);
});

// DELETE /api/requisitions/:id/documents/:documentId
const unlinkRequisitionDocument = asyncHandler(async (req, res) => {
    await withTransaction(async (client) => {
        await loadRequisitionForDocs(client, req.params.id, req.user, { forWrite: true });
        const r = await client.query(`
            UPDATE requisition_document_links SET removed_at = NOW(), removed_by = $3
            WHERE requisition_id = $1 AND document_id = $2 AND removed_at IS NULL RETURNING id`,
        [req.params.id, req.params.documentId, req.user.id]);
        if (!r.rows.length) throw createError.notFound('This document is not connected to the requisition.');
        await logAction(req.user.id, ACTIONS.REQUISITION_UPDATED, MODULES.FINANCE, {
            ipAddress: req.ip, recordType: 'requisitions', recordId: parseInt(req.params.id, 10), oldValues: { document_id: parseInt(req.params.documentId, 10) },
            description: `Document #${req.params.documentId} disconnected from requisition #${req.params.id}`, client,
        });
    });
    sendSuccess(res, null, 'Document disconnected');
});

MODULE_CODES.REQUISITION = 'REQ';

// ============================================================
// CREATE REQUISITION
// POST /api/requisitions
// Any authenticated member can create a requisition.
// ============================================================
const createRequisition = asyncHandler(async (req, res) => {
    const {
        category_id,
        title,
        description,
        amount_requested,
        purpose,
        required_by_date,
        priority,
        requisition_type,
        contribution_date,
        fine_id,
    } = req.body;
    let { category_id: categoryId } = req.body;

    const type = requisition_type || 'EXPENSE';
    // v1.80.0 — a money-out requisition may be FOR AN INVESTMENT
    const investmentId = type === 'EXPENSE' && req.body.investment_id ? parseInt(req.body.investment_id, 10) : null;
    const invPurpose = investmentId ? req.body.investment_purpose : null;
    if (!investmentId && !categoryId) throw createError.badRequest('A valid category is required');
    const isAcknowledgementType = (t) =>
        t === 'CONTRIBUTION_ACKNOWLEDGEMENT' || t === 'SAVINGS_DEPOSIT' ||
        t === 'SIDE_FUND_CONTRIBUTION' || t === 'FINE_PAYMENT';

    if (isAcknowledgementType(type) && !contribution_date) {
        throw createError.badRequest(
            type === 'SAVINGS_DEPOSIT' ? 'Please provide the date you made the savings deposit' :
            type === 'SIDE_FUND_CONTRIBUTION' ? 'Please provide the date you made the side fund payment' :
            type === 'FINE_PAYMENT' ? 'Please provide the date you made the fine payment' :
            'Please provide the date you made the contribution'
        );
    }

    if (type === 'FINE_PAYMENT' && !fine_id) {
        throw createError.badRequest('Please select which fine this payment is for');
    }

    await withTransaction(async (client) => {
        // FINE_PAYMENT — validate the fine up front so we never let a
        // member request acknowledgement against someone else's fine, or
        // a fine that's already been cleared.
        let validatedFineId = null;
        if (type === 'FINE_PAYMENT') {
            const fineCheck = await client.query(
                'SELECT id, status, user_id FROM fines WHERE id = $1 FOR UPDATE', [fine_id]
            );
            if (fineCheck.rows.length === 0) {
                throw createError.notFound('Fine not found');
            }
            if (fineCheck.rows[0].user_id !== req.user.id) {
                throw createError.forbidden('This fine does not belong to you');
            }
            if (fineCheck.rows[0].status !== 'OUTSTANDING') {
                throw createError.badRequest('This fine has already been cleared');
            }
            validatedFineId = fineCheck.rows[0].id;
        }

        const v180 = await requisitionsV180Ready(client);
        if (investmentId && !v180) throw createError.conflict('Requisitions for an investment need the v1.80.0 database update.');
        const investment = await checkInvestmentChoice(client, investmentId, invPurpose);
        // Expense › Investments › <purpose>
        if (investment) categoryId = await investmentCost.purposeCategory(client, invPurpose, req.user.id);

        // Generate requisition reference
        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.REQUISITION, 'REQ',
            'REQUISITION', req.user.id
        );

        const result = await client.query(`
            INSERT INTO requisitions (
                reference_id, requested_by, category_id,
                title, description, amount_requested,
                purpose, required_by_date, priority, status,
                requisition_type, contribution_date, fine_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10, $11, $12)
            RETURNING id
        `, [
            referenceId, req.user.id, categoryId,
            title.trim(), description || null, amount_requested,
            purpose.trim(), required_by_date || null,
            priority || 'NORMAL',
            type,
            isAcknowledgementType(type) ? contribution_date : null,
            validatedFineId,
        ]);

        const reqId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, reqId);
        if (investment) {
            await client.query('UPDATE requisitions SET investment_id = $1, investment_purpose = $2 WHERE id = $3', [investment.id, invPurpose, reqId]);
        }
        // Documents picked on the form (Treasury: existing ones; anyone: their own uploads)
        if (v180 && req.body.document_ids && req.body.document_ids.length) {
            if (!isTreasury(req.user)) {
                const ids = req.body.document_ids.map(Number);
                const mine = await client.query('SELECT COUNT(*)::int AS n FROM documents WHERE id = ANY($1::int[]) AND created_by = $2', [ids, req.user.id]);
                if (mine.rows[0].n !== new Set(ids).size) throw createError.forbidden('You can connect only documents you uploaded.');
            }
            await linkDocumentsToRequisition(client, reqId, req.body.document_ids, req.user.id, req.ip);
        }

        await logAction(req.user.id, ACTIONS.REQUISITION_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'requisitions',
            recordId:    reqId,
            newValues:   { referenceCode, title, amount_requested, requisition_type: type, investment_id: investmentId, investment_purpose: invPurpose },
            description: `Requisition created: ${referenceCode} — ${title}`,
            client,
        });

        // --------------------------------------------------------
        // NOTIFY APPROVERS — Treasurer / Assistant Treasurer need
        // to know a new requisition is waiting on them.
        // --------------------------------------------------------
        const approversResult = await client.query(`
            SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
            FROM   users u
            JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            JOIN   roles r       ON r.id = ur.role_id
            WHERE  r.name IN ('Treasurer', 'Assistant Treasurer')
            AND    u.is_active = TRUE
        `);

        // wrapEmail is async and notifyMany's build() callback below must
        // stay synchronous, so render the branded shell once up-front with
        // a placeholder greeting, then personalise per-recipient with a
        // simple string replace.
        const approverEmailShell = await wrapEmail(`
            <p>Dear {{FIRST_NAME}},</p>
            <p><strong>${req.user.first_name} ${req.user.last_name}</strong> submitted a requisition that needs your approval:</p>
            <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                <tr><td style="padding:4px 0; color:#6b7280;">Title</td><td style="padding:4px 0; text-align:right;">${title}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Amount requested</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount_requested}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
            </table>
            <p>Please review and action this in the system.</p>
        `, { preheader: 'A requisition needs your approval' });

        notifyMany(approversResult.rows, 'REQUISITION_PENDING', (approver) => ({
            title:      'New requisition awaiting your approval',
            body:       `${req.user.first_name || 'A member'} submitted "${title}" for ${amount_requested}. Reference: ${referenceCode}.`,
            // v1.41.0 fix: there is no /requisitions/:id detail route —
            // RequisitionsPage.jsx is list-only — so this used to silently
            // bounce to the dashboard. Matches the other requisition
            // notifications elsewhere in this file.
            link:       `/requisitions`,
            module:     'FINANCE',
            recordType: 'requisitions',
            recordId:   reqId,
            email: {
                subject: `Requisition awaiting approval — ${referenceCode}`,
                html:    approverEmailShell.replace('{{FIRST_NAME}}', approver.first_name),
            },
        }));

        sendCreated(res, {
            requisition_id: reqId,
            reference:      referenceCode,
            title,
            amount_requested,
            status:         'PENDING',
        }, `Requisition submitted. Reference: ${referenceCode}`);
    });
});

// ============================================================
// APPROVE REQUISITION
// POST /api/requisitions/:id/approve
// Treasurer or Director approves and posts a transaction.
// ============================================================
const approveRequisition = asyncHandler(async (req, res) => {
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'requisitions', req.params.id, ['requested_by'], 'requisition');
    const { id }  = req.params;
    const {
        account_id,
        amount_approved,
        review_notes,
    } = req.body;

    await withTransaction(async (client) => {
        const reqResult = await client.query(`
            SELECT r.*, rr.reference_code,
                   u.first_name, u.last_name
            FROM   requisitions r
            JOIN   references_registry rr ON rr.id = r.reference_id
            JOIN   users u ON u.id = r.requested_by
            WHERE  r.id = $1 FOR UPDATE
        `, [id]);

        if (reqResult.rows.length === 0) {
            throw createError.notFound('Requisition not found');
        }

        const req_ = reqResult.rows[0];

        if (req_.status !== 'PENDING') {
            throw createError.badRequest(
                `Requisition cannot be approved. Status: ${req_.status}`
            );
        }

        const approvedAmount = parseFloat(amount_approved || req_.amount_requested);

        // ----------------------------------------------------------
        // CONTRIBUTION ACKNOWLEDGEMENT — member is asking us to record
        // capital they've already contributed. Runs the exact same
        // crediting logic as a Treasurer directly recording a
        // contribution (POST /transactions/contributions), just
        // triggered by this approval instead.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT') {
            const {
                transactionId, balanceBefore, balanceAfter,
                referenceCode: txRefCode, account,
            } = await creditShareholderContribution(client, {
                contributorId:     req_.requested_by,
                amount:            approvedAmount,
                contributionDate:  req_.contribution_date || new Date().toISOString().split('T')[0],
                categoryId:        req_.category_id,
                notes:             review_notes || req_.purpose,
                recordedByUserId:  req.user.id,
                // v1.69.1 — the account the member actually paid into
                // (any currency; shares are valued by conversion at the
                // rate on the contribution date). Primary if not chosen.
                accountId:         account_id ? parseInt(account_id) : undefined,
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       account_id      = $1,
                       currency_id     = $2,
                       amount_approved = $3,
                       transaction_id  = $4,
                       reviewed_by     = $5,
                       reviewed_at     = NOW(),
                       review_notes    = $6
                WHERE  id = $7
            `, [
                account.id,
                account.currency_id,
                approvedAmount,
                transactionId,
                req.user.id,
                review_notes || null,
                id,
            ]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { txRefCode, approvedAmount, balanceBefore, balanceAfter },
                description: `Contribution acknowledged: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Contribution acknowledgement approved',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and the contribution has been recorded.`,
                link:       `/requisitions`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
                email: {
                    subject: `Requisition approved — ${req_.reference_code}`,
                    html:    await wrapEmail(`
                        <p>Dear ${req_.first_name},</p>
                        <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved and the contribution recorded to your account.</p>
                        ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                    `, { preheader: 'Your requisition has been approved' }),
                },
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'CONTRIBUTION_ACKNOWLEDGEMENT',
                amount_approved:       approvedAmount,
                transaction_reference: txRefCode,
                balance_before:        balanceBefore,
                balance_after:         balanceAfter,
            }, 'Contribution acknowledged and recorded in the ledger');
        }

        // ----------------------------------------------------------
        // SAVINGS DEPOSIT — member is asking to add money to their own
        // savings. Approving here does NOT post any money movement —
        // it hands the request off to a Treasurer/Assistant Treasurer,
        // who gives the actual financial sign-off (see
        // savingsController.approveSavingsDeposit). This mirrors the
        // Treasurer-direct path exactly from that point on.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'SAVINGS_DEPOSIT') {
            const { savingsId, referenceCode: savRefCode } = await createPendingFlexibleDeposit(client, {
                userId:           req_.requested_by,
                categoryId:       req_.category_id,
                amount:           approvedAmount,
                depositDate:      req_.contribution_date || new Date().toISOString().split('T')[0],
                notes:            review_notes || req_.purpose,
                recordedByUserId: req.user.id,
                source:           'REQUISITION',
                requisitionId:    parseInt(id),
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       amount_approved = $1,
                       reviewed_by     = $2,
                       reviewed_at     = NOW(),
                       review_notes    = $3
                WHERE  id = $4
            `, [approvedAmount, req.user.id, review_notes || null, id]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { savRefCode, approvedAmount },
                description: `Savings deposit request forwarded to Treasurer/Assistant Treasurer for approval: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Savings deposit request forwarded for approval',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and forwarded to the Treasurer/Assistant Treasurer for final sign-off.`,
                link:       `/savings`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'SAVINGS_DEPOSIT',
                amount_approved:       approvedAmount,
                savings_reference:     savRefCode,
                savings_id:            savingsId,
            }, 'Savings deposit request forwarded to the Treasurer/Assistant Treasurer for approval');
        }

        // ----------------------------------------------------------
        // SIDE FUND CONTRIBUTION (v1.26.0) — member is asking us to
        // record a side fund payment they've already made. Just like
        // CONTRIBUTION_ACKNOWLEDGEMENT, this runs the exact same
        // crediting logic as every other side fund payment path
        // (applySideFundPayment, oldest-unpaid-period-first) — no
        // month picker on the request itself, the cascade sorts out
        // which period(s) it covers.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'SIDE_FUND_CONTRIBUTION') {
            const {
                transactionId, balanceBefore, balanceAfter,
                referenceCode: txRefCode, settled, creditBanked,
            } = await creditSideFundContribution(client, {
                userId:            req_.requested_by,
                amount:            approvedAmount,
                contributionDate:  req_.contribution_date || new Date().toISOString().split('T')[0],
                categoryId:        req_.category_id,
                recordedByUserId:  req.user.id,
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       amount_approved = $1,
                       transaction_id  = $2,
                       reviewed_by     = $3,
                       reviewed_at     = NOW(),
                       review_notes    = $4
                WHERE  id = $5
            `, [approvedAmount, transactionId, req.user.id, review_notes || null, id]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { txRefCode, approvedAmount, settled, creditBanked, balanceBefore, balanceAfter },
                description: `Side fund contribution acknowledged: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Side fund contribution approved',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and the side fund payment has been recorded.`,
                link:       `/side-fund`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
                email: {
                    subject: `Requisition approved — ${req_.reference_code}`,
                    html:    await wrapEmail(`
                        <p>Dear ${req_.first_name},</p>
                        <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved and the side fund payment recorded.</p>
                        ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                    `, { preheader: 'Your requisition has been approved' }),
                },
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'SIDE_FUND_CONTRIBUTION',
                amount_approved:       approvedAmount,
                transaction_reference: txRefCode,
                settled,
                credit_banked:         creditBanked,
                balance_before:        balanceBefore,
                balance_after:         balanceAfter,
            }, 'Side fund contribution acknowledged and recorded');
        }

        // ----------------------------------------------------------
        // FINE PAYMENT (v1.37.0) — member is asking us to record a fine
        // payment they've already made externally. Unlike the three
        // acknowledgement types above, this needs a Treasurer-chosen
        // account at approval time, because a fine must be paid into an
        // account in the SAME currency it was posted in — there's no
        // single "the" account to auto-resolve the way Savings/Side Fund
        // do. Runs the exact same crediting logic as the direct
        // Treasurer-clears-it path (finesController.clearFineDirect),
        // via the shared finesService.clearFine core.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'FINE_PAYMENT') {
            if (!account_id) {
                throw createError.badRequest(
                    'A receiving account (in the same currency as the fine) is required to approve this requisition'
                );
            }

            const {
                transactionId, balanceBefore, balanceAfter,
                referenceCode: txRefCode,
            } = await clearFine(client, {
                fineId:             req_.fine_id,
                accountId:          parseInt(account_id),
                paidDate:           req_.contribution_date || new Date().toISOString().split('T')[0],
                paymentDescription: review_notes || req_.purpose,
                recordedByUserId:   req.user.id,
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       account_id      = $1,
                       amount_approved = $2,
                       transaction_id  = $3,
                       reviewed_by     = $4,
                       reviewed_at     = NOW(),
                       review_notes    = $5
                WHERE  id = $6
            `, [account_id, approvedAmount, transactionId, req.user.id, review_notes || null, id]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { txRefCode, approvedAmount, balanceBefore, balanceAfter, fineId: req_.fine_id },
                description: `Fine payment acknowledged: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Fine payment approved',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and your fine payment has been recorded.`,
                link:       `/fines`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
                email: {
                    subject: `Requisition approved — ${req_.reference_code}`,
                    html:    await wrapEmail(`
                        <p>Dear ${req_.first_name},</p>
                        <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved and your fine payment recorded.</p>
                        ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                    `, { preheader: 'Your requisition has been approved' }),
                },
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'FINE_PAYMENT',
                amount_approved:       approvedAmount,
                transaction_reference: txRefCode,
                balance_before:        balanceBefore,
                balance_after:         balanceAfter,
            }, 'Fine payment acknowledged and recorded');
        }

        // ----------------------------------------------------------
        // EXPENSE (original behaviour) — money OUT of the selected
        // account to fulfil the request.
        // ----------------------------------------------------------
        // ----------------------------------------------------------
        // v1.80.0 — PREREQUISITES before money leaves the company:
        //   • at least one supporting document connected;
        //   • for an investment: the investment and the purpose.
        // ----------------------------------------------------------
        const v180 = await requisitionsV180Ready(client);
        let docIds = [];
        if (v180) {
            docIds = await liveDocumentIds(client, id);
            if (!docIds.length) {
                throw createError.badRequest('Connect at least one supporting document (quotation, invoice or receipt) to this requisition before approving it.');
            }
        }
        const { postInvestmentFunding, postInvestmentExpense } = require('./investmentsController');
        const today = new Date().toISOString().split('T')[0];
        const payDescription = `Requisition: ${req_.title} — ${req_.first_name} ${req_.last_name} (${req_.reference_code})`;
        let transactionId; let txRefCode; let balanceBefore; let balanceAfter; let accountRow;

        if (v180 && req_.investment_id) {
            const costType = investmentCost.assertCostType(req_.investment_purpose, { required: true });
            const invR = await client.query(`
                SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
                FROM   investments i
                JOIN   accounts a ON a.id = i.funding_account_id
                JOIN   references_registry r ON r.id = i.reference_id
                WHERE  i.id = $1
                FOR UPDATE OF i`, [req_.investment_id]);
            if (!invR.rows.length) throw createError.notFound('The investment of this requisition was not found.');
            const inv = invR.rows[0];
            if (costType === 'CAPITAL' && inv.status !== 'ACTIVE') {
                throw createError.badRequest(`${inv.name} must be approved (active) before money can be put into it.`);
            }
            const payFrom = account_id ? parseInt(account_id, 10) : (costType === 'CAPITAL' ? inv.funding_account_id : inv.returns_account_id);
            const acc = await client.query('SELECT id, currency_id, account_type, reference_prefix, name FROM accounts WHERE id = $1', [payFrom]);
            if (!acc.rows.length) throw createError.notFound('Account not found');
            if (acc.rows[0].currency_id !== inv.currency_id) {
                throw createError.badRequest(`${inv.name} is kept in another currency — pay it from an account in the investment's currency (or transfer the money first).`);
            }
            accountRow = acc.rows[0];
            const description = `${payDescription} — ${inv.name} (${inv.reference_code})`;
            const posted = costType === 'CAPITAL'
                ? await postInvestmentFunding(client, inv, { amount: approvedAmount, description, valueDate: today, userId: req.user.id, accountId: payFrom, categoryId: req_.category_id })
                : await postInvestmentExpense(client, inv, { amount: approvedAmount, description, entryDate: today, costType, accountId: payFrom, categoryId: req_.category_id, userId: req.user.id });
            ({ transactionId, referenceCode: txRefCode, balanceBefore, balanceAfter } = posted);
        } else {
            if (!account_id) {
                throw createError.badRequest('A valid account is required to approve this requisition');
            }
            const account = await client.query(
                'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
                [account_id]
            );
            if (account.rows.length === 0) {
                throw createError.notFound('Account not found');
            }
            accountRow = account.rows[0];

            const ref = await generateReference(
                client, resolveModuleCode(account.rows[0]), 'REQ', 'TRANSACTION', req.user.id
            );
            txRefCode = ref.referenceCode;

            ({ transactionId, balanceBefore, balanceAfter } =
                await postTransaction(client, {
                    accountId:       account_id,
                    transactionType: 'DEBIT',
                    inflowType:      'EXPENSE',
                    amount:          approvedAmount,
                    currencyId:      account.rows[0].currency_id,
                    categoryId:      req_.category_id,
                    description:     payDescription,
                    valueDate:       today,
                    createdBy:       req.user.id,
                    referenceId:     ref.referenceId,
                }));

            await linkReferenceToRecord(client, ref.referenceId, transactionId);
        }

        // The requisition's documents now belong to the payment too.
        if (docIds.length) {
            await documentLinks.link(client, {
                transactionIds: [transactionId], documentIds: docIds, userId: req.user.id,
                via: 'AT_ENTRY', confirmAdditional: true, note: `From requisition ${req_.reference_code}`, ipAddress: req.ip,
            });
        }

        await client.query(`
            UPDATE requisitions
            SET    status         = 'APPROVED',
                   account_id     = $1,
                   currency_id    = $2,
                   amount_approved = $3,
                   transaction_id  = $4,
                   reviewed_by     = $5,
                   reviewed_at     = NOW(),
                   review_notes    = $6
            WHERE  id = $7
        `, [
            accountRow.id,
            accountRow.currency_id,
            approvedAmount,
            transactionId,
            req.user.id,
            review_notes || null,
            id,
        ]);

        await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'requisitions',
            recordId:    parseInt(id),
            newValues:   { txRefCode, approvedAmount, balanceBefore, balanceAfter },
            description: `Requisition approved: ${req_.reference_code} — ${approvedAmount}`,
            client,
        });

        notify({
            userId:     req_.requested_by,
            type:       'REQUISITION_APPROVED',
            title:      'Requisition approved',
            body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved for ${approvedAmount}.`,
            link:       `/requisitions`,
            module:     'FINANCE',
            recordType: 'requisitions',
            recordId:   parseInt(id),
            email: {
                subject: `Requisition approved — ${req_.reference_code}`,
                html:    await wrapEmail(`
                    <p>Dear ${req_.first_name},</p>
                    <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved.</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Amount approved</td><td style="padding:4px 0; text-align:right; font-weight:700;">${approvedAmount}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Transaction reference</td><td style="padding:4px 0; text-align:right;">${txRefCode}</td></tr>
                    </table>
                    ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                `, { preheader: 'Your requisition has been approved' }),
            },
        });

        sendSuccess(res, {
            status:                'APPROVED',
            amount_approved:       approvedAmount,
            transaction_reference: txRefCode,
            balance_before:        balanceBefore,
            balance_after:         balanceAfter,
        }, 'Requisition approved and payment processed');
    });
});

// ============================================================
// REJECT REQUISITION
// POST /api/requisitions/:id/reject
// ============================================================
const rejectRequisition = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { review_notes } = req.body;

    const result = await query(`
        UPDATE requisitions
        SET    status       = 'REJECTED',
               reviewed_by  = $1,
               reviewed_at  = NOW(),
               review_notes = $2
        WHERE  id = $3
        AND    status = 'PENDING'
        RETURNING id, title, requested_by
    `, [req.user.id, review_notes || null, id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Requisition not found or cannot be rejected');
    }

    const rejected = result.rows[0];

    await logAction(req.user.id, ACTIONS.REQUISITION_REJECTED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'requisitions',
        recordId:    parseInt(id),
        description: `Requisition rejected: ID ${id}`,
    });

    notify({
        userId:     rejected.requested_by,
        type:       'REQUISITION_REJECTED',
        title:      'Requisition rejected',
        body:       `Your requisition "${rejected.title}" was not approved.${review_notes ? ` Reason: ${review_notes}` : ''}`,
        link:       `/requisitions`,
        module:     'FINANCE',
        recordType: 'requisitions',
        recordId:   parseInt(id),
        email: {
            subject: `Requisition not approved — ${rejected.title}`,
            html:    await wrapEmail(`
                <p>Your requisition <strong>${rejected.title}</strong> was not approved.</p>
                ${review_notes ? `<p style="color:#6b7280;">Reason: ${review_notes}</p>` : ''}
            `, { preheader: 'Your requisition was not approved' }),
        },
    });

    sendSuccess(res, null, 'Requisition rejected');
});


const requisitionExtrasSql = async () => (await requisitionsV180Ready({ query })) ? `,
            r.investment_id, r.investment_purpose, r.transaction_id, r.reversed_at, r.reversal_reason,
            inv.name AS investment_name, invr.reference_code AS investment_reference, inv.currency_id AS investment_currency_id,
            txr.reference_code AS transaction_reference,
            (SELECT COUNT(*)::int FROM requisition_document_links l JOIN documents d ON d.id = l.document_id
              WHERE l.requisition_id = r.id AND l.removed_at IS NULL AND d.status <> 'DELETED') AS document_count,
            (SELECT rq.id FROM reversal_requests rq WHERE rq.transaction_id = r.transaction_id AND rq.status = 'PENDING' LIMIT 1) AS pending_reversal_id` : `,
            r.transaction_id, NULL::int AS document_count`;
const requisitionExtrasJoin = async () => (await requisitionsV180Ready({ query })) ? `
        LEFT JOIN investments inv ON inv.id = r.investment_id
        LEFT JOIN references_registry invr ON invr.id = inv.reference_id
        LEFT JOIN transactions tx ON tx.id = r.transaction_id
        LEFT JOIN references_registry txr ON txr.id = tx.reference_id` : '';

// ============================================================
// GET MY REQUISITIONS
// GET /api/requisitions/me
// ============================================================
const getMyRequisitions = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            r.id, r.title, r.description, r.amount_requested,
            r.amount_approved, r.purpose, r.required_by_date,
            r.priority, r.status, r.review_notes, r.created_at,
            r.reviewed_at, r.requisition_type, r.contribution_date,
            r.category_id, r.requested_by,
            rr.reference_code,
            rr.public_id,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            reviewer.first_name || ' ' || reviewer.last_name AS reviewed_by_name
            ${await requisitionExtrasSql()}
        FROM  requisitions r
        JOIN  references_registry rr ON rr.id  = r.reference_id
        JOIN  categories cat         ON cat.id = r.category_id
        JOIN  category_paths cp      ON cp.category_id = r.category_id
        LEFT JOIN users reviewer     ON reviewer.id = r.reviewed_by
        ${await requisitionExtrasJoin()}
        WHERE r.requested_by = $1
        ORDER BY r.created_at DESC
    `, [req.user.id]);

    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL REQUISITIONS
// GET /api/requisitions
// Treasurer and Directors see all
// ============================================================
const getAllRequisitions = asyncHandler(async (req, res) => {
    const { status, priority } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`r.status = $${p}`);
        params.push(status.toUpperCase());
    }
    if (priority) {
        p++; conditions.push(`r.priority = $${p}`);
        params.push(priority.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM requisitions r ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            r.id, r.title, r.description, r.amount_requested, r.amount_approved,
            r.priority, r.status, r.required_by_date, r.created_at,
            r.reviewed_at, r.review_notes, r.requisition_type, r.contribution_date,
            r.category_id, r.purpose, r.requested_by,
            rr.reference_code,
            rr.public_id,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS requested_by_name,
            u.email      AS requested_by_email,
            reviewer.first_name || ' ' || reviewer.last_name AS reviewed_by_name
            ${await requisitionExtrasSql()}
        FROM  requisitions r
        JOIN  references_registry rr ON rr.id  = r.reference_id
        JOIN  categories cat         ON cat.id = r.category_id
        JOIN  category_paths cp      ON cp.category_id = r.category_id
        JOIN  users u                ON u.id  = r.requested_by
        LEFT JOIN users reviewer     ON reviewer.id = r.reviewed_by
        ${await requisitionExtrasJoin()}
        ${where}
        ORDER BY
            CASE r.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2
                WHEN 'NORMAL' THEN 3 WHEN 'LOW' THEN 4 END,
            r.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// EDIT A REQUISITION (before approval)
// PATCH /api/requisitions/:id
// Only while still PENDING. Editable by whoever requested it, or
// Treasurer/Assistant Treasurer.
// ============================================================
const editRequisition = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        category_id, title, description, amount_requested,
        purpose, required_by_date, priority,
        requisition_type, contribution_date, fine_id,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM requisitions WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Requisition not found');
        }
        const requisition = existing.rows[0];

        if (requisition.status !== 'PENDING') {
            throw createError.badRequest('Only a pending requisition can be edited');
        }

        const isRequester = requisition.requested_by === req.user.id;
        const userRoles = (req.user.roles || []);
        const canApprove = userRoles.includes('Treasurer') || userRoles.includes('Assistant Treasurer');
        if (!isRequester && !canApprove) {
            throw createError.forbidden(
                'Only the person who requested this, or the Treasurer/Assistant Treasurer, can edit it'
            );
        }

        const newType = requisition_type || requisition.requisition_type;
        const isAcknowledgementType = (t) =>
            t === 'CONTRIBUTION_ACKNOWLEDGEMENT' || t === 'SAVINGS_DEPOSIT' ||
            t === 'SIDE_FUND_CONTRIBUTION' || t === 'FINE_PAYMENT';
        if (isAcknowledgementType(newType) && !(contribution_date || requisition.contribution_date)) {
            throw createError.badRequest(
                newType === 'SAVINGS_DEPOSIT' ? 'Please provide the date the savings deposit was made' :
                newType === 'SIDE_FUND_CONTRIBUTION' ? 'Please provide the date the side fund payment was made' :
                newType === 'FINE_PAYMENT' ? 'Please provide the date the fine payment was made' :
                'Please provide the date the contribution was made'
            );
        }

        // v1.80.0 — the investment it is for, and the purpose
        let newInvestmentId = requisition.investment_id || null;
        let newInvPurpose = requisition.investment_purpose || null;
        let newCategoryId = category_id || null;
        if (req.body.investment_id !== undefined || req.body.investment_purpose !== undefined) {
            if (!(await requisitionsV180Ready(client))) throw createError.conflict('Requisitions for an investment need the v1.80.0 database update.');
            newInvestmentId = req.body.investment_id ? parseInt(req.body.investment_id, 10) : (req.body.investment_id === undefined ? newInvestmentId : null);
            newInvPurpose = newInvestmentId ? (req.body.investment_purpose || newInvPurpose) : null;
            if (newInvestmentId && newType !== 'EXPENSE') throw createError.badRequest('Only a money-out requisition can be for an investment.');
            await checkInvestmentChoice(client, newInvestmentId, newInvPurpose);
            if (newInvestmentId) newCategoryId = await investmentCost.purposeCategory(client, newInvPurpose, req.user.id);
            else if (!newCategoryId && requisition.investment_id) throw createError.badRequest('Choose a category now that it is no longer for an investment.');
        }

        let newFineId = requisition.fine_id;
        if (newType === 'FINE_PAYMENT') {
            const targetFineId = fine_id || requisition.fine_id;
            if (!targetFineId) {
                throw createError.badRequest('Please select which fine this payment is for');
            }
            const fineCheck = await client.query(
                'SELECT id, status, user_id FROM fines WHERE id = $1 FOR UPDATE', [targetFineId]
            );
            if (fineCheck.rows.length === 0) {
                throw createError.notFound('Fine not found');
            }
            if (fineCheck.rows[0].user_id !== requisition.requested_by) {
                throw createError.forbidden('This fine does not belong to the requester');
            }
            if (fineCheck.rows[0].status !== 'OUTSTANDING') {
                throw createError.badRequest('This fine has already been cleared');
            }
            newFineId = fineCheck.rows[0].id;
        } else {
            newFineId = null;
        }

        const updated = await client.query(`
            UPDATE requisitions
            SET    category_id       = COALESCE($1, category_id),
                   title             = COALESCE($2, title),
                   description       = COALESCE($3, description),
                   amount_requested  = COALESCE($4, amount_requested),
                   purpose           = COALESCE($5, purpose),
                   required_by_date  = $6,
                   priority          = COALESCE($7, priority),
                   requisition_type  = $8,
                   contribution_date = $9,
                   fine_id           = $10
            WHERE  id = $11
            RETURNING *
        `, [
            newCategoryId, title ? title.trim() : null,
            description !== undefined ? description : null,
            amount_requested || null, purpose ? purpose.trim() : null,
            required_by_date !== undefined ? required_by_date : requisition.required_by_date,
            priority || null, newType,
            isAcknowledgementType(newType)
                ? (contribution_date || requisition.contribution_date) : null,
            newFineId,
            id,
        ]);

        if (await requisitionsV180Ready(client)) {
            const inv = await client.query('UPDATE requisitions SET investment_id = $1, investment_purpose = $2 WHERE id = $3 RETURNING investment_id, investment_purpose',
                [newInvestmentId, newInvPurpose, id]);
            Object.assign(updated.rows[0], inv.rows[0]);
        }

        await logAction(req.user.id, ACTIONS.REQUISITION_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'requisitions',
            recordId:    id,
            oldValues:   requisition,
            newValues:   updated.rows[0],
            description: `Requisition edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Requisition updated');
    });
});

module.exports = {
    getInvestmentOptions, getRequisitionDocuments, linkRequisitionDocuments, uploadRequisitionDocument, unlinkRequisitionDocument, // v1.80.0
    createRequisition,
    editRequisition,
    approveRequisition,
    rejectRequisition,
    getMyRequisitions,
    getAllRequisitions,
};