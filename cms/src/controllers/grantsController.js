// ============================================================
// GRANTS CONTROLLER
// Handles all grant management — receiving grants,
// recording tranches, and managing conditions.
//
// RULES ENFORCED HERE:
//   - Grants can be conditional or unconditional
//   - Conditional grants track each condition separately
//   - Grants can be received in multiple tranches
//   - Each tranche creates a transaction in the target account
//   - Grant amounts are tracked (received vs total)
//   - All grant activity is referenced and audited
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');

// ============================================================
// CREATE A GRANT RECORD
// POST /api/grants
// Records a new grant the company has received or is expecting.
// ============================================================
const createGrant = asyncHandler(async (req, res) => {
    const {
        account_id,
        category_id,
        grantor_name,
        grantor_type,
        grantor_contact,
        title,
        description,
        total_amount,
        is_conditional,
        start_date,
        end_date,
        conditions,
    } = req.body;

    await withTransaction(async (client) => {
        // Verify account exists
        const account = await client.query(`
            SELECT id, currency_id, name
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [account_id]);

        if (account.rows.length === 0) {
            throw createError.notFound('Account not found');
        }

        // Generate grant reference: GRN-GRANT-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.GRANT,
            'GRANT',
            'GRANT',
            req.user.id
        );

        // Create the grant record
        const grantResult = await client.query(`
            INSERT INTO grants (
                reference_id,
                account_id,
                currency_id,
                category_id,
                grantor_name,
                grantor_type,
                grantor_contact,
                title,
                description,
                total_amount,
                amount_received,
                is_conditional,
                start_date,
                end_date,
                status,
                created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                0, $11, $12, $13, 'PENDING', $14
            )
            RETURNING id
        `, [
            referenceId,
            account_id,
            account.rows[0].currency_id,
            category_id,
            grantor_name.trim(),
            grantor_type,
            grantor_contact || null,
            title.trim(),
            description || null,
            total_amount,
            is_conditional || false,
            start_date || null,
            end_date || null,
            req.user.id,
        ]);

        const grantId = grantResult.rows[0].id;

        // Link reference to grant
        await linkReferenceToRecord(client, referenceId, grantId);

        // If conditional, create the condition records
        if (is_conditional && conditions && conditions.length > 0) {
            for (const condition of conditions) {
                await client.query(`
                    INSERT INTO grant_conditions (
                        grant_id, title, description, due_date, created_by
                    ) VALUES ($1, $2, $3, $4, $5)
                `, [
                    grantId,
                    condition.title,
                    condition.description || null,
                    condition.due_date || null,
                    req.user.id,
                ]);
            }
        }

        // Create approval workflow
        await client.query(`
            INSERT INTO approval_workflows (
                workflow_type, record_type, record_id,
                required_approvals, initiated_by
            ) VALUES ('GRANT', 'grants', $1, 1, $2)
        `, [grantId, req.user.id]);

        await logAction(req.user.id, ACTIONS.GRANT_CREATED, MODULES.GRANTS, {
            ipAddress:   req.ip,
            recordType:  'grants',
            recordId:    grantId,
            newValues:   { referenceCode, title, total_amount, grantor_name },
            description: `Grant created: ${referenceCode} — ${title} from ${grantor_name}`,
            client,
        });

        sendCreated(res, {
            grant_id:    grantId,
            reference:   referenceCode,
            title,
            grantor:     grantor_name,
            total_amount,
            is_conditional,
            status:      'PENDING',
            conditions_added: is_conditional ? (conditions?.length || 0) : 0,
        }, `Grant record created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT A GRANT (before approval)
// PATCH /api/grants/:id
// Only while still PENDING. Editable by whoever created it, or
// anyone who could approve it. Conditions aren't editable here —
// use Manage Conditions once the grant exists.
// ============================================================
const editGrant = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        account_id, category_id, grantor_name, grantor_type,
        grantor_contact, title, description, total_amount,
        is_conditional, start_date, end_date,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM grants WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Grant not found');
        }
        const grant = existing.rows[0];

        if (grant.status !== 'PENDING') {
            throw createError.badRequest('Only a pending grant can be edited');
        }

        const isCreator = grant.created_by === req.user.id;
        const canApprove = (req.user.permissions || []).includes('GRANT_APPROVE');
        if (!isCreator && !canApprove) {
            throw createError.forbidden(
                'Only the person who created this grant, or someone who can approve it, can edit it'
            );
        }

        let currencyId = grant.currency_id;
        if (account_id) {
            const account = await client.query(
                'SELECT id, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE', [account_id]
            );
            if (account.rows.length === 0) {
                throw createError.notFound('Account not found');
            }
            currencyId = account.rows[0].currency_id;
        }

        const updated = await client.query(`
            UPDATE grants
            SET    account_id      = COALESCE($1, account_id),
                   currency_id     = $2,
                   category_id     = COALESCE($3, category_id),
                   grantor_name    = COALESCE($4, grantor_name),
                   grantor_type    = COALESCE($5, grantor_type),
                   grantor_contact = COALESCE($6, grantor_contact),
                   title           = COALESCE($7, title),
                   description     = COALESCE($8, description),
                   total_amount    = COALESCE($9, total_amount),
                   is_conditional  = COALESCE($10, is_conditional),
                   start_date      = COALESCE($11, start_date),
                   end_date        = $12
            WHERE  id = $13
            RETURNING *
        `, [
            account_id || null, currencyId, category_id || null,
            grantor_name ? grantor_name.trim() : null, grantor_type || null,
            grantor_contact !== undefined ? grantor_contact : null,
            title ? title.trim() : null, description !== undefined ? description : null,
            total_amount || null, is_conditional !== undefined ? is_conditional : null,
            start_date || null, end_date !== undefined ? end_date : grant.end_date,
            id,
        ]);

        await logAction(req.user.id, ACTIONS.GRANT_UPDATED, MODULES.GRANTS, {
            ipAddress:   req.ip,
            recordType:  'grants',
            recordId:    id,
            oldValues:   grant,
            newValues:   updated.rows[0],
            description: `Grant edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Grant updated');
    });
});

// ============================================================
// APPROVE A GRANT
// POST /api/grants/:id/approve
// ============================================================
const approveGrant = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const grant = await client.query(`
            SELECT * FROM grants WHERE id = $1 FOR UPDATE
        `, [id]);

        if (grant.rows.length === 0) {
            throw createError.notFound('Grant not found');
        }
        if (grant.rows[0].status !== 'PENDING') {
            throw createError.badRequest(
                `Grant cannot be approved. Current status: ${grant.rows[0].status}`
            );
        }

        await client.query(`
            UPDATE grants
            SET    status      = 'ACTIVE',
                   approved_by = $1,
                   approved_at = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        await client.query(`
            UPDATE approval_workflows
            SET    status            = 'APPROVED',
                   current_approvals = 1,
                   completed_at      = NOW()
            WHERE  record_type = 'grants'
            AND    record_id   = $1
        `, [id]);

        await logAction(req.user.id, ACTIONS.GRANT_APPROVED, MODULES.GRANTS, {
            ipAddress:   req.ip,
            recordType:  'grants',
            recordId:    parseInt(id),
            description: `Grant approved: ID ${id}`,
            client,
        });

        notify({
            userId:     grant.rows[0].created_by,
            type:       'GRANT_APPROVED',
            title:      'Grant approved',
            body:       `The grant "${grant.rows[0].title}" from ${grant.rows[0].grantor_name} was approved.`,
            link:       `/grants/${id}`,
            module:     'GRANTS',
            recordType: 'grants',
            recordId:   parseInt(id),
            email: {
                subject: `Grant approved — ${grant.rows[0].title}`,
                html:    await wrapEmail(`
                    <p>The grant you recorded has been approved:</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Title</td><td style="padding:4px 0; text-align:right;">${grant.rows[0].title}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Grantor</td><td style="padding:4px 0; text-align:right;">${grant.rows[0].grantor_name}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Total amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${grant.rows[0].total_amount}</td></tr>
                    </table>
                    <p>Tranches can now be recorded against it.</p>
                `, { preheader: 'Your grant has been approved' }),
            },
        });

        sendSuccess(res, null, 'Grant approved successfully');
    });
});

// ============================================================
// RECORD A GRANT TRANCHE
// POST /api/grants/:id/tranches
// Records each disbursement of a grant.
// Each tranche creates a transaction in the grant account.
// ============================================================
const recordTranche = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, received_date, notes } = req.body;

    await withTransaction(async (client) => {
        // Get the grant
        const grantResult = await client.query(`
            SELECT g.*, a.currency_id, a.name AS account_name,
                   a.account_type, a.reference_prefix,
                   r.reference_code
            FROM   grants g
            JOIN   accounts a ON a.id = g.account_id
            JOIN   references_registry r ON r.id = g.reference_id
            WHERE  g.id = $1
            FOR UPDATE
        `, [id]);

        if (grantResult.rows.length === 0) {
            throw createError.notFound('Grant not found');
        }

        const grant = grantResult.rows[0];

        if (grant.status === 'PENDING') {
            throw createError.badRequest(
                'Grant must be approved before recording tranches'
            );
        }
        if (grant.status === 'FULLY_RECEIVED' || grant.status === 'CLOSED') {
            throw createError.badRequest(
                'Grant is already fully received or closed'
            );
        }

        // Check tranche does not exceed total grant amount
        const newTotalReceived = parseFloat(grant.amount_received) + parseFloat(amount);
        if (newTotalReceived > parseFloat(grant.total_amount)) {
            throw createError.badRequest(
                `This tranche of ${amount} would exceed the total grant amount of ` +
                `${grant.total_amount}. Remaining: ` +
                `${parseFloat(grant.total_amount) - parseFloat(grant.amount_received)}`
            );
        }

        // Get next tranche number
        const trancheCount = await client.query(
            `SELECT COUNT(*) AS count FROM grant_tranches WHERE grant_id = $1`,
            [id]
        );
        const trancheNumber = parseInt(trancheCount.rows[0].count) + 1;

        // Generate tranche reference: GRN-TRANCHE-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.GRANT,
            'TRANCHE',
            'GRANT_TRANCHE',
            req.user.id
        );

        // Generate transaction reference
        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(grant),
            'GRANT',
            'TRANSACTION',
            req.user.id
        );

        // Post the transaction — money arrives in the account
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       grant.account_id,
            transactionType: 'CREDIT',
            inflowType:      'GRANT',
            amount,
            currencyId:      grant.currency_id,
            categoryId:      grant.category_id,
            description:     `Grant tranche ${trancheNumber} — ${grant.title} ` +
                             `(${grant.reference_code})`,
            valueDate:       received_date,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            grantTrancheId:  null, // updated after tranche created
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Create the tranche record
        const trancheResult = await client.query(`
            INSERT INTO grant_tranches (
                reference_id, grant_id, tranche_number,
                amount, received_date, transaction_id, notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [
            referenceId,
            id,
            trancheNumber,
            amount,
            received_date,
            transactionId,
            notes || null,
            req.user.id,
        ]);

        await linkReferenceToRecord(client, referenceId, trancheResult.rows[0].id);

        // Update grant amount received and status
        const isFullyReceived = newTotalReceived >= parseFloat(grant.total_amount);
        await client.query(`
            UPDATE grants
            SET    amount_received = $1,
                   status = CASE
                       WHEN $2 THEN 'FULLY_RECEIVED'
                       ELSE 'PARTIALLY_RECEIVED'
                   END
            WHERE  id = $3
        `, [newTotalReceived, isFullyReceived, id]);

        await logAction(req.user.id, ACTIONS.GRANT_TRANCHE_RECORDED, MODULES.GRANTS, {
            ipAddress:   req.ip,
            recordType:  'grant_tranches',
            recordId:    trancheResult.rows[0].id,
            newValues:   { referenceCode, amount, trancheNumber, balanceBefore, balanceAfter },
            description: `Grant tranche ${trancheNumber} recorded: ${referenceCode} — ${amount}`,
            client,
        });

        sendCreated(res, {
            tranche_reference: referenceCode,
            tranche_number:    trancheNumber,
            amount,
            total_received:    newTotalReceived,
            total_grant:       grant.total_amount,
            is_fully_received: isFullyReceived,
            balance_before:    balanceBefore,
            balance_after:     balanceAfter,
        }, `Tranche ${trancheNumber} recorded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// UPDATE GRANT CONDITION STATUS
// PATCH /api/grants/:id/conditions/:conditionId
// ============================================================
const updateCondition = asyncHandler(async (req, res) => {
    const { id, conditionId } = req.params;
    const { status, met_at } = req.body;

    const result = await query(`
        UPDATE grant_conditions
        SET    status = $1,
               met_at = $2
        WHERE  id = $3
        AND    grant_id = $4
        RETURNING *
    `, [status, met_at || null, conditionId, id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Condition not found');
    }

    await logAction(req.user.id, ACTIONS.GRANT_CONDITION_MET, MODULES.GRANTS, {
        ipAddress:   req.ip,
        recordType:  'grant_conditions',
        recordId:    parseInt(conditionId),
        newValues:   { status, met_at },
        description: `Grant condition updated to ${status}`,
    });

    sendSuccess(res, result.rows[0], 'Condition updated successfully');
});

// ============================================================
// GET ALL GRANTS
// GET /api/grants
// ============================================================
const getAllGrants = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`g.status = $${p}`);
        params.push(status.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM grants g ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            g.id,
            g.title,
            g.grantor_name,
            g.grantor_type,
            g.total_amount,
            g.amount_received,
            g.amount_remaining,
            g.is_conditional,
            g.status,
            g.start_date,
            g.end_date,
            g.created_at,
            g.created_by,
            r.reference_code,
            r.public_id,
            a.name        AS account_name,
            c.code        AS currency_code,
            c.symbol      AS currency_symbol,
            cat.name      AS category_name,
            cp.full_path  AS category_trail,
            u.first_name  || ' ' || u.last_name AS created_by_name,
            -- Count conditions
            (
                SELECT COUNT(*) FROM grant_conditions gc
                WHERE  gc.grant_id = g.id
            ) AS total_conditions,
            (
                SELECT COUNT(*) FROM grant_conditions gc
                WHERE  gc.grant_id = g.id AND gc.status = 'MET'
            ) AS conditions_met
        FROM  grants g
        JOIN  references_registry r ON r.id  = g.reference_id
        JOIN  accounts a            ON a.id  = g.account_id
        JOIN  currencies c          ON c.id  = g.currency_id
        JOIN  categories cat        ON cat.id = g.category_id
        JOIN  category_paths cp     ON cp.category_id = g.category_id
        JOIN  users u               ON u.id  = g.created_by
        ${where}
        ORDER BY g.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE GRANT WITH FULL DETAILS
// GET /api/grants/:id
// ============================================================
const getGrantById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            g.*,
            r.reference_code,
            a.name        AS account_name,
            c.code        AS currency_code,
            c.symbol      AS currency_symbol,
            cat.name      AS category_name,
            cp.full_path  AS category_trail,
            u.first_name  || ' ' || u.last_name AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name,
            -- Tranches
            (
                SELECT json_agg(t_data ORDER BY t_data.tranche_number ASC)
                FROM (
                    SELECT
                        gt.id, gt.tranche_number, gt.amount,
                        gt.received_date, gt.notes,
                        tr.reference_code AS tranche_reference
                    FROM grant_tranches gt
                    JOIN references_registry tr ON tr.id = gt.reference_id
                    WHERE gt.grant_id = g.id
                ) t_data
            ) AS tranches,
            -- Conditions
            (
                SELECT json_agg(c_data ORDER BY c_data.id ASC)
                FROM (
                    SELECT
                        gc.id, gc.title, gc.description,
                        gc.due_date, gc.status, gc.met_at
                    FROM grant_conditions gc
                    WHERE gc.grant_id = g.id
                ) c_data
            ) AS conditions
        FROM  grants g
        JOIN  references_registry r   ON r.id  = g.reference_id
        JOIN  accounts a              ON a.id  = g.account_id
        JOIN  currencies c            ON c.id  = g.currency_id
        JOIN  categories cat          ON cat.id = g.category_id
        JOIN  category_paths cp       ON cp.category_id = g.category_id
        JOIN  users u                 ON u.id  = g.created_by
        LEFT JOIN users approver      ON approver.id = g.approved_by
        WHERE g.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Grant not found');
    }

    sendSuccess(res, result.rows[0]);
});

module.exports = {
    createGrant,
    editGrant,
    approveGrant,
    recordTranche,
    updateCondition,
    getAllGrants,
    getGrantById,
};