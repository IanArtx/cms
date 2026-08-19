// ============================================================
// SERVICE FEES CONTROLLER (v1.21.0)
//
// Covers the compensation side of the Administrative Officer role
// (and any future contracted-staff role): a recurring monthly
// service-fee arrangement, its payment history, and an expense
// reimbursement request/approval flow.
//
// Deliberately called "service fee", never "salary" or "payroll" —
// this models a contracted-service relationship, not an employment
// relationship. Whether a specific hire should legally be an
// employee or an independent contractor is a real question with
// tax/labour-law consequences that varies by jurisdiction — this
// software makes no claim about that classification either way;
// it just needs a name that doesn't presume one. Confirm the
// correct classification with an accountant/lawyer before relying
// on this module's terminology as any kind of legal position.
//
// Both money movements this module can produce (the monthly fee
// payment, and an approved reimbursement) go through the exact same
// postTransaction() choke point as every other module — no
// shortcuts around floor limits or the "never negative" rule just
// because the request originated here.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { uploadBuffer, generateKey, sendFileDownload, toKey } = require('../services/storageService');
const { createPaymentAcknowledgement } = require('./paymentAcknowledgementsController');

MODULE_CODES.SERVICE_FEE = 'SVC';

// ============================================================
// INTERNAL HELPER — everyone holding Treasurer or Assistant
// Treasurer, active accounts only. Same shape as requisitions'
// approver-notification helper.
// ============================================================
const getTreasurers = async () => {
    const result = await query(`
        SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id
        WHERE  r.name IN ('Treasurer', 'Assistant Treasurer') AND u.is_active = TRUE
    `);
    return result.rows;
};

// ============================================================================
// ADMIN — SERVICE FEE AGREEMENTS
// ============================================================================

// POST /api/service-fees/agreements
// currency_id is deliberately NOT accepted from the client — it's
// always derived from the paying account, the same way every other
// money-recording endpoint in this system works (recordExpense,
// requisitions, savings deposits, etc.). An account can only ever
// hold one currency, so asking the person creating this agreement to
// separately pick a currency was both redundant and a way to end up
// with a mismatch between account_id and currency_id.
const createAgreement = asyncHandler(async (req, res) => {
    const { user_id, monthly_amount, account_id, category_id, start_date, notes } = req.body;

    const existing = await query(
        `SELECT 1 FROM service_fee_agreements WHERE user_id = $1 AND status = 'ACTIVE'`,
        [user_id]
    );
    if (existing.rows.length > 0) {
        throw createError.conflict('This person already has an active service fee agreement');
    }

    const accountResult = await query(
        'SELECT id, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE',
        [account_id]
    );
    if (accountResult.rows.length === 0) {
        throw createError.notFound('Account not found');
    }
    const currency_id = accountResult.rows[0].currency_id;

    const result = await query(`
        INSERT INTO service_fee_agreements
            (user_id, monthly_amount, currency_id, account_id, category_id, start_date, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
    `, [user_id, monthly_amount, currency_id, account_id, category_id, start_date, notes || null, req.user.id]);

    const agreementId = result.rows[0].id;

    await logAction(req.user.id, ACTIONS.SERVICE_FEE_AGREEMENT_CREATED, MODULES.STAFF, {
        ipAddress:   req.ip,
        recordType:  'service_fee_agreements',
        recordId:    agreementId,
        newValues:   { user_id, monthly_amount, start_date },
        description: `Service fee agreement created for user ID ${user_id}: ${monthly_amount}/month`,
    });

    sendCreated(res, { id: agreementId }, 'Service fee agreement created');
});

