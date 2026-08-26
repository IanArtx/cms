// ============================================================
// TRANSFERS CONTROLLER
// Handles moving money between accounts.
//
// RULES ENFORCED HERE:
//   - Every transfer records the exchange rate manually
//   - Primary to Secondary requires Treasurer approval
//   - Secondary to Primary requires 3 Director approvals
//   - A transfer creates TWO transactions (debit + credit)
//   - Both legs are atomic — either both succeed or neither does
//   - Exchange rate and all approvers are permanently recorded
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
// INITIATE A TRANSFER
// POST /api/transfers
// Any Director can initiate a transfer.
// It starts in PENDING status and waits for approval.
// ============================================================
const initiateTransfer = asyncHandler(async (req, res) => {
    const {
        from_account_id,
        to_account_id,
        amount_sent,
        exchange_rate,
        category_id,
        description,
        value_date,
        sending_bank_charge,
        receiving_bank_charge,
    } = req.body;

    await withTransaction(async (client) => {
        // Load both accounts
        const fromAccount = await client.query(`
            SELECT id, account_type, currency_id, current_balance, name
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [from_account_id]);

        const toAccount = await client.query(`
            SELECT id, account_type, currency_id, name
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [to_account_id]);

        if (fromAccount.rows.length === 0) {
            throw createError.notFound('Source account not found');
        }
        if (toAccount.rows.length === 0) {
            throw createError.notFound('Destination account not found');
        }

        const from = fromAccount.rows[0];
        const to   = toAccount.rows[0];

        if (from_account_id === to_account_id) {
            throw createError.badRequest('Cannot transfer to the same account');
        }

        // Determine transfer type
        let transferType;
        if (from.account_type === 'PRIMARY' && to.account_type === 'SECONDARY') {
            transferType = 'PRIMARY_TO_SECONDARY';
        } else if (from.account_type === 'SECONDARY' && to.account_type === 'PRIMARY') {
            transferType = 'SECONDARY_TO_PRIMARY';
        } else {
            throw createError.badRequest(
                'Transfers are only allowed between primary and secondary accounts'
            );
        }

        // Two accounts sharing the same currency never have an exchange
        // rate between them — it's locked to 1, regardless of what (if
        // anything) was submitted. Bank charges still apply independently.
        const sameCurrency = from.currency_id === to.currency_id;
        if (!sameCurrency && (exchange_rate === undefined || exchange_rate === null || exchange_rate === '')) {
            throw createError.badRequest(
                'An exchange rate is required when the two accounts use different currencies'
            );
        }
        const effectiveExchangeRate = sameCurrency ? 1 : parseFloat(exchange_rate);

        const amountReceived = parseFloat(amount_sent) * effectiveExchangeRate;
        const sendingCharge   = parseFloat(sending_bank_charge   || 0);
        const receivingCharge = parseFloat(receiving_bank_charge  || 0);

        // Generate transfer reference
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.TRANSFER,
            transferType === 'PRIMARY_TO_SECONDARY' ? 'P2S' : 'S2P',
            'TRANSFER',
            req.user.id
        );

        // Create the transfer record
        const transferResult = await client.query(`
            INSERT INTO transfers (
                reference_id,
                from_account_id,
                to_account_id,
                transfer_type,
                amount_sent,
                currency_sent_id,
                amount_received,
                currency_received_id,
                exchange_rate,
                exchange_rate_entered_by,
                category_id,
                description,
                value_date,
                sending_bank_charge,
                receiving_bank_charge,
                status,
                created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, 'AWAITING_APPROVAL', $16
            )
            RETURNING id
        `, [
            referenceId,
            from_account_id,
            to_account_id,
            transferType,
            amount_sent,
            from.currency_id,
            amountReceived,
            to.currency_id,
            effectiveExchangeRate,
            req.user.id,
            category_id,
            description || null,
            value_date,
            sendingCharge,
            receivingCharge,
            req.user.id,
        ]);

        const transferId = transferResult.rows[0].id;
        await linkReferenceToRecord(client, referenceId, transferId);

        // Create approval workflow
        const requiredApprovals = transferType === 'PRIMARY_TO_SECONDARY' ? 1 : 3;

        await client.query(`
            INSERT INTO approval_workflows (
                workflow_type, record_type, record_id,
                required_approvals, initiated_by
            ) VALUES ($1, 'transfers', $2, $3, $4)
        `, [
            transferType === 'PRIMARY_TO_SECONDARY'
                ? 'PRIMARY_TO_SECONDARY_TRANSFER'
                : 'SECONDARY_TO_PRIMARY_TRANSFER',
            transferId,
            requiredApprovals,
            req.user.id,
        ]);

        await logAction(req.user.id, ACTIONS.TRANSFER_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transfers',
            recordId:    transferId,
            newValues:   {
                referenceCode, from_account_id, to_account_id,
                amount_sent, exchange_rate: effectiveExchangeRate, amountReceived,
                transferType, sendingCharge, receivingCharge,
            },
            description: `Transfer initiated: ${referenceCode} — ` +
                         `${from.name} to ${to.name} — Amount: ${amount_sent}`,
            client,
        });

        sendCreated(res, {
            transfer_id:        transferId,
            reference:          referenceCode,
            transfer_type:      transferType,
            from_account:       from.name,
            to_account:         to.name,
            amount_sent,
            amount_received:    amountReceived,
            exchange_rate,
            sending_bank_charge:   sendingCharge,
            receiving_bank_charge: receivingCharge,
            required_approvals: requiredApprovals,
            status:             'AWAITING_APPROVAL',
        }, `Transfer initiated. Reference: ${referenceCode}. Awaiting approval.`);
    });
});

