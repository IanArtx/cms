// ============================================================
// EXTERNAL AUDIT CONTROLLER
//
// Two audiences, two sets of endpoints:
//   ADMIN  — create/edit/revoke audit engagements; choose which
//            accounts, auditor logins, and documents belong to each
//   AUDITOR — see only their own attached engagement(s), and only
//            the accounts/date range/documents an Admin chose for it
//
// The Auditor role itself grants nothing by default. Every
// auditor-facing query below re-derives its own scope from
// audit_engagement_accounts / audit_engagement_users /
// audit_engagement_documents — an auditor can never see more than
// what an Admin explicitly attached to their engagement, no matter
// what filters they pass in.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord } = require('../services/referenceService');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { uploadBuffer, generateKey, sendFileDownload, deleteObject, toKey } = require('../services/storageService');

// ============================================================
// INTERNAL HELPER — build a per-auditor reference-code prefix
// Combines the auditor's first name and their firm's initials
// (both required profile fields — see isAuditorProfileComplete
// below) into the "module code" segment of a normal reference —
// e.g. auditor "John", firm initials "KPMG" produces reference
// codes like JOHNKPMG-FEEDBACK-202607-00001. Sanitised/truncated
// to fit reference_sequences.module_code (VARCHAR(20)).
// ============================================================
const buildAuditorModuleCode = (firstName, companyInitials) => {
    const combined = `${(firstName || '').trim().split(/\s+/)[0] || 'AUD'}${companyInitials || ''}`;
    const sanitized = combined.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (sanitized || 'AUDITOR').slice(0, 20);
};

// ============================================================
// INTERNAL HELPER — has this auditor filled in the required
// profile fields yet? Checked before any comment, file upload, or
// "Finish Audit" action — these fields are what makes the reference
// codes on their eventual submission meaningful, so they're required
// up front rather than left until submission time.
// ============================================================
const isAuditorProfileComplete = (user) =>
    !!(user.auditor_company_name && user.auditor_company_initials && user.auditor_contact_phone);

// ============================================================
// INTERNAL HELPER — everyone holding the Director or Secretary
// role, active accounts only. Used to fan out submission/extension
// notifications — either role can act on either kind of request,
// so both groups always hear about both.
// ============================================================
const getDirectorsAndSecretaries = async () => {
    const result = await query(`
        SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id
        WHERE  r.name IN ('Director', 'Secretary') AND u.is_active = TRUE
    `);
    return result.rows;
};

// ============================================================
// INTERNAL HELPER
// Confirms the logged-in user is attached to this engagement, and
// that the engagement is still ACTIVE and hasn't hit its optional
// access_expires_at. Returns the engagement row on success — every
// auditor-facing endpoint calls this first and uses the returned
// period_start/period_end to clamp its own query.
// ============================================================
const assertEngagementAccess = async (engagementId, userId) => {
    const result = await query(`
        SELECT e.id, e.name, e.period_start, e.period_end, e.status, e.access_expires_at
        FROM   audit_engagements e
        JOIN   audit_engagement_users eu ON eu.engagement_id = e.id
        WHERE  e.id = $1 AND eu.user_id = $2
    `, [engagementId, userId]);

    if (result.rows.length === 0) {
        throw createError.forbidden('You do not have access to this audit engagement');
    }
    const engagement = result.rows[0];
    if (engagement.status !== 'ACTIVE') {
        throw createError.forbidden('This audit engagement has been revoked');
    }
    if (engagement.access_expires_at && new Date(engagement.access_expires_at) < new Date()) {
        throw createError.forbidden('Access to this audit engagement has expired');
    }
    return engagement;
};

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

// GET /api/audit/engagements
const listEngagements = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT e.id, e.name, e.description, e.period_start, e.period_end,
               e.access_expires_at, e.status, e.created_at,
               u.first_name || ' ' || u.last_name AS created_by_name,
               (SELECT COUNT(*) FROM audit_engagement_accounts  WHERE engagement_id = e.id) AS account_count,
               (SELECT COUNT(*) FROM audit_engagement_users     WHERE engagement_id = e.id) AS user_count,
               (SELECT COUNT(*) FROM audit_engagement_documents WHERE engagement_id = e.id) AS document_count
        FROM   audit_engagements e
        JOIN   users u ON u.id = e.created_by
        ORDER BY e.created_at DESC
    `);
    sendSuccess(res, result.rows);
});

// GET /api/audit/engagements/:id
const getEngagementById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const engagementResult = await query(`
        SELECT e.*, u.first_name || ' ' || u.last_name AS created_by_name
        FROM   audit_engagements e
        JOIN   users u ON u.id = e.created_by
        WHERE  e.id = $1
    `, [id]);
    if (engagementResult.rows.length === 0) {
        throw createError.notFound('Audit engagement not found');
    }

    const accountsResult = await query(`
        SELECT a.id, a.name, a.account_type
        FROM   audit_engagement_accounts ea
        JOIN   accounts a ON a.id = ea.account_id
        WHERE  ea.engagement_id = $1
        ORDER BY a.name
    `, [id]);

    const usersResult = await query(`
        SELECT u.id, u.first_name, u.last_name, u.email, eu.added_at
        FROM   audit_engagement_users eu
        JOIN   users u ON u.id = eu.user_id
        WHERE  eu.engagement_id = $1
        ORDER BY eu.added_at
    `, [id]);

    const documentsResult = await query(`
        SELECT d.id, d.title, d.document_type, d.status, ed.added_at
        FROM   audit_engagement_documents ed
        JOIN   documents d ON d.id = ed.document_id
        WHERE  ed.engagement_id = $1
        ORDER BY ed.added_at
    `, [id]);

    sendSuccess(res, {
        ...engagementResult.rows[0],
        accounts:  accountsResult.rows,
        users:     usersResult.rows,
        documents: documentsResult.rows,
    });
});

// POST /api/audit/engagements
const createEngagement = asyncHandler(async (req, res) => {
    const { name, description, period_start, period_end, access_expires_at, account_ids } = req.body;

    if (!Array.isArray(account_ids) || account_ids.length === 0) {
        throw createError.badRequest('Select at least one account for this engagement');
    }

    await withTransaction(async (client) => {
        const result = await client.query(`
            INSERT INTO audit_engagements
                (name, description, period_start, period_end, access_expires_at, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [
            name.trim(),
            description || null,
            period_start,
            period_end,
            access_expires_at || null,
            req.user.id,
        ]);

        const engagementId = result.rows[0].id;

        for (const accountId of account_ids) {
            await client.query(
                `INSERT INTO audit_engagement_accounts (engagement_id, account_id) VALUES ($1, $2)`,
                [engagementId, accountId]
            );
        }

        await logAction(req.user.id, ACTIONS.AUDIT_ENGAGEMENT_CREATED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'audit_engagements',
            recordId:    engagementId,
            newValues:   { name, period_start, period_end, account_ids },
            description: `Audit engagement created: ${name}`,
            client,
        });

        sendCreated(res, { id: engagementId }, 'Audit engagement created');
    });
});

// PATCH /api/audit/engagements/:id
// Full-replace semantics — the edit form always sends the whole
// object back, same pattern as create.
const updateEngagement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, description, period_start, period_end, access_expires_at, account_ids } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            `SELECT id, status FROM audit_engagements WHERE id = $1`, [id]
        );
        if (existing.rows.length === 0) throw createError.notFound('Audit engagement not found');
        if (existing.rows[0].status !== 'ACTIVE') {
            throw createError.badRequest('Cannot edit a revoked engagement');
        }

        await client.query(`
            UPDATE audit_engagements
            SET    name = $1, description = $2, period_start = $3,
                   period_end = $4, access_expires_at = $5
            WHERE  id = $6
        `, [
            name.trim(),
            description || null,
            period_start,
            period_end,
            access_expires_at || null,
            id,
        ]);

        if (Array.isArray(account_ids)) {
            await client.query(`DELETE FROM audit_engagement_accounts WHERE engagement_id = $1`, [id]);
            for (const accountId of account_ids) {
                await client.query(
                    `INSERT INTO audit_engagement_accounts (engagement_id, account_id) VALUES ($1, $2)`,
                    [id, accountId]
                );
            }
        }

        await logAction(req.user.id, ACTIONS.AUDIT_ENGAGEMENT_UPDATED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'audit_engagements',
            recordId:    parseInt(id),
            newValues:   req.body,
            description: `Audit engagement updated: ${name}`,
            client,
        });

        sendSuccess(res, null, 'Audit engagement updated');
    });
});

// POST /api/audit/engagements/:id/revoke
const revokeEngagement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(`
        UPDATE audit_engagements
        SET    status = 'REVOKED', revoked_at = NOW(), revoked_by = $1
        WHERE  id = $2 AND status = 'ACTIVE'
        RETURNING id, name
    `, [req.user.id, id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Engagement not found or already revoked');
    }

    await logAction(req.user.id, ACTIONS.AUDIT_ENGAGEMENT_REVOKED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        description: `Audit engagement revoked: ${result.rows[0].name}`,
    });

    sendSuccess(res, result.rows[0], 'Audit engagement revoked');
});

// POST /api/audit/engagements/:id/users
// Looks the person up by email. They must already have a registered
// account (self-service, same as any other user) — this never
// creates one from scratch. Grants the Auditor role automatically if
// they don't already have it, since being attached to an engagement
// is what should actually let them in.
const addUserToEngagement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { email } = req.body;

    await withTransaction(async (client) => {
        const engagement = await client.query(
            `SELECT id, status FROM audit_engagements WHERE id = $1`, [id]
        );
        if (engagement.rows.length === 0) throw createError.notFound('Audit engagement not found');
        if (engagement.rows[0].status !== 'ACTIVE') {
            throw createError.badRequest('Cannot add users to a revoked engagement');
        }

        const userResult = await client.query(
            `SELECT id, first_name, last_name FROM users WHERE email = $1`,
            [email.toLowerCase()]
        );
        if (userResult.rows.length === 0) {
            throw createError.notFound(
                'No account with this email exists yet. The auditor needs to register first ' +
                '(they can request the "Auditor" role during registration, or you can add them ' +
                'here once they have).'
            );
        }
        const user = userResult.rows[0];

        const alreadyAttached = await client.query(
            `SELECT 1 FROM audit_engagement_users WHERE engagement_id = $1 AND user_id = $2`,
            [id, user.id]
        );
        if (alreadyAttached.rows.length > 0) {
            throw createError.conflict('This person is already attached to this engagement');
        }

        const roleResult = await client.query(`SELECT id FROM roles WHERE name = 'Auditor'`);
        const auditorRoleId = roleResult.rows[0].id;
        const hasRole = await client.query(
            `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2`,
            [user.id, auditorRoleId]
        );
        if (hasRole.rows.length === 0) {
            await client.query(
                `INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1, $2, $3)`,
                [user.id, auditorRoleId, req.user.id]
            );
        }

        await client.query(
            `INSERT INTO audit_engagement_users (engagement_id, user_id, added_by) VALUES ($1, $2, $3)`,
            [id, user.id, req.user.id]
        );

        await logAction(req.user.id, ACTIONS.AUDIT_USER_ADDED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'audit_engagements',
            recordId:    parseInt(id),
            newValues:   { user_id: user.id, email },
            description: `${user.first_name} ${user.last_name} added to audit engagement ID ${id}`,
            client,
        });

        sendSuccess(res, {
            id: user.id, first_name: user.first_name, last_name: user.last_name, email,
        }, 'Auditor added to engagement');
    });
});

// DELETE /api/audit/engagements/:id/users/:userId
// Detaches from this engagement only — does not strip the Auditor
// role itself, since the same person may be attached elsewhere.
const removeUserFromEngagement = asyncHandler(async (req, res) => {
    const { id, userId } = req.params;
    const result = await query(
        `DELETE FROM audit_engagement_users WHERE engagement_id = $1 AND user_id = $2 RETURNING user_id`,
        [id, userId]
    );
    if (result.rows.length === 0) {
        throw createError.notFound('That user is not attached to this engagement');
    }

    await logAction(req.user.id, ACTIONS.AUDIT_USER_REMOVED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        description: `User ID ${userId} removed from audit engagement ID ${id}`,
    });

    sendSuccess(res, null, 'Auditor removed from engagement');
});

// POST /api/audit/engagements/:id/documents
const addDocumentToEngagement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { document_id } = req.body;

    const docResult = await query(`SELECT id, title FROM documents WHERE id = $1`, [document_id]);
    if (docResult.rows.length === 0) throw createError.notFound('Document not found');

    try {
        await query(
            `INSERT INTO audit_engagement_documents (engagement_id, document_id, added_by) VALUES ($1, $2, $3)`,
            [id, document_id, req.user.id]
        );
    } catch (err) {
        if (err.code === '23505') {
            throw createError.conflict('This document is already shared with this engagement');
        }
        throw err;
    }

    await logAction(req.user.id, ACTIONS.AUDIT_DOCUMENT_ADDED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        newValues:   { document_id },
        description: `Document "${docResult.rows[0].title}" shared with audit engagement ID ${id}`,
    });

    sendSuccess(res, null, 'Document shared with engagement');
});

// DELETE /api/audit/engagements/:id/documents/:documentId
const removeDocumentFromEngagement = asyncHandler(async (req, res) => {
    const { id, documentId } = req.params;
    const result = await query(
        `DELETE FROM audit_engagement_documents WHERE engagement_id = $1 AND document_id = $2 RETURNING document_id`,
        [id, documentId]
    );
    if (result.rows.length === 0) {
        throw createError.notFound('That document is not shared with this engagement');
    }

    await logAction(req.user.id, ACTIONS.AUDIT_DOCUMENT_REMOVED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        description: `Document ID ${documentId} removed from audit engagement ID ${id}`,
    });

    sendSuccess(res, null, 'Document removed from engagement');
});

// ============================================================================
// AUDITOR-FACING ENDPOINTS
// Every one of these calls assertEngagementAccess() first.
// ============================================================================

// GET /api/audit/my-engagements
const getMyEngagements = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT e.id, e.name, e.description, e.period_start, e.period_end,
               e.access_expires_at, e.status
        FROM   audit_engagements e
        JOIN   audit_engagement_users eu ON eu.engagement_id = e.id
        WHERE  eu.user_id = $1
        ORDER BY e.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// GET /api/audit/engagements/:id/allowed-accounts
const getAllowedAccounts = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const result = await query(`
        SELECT a.id, a.name, a.account_type, c.code AS currency_code
        FROM   audit_engagement_accounts ea
        JOIN   accounts a ON a.id = ea.account_id
        JOIN   currencies c ON c.id = a.currency_id
        WHERE  ea.engagement_id = $1
        ORDER BY a.name
    `, [id]);
    sendSuccess(res, result.rows);
});

// GET /api/audit/engagements/:id/transactions
// Every filter is intersected with the engagement's own scope — an
// auditor can narrow what they see, never widen it.
const getEngagementTransactions = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const engagement = await assertEngagementAccess(id, req.user.id);
    const { account_id, from_date, to_date } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    // Clamping is done here, in SQL, rather than by comparing dates in
    // JS first — pg returns DATE columns as JS Date objects, and
    // comparing one of those against a plain 'YYYY-MM-DD' query-param
    // string with JS's < / > operators does not do what it looks like
    // it does (Date coerces to a timestamp, the string does not coerce
    // to one the same way, so the comparison silently misbehaves).
    // GREATEST/LEAST against two properly-typed ::date values sidesteps
    // that entirely and is the actual enforcement point: no matter what
    // from_date/to_date a request sends, the audited period always wins
    // if the request tries to reach outside it.
    // $1 = engagement id (account subquery), $2 = period_start,
    // $3 = from_date (nullable), $4 = period_end, $5 = to_date (nullable)
    const conditions = [
        `t.account_id IN (SELECT account_id FROM audit_engagement_accounts WHERE engagement_id = $1)`,
        `t.status IN ('POSTED','REVERSED')`,
        `t.value_date >= GREATEST($2::date, COALESCE($3::date, $2::date))`,
        `t.value_date <= LEAST($4::date, COALESCE($5::date, $4::date))`,
    ];
    const params = [id, engagement.period_start, from_date || null, engagement.period_end, to_date || null];
    let p = 5;

    if (account_id) {
        p++; conditions.push(`t.account_id = $${p}`);
        params.push(account_id);
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    const countResult = await query(`SELECT COUNT(*) AS total FROM transactions t ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            t.id, t.transaction_type, t.inflow_type, t.amount,
            t.balance_before, t.balance_after, t.description,
            t.value_date, t.status,
            r.reference_code,
            c.code AS currency_code,
            cat.name AS category_name,
            cp.full_path AS category_trail,
            a.name AS account_name,
            u.first_name || ' ' || u.last_name AS recorded_by_name
        FROM  transactions t
        JOIN  references_registry r  ON r.id  = t.reference_id
        JOIN  currencies c           ON c.id  = t.currency_id
        JOIN  categories cat         ON cat.id = t.category_id
        JOIN  category_paths cp      ON cp.category_id = t.category_id
        JOIN  accounts a             ON a.id  = t.account_id
        JOIN  users u                ON u.id  = t.created_by
        ${where}
        ORDER BY t.value_date DESC, t.id DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// GET /api/audit/engagements/:id/documents
const getEngagementDocuments = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const result = await query(`
        SELECT d.id, d.title, d.document_type, d.status, d.created_at, ed.added_at
        FROM   audit_engagement_documents ed
        JOIN   documents d ON d.id = ed.document_id
        WHERE  ed.engagement_id = $1
        ORDER BY ed.added_at DESC
    `, [id]);
    sendSuccess(res, result.rows);
});

// GET /api/audit/engagements/:id/documents/:documentId
// Mirrors documentsController.downloadDocument's UPLOADED vs
// SYSTEM_GENERATED split. Authorization is entirely engagement-
// membership based — the Auditor role carries no DOCUMENT_VIEW
// permission, so this is the only gate.
const previewEngagementDocument = asyncHandler(async (req, res) => {
    const { id, documentId } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const attached = await query(
        `SELECT 1 FROM audit_engagement_documents WHERE engagement_id = $1 AND document_id = $2`,
        [id, documentId]
    );
    if (attached.rows.length === 0) {
        throw createError.forbidden('This document is not shared with this audit engagement');
    }

    const result = await query(
        `SELECT id, title, source, document_type, template_data, file_path, file_name, mime_type
         FROM   documents WHERE id = $1`,
        [documentId]
    );
    if (result.rows.length === 0) throw createError.notFound('Document not found');
    const doc = result.rows[0];

    await logAction(req.user.id, ACTIONS.AUDIT_DOCUMENT_VIEWED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'documents',
        recordId:    parseInt(documentId),
        description: `Auditor viewed document "${doc.title}" (engagement ID ${id})`,
    });

    if (doc.source === 'UPLOADED') {
        return sendFileDownload(res, toKey(doc.file_path), doc.file_name || `document-${doc.id}`);
    }

    if (!doc.template_data) {
        throw createError.badRequest('This document has no content to preview');
    }
    sendSuccess(res, {
        title:         doc.title,
        document_type: doc.document_type,
        template_data: doc.template_data,
    });
});

// GET /api/audit/engagements/:id/summary
// Aggregated totals the frontend's auditSummaryTemplate() renders
// into the downloadable PDF: opening/closing balance and total
// in/out per account, plus a per-category breakdown, all clamped to
// the engagement's own period.
const getEngagementSummary = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const engagement = await assertEngagementAccess(id, req.user.id);

    const accountsResult = await query(`
        SELECT a.id, a.name, a.account_type, c.code AS currency_code
        FROM   audit_engagement_accounts ea
        JOIN   accounts a ON a.id = ea.account_id
        JOIN   currencies c ON c.id = a.currency_id
        WHERE  ea.engagement_id = $1
        ORDER BY a.name
    `, [id]);

    const perAccount = [];
    for (const account of accountsResult.rows) {
        const boundsResult = await query(`
            SELECT
                (SELECT balance_before FROM transactions
                  WHERE account_id = $1 AND value_date >= $2 AND value_date <= $3
                    AND status IN ('POSTED','REVERSED')
                  ORDER BY value_date ASC, id ASC LIMIT 1) AS opening_balance,
                (SELECT balance_after FROM transactions
                  WHERE account_id = $1 AND value_date >= $2 AND value_date <= $3
                    AND status IN ('POSTED','REVERSED')
                  ORDER BY value_date DESC, id DESC LIMIT 1) AS closing_balance,
                COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('CREDIT','REVERSAL_CREDIT')), 0) AS total_in,
                COALESCE(SUM(amount) FILTER (WHERE transaction_type IN ('DEBIT','REVERSAL_DEBIT')), 0) AS total_out,
                COUNT(*) AS transaction_count
            FROM transactions
            WHERE account_id = $1 AND value_date >= $2 AND value_date <= $3
              AND status IN ('POSTED','REVERSED')
        `, [account.id, engagement.period_start, engagement.period_end]);

        const bounds = boundsResult.rows[0];
        perAccount.push({
            ...account,
            opening_balance:   bounds.opening_balance,
            closing_balance:   bounds.closing_balance,
            total_in:          bounds.total_in,
            total_out:         bounds.total_out,
            transaction_count: parseInt(bounds.transaction_count),
        });
    }

    const categoryResult = await query(`
        SELECT cat.name AS category_name, cp.full_path AS category_trail,
               SUM(CASE WHEN t.transaction_type IN ('CREDIT','REVERSAL_CREDIT') THEN t.amount ELSE 0 END) AS total_in,
               SUM(CASE WHEN t.transaction_type IN ('DEBIT','REVERSAL_DEBIT') THEN t.amount ELSE 0 END) AS total_out,
               COUNT(*) AS transaction_count
        FROM   transactions t
        JOIN   categories cat    ON cat.id = t.category_id
        JOIN   category_paths cp ON cp.category_id = t.category_id
        WHERE  t.account_id IN (SELECT account_id FROM audit_engagement_accounts WHERE engagement_id = $1)
          AND  t.value_date >= $2 AND t.value_date <= $3
          AND  t.status IN ('POSTED','REVERSED')
        GROUP BY cat.name, cp.full_path
        ORDER BY cp.full_path
    `, [id, engagement.period_start, engagement.period_end]);

    // Full, unpaginated transaction list for the same period/scope —
    // this endpoint exists specifically to build the one-shot
    // downloadable PDF, not for interactive browsing (that's what
    // getEngagementTransactions is for, capped at 100/page). A
    // club-scale audit period realistically has hundreds of
    // transactions at most, so returning them all in one response
    // is fine here.
    const transactionsResult = await query(`
        SELECT
            t.id, t.transaction_type, t.inflow_type, t.amount,
            t.balance_before, t.balance_after, t.description,
            t.value_date, t.status,
            r.reference_code,
            c.code AS currency_code,
            cat.name AS category_name,
            cp.full_path AS category_trail,
            a.name AS account_name,
            u.first_name || ' ' || u.last_name AS recorded_by_name
        FROM  transactions t
        JOIN  references_registry r  ON r.id  = t.reference_id
        JOIN  currencies c           ON c.id  = t.currency_id
        JOIN  categories cat         ON cat.id = t.category_id
        JOIN  category_paths cp      ON cp.category_id = t.category_id
        JOIN  accounts a             ON a.id  = t.account_id
        JOIN  users u                ON u.id  = t.created_by
        WHERE t.account_id IN (SELECT account_id FROM audit_engagement_accounts WHERE engagement_id = $1)
          AND t.status IN ('POSTED','REVERSED')
          AND t.value_date >= $2 AND t.value_date <= $3
        ORDER BY t.value_date ASC, t.id ASC
    `, [id, engagement.period_start, engagement.period_end]);

    await logAction(req.user.id, ACTIONS.AUDIT_SUMMARY_DOWNLOADED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        description: `Audit summary generated for engagement ID ${id}`,
    });

    sendSuccess(res, {
        engagement: {
            id:           engagement.id,
            name:         engagement.name,
            period_start: engagement.period_start,
            period_end:   engagement.period_end,
        },
        accounts:     perAccount,
        categories:   categoryResult.rows,
        transactions: transactionsResult.rows,
    });
});

// ============================================================================
// AUDITOR SUBMISSION WORKFLOW (v1.20.0)
//
// Lifecycle of one round of work:
//   1. Auditor fills in their profile (company name/initials/phone) via
//      the normal PATCH /api/users/me — required before anything below.
//   2. Auditor adds comments and uploads report files one at a time.
//      Each lands with submission_id = NULL ("staged") until finished.
//   3. Auditor clicks "Finish Audit" -> creates one audit_submissions row
//      and atomically attaches every currently-staged comment/file to it.
//   4. A Director AND a Secretary must each approve (dual sign-off). The
//      moment both are in place, the system generates reference codes,
//      creates real `documents` rows (this is the only point at which
//      any of this becomes a permanent, referenced, archived record —
//      documents.reference_id is NOT NULL, so nothing above this line
//      could ever have been inserted into `documents` directly), and
//      emails the auditor a receipt confirmation.
//   5. A rejection from EITHER approver short-circuits the whole
//      submission to REJECTED, and the auditor can stage a fresh round.
// ============================================================================

// INTERNAL HELPER — the auditor's own profile fields. req.user (attached
// by the authenticate middleware) does not carry these columns — see the
// SELECT in middleware/auth.js — so every function that needs them loads
// a fresh copy here rather than trusting a stale JWT-derived object.
const fetchAuditorProfile = async (userId) => {
    const result = await query(`
        SELECT id, first_name, last_name, email,
               auditor_company_name, auditor_company_initials, auditor_contact_phone
        FROM   users WHERE id = $1
    `, [userId]);
    return result.rows[0];
};

// INTERNAL HELPER — category to file archived audit documents under.
// Reuses the seeded "Legal / compliance" DOCUMENT category (abbreviation
// LEG) if it's still there; falls back to any DOCUMENT-module category so
// a renamed/reorganised category tree doesn't break archiving.
const resolveAuditCategoryId = async (client) => {
    const named = await client.query(
        `SELECT id FROM categories WHERE module = 'DOCUMENT' AND abbreviation = 'LEG' LIMIT 1`
    );
    if (named.rows.length > 0) return named.rows[0].id;
    const any = await client.query(
        `SELECT id FROM categories WHERE module = 'DOCUMENT' ORDER BY id LIMIT 1`
    );
    if (any.rows.length > 0) return any.rows[0].id;
    throw createError.badRequest('No document category is configured — cannot archive the audit report');
};

// Small reusable email fragment builder — keeps the HTML in one place
// instead of duplicated inline in every notify() call below.
const emailParagraphs = (lines) => lines.map(l => `<p style="margin:0 0 12px 0;">${l}</p>`).join('');

// ----------------------------------------------------------------
// COMMENTS
// ----------------------------------------------------------------

// GET /api/audit/engagements/:id/comments
const getComments = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const result = await query(`
        SELECT c.id, c.comment_text, c.created_at, c.submission_id,
               u.first_name || ' ' || u.last_name AS author_name
        FROM   audit_engagement_comments c
        JOIN   users u ON u.id = c.user_id
        WHERE  c.engagement_id = $1
        ORDER BY c.created_at ASC
    `, [id]);
    sendSuccess(res, result.rows);
});

// POST /api/audit/engagements/:id/comments
const addComment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { comment_text } = req.body;
    if (!comment_text || !comment_text.trim()) {
        throw createError.badRequest('Comment text is required');
    }

    await assertEngagementAccess(id, req.user.id);

    const profile = await fetchAuditorProfile(req.user.id);
    if (!isAuditorProfileComplete(profile)) {
        throw createError.badRequest(
            'Please complete your company name, company initials, and contact phone on your profile before adding comments.'
        );
    }

    const pending = await query(
        `SELECT 1 FROM audit_submissions WHERE engagement_id = $1 AND status = 'SUBMITTED'`, [id]
    );
    if (pending.rows.length > 0) {
        throw createError.badRequest(
            'A submission for this engagement is already awaiting review. New comments can be added once it is approved or rejected.'
        );
    }

    const result = await query(`
        INSERT INTO audit_engagement_comments (engagement_id, user_id, comment_text)
        VALUES ($1, $2, $3)
        RETURNING id, comment_text, created_at
    `, [id, req.user.id, comment_text.trim()]);

    await logAction(req.user.id, ACTIONS.AUDIT_COMMENT_ADDED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        description: `Auditor comment added to engagement ID ${id}`,
    });

    sendCreated(res, result.rows[0], 'Comment added');
});

// ----------------------------------------------------------------
// REPORT FILES
// ----------------------------------------------------------------

// GET /api/audit/engagements/:id/report-files
const getReportFiles = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const result = await query(`
        SELECT f.id, f.file_name, f.file_size_bytes, f.mime_type, f.uploaded_at, f.submission_id
        FROM   audit_submission_files f
        WHERE  f.engagement_id = $1
        ORDER BY f.uploaded_at DESC
    `, [id]);
    sendSuccess(res, result.rows);
});

// POST /api/audit/engagements/:id/report-files
// Uses uploadSingle('report', 'audit-reports') — the file arrives as an
// in-memory buffer (req.file.buffer); it's only sent to storageService
// once every validation below has passed (v1.29.1 — this also means the
// old "upload then delete on failure" fs.unlink cleanup calls are no
// longer needed, since nothing is persisted until validation succeeds).
const uploadReportFile = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!req.file) throw createError.badRequest('No file uploaded');

    await assertEngagementAccess(id, req.user.id);

    const profile = await fetchAuditorProfile(req.user.id);
    if (!isAuditorProfileComplete(profile)) {
        throw createError.badRequest(
            'Please complete your company name, company initials, and contact phone on your profile before uploading files.'
        );
    }

    const pending = await query(
        `SELECT 1 FROM audit_submissions WHERE engagement_id = $1 AND status = 'SUBMITTED'`, [id]
    );
    if (pending.rows.length > 0) {
        throw createError.badRequest(
            'A submission for this engagement is already awaiting review. New files can be uploaded once it is approved or rejected.'
        );
    }

    const reportKey = generateKey('audit-reports', req.file.originalname);
    await uploadBuffer(req.file.buffer, reportKey, req.file.mimetype);

    const result = await query(`
        INSERT INTO audit_submission_files
            (engagement_id, file_path, file_name, file_size_bytes, mime_type, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, file_name, file_size_bytes, mime_type, uploaded_at
    `, [id, reportKey, req.file.originalname, req.file.size, req.file.mimetype, req.user.id]);

    await logAction(req.user.id, ACTIONS.AUDIT_FILE_UPLOADED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        newValues:   { file_name: req.file.originalname },
        description: `Auditor uploaded report file "${req.file.originalname}" to engagement ID ${id}`,
    });

    sendCreated(res, result.rows[0], 'File uploaded');
});

// DELETE /api/audit/engagements/:id/report-files/:fileId
// Only the uploader can remove it, and only while it's still staged
// (submission_id IS NULL) — once part of a submitted round it's locked,
// same reasoning as comments.
const deleteReportFile = asyncHandler(async (req, res) => {
    const { id, fileId } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const result = await query(`
        DELETE FROM audit_submission_files
        WHERE  id = $1 AND engagement_id = $2 AND uploaded_by = $3 AND submission_id IS NULL
        RETURNING file_path, file_name
    `, [fileId, id, req.user.id]);

    if (result.rows.length === 0) {
        throw createError.notFound(
            'File not found, not yours, or already part of a submitted round'
        );
    }

    deleteObject(toKey(result.rows[0].file_path));

    await logAction(req.user.id, ACTIONS.AUDIT_FILE_REMOVED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_engagements',
        recordId:    parseInt(id),
        description: `Auditor removed report file "${result.rows[0].file_name}" from engagement ID ${id}`,
    });

    sendSuccess(res, null, 'File removed');
});

// GET /api/audit/engagements/:id/submissions
// Lets the auditor see their own submission history and current review
// status for this engagement — the in-portal counterpart to the email
// confirmations sent at each step (deliverables received / approved /
// rejected).
const getEngagementSubmissions = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const result = await query(`
        SELECT id, submitted_at, status,
               director_approved_at, secretary_approved_at,
               rejected_at, rejection_reason, feedback_document_id
        FROM   audit_submissions
        WHERE  engagement_id = $1
        ORDER BY submitted_at DESC
    `, [id]);
    sendSuccess(res, result.rows);
});

// ----------------------------------------------------------------
// FINISH AUDIT
// ----------------------------------------------------------------

// POST /api/audit/engagements/:id/finish
const finishAudit = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await assertEngagementAccess(id, req.user.id);

    const profile = await fetchAuditorProfile(req.user.id);
    if (!isAuditorProfileComplete(profile)) {
        throw createError.badRequest(
            'Please complete your company name, company initials, and contact phone on your profile first.'
        );
    }

    const pending = await query(
        `SELECT 1 FROM audit_submissions WHERE engagement_id = $1 AND status = 'SUBMITTED'`, [id]
    );
    if (pending.rows.length > 0) {
        throw createError.badRequest('A submission for this engagement is already awaiting review.');
    }

    const stagedComments = await query(
        `SELECT COUNT(*) AS n FROM audit_engagement_comments WHERE engagement_id = $1 AND submission_id IS NULL`,
        [id]
    );
    const stagedFiles = await query(
        `SELECT COUNT(*) AS n FROM audit_submission_files WHERE engagement_id = $1 AND submission_id IS NULL`,
        [id]
    );
    const commentCount = parseInt(stagedComments.rows[0].n);
    const fileCount    = parseInt(stagedFiles.rows[0].n);
    if (commentCount === 0 && fileCount === 0) {
        throw createError.badRequest(
            'Add at least one comment or report file before finishing the audit.'
        );
    }

    const submission = await withTransaction(async (client) => {
        const subResult = await client.query(`
            INSERT INTO audit_submissions (engagement_id, submitted_by)
            VALUES ($1, $2)
            RETURNING id, submitted_at
        `, [id, req.user.id]);
        const submissionId = subResult.rows[0].id;

        await client.query(
            `UPDATE audit_engagement_comments SET submission_id = $1 WHERE engagement_id = $2 AND submission_id IS NULL`,
            [submissionId, id]
        );
        await client.query(
            `UPDATE audit_submission_files SET submission_id = $1 WHERE engagement_id = $2 AND submission_id IS NULL`,
            [submissionId, id]
        );

        await logAction(req.user.id, ACTIONS.AUDIT_SUBMISSION_CREATED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'audit_submissions',
            recordId:    submissionId,
            newValues:   { engagement_id: id, comment_count: commentCount, file_count: fileCount },
            description: `Audit submitted for review — engagement ID ${id}`,
            client,
        });

        return { id: submissionId, submitted_at: subResult.rows[0].submitted_at };
    });

    // Best-effort notifications — outside the transaction, never block the
    // response or roll back the submission if an email fails to send.
    notify({
        userId:  req.user.id,
        type:    'AUDIT_DELIVERABLES_CONFIRMATION',
        title:   'Deliverables received',
        body:    `We've received your submission (${commentCount} comment(s), ${fileCount} file(s)) and it is now awaiting Director and Secretary approval.`,
        link:    '/audit',
        module:  'SYSTEM',
        recordType: 'audit_submissions',
        recordId: submission.id,
        email: {
            subject: 'Audit deliverables received',
            html: await wrapEmail(emailParagraphs([
                `Hello ${profile.first_name},`,
                `This confirms we've received your audit deliverables: <strong>${commentCount}</strong> comment(s) and <strong>${fileCount}</strong> file(s).`,
                `Your submission is now awaiting approval from a Director and a Secretary. You will receive another email once it has been reviewed.`,
            ]), { preheader: 'Your audit deliverables have been received' }),
        },
    }).catch(() => {});

    (async () => {
        try {
            const reviewers = await getDirectorsAndSecretaries();
            const reviewerHtml = await wrapEmail(emailParagraphs([
                `${profile.first_name} ${profile.last_name} (${profile.auditor_company_name}) has finished an audit and submitted ${commentCount} comment(s) and ${fileCount} file(s) for engagement ID ${id}.`,
                `This submission requires approval from both a Director and a Secretary before it is archived. Please review it in the External Audit review page.`,
            ]), { preheader: 'An audit submission needs your approval' });

            await notifyMany(reviewers, 'AUDIT_SUBMISSION_PENDING', () => ({
                title:   'Audit submission awaiting your approval',
                body:    `${profile.first_name} ${profile.last_name} (${profile.auditor_company_name}) has finished an audit and it needs your approval.`,
                link:    '/audit-review',
                module:  'SYSTEM',
                recordType: 'audit_submissions',
                recordId: submission.id,
                email: { subject: 'Audit submission awaiting approval', html: reviewerHtml },
            }));
        } catch { /* best-effort — never block the response */ }
    })();

    sendCreated(res, submission, 'Audit submitted for review');
});

// ============================================================================
// DIRECTOR / SECRETARY — SUBMISSION REVIEW
// ============================================================================

// GET /api/audit/submissions?status=SUBMITTED
const listSubmissions = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`s.status = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(`
        SELECT s.id, s.engagement_id, s.submitted_at, s.status,
               s.director_approved_at, s.secretary_approved_at,
               s.rejected_at, s.rejection_reason,
               e.name AS engagement_name,
               u.first_name || ' ' || u.last_name AS auditor_name,
               u.auditor_company_name,
               (SELECT COUNT(*) FROM audit_engagement_comments WHERE submission_id = s.id) AS comment_count,
               (SELECT COUNT(*) FROM audit_submission_files    WHERE submission_id = s.id) AS file_count
        FROM   audit_submissions s
        JOIN   audit_engagements e ON e.id = s.engagement_id
        JOIN   users u             ON u.id = s.submitted_by
        ${where}
        ORDER BY s.submitted_at DESC
    `, params);
    sendSuccess(res, result.rows);
});

// GET /api/audit/submissions/:id
const getSubmissionById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const subResult = await query(`
        SELECT s.*, e.name AS engagement_name, e.period_start, e.period_end,
               u.first_name || ' ' || u.last_name AS auditor_name, u.email AS auditor_email,
               u.auditor_company_name, u.auditor_company_initials, u.auditor_contact_phone,
               d.first_name || ' ' || d.last_name AS director_approved_by_name,
               sec.first_name || ' ' || sec.last_name AS secretary_approved_by_name,
               rej.first_name || ' ' || rej.last_name AS rejected_by_name
        FROM   audit_submissions s
        JOIN   audit_engagements e ON e.id = s.engagement_id
        JOIN   users u             ON u.id = s.submitted_by
        LEFT JOIN users d   ON d.id = s.director_approved_by
        LEFT JOIN users sec ON sec.id = s.secretary_approved_by
        LEFT JOIN users rej ON rej.id = s.rejected_by
        WHERE  s.id = $1
    `, [id]);
    if (subResult.rows.length === 0) throw createError.notFound('Submission not found');
    const submission = subResult.rows[0];

    const commentsResult = await query(`
        SELECT c.id, c.comment_text, c.created_at
        FROM   audit_engagement_comments c
        WHERE  c.submission_id = $1
        ORDER BY c.created_at ASC
    `, [id]);

    const filesResult = await query(`
        SELECT f.id, f.file_name, f.file_size_bytes, f.mime_type, f.uploaded_at, f.document_id
        FROM   audit_submission_files f
        WHERE  f.submission_id = $1
        ORDER BY f.uploaded_at ASC
    `, [id]);

    sendSuccess(res, { ...submission, comments: commentsResult.rows, files: filesResult.rows });
});

// GET /api/audit/submissions/:id/files/:fileId
// Lets a Director/Secretary preview a still-staged report file before
// approving — these files have no `documents` row yet (that only happens
// on finalize), so this reads audit_submission_files directly instead of
// going through documentsController's usual path.
const previewSubmissionFile = asyncHandler(async (req, res) => {
    const { id, fileId } = req.params;
    const result = await query(
        `SELECT file_path, file_name FROM audit_submission_files WHERE id = $1 AND submission_id = $2`,
        [fileId, id]
    );
    if (result.rows.length === 0) throw createError.notFound('File not found on this submission');
    const file = result.rows[0];
    return sendFileDownload(res, toKey(file.file_path), file.file_name);
});

// POST /api/audit/submissions/:id/approve
// Records this reviewer's sign-off (Director and/or Secretary — a user
// holding both roles satisfies both slots in one call). Once both slots
// are filled, finalizes the submission: generates references, creates
// the real `documents` rows, archives them, and emails the auditor.
const approveSubmission = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const roles = req.user.roles || [];

    if (!roles.includes('Director') && !roles.includes('Secretary')) {
        throw createError.forbidden('Only a Director or Secretary can approve an audit submission');
    }

    const result = await withTransaction(async (client) => {
        const subResult = await client.query(
            `SELECT * FROM audit_submissions WHERE id = $1 FOR UPDATE`, [id]
        );
        if (subResult.rows.length === 0) throw createError.notFound('Submission not found');
        let submission = subResult.rows[0];
        if (submission.status !== 'SUBMITTED') {
            throw createError.badRequest(`This submission is already ${submission.status.toLowerCase()}`);
        }

        const sets = [];
        const setParams = [];
        if (roles.includes('Director') && !submission.director_approved_by) {
            setParams.push(req.user.id); sets.push(`director_approved_by = $${setParams.length}`);
            sets.push(`director_approved_at = NOW()`);
        }
        if (roles.includes('Secretary') && !submission.secretary_approved_by) {
            setParams.push(req.user.id); sets.push(`secretary_approved_by = $${setParams.length}`);
            sets.push(`secretary_approved_at = NOW()`);
        }
        if (sets.length === 0) {
            throw createError.conflict('You have already approved this submission');
        }

        setParams.push(id);
        const updateResult = await client.query(
            `UPDATE audit_submissions SET ${sets.join(', ')} WHERE id = $${setParams.length} RETURNING *`,
            setParams
        );
        submission = updateResult.rows[0];

        await logAction(req.user.id, ACTIONS.AUDIT_SUBMISSION_APPROVED_STEP, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'audit_submissions',
            recordId:    parseInt(id),
            description: `Audit submission ID ${id} approved by ${roles.includes('Director') ? 'Director' : 'Secretary'}`,
            client,
        });

        const bothApproved = !!submission.director_approved_by && !!submission.secretary_approved_by;
        if (!bothApproved) {
            return { submission, finalized: false };
        }

        // ------------------------------------------------------
        // BOTH APPROVALS IN — finalize: generate references, create
        // real `documents` rows, archive everything, link it all back.
        // ------------------------------------------------------
        const engagementResult = await client.query(
            `SELECT id, name FROM audit_engagements WHERE id = $1`, [submission.engagement_id]
        );
        const engagement = engagementResult.rows[0];

        const auditorResult = await client.query(
            `SELECT first_name, last_name, email, auditor_company_name, auditor_company_initials, auditor_contact_phone
             FROM users WHERE id = $1`, [submission.submitted_by]
        );
        const auditor = auditorResult.rows[0];

        const commentsResult = await client.query(
            `SELECT comment_text, created_at FROM audit_engagement_comments WHERE submission_id = $1 ORDER BY created_at ASC`,
            [id]
        );
        const filesResult = await client.query(
            `SELECT id, file_path, file_name, file_size_bytes, mime_type FROM audit_submission_files WHERE submission_id = $1 ORDER BY uploaded_at ASC`,
            [id]
        );

        const moduleCode = buildAuditorModuleCode(auditor.first_name, auditor.auditor_company_initials);
        const categoryId = await resolveAuditCategoryId(client);

        // --- Feedback document (SYSTEM_GENERATED — re-rendered client-side
        //     from template_data, same pattern as every other generated
        //     document in the system) ---
        const feedbackRef = await generateReference(client, moduleCode, 'FEEDBACK', 'DOCUMENT', req.user.id);
        const feedbackTemplateData = {
            engagement_name:  engagement.name,
            auditor_name:     `${auditor.first_name} ${auditor.last_name}`,
            auditor_company:  auditor.auditor_company_name,
            auditor_initials: auditor.auditor_company_initials,
            auditor_phone:    auditor.auditor_contact_phone,
            auditor_email:    auditor.email,
            submitted_at:     submission.submitted_at,
            director_approved_at:  submission.director_approved_at,
            secretary_approved_at: submission.secretary_approved_at,
            comments:  commentsResult.rows,
            files:     filesResult.rows.map(f => ({ file_name: f.file_name })),
            reference_code: feedbackRef.referenceCode,
        };
        const feedbackDocResult = await client.query(`
            INSERT INTO documents (
                reference_id, category_id, title, document_type, source,
                template_data, version, related_record_type, related_record_id,
                status, created_by, approved_by, approved_at
            ) VALUES ($1, $2, $3, 'AUDITOR_FEEDBACK', 'SYSTEM_GENERATED',
                      $4, 1, 'audit_engagements', $5,
                      'FINAL', $6, $7, NOW())
            RETURNING id
        `, [
            feedbackRef.referenceId, categoryId,
            `Auditor Feedback — ${engagement.name}`,
            JSON.stringify(feedbackTemplateData),
            submission.engagement_id,
            submission.submitted_by, req.user.id,
        ]);
        const feedbackDocId = feedbackDocResult.rows[0].id;
        await linkReferenceToRecord(client, feedbackRef.referenceId, feedbackDocId);
        await client.query(
            `INSERT INTO audit_engagement_documents (engagement_id, document_id, added_by) VALUES ($1, $2, $3)`,
            [submission.engagement_id, feedbackDocId, req.user.id]
        );

        // --- Each uploaded report file (UPLOADED — points at the file
        //     already sitting on disk since it was uploaded) ---
        for (const file of filesResult.rows) {
            const fileRef = await generateReference(client, moduleCode, 'REPORT', 'DOCUMENT', req.user.id);
            const fileDocResult = await client.query(`
                INSERT INTO documents (
                    reference_id, category_id, title, document_type, source,
                    file_path, file_name, file_size_bytes, mime_type, version,
                    related_record_type, related_record_id,
                    status, created_by, approved_by, approved_at
                ) VALUES ($1, $2, $3, 'AUDIT_REPORT', 'UPLOADED',
                          $4, $5, $6, $7, 1,
                          'audit_engagements', $8,
                          'FINAL', $9, $10, NOW())
                RETURNING id
            `, [
                fileRef.referenceId, categoryId, file.file_name,
                file.file_path, file.file_name, file.file_size_bytes, file.mime_type,
                submission.engagement_id,
                submission.submitted_by, req.user.id,
            ]);
            const fileDocId = fileDocResult.rows[0].id;
            await linkReferenceToRecord(client, fileRef.referenceId, fileDocId);
            await client.query(`UPDATE audit_submission_files SET document_id = $1 WHERE id = $2`, [fileDocId, file.id]);
            await client.query(
                `INSERT INTO audit_engagement_documents (engagement_id, document_id, added_by) VALUES ($1, $2, $3)`,
                [submission.engagement_id, fileDocId, req.user.id]
            );
        }

        const finalResult = await client.query(
            `UPDATE audit_submissions SET status = 'APPROVED', feedback_document_id = $1 WHERE id = $2 RETURNING *`,
            [feedbackDocId, id]
        );

        await logAction(req.user.id, ACTIONS.AUDIT_SUBMISSION_FINALIZED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'audit_submissions',
            recordId:    parseInt(id),
            newValues:   { feedback_document_id: feedbackDocId, report_files: filesResult.rows.length },
            description: `Audit submission ID ${id} fully approved and archived — engagement "${engagement.name}"`,
            client,
        });

        return { submission: finalResult.rows[0], finalized: true, auditor, engagement };
    });

    if (result.finalized) {
        notify({
            userId:  result.submission.submitted_by,
            type:    'AUDIT_REPORT_APPROVED',
            title:   'Audit report approved',
            body:    `Your audit report for "${result.engagement.name}" has been approved and archived.`,
            link:    '/audit',
            module:  'SYSTEM',
            recordType: 'audit_submissions',
            recordId: result.submission.id,
            email: {
                subject: 'Your audit report has been approved',
                html: await wrapEmail(emailParagraphs([
                    `Hello ${result.auditor.first_name},`,
                    `This confirms your audit report for <strong>${result.engagement.name}</strong> has been reviewed and approved by both a Director and a Secretary.`,
                    `It has been archived in the company's records. Thank you for your work.`,
                ]), { preheader: 'Your audit report has been approved and archived' }),
            },
        }).catch(() => {});
    }

    sendSuccess(res, result.submission, result.finalized ? 'Submission fully approved and archived' : 'Approval recorded');
});

// POST /api/audit/submissions/:id/reject
// A single Director or Secretary rejecting is enough to send the whole
// submission back — unlike approval, rejection does not need to wait
// for the other reviewer's opinion.
const rejectSubmission = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason || !reason.trim()) throw createError.badRequest('A rejection reason is required');

    const roles = req.user.roles || [];
    if (!roles.includes('Director') && !roles.includes('Secretary')) {
        throw createError.forbidden('Only a Director or Secretary can reject an audit submission');
    }

    const result = await query(`
        UPDATE audit_submissions
        SET    status = 'REJECTED', rejected_by = $1, rejected_at = NOW(), rejection_reason = $2
        WHERE  id = $3 AND status = 'SUBMITTED'
        RETURNING *
    `, [req.user.id, reason.trim(), id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Submission not found or already reviewed');
    }
    const submission = result.rows[0];

    const auditorResult = await query(
        `SELECT first_name, email FROM users WHERE id = $1`, [submission.submitted_by]
    );
    const engagementResult = await query(
        `SELECT name FROM audit_engagements WHERE id = $1`, [submission.engagement_id]
    );
    const auditor = auditorResult.rows[0];
    const engagement = engagementResult.rows[0];

    await logAction(req.user.id, ACTIONS.AUDIT_SUBMISSION_REJECTED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_submissions',
        recordId:    parseInt(id),
        newValues:   { reason },
        description: `Audit submission ID ${id} rejected — engagement "${engagement.name}"`,
    });

    notify({
        userId:  submission.submitted_by,
        type:    'AUDIT_REPORT_REJECTED',
        title:   'Audit submission needs revision',
        body:    `Your submission for "${engagement.name}" was not approved. Reason: ${reason.trim()}`,
        link:    '/audit',
        module:  'SYSTEM',
        recordType: 'audit_submissions',
        recordId: submission.id,
        email: {
            subject: 'Your audit submission needs revision',
            html: await wrapEmail(emailParagraphs([
                `Hello ${auditor.first_name},`,
                `Your audit submission for <strong>${engagement.name}</strong> was reviewed and was not approved.`,
                `Reason given: "${reason.trim()}"`,
                `You can add further comments and files and finish the audit again through the External Audit portal.`,
            ]), { preheader: 'Your audit submission needs revision' }),
        },
    }).catch(() => {});

    sendSuccess(res, submission, 'Submission rejected');
});

// ============================================================================
// EXTENSION OF ACCESS REQUESTS
// ============================================================================

// POST /api/audit/engagements/:id/extension-requests
const requestExtension = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { requested_new_access_expires_at, reason } = req.body;
    if (!requested_new_access_expires_at) throw createError.badRequest('A new requested access date is required');
    if (!reason || !reason.trim()) throw createError.badRequest('A reason for the extension is required');

    const engagement = await assertEngagementAccess(id, req.user.id);
    const profile = await fetchAuditorProfile(req.user.id);

    const existing = await query(
        `SELECT 1 FROM audit_extension_requests WHERE engagement_id = $1 AND status = 'PENDING'`, [id]
    );
    if (existing.rows.length > 0) {
        throw createError.badRequest('An extension request for this engagement is already pending review');
    }

    const result = await query(`
        INSERT INTO audit_extension_requests
            (engagement_id, requested_by, current_access_expires_at, requested_new_access_expires_at, reason)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `, [id, req.user.id, engagement.access_expires_at, requested_new_access_expires_at, reason.trim()]);

    await logAction(req.user.id, ACTIONS.AUDIT_EXTENSION_REQUESTED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_extension_requests',
        recordId:    result.rows[0].id,
        newValues:   { requested_new_access_expires_at, reason },
        description: `Extension requested for audit engagement ID ${id}`,
    });

    (async () => {
        try {
            const reviewers = await getDirectorsAndSecretaries();
            const html = await wrapEmail(emailParagraphs([
                `${profile.first_name} ${profile.last_name} (${profile.auditor_company_name}) has requested more time to complete the audit "${engagement.name}".`,
                `Reason given: "${reason.trim()}"`,
                `Please review this request in the External Audit review page.`,
            ]), { preheader: 'An auditor has requested more time' });
            await notifyMany(reviewers, 'AUDIT_EXTENSION_PENDING', () => ({
                title: 'Audit extension request',
                body:  `${profile.first_name} ${profile.last_name} has requested an extension for "${engagement.name}"`,
                link:  '/audit-review',
                module: 'SYSTEM',
                recordType: 'audit_extension_requests',
                recordId: result.rows[0].id,
                email: { subject: 'Audit extension request', html },
            }));
        } catch { /* best-effort */ }
    })();

    sendCreated(res, result.rows[0], 'Extension request submitted');
});

// GET /api/audit/engagements/:id/extension-requests
const getMyExtensionRequests = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await assertEngagementAccess(id, req.user.id);
    const result = await query(
        `SELECT * FROM audit_extension_requests WHERE engagement_id = $1 ORDER BY created_at DESC`, [id]
    );
    sendSuccess(res, result.rows);
});

// GET /api/audit/extension-requests?status=PENDING
const listExtensionRequests = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`x.status = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(`
        SELECT x.*, e.name AS engagement_name,
               u.first_name || ' ' || u.last_name AS auditor_name, u.auditor_company_name
        FROM   audit_extension_requests x
        JOIN   audit_engagements e ON e.id = x.engagement_id
        JOIN   users u             ON u.id = x.requested_by
        ${where}
        ORDER BY x.created_at DESC
    `, params);
    sendSuccess(res, result.rows);
});

// POST /api/audit/extension-requests/:id/approve
const approveExtensionRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reviewer_notes } = req.body;
    const roles = req.user.roles || [];
    if (!roles.includes('Director') && !roles.includes('Secretary')) {
        throw createError.forbidden('Only a Director or Secretary can review extension requests');
    }

    const result = await withTransaction(async (client) => {
        const reqResult = await client.query(
            `SELECT * FROM audit_extension_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [id]
        );
        if (reqResult.rows.length === 0) throw createError.badRequest('Request not found or already reviewed');
        const extReq = reqResult.rows[0];

        await client.query(
            `UPDATE audit_engagements SET access_expires_at = $1 WHERE id = $2`,
            [extReq.requested_new_access_expires_at, extReq.engagement_id]
        );
        const updated = await client.query(`
            UPDATE audit_extension_requests
            SET    status = 'APPROVED', reviewed_by = $1, reviewed_at = NOW(), reviewer_notes = $2
            WHERE  id = $3
            RETURNING *
        `, [req.user.id, reviewer_notes || null, id]);

        await logAction(req.user.id, ACTIONS.AUDIT_EXTENSION_APPROVED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'audit_extension_requests',
            recordId:    parseInt(id),
            description: `Extension request ID ${id} approved — new access expiry ${extReq.requested_new_access_expires_at}`,
            client,
        });

        return updated.rows[0];
    });

    const engagementResult = await query(`SELECT name FROM audit_engagements WHERE id = $1`, [result.engagement_id]);
    const auditorResult = await query(`SELECT first_name FROM users WHERE id = $1`, [result.requested_by]);
    const engagementName = engagementResult.rows[0]?.name;
    const auditorFirstName = auditorResult.rows[0]?.first_name;

    notify({
        userId:  result.requested_by,
        type:    'AUDIT_EXTENSION_APPROVED',
        title:   'Extension approved',
        body:    `Your extension request for "${engagementName}" has been approved.`,
        link:    '/audit',
        module:  'SYSTEM',
        recordType: 'audit_extension_requests',
        recordId: result.id,
        email: {
            subject: 'Your audit extension request was approved',
            html: await wrapEmail(emailParagraphs([
                `Hello ${auditorFirstName},`,
                `Your request for more time on "${engagementName}" has been approved.`,
                `Your new access expiry is <strong>${new Date(result.requested_new_access_expires_at).toDateString()}</strong>.`,
            ]), { preheader: 'Your extension request was approved' }),
        },
    }).catch(() => {});

    sendSuccess(res, result, 'Extension approved');
});

// POST /api/audit/extension-requests/:id/reject
const rejectExtensionRequest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reviewer_notes } = req.body;
    const roles = req.user.roles || [];
    if (!roles.includes('Director') && !roles.includes('Secretary')) {
        throw createError.forbidden('Only a Director or Secretary can review extension requests');
    }

    const result = await query(`
        UPDATE audit_extension_requests
        SET    status = 'REJECTED', reviewed_by = $1, reviewed_at = NOW(), reviewer_notes = $2
        WHERE  id = $3 AND status = 'PENDING'
        RETURNING *
    `, [req.user.id, reviewer_notes || null, id]);

    if (result.rows.length === 0) throw createError.badRequest('Request not found or already reviewed');
    const extReq = result.rows[0];

    const engagementResult = await query(`SELECT name FROM audit_engagements WHERE id = $1`, [extReq.engagement_id]);
    const auditorResult = await query(`SELECT first_name FROM users WHERE id = $1`, [extReq.requested_by]);
    const engagementName = engagementResult.rows[0]?.name;
    const auditorFirstName = auditorResult.rows[0]?.first_name;

    await logAction(req.user.id, ACTIONS.AUDIT_EXTENSION_REJECTED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'audit_extension_requests',
        recordId:    parseInt(id),
        description: `Extension request ID ${id} rejected`,
    });

    notify({
        userId:  extReq.requested_by,
        type:    'AUDIT_EXTENSION_REJECTED',
        title:   'Extension request declined',
        body:    `Your extension request for "${engagementName}" was declined.`,
        link:    '/audit',
        module:  'SYSTEM',
        recordType: 'audit_extension_requests',
        recordId: extReq.id,
        email: {
            subject: 'Your audit extension request was declined',
            html: await wrapEmail(emailParagraphs([
                `Hello ${auditorFirstName},`,
                `Your request for more time on "${engagementName}" was declined.`,
                extReq.reviewer_notes ? `Note from the reviewer: "${extReq.reviewer_notes}"` : '',
                `Please contact the company directly if you have questions.`,
            ].filter(Boolean)), { preheader: 'Your extension request was declined' }),
        },
    }).catch(() => {});

    sendSuccess(res, extReq, 'Extension rejected');
});

module.exports = {
    // Admin
    listEngagements, getEngagementById, createEngagement, updateEngagement, revokeEngagement,
    addUserToEngagement, removeUserFromEngagement,
    addDocumentToEngagement, removeDocumentFromEngagement,
    // Auditor
    getMyEngagements, getAllowedAccounts, getEngagementTransactions,
    getEngagementDocuments, previewEngagementDocument, getEngagementSummary,
    // Auditor — submission workflow (v1.20.0)
    getComments, addComment,
    getReportFiles, uploadReportFile, deleteReportFile,
    getEngagementSubmissions, finishAudit,
    requestExtension, getMyExtensionRequests,
    // Director / Secretary — review (v1.20.0)
    listSubmissions, getSubmissionById, previewSubmissionFile,
    approveSubmission, rejectSubmission,
    listExtensionRequests, approveExtensionRequest, rejectExtensionRequest,
};