// GET /api/service-fees/agreements
const listAgreements = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status.toUpperCase()); conditions.push(`a.status = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(`
        SELECT a.id, a.user_id, a.monthly_amount, a.currency_id, a.account_id,
               a.start_date, a.end_date, a.status, a.notes, a.created_at,
               u.first_name || ' ' || u.last_name AS user_name,
               c.code AS currency_code,
               acc.name AS account_name,
               (SELECT MAX(payment_date) FROM service_fee_payments WHERE agreement_id = a.id) AS last_paid_date
        FROM   service_fee_agreements a
        JOIN   users u        ON u.id = a.user_id
        JOIN   currencies c    ON c.id = a.currency_id
        JOIN   accounts acc    ON acc.id = a.account_id
        ${where}
        ORDER BY a.created_at DESC
    `, params);
    sendSuccess(res, result.rows);
});

// GET /api/service-fees/agreements/:id
const getAgreementById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const agreementResult = await query(`
        SELECT a.*, u.first_name || ' ' || u.last_name AS user_name,
               c.code AS currency_code, acc.name AS account_name
        FROM   service_fee_agreements a
        JOIN   users u     ON u.id = a.user_id
        JOIN   currencies c ON c.id = a.currency_id
        JOIN   accounts acc ON acc.id = a.account_id
        WHERE  a.id = $1
    `, [id]);
    if (agreementResult.rows.length === 0) throw createError.notFound('Service fee agreement not found');

    const paymentsResult = await query(`
        SELECT p.id, p.amount, p.payment_date, p.notes, p.created_at,
               r.reference_code,
               payer.first_name || ' ' || payer.last_name AS paid_by_name
        FROM   service_fee_payments p
        LEFT JOIN transactions t       ON t.id = p.transaction_id
        LEFT JOIN references_registry r ON r.id = t.reference_id
        JOIN   users payer              ON payer.id = p.paid_by
        WHERE  p.agreement_id = $1
        ORDER BY p.payment_date DESC
    `, [id]);

    sendSuccess(res, { ...agreementResult.rows[0], payments: paymentsResult.rows });
});

// PATCH /api/service-fees/agreements/:id
// Covers both amending an active agreement (monthly amount, paying
// account, category, notes) and terminating one (status='ENDED' with
// an end_date). If the paying account changes, currency_id is
// recomputed from the new account server-side — same reasoning as
// createAgreement above, an account can only ever hold one currency.
const updateAgreement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { monthly_amount, account_id, category_id, notes, status, end_date } = req.body;

    const existing = await query('SELECT * FROM service_fee_agreements WHERE id = $1', [id]);
    if (existing.rows.length === 0) throw createError.notFound('Service fee agreement not found');

    if (status === 'ENDED' && !end_date) {
        throw createError.badRequest('An end date is required to end an agreement');
    }

    let currency_id = null;
    if (account_id) {
        const accountResult = await query(
            'SELECT id, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE',
            [account_id]
        );
        if (accountResult.rows.length === 0) {
            throw createError.notFound('Account not found');
        }
        currency_id = accountResult.rows[0].currency_id;
    }

    const updated = await query(`
        UPDATE service_fee_agreements
        SET    monthly_amount = COALESCE($1, monthly_amount),
               account_id     = COALESCE($2, account_id),
               currency_id    = COALESCE($3, currency_id),
               category_id    = COALESCE($4, category_id),
               notes          = COALESCE($5, notes),
               status         = COALESCE($6, status),
               end_date       = COALESCE($7, end_date)
        WHERE  id = $8
        RETURNING *
    `, [monthly_amount || null, account_id || null, currency_id, category_id || null,
        notes !== undefined ? notes : null, status || null, end_date || null, id]);

    await logAction(req.user.id, ACTIONS.SERVICE_FEE_AGREEMENT_UPDATED, MODULES.STAFF, {
        ipAddress:   req.ip,
        recordType:  'service_fee_agreements',
        recordId:    parseInt(id),
        oldValues:   existing.rows[0],
        newValues:   updated.rows[0],
        description: `Service fee agreement ID ${id} updated`,
    });

    sendSuccess(res, updated.rows[0], 'Service fee agreement updated');
});

// POST /api/service-fees/agreements/:id/pay
const recordPayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, payment_date, notes } = req.body;

    await withTransaction(async (client) => {
        const agreementResult = await client.query(`
            SELECT a.*, u.first_name, u.last_name
            FROM   service_fee_agreements a
            JOIN   users u ON u.id = a.user_id
            WHERE  a.id = $1 FOR UPDATE
        `, [id]);
        if (agreementResult.rows.length === 0) throw createError.notFound('Service fee agreement not found');
        const agreement = agreementResult.rows[0];

        if (agreement.status !== 'ACTIVE') {
            throw createError.badRequest('This agreement is no longer active');
        }

        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [agreement.account_id]
        );

        const payAmount = parseFloat(amount || agreement.monthly_amount);

        const { referenceId: txRefId, referenceCode: txRefCode } = await generateReference(
            client, resolveModuleCode(account.rows[0]), 'SVC', 'TRANSACTION', req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       agreement.account_id,
            transactionType: 'DEBIT',
            inflowType:      'SERVICE_FEE_OUT',
            amount:          payAmount,
            currencyId:      agreement.currency_id,
            categoryId:      agreement.category_id,
            description:     `Service fee — ${agreement.first_name} ${agreement.last_name} (agreement ID ${id})`,
            valueDate:       payment_date || new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId:     txRefId,
        });
        await linkReferenceToRecord(client, txRefId, transactionId);

        const paymentResult = await client.query(`
            INSERT INTO service_fee_payments (agreement_id, amount, payment_date, transaction_id, notes, paid_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [id, payAmount, payment_date || new Date().toISOString().split('T')[0], transactionId, notes || null, req.user.id]);

        // v1.30.0 (Section 4.35) — recipient acknowledges each monthly
        // service fee payment individually.
        await createPaymentAcknowledgement(client, {
            sourceType:    'SERVICE_FEE_PAYMENT',
            sourceId:      paymentResult.rows[0].id,
            transactionId,
            payerId:       req.user.id,
            recipientId:   agreement.user_id,
            amount:        payAmount,
            currencyId:    agreement.currency_id,
            purpose:       `Monthly service fee — ${agreement.first_name} ${agreement.last_name} (agreement ID ${id})`,
        });

        await logAction(req.user.id, ACTIONS.SERVICE_FEE_PAYMENT_RECORDED, MODULES.STAFF, {
            ipAddress:   req.ip,
            recordType:  'service_fee_payments',
            recordId:    paymentResult.rows[0].id,
            newValues:   { txRefCode, payAmount, balanceBefore, balanceAfter },
            description: `Service fee paid: ${txRefCode} — ${agreement.first_name} ${agreement.last_name}: ${payAmount}`,
            client,
        });

        notify({
            userId:  agreement.user_id,
            type:    'SERVICE_FEE_PAID',
            title:   'Service fee payment recorded',
            body:    `Your monthly service fee of ${payAmount} has been paid. Reference: ${txRefCode}.`,
            link:    '/service-fees',
            module:  'STAFF',
            recordType: 'service_fee_payments',
            recordId: paymentResult.rows[0].id,
            email: {
                subject: 'Your service fee payment has been recorded',
                html: await wrapEmail(`
                    <p>Dear ${agreement.first_name},</p>
                    <p>Your monthly service fee payment of <strong>${payAmount}</strong> has been recorded.</p>
                    <p style="color:#6b7280;">Reference: ${txRefCode}</p>
                `, { preheader: 'Your service fee payment has been recorded' }),
            },
        }).catch(() => {});

        sendCreated(res, {
            payment_id: paymentResult.rows[0].id,
            transaction_reference: txRefCode,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
        }, 'Service fee payment recorded');
    });
});

// ============================================================================
// SELF-SERVICE — MY AGREEMENT
// ============================================================================

// GET /api/service-fees/my-agreement
const getMyAgreement = asyncHandler(async (req, res) => {
    const agreementResult = await query(`
        SELECT a.id, a.monthly_amount, a.currency_id, a.start_date, a.end_date, a.status,
               c.code AS currency_code
        FROM   service_fee_agreements a
        JOIN   currencies c ON c.id = a.currency_id
        WHERE  a.user_id = $1
        ORDER BY a.created_at DESC
        LIMIT 1
    `, [req.user.id]);

    if (agreementResult.rows.length === 0) {
        return sendSuccess(res, null);
    }
    const agreement = agreementResult.rows[0];

    const paymentsResult = await query(`
        SELECT p.amount, p.payment_date, r.reference_code
        FROM   service_fee_payments p
        LEFT JOIN transactions t        ON t.id = p.transaction_id
        LEFT JOIN references_registry r ON r.id = t.reference_id
        WHERE  p.agreement_id = $1
        ORDER BY p.payment_date DESC
    `, [agreement.id]);

    sendSuccess(res, { ...agreement, payments: paymentsResult.rows });
});

// ============================================================================
// EXPENSE REIMBURSEMENTS
// ============================================================================

// POST /api/service-fees/reimbursements
const requestReimbursement = asyncHandler(async (req, res) => {
    const { amount, currency_id, category_id, description, expense_date } = req.body;

    // v1.29.1 — receipt is optional; only touch storageService if one
    // was actually attached.
    let receiptKey = null;
    if (req.file) {
        receiptKey = generateKey('service-fees', req.file.originalname);
        await uploadBuffer(req.file.buffer, receiptKey, req.file.mimetype);
    }

    await withTransaction(async (client) => {
        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.SERVICE_FEE, 'REIMB', 'SERVICE_REIMBURSEMENT', req.user.id
        );

        const result = await client.query(`
            INSERT INTO service_reimbursement_requests
                (reference_id, user_id, amount, currency_id, category_id, description, expense_date,
                 receipt_file_path, receipt_file_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
        `, [
            referenceId, req.user.id, amount, currency_id, category_id, description.trim(), expense_date,
            receiptKey, req.file ? req.file.originalname : null,
        ]);

        const reqId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, reqId);

        await logAction(req.user.id, ACTIONS.SERVICE_REIMBURSEMENT_REQUESTED, MODULES.STAFF, {
            ipAddress:   req.ip,
            recordType:  'service_reimbursement_requests',
            recordId:    reqId,
            newValues:   { referenceCode, amount, description },
            description: `Reimbursement requested: ${referenceCode} — ${amount}`,
            client,
        });

        const treasurers = await getTreasurers();
        const treasurerHtml = await wrapEmail(`
            <p><strong>${req.user.first_name} ${req.user.last_name}</strong> requested an expense reimbursement:</p>
            <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
            </table>
        `, { preheader: 'A reimbursement request needs your approval' });

        notifyMany(treasurers, 'SERVICE_REIMBURSEMENT_PENDING', () => ({
            title:      'Reimbursement request awaiting approval',
            body:       `${req.user.first_name || 'A staff member'} requested reimbursement of ${amount}. Reference: ${referenceCode}.`,
            link:       `/service-fees`,
            module:     'STAFF',
            recordType: 'service_reimbursement_requests',
            recordId:   reqId,
            email: { subject: `Reimbursement request — ${referenceCode}`, html: treasurerHtml },
        }));

        sendCreated(res, {
            reimbursement_id: reqId,
            reference: referenceCode,
            status: 'PENDING',
        }, `Reimbursement request submitted. Reference: ${referenceCode}`);
    });
});

// GET /api/service-fees/my-reimbursements
const getMyReimbursements = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT rr.id, rr.amount, rr.description, rr.expense_date, rr.status,
               rr.review_notes, rr.reviewed_at, rr.receipt_file_name, rr.created_at,
               r.reference_code, r.public_id,
               cat.name AS category_name
        FROM   service_reimbursement_requests rr
        JOIN   references_registry r ON r.id = rr.reference_id
        JOIN   categories cat        ON cat.id = rr.category_id
        WHERE  rr.user_id = $1
        ORDER BY rr.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// GET /api/service-fees/reimbursements
const listReimbursements = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status.toUpperCase()); conditions.push(`rr.status = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(`
        SELECT rr.id, rr.user_id, rr.amount, rr.description, rr.expense_date, rr.status,
               rr.review_notes, rr.reviewed_at, rr.receipt_file_name, rr.created_at,
               r.reference_code, r.public_id,
               cat.name AS category_name,
               u.first_name || ' ' || u.last_name AS user_name
        FROM   service_reimbursement_requests rr
        JOIN   references_registry r ON r.id = rr.reference_id
        JOIN   categories cat        ON cat.id = rr.category_id
        JOIN   users u                ON u.id = rr.user_id
        ${where}
        ORDER BY rr.created_at DESC
    `, params);
    sendSuccess(res, result.rows);
});

// GET /api/service-fees/reimbursements/:id/receipt
const previewReceipt = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(
        `SELECT receipt_file_path, receipt_file_name, user_id FROM service_reimbursement_requests WHERE id = $1`,
        [id]
    );
    if (result.rows.length === 0) throw createError.notFound('Reimbursement request not found');
    const rr = result.rows[0];
    if (!rr.receipt_file_path) throw createError.notFound('No receipt was attached to this request');

    const isOwner = rr.user_id === req.user.id;
    const canReview = (req.user.roles || []).some(r => ['Treasurer', 'Assistant Treasurer', 'Admin'].includes(r));
    if (!isOwner && !canReview) {
        throw createError.forbidden('You do not have access to this receipt');
    }
    // v1.29.1 — same permission check as before, only the byte-fetch
    // mechanism changed (storageService, not a raw fs read).
    return sendFileDownload(res, toKey(rr.receipt_file_path), rr.receipt_file_name || `receipt-${id}`);
});

// POST /api/service-fees/reimbursements/:id/approve
const approveReimbursement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { account_id, review_notes } = req.body;

    await withTransaction(async (client) => {
        const rrResult = await client.query(`
            SELECT rr.*, u.first_name, u.last_name, r.reference_code
            FROM   service_reimbursement_requests rr
            JOIN   users u ON u.id = rr.user_id
            JOIN   references_registry r ON r.id = rr.reference_id
            WHERE  rr.id = $1 FOR UPDATE
        `, [id]);
        if (rrResult.rows.length === 0) throw createError.notFound('Reimbursement request not found');
        const rr = rrResult.rows[0];

        if (rr.status !== 'PENDING') {
            throw createError.badRequest(`This request is already ${rr.status.toLowerCase()}`);
        }
        if (!account_id) throw createError.badRequest('A valid account is required to approve this reimbursement');

        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [account_id]
        );
        if (account.rows.length === 0) throw createError.notFound('Account not found');

        const { referenceId: txRefId, referenceCode: txRefCode } = await generateReference(
            client, resolveModuleCode(account.rows[0]), 'REIMB', 'TRANSACTION', req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       account_id,
            transactionType: 'DEBIT',
            inflowType:      'SERVICE_REIMBURSEMENT_OUT',
            amount:          parseFloat(rr.amount),
            currencyId:      account.rows[0].currency_id,
            categoryId:      rr.category_id,
            description:     `Expense reimbursement — ${rr.first_name} ${rr.last_name} (${rr.reference_code})`,
            valueDate:       new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId:     txRefId,
        });
        await linkReferenceToRecord(client, txRefId, transactionId);

        await client.query(`
            UPDATE service_reimbursement_requests
            SET    status = 'APPROVED', account_id = $1, transaction_id = $2,
                   reviewed_by = $3, reviewed_at = NOW(), review_notes = $4
            WHERE  id = $5
        `, [account_id, transactionId, req.user.id, review_notes || null, id]);

        // v1.30.0 (Section 4.35) — recipient acknowledges the paid-out
        // reimbursement, separate from their original request.
        await createPaymentAcknowledgement(client, {
            sourceType:    'REIMBURSEMENT',
            sourceId:      parseInt(id),
            transactionId,
            payerId:       req.user.id,
            recipientId:   rr.user_id,
            amount:        parseFloat(rr.amount),
            currencyId:    account.rows[0].currency_id,
            purpose:       `Expense reimbursement — ${rr.reference_code}: ${rr.description}`,
        });

        await logAction(req.user.id, ACTIONS.SERVICE_REIMBURSEMENT_APPROVED, MODULES.STAFF, {
            ipAddress:   req.ip,
            recordType:  'service_reimbursement_requests',
            recordId:    parseInt(id),
            newValues:   { txRefCode, balanceBefore, balanceAfter },
            description: `Reimbursement approved: ${rr.reference_code} — ${rr.amount}`,
            client,
        });

        notify({
            userId:  rr.user_id,
            type:    'SERVICE_REIMBURSEMENT_APPROVED',
            title:   'Reimbursement approved',
            body:    `Your reimbursement request (${rr.reference_code}) for ${rr.amount} was approved and paid.`,
            link:    '/service-fees',
            module:  'STAFF',
            recordType: 'service_reimbursement_requests',
            recordId: parseInt(id),
            email: {
                subject: `Reimbursement approved — ${rr.reference_code}`,
                html: await wrapEmail(`
                    <p>Dear ${rr.first_name},</p>
                    <p>Your reimbursement request <strong>${rr.reference_code}</strong> for ${rr.amount} has been approved and paid.</p>
                    ${review_notes ? `<p style="color:#6b7280;">Notes: ${review_notes}</p>` : ''}
                `, { preheader: 'Your reimbursement request was approved' }),
            },
        }).catch(() => {});

        sendSuccess(res, {
            status: 'APPROVED',
            transaction_reference: txRefCode,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
        }, 'Reimbursement approved and paid');
    });
});

// POST /api/service-fees/reimbursements/:id/reject
const rejectReimbursement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { review_notes } = req.body;
    if (!review_notes || !review_notes.trim()) {
        throw createError.badRequest('A reason is required to reject a reimbursement request');
    }

    const result = await query(`
        UPDATE service_reimbursement_requests
        SET    status = 'REJECTED', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
        WHERE  id = $3 AND status = 'PENDING'
        RETURNING id, user_id, amount
    `, [req.user.id, review_notes.trim(), id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Reimbursement request not found or already reviewed');
    }
    const rejected = result.rows[0];

    await logAction(req.user.id, ACTIONS.SERVICE_REIMBURSEMENT_REJECTED, MODULES.STAFF, {
        ipAddress:   req.ip,
        recordType:  'service_reimbursement_requests',
        recordId:    parseInt(id),
        description: `Reimbursement request ID ${id} rejected`,
    });

    notify({
        userId:  rejected.user_id,
        type:    'SERVICE_REIMBURSEMENT_REJECTED',
        title:   'Reimbursement request declined',
        body:    `Your reimbursement request for ${rejected.amount} was not approved. Reason: ${review_notes.trim()}`,
        link:    '/service-fees',
        module:  'STAFF',
        recordType: 'service_reimbursement_requests',
        recordId: parseInt(id),
    }).catch(() => {});

    sendSuccess(res, null, 'Reimbursement request rejected');
});

module.exports = {
    createAgreement,
    listAgreements,
    getAgreementById,
    updateAgreement,
    recordPayment,
    getMyAgreement,
    requestReimbursement,
    getMyReimbursements,
    listReimbursements,
    previewReceipt,
    approveReimbursement,
    rejectReimbursement,
};