// ============================================================
// EDIT A TRANSFER (before approval)
// PATCH /api/transfers/:id
// Only while still AWAITING_APPROVAL — once any approval has been
// recorded, the transfer is locked and must be rejected + recreated
// instead. Editable by whoever initiated it, or anyone who could
// approve it.
// ============================================================
const editTransfer = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        amount_sent, exchange_rate, category_id,
        description, value_date,
        sending_bank_charge, receiving_bank_charge,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT t.*, fa.currency_id AS from_currency_id, ta.currency_id AS to_currency_id
            FROM   transfers t
            JOIN   accounts fa ON fa.id = t.from_account_id
            JOIN   accounts ta ON ta.id = t.to_account_id
            WHERE  t.id = $1
            FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Transfer not found');
        }
        const transfer = existing.rows[0];

        if (transfer.status !== 'AWAITING_APPROVAL') {
            throw createError.badRequest(
                'Only a transfer still awaiting approval can be edited'
            );
        }

        const isCreator = transfer.created_by === req.user.id;
        const canApprove = (req.user.permissions || []).includes('FINANCE_TRANSFER_APPROVE');
        if (!isCreator && !canApprove) {
            throw createError.forbidden(
                'Only the person who initiated this transfer, or someone who can approve it, can edit it'
            );
        }

        const sameCurrency = transfer.from_currency_id === transfer.to_currency_id;

        const newAmountSent    = amount_sent    !== undefined ? parseFloat(amount_sent)    : parseFloat(transfer.amount_sent);
        const newExchangeRate  = sameCurrency
            ? 1
            : (exchange_rate !== undefined ? parseFloat(exchange_rate) : parseFloat(transfer.exchange_rate));
        const newAmountReceived = newAmountSent * newExchangeRate;

        const updated = await client.query(`
            UPDATE transfers
            SET    amount_sent            = $1,
                   exchange_rate           = $2,
                   amount_received         = $3,
                   category_id             = COALESCE($4, category_id),
                   description             = COALESCE($5, description),
                   value_date              = COALESCE($6, value_date),
                   sending_bank_charge     = COALESCE($7, sending_bank_charge),
                   receiving_bank_charge   = COALESCE($8, receiving_bank_charge)
            WHERE  id = $9
            RETURNING *
        `, [
            newAmountSent, newExchangeRate, newAmountReceived,
            category_id || null, description !== undefined ? description : null,
            value_date || null,
            sending_bank_charge !== undefined ? sending_bank_charge : null,
            receiving_bank_charge !== undefined ? receiving_bank_charge : null,
            id,
        ]);

        await logAction(req.user.id, ACTIONS.TRANSFER_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transfers',
            recordId:    id,
            oldValues:   transfer,
            newValues:   updated.rows[0],
            description: `Transfer edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Transfer updated');
    });
});

// ============================================================
// APPROVE A TRANSFER
// POST /api/transfers/:id/approve
// Treasurer approves Primary to Secondary.
// Directors approve Secondary to Primary (needs 3).
// ============================================================
const approveTransfer = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;

    await withTransaction(async (client) => {
        // Get the transfer
        const transferResult = await client.query(`
            SELECT t.*,
                   fa.account_type AS from_type,
                   fa.currency_id  AS from_currency,
                   fa.name         AS from_name,
                   fa.reference_prefix AS from_reference_prefix,
                   ta.account_type AS to_type,
                   ta.currency_id  AS to_currency,
                   ta.name         AS to_name,
                   ta.reference_prefix AS to_reference_prefix
            FROM   transfers t
            JOIN   accounts fa ON fa.id = t.from_account_id
            JOIN   accounts ta ON ta.id = t.to_account_id
            WHERE  t.id = $1
            FOR UPDATE
        `, [id]);

        if (transferResult.rows.length === 0) {
            throw createError.notFound('Transfer not found');
        }

        const transfer = transferResult.rows[0];

        if (transfer.status !== 'AWAITING_APPROVAL') {
            throw createError.badRequest(
                `Transfer cannot be approved. Current status: ${transfer.status}`
            );
        }

        // Get the approval workflow
        const workflowResult = await client.query(`
            SELECT * FROM approval_workflows
            WHERE  record_type = 'transfers'
            AND    record_id   = $1
            AND    status      = 'PENDING'
        `, [id]);

        if (workflowResult.rows.length === 0) {
            throw createError.notFound('Approval workflow not found');
        }

        const workflow = workflowResult.rows[0];

        // Check this user has not already approved
        const alreadyApproved = await client.query(`
            SELECT id FROM approval_actions
            WHERE  workflow_id = $1
            AND    actor_id    = $2
        `, [workflow.id, req.user.id]);

        if (alreadyApproved.rows.length > 0) {
            throw createError.badRequest('You have already approved this transfer');
        }

        // Check the user has the right role
        if (transfer.transfer_type === 'PRIMARY_TO_SECONDARY') {
            // Treasurer only
            if (!req.user.roles.includes('Treasurer')) {
                throw createError.forbidden(
                    'Only the Treasurer can approve Primary to Secondary transfers'
                );
            }
        } else {
            // Director only for Secondary to Primary
            if (!req.user.roles.includes('Director')) {
                throw createError.forbidden(
                    'Only Directors can approve Secondary to Primary transfers'
                );
            }
        }

        // Get the approver's role id
        const roleResult = await client.query(`
            SELECT r.id FROM roles r
            JOIN   user_roles ur ON ur.role_id = r.id
            WHERE  ur.user_id    = $1
            AND    ur.revoked_at IS NULL
            AND    r.name = $2
        `, [
            req.user.id,
            transfer.transfer_type === 'PRIMARY_TO_SECONDARY' ? 'Treasurer' : 'Director',
        ]);

        // Record this approval action
        await client.query(`
            INSERT INTO approval_actions
                (workflow_id, actor_id, action, role_id, notes)
            VALUES ($1, $2, 'APPROVED', $3, $4)
        `, [workflow.id, req.user.id, roleResult.rows[0].id, notes || null]);

        // Update approval count
        const newApprovalCount = workflow.current_approvals + 1;

        await client.query(`
            UPDATE approval_workflows
            SET    current_approvals = $1
            WHERE  id = $2
        `, [newApprovalCount, workflow.id]);

        // Check if we have enough approvals to post the transfer
        if (newApprovalCount >= workflow.required_approvals) {
            // All approvals received — post the transfer
            await client.query(`
                UPDATE approval_workflows
                SET    status       = 'APPROVED',
                       completed_at = NOW()
                WHERE  id = $1
            `, [workflow.id]);

            // Generate references for both transaction legs — each side
            // uses its own account's reference_prefix if one is set,
            // else the generic PA/SA module code for its account type.
            // (Previously the credit leg always used the generic SA
            // code regardless of the destination account type — fixed
            // here as part of wiring per-account prefixes through.)
            const fromModuleCode = resolveModuleCode({
                account_type: transfer.from_type,
                reference_prefix: transfer.from_reference_prefix,
            });
            const toModuleCode = resolveModuleCode({
                account_type: transfer.to_type,
                reference_prefix: transfer.to_reference_prefix,
            });

            const { referenceId: debitRefId, referenceCode: debitRefCode } =
                await generateReference(
                    client, fromModuleCode, 'TRF-OUT', 'TRANSACTION', req.user.id
                );

            const { referenceId: creditRefId, referenceCode: creditRefCode } =
                await generateReference(
                    client,
                    toModuleCode,
                    'TRF-IN',
                    'TRANSACTION',
                    req.user.id
                );

            // POST THE DEBIT LEG (money leaving source account)
            const { transactionId: debitTxId } = await postTransaction(client, {
                accountId:       transfer.from_account_id,
                transactionType: 'DEBIT',
                inflowType:      'TRANSFER_OUT',
                amount:          transfer.amount_sent,
                currencyId:      transfer.from_currency,
                categoryId:      transfer.category_id,
                description:     `Transfer out to ${transfer.to_name} — ` +
                                 `Rate: ${transfer.exchange_rate}`,
                valueDate:       transfer.value_date,
                createdBy:       req.user.id,
                referenceId:     debitRefId,
                transferId:      transfer.id,
            });

            await linkReferenceToRecord(client, debitRefId, debitTxId);

            // POST THE CREDIT LEG (money arriving in destination account)
            const { transactionId: creditTxId } = await postTransaction(client, {
                accountId:       transfer.to_account_id,
                transactionType: 'CREDIT',
                inflowType:      'TRANSFER_IN',
                amount:          transfer.amount_received,
                currencyId:      transfer.to_currency,
                categoryId:      transfer.category_id,
                description:     `Transfer in from ${transfer.from_name} — ` +
                                 `Rate: ${transfer.exchange_rate}`,
                valueDate:       transfer.value_date,
                createdBy:       req.user.id,
                referenceId:     creditRefId,
                transferId:      transfer.id,
            });

            await linkReferenceToRecord(client, creditRefId, creditTxId);

            // --------------------------------------------------------
            // POST BANK CHARGE TRANSACTIONS (if any)
            // --------------------------------------------------------
            let sendingChargeTxId   = null;
            let receivingChargeTxId = null;

            if (parseFloat(transfer.sending_bank_charge || 0) > 0) {
                const { referenceId: scRefId } = await generateReference(
                    client, fromModuleCode, 'BANK-CHG', 'TRANSACTION', req.user.id
                );
                const { transactionId: scTxId } = await postTransaction(client, {
                    accountId:       transfer.from_account_id,
                    transactionType: 'DEBIT',
                    inflowType:      'EXPENSE',
                    amount:          transfer.sending_bank_charge,
                    currencyId:      transfer.from_currency,
                    categoryId:      transfer.category_id,
                    description:     `Sending bank charge — Transfer ${transfer.reference_id}`,
                    valueDate:       transfer.value_date,
                    createdBy:       req.user.id,
                    referenceId:     scRefId,
                    transferId:      transfer.id,
                });
                await linkReferenceToRecord(client, scRefId, scTxId);
                sendingChargeTxId = scTxId;
            }

            if (parseFloat(transfer.receiving_bank_charge || 0) > 0) {
                // Reuses the `toModuleCode` resolved above (destination
                // account's own reference_prefix, or its PA/SA fallback).
                const { referenceId: rcRefId } = await generateReference(
                    client, toModuleCode, 'BANK-CHG', 'TRANSACTION', req.user.id
                );
                const { transactionId: rcTxId } = await postTransaction(client, {
                    accountId:       transfer.to_account_id,
                    transactionType: 'DEBIT',
                    inflowType:      'EXPENSE',
                    amount:          transfer.receiving_bank_charge,
                    currencyId:      transfer.to_currency,
                    categoryId:      transfer.category_id,
                    description:     `Receiving bank charge — Transfer ${transfer.reference_id}`,
                    valueDate:       transfer.value_date,
                    createdBy:       req.user.id,
                    referenceId:     rcRefId,
                    transferId:      transfer.id,
                });
                await linkReferenceToRecord(client, rcRefId, rcTxId);
                receivingChargeTxId = rcTxId;
            }

            // Update transfer record with transaction IDs and status
            await client.query(`
                UPDATE transfers
                SET    status                 = 'POSTED',
                       debit_transaction_id   = $1,
                       credit_transaction_id  = $2,
                       sending_charge_tx_id   = $3,
                       receiving_charge_tx_id = $4
                WHERE  id = $5
            `, [debitTxId, creditTxId, sendingChargeTxId, receivingChargeTxId, transfer.id]);

            await logAction(req.user.id, ACTIONS.TRANSFER_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'transfers',
                recordId:    transfer.id,
                description: `Transfer approved and posted: ${debitRefCode} / ${creditRefCode}`,
                client,
            });

            notify({
                userId:     transfer.created_by,
                type:       'TRANSFER_POSTED',
                title:      'Transfer approved and posted',
                body:       `Your transfer from ${transfer.from_name} to ${transfer.to_name} for ${transfer.amount_sent} has been fully approved and posted.`,
                // v1.41.0 fix: there is no /transfers/:id detail route —
                // TransfersPage.jsx is list-only — so this used to silently
                // bounce to the dashboard.
                link:       `/transfers`,
                module:     'FINANCE',
                recordType: 'transfers',
                recordId:   transfer.id,
                email: {
                    subject: `Transfer posted — ${debitRefCode}`,
                    html:    await wrapEmail(`
                        <p>Your transfer has received all required approvals and has been posted to the ledger:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">From</td><td style="padding:4px 0; text-align:right;">${transfer.from_name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">To</td><td style="padding:4px 0; text-align:right;">${transfer.to_name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Amount sent</td><td style="padding:4px 0; text-align:right; font-weight:700;">${transfer.amount_sent}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Amount received</td><td style="padding:4px 0; text-align:right;">${transfer.amount_received}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Exchange rate</td><td style="padding:4px 0; text-align:right;">${transfer.exchange_rate}</td></tr>
                        </table>
                    `, { preheader: 'Your transfer has been posted' }),
                },
            });

            return sendSuccess(res, {
                status:              'POSTED',
                debit_reference:     debitRefCode,
                credit_reference:    creditRefCode,
                amount_sent:         transfer.amount_sent,
                amount_received:     transfer.amount_received,
                exchange_rate:       transfer.exchange_rate,
            }, 'Transfer approved and posted successfully.');
        }

        // Not enough approvals yet — waiting for more
        const remaining = workflow.required_approvals - newApprovalCount;

        await logAction(req.user.id, ACTIONS.TRANSFER_APPROVED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transfers',
            recordId:    transfer.id,
            description: `Transfer approval recorded. ${remaining} more approval(s) needed.`,
            client,
        });

        // Bell-only progress update for the initiator — no email for
        // partial approvals, to avoid noise; the final approval above
        // sends the full email confirmation.
        notify({
            userId:     transfer.created_by,
            type:       'TRANSFER_APPROVAL_PROGRESS',
            title:      'Transfer approval progress',
            body:       `Your transfer received an approval. ${remaining} more needed before it posts.`,
            // v1.41.1 fix: no /transfers/:id detail route exists — TransfersPage.jsx is list-only.
            link:       `/transfers`,
            module:     'FINANCE',
            recordType: 'transfers',
            recordId:   transfer.id,
        });

        sendSuccess(res, {
            status:             'AWAITING_APPROVAL',
            approvals_received: newApprovalCount,
            approvals_required: workflow.required_approvals,
            remaining,
        }, `Approval recorded. ${remaining} more approval(s) needed.`);
    });
});

// ============================================================
// REJECT A TRANSFER
// POST /api/transfers/:id/reject
// ============================================================
const rejectTransfer = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const transferResult = await client.query(`
            SELECT * FROM transfers WHERE id = $1 FOR UPDATE
        `, [id]);

        if (transferResult.rows.length === 0) {
            throw createError.notFound('Transfer not found');
        }

        const transfer = transferResult.rows[0];

        if (transfer.status !== 'AWAITING_APPROVAL') {
            throw createError.badRequest(
                `Transfer cannot be rejected. Current status: ${transfer.status}`
            );
        }

        // Update transfer status
        await client.query(`
            UPDATE transfers SET status = 'REJECTED' WHERE id = $1
        `, [id]);

        // Update workflow status
        await client.query(`
            UPDATE approval_workflows
            SET    status       = 'REJECTED',
                   completed_at = NOW(),
                   notes        = $1
            WHERE  record_type  = 'transfers'
            AND    record_id    = $2
        `, [reason, id]);

        await logAction(req.user.id, ACTIONS.TRANSFER_REJECTED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transfers',
            recordId:    transfer.id,
            description: `Transfer rejected. Reason: ${reason}`,
            client,
        });

        notify({
            userId:     transfer.created_by,
            type:       'TRANSFER_REJECTED',
            title:      'Transfer rejected',
            body:       `Your transfer of ${transfer.amount_sent} was rejected.${reason ? ` Reason: ${reason}` : ''}`,
            // v1.41.1 fix: no /transfers/:id detail route exists — TransfersPage.jsx is list-only.
            link:       `/transfers`,
            module:     'FINANCE',
            recordType: 'transfers',
            recordId:   transfer.id,
            email: {
                subject: `Transfer rejected`,
                html:    await wrapEmail(`
                    <p>Your transfer of <strong>${transfer.amount_sent}</strong> was not approved.</p>
                    ${reason ? `<p style="color:#6b7280;">Reason: ${reason}</p>` : ''}
                `, { preheader: 'Your transfer was rejected' }),
            },
        });

        sendSuccess(res, null, 'Transfer rejected successfully.');
    });
});

// ============================================================
// GET ALL TRANSFERS
// GET /api/transfers
// ============================================================
const getTransfers = asyncHandler(async (req, res) => {
    const { status, transfer_type } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`t.status = $${p}`);
        params.push(status.toUpperCase());
    }
    if (transfer_type) {
        p++; conditions.push(`t.transfer_type = $${p}`);
        params.push(transfer_type.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM transfers t ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            t.id,
            t.transfer_type,
            t.from_account_id,
            t.to_account_id,
            t.amount_sent,
            t.amount_received,
            t.exchange_rate,
            t.value_date,
            t.status,
            t.created_at,
            t.created_by,
            t.category_id,
            t.description,
            t.sending_bank_charge,
            t.receiving_bank_charge,
            r.reference_code,
            r.public_id,
            fa.name AS from_account,
            ta.name AS to_account,
            fc.code AS from_currency,
            tc.code AS to_currency,
            u.first_name || ' ' || u.last_name AS initiated_by,
            -- Approval progress
            aw.required_approvals,
            aw.current_approvals
        FROM  transfers t
        JOIN  references_registry r ON r.id  = t.reference_id
        JOIN  accounts fa           ON fa.id = t.from_account_id
        JOIN  accounts ta           ON ta.id = t.to_account_id
        JOIN  currencies fc         ON fc.id = t.currency_sent_id
        JOIN  currencies tc         ON tc.id = t.currency_received_id
        JOIN  users u               ON u.id  = t.created_by
        LEFT JOIN approval_workflows aw
            ON aw.record_type = 'transfers' AND aw.record_id = t.id
        ${where}
        ORDER BY t.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE TRANSFER
// GET /api/transfers/:id
// ============================================================
const getTransferById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            t.*,
            r.reference_code,
            r.public_id,
            fa.name AS from_account_name,
            ta.name AS to_account_name,
            fc.code AS from_currency_code,
            tc.code AS to_currency_code,
            u.first_name || ' ' || u.last_name AS initiated_by_name,
            -- Full approval history
            (
                SELECT json_agg(aa_data ORDER BY aa_data.acted_at ASC)
                FROM (
                    SELECT
                        aa.action,
                        aa.notes,
                        aa.acted_at,
                        approver.first_name || ' ' || approver.last_name AS approver_name,
                        ro.name AS approver_role
                    FROM approval_actions aa
                    JOIN approval_workflows aw ON aw.id = aa.workflow_id
                    JOIN users approver        ON approver.id = aa.actor_id
                    JOIN roles ro              ON ro.id = aa.role_id
                    WHERE aw.record_type = 'transfers'
                    AND   aw.record_id   = t.id
                ) aa_data
            ) AS approval_history,
            aw.required_approvals,
            aw.current_approvals,
            aw.status AS workflow_status
        FROM  transfers t
        JOIN  references_registry r ON r.id  = t.reference_id
        JOIN  accounts fa           ON fa.id = t.from_account_id
        JOIN  accounts ta           ON ta.id = t.to_account_id
        JOIN  currencies fc         ON fc.id = t.currency_sent_id
        JOIN  currencies tc         ON tc.id = t.currency_received_id
        JOIN  users u               ON u.id  = t.created_by
        LEFT JOIN approval_workflows aw
            ON aw.record_type = 'transfers' AND aw.record_id = t.id
        WHERE t.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Transfer not found');
    }

    sendSuccess(res, result.rows[0]);
});

module.exports = {
    initiateTransfer,
    editTransfer,
    approveTransfer,
    rejectTransfer,
    getTransfers,
    getTransferById,
};