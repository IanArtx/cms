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
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const path = require('path');
const fs   = require('fs');

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
        if (!doc.file_path || !fs.existsSync(doc.file_path)) {
            throw createError.notFound('The uploaded file could not be found on the server.');
        }
        return res.download(path.resolve(doc.file_path), doc.file_name || `document-${doc.id}`);
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

module.exports = {
    // Admin
    listEngagements, getEngagementById, createEngagement, updateEngagement, revokeEngagement,
    addUserToEngagement, removeUserFromEngagement,
    addDocumentToEngagement, removeDocumentFromEngagement,
    // Auditor
    getMyEngagements, getAllowedAccounts, getEngagementTransactions,
    getEngagementDocuments, previewEngagementDocument, getEngagementSummary,
};
