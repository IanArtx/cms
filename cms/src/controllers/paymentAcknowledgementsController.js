// ============================================================
// PAYMENT ACKNOWLEDGEMENTS CONTROLLER (v1.30.0, Section 4.35)
//
// A two-way, two-step confirmation record for money paid OUT to an
// individual — dividends, service fee payments, expense
// reimbursements. This is the mirror image of the requisitions
// module's "acknowledgement" types (a member confirming money they
// already handed TO the company) — this one is the company's own
// money-out side: "you received this, you confirm what it was for."
//
// Flow (matches the requesting brief exactly):
//   1. The system auto-creates one row (PENDING_ACK) the instant a
//      payment actually pays out — never created by hand. See
//      createPaymentAcknowledgement() below, called from
//      dividendsController.approveDividend (one per shareholder
//      distribution), serviceFeesController.recordPayment, and
//      serviceFeesController.approveReimbursement.
//   2. The RECIPIENT reviews the amount and purpose and either
//      acknowledges it (ACKNOWLEDGED) or disputes it (DISPUTED, with
//      a reason). Nothing about the underlying payment is reversed or
//      re-posted either way — this is a paper-trail confirmation
//      step, not a second approval of the money movement itself.
//   3. Whoever holds PAYMENT_ACK_MANAGE (Treasurer/Director — granted
//      like any other permission in this system, ungranted by
//      default even for Admin) gives the final sign-off
//      (FINAL_APPROVED). A two-party printable document (payer +
//      recipient, both named) is available from this point via the
//      frontend's paymentAcknowledgementTemplate.
//
// A DISPUTED record can be reopened back to PENDING_ACK by a
// PAYMENT_ACK_MANAGE holder once the discrepancy has been sorted out
// off-system, so the recipient can acknowledge again — see
// reopenAcknowledgement().
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const { notify, notifyMany } = require('../services/notificationService');

const SOURCE_LABELS = {
    DIVIDEND:             'Dividend Payment',
    SERVICE_FEE_PAYMENT:  'Service Fee Payment',
    REIMBURSEMENT:        'Expense Reimbursement',
    SAVINGS_HANDOUT:      'Savings Handout',
};

// ============================================================
// INTERNAL HELPER — everyone holding Treasurer, Assistant Treasurer,
// Director, or Admin, active accounts only. These are the roles a
// PAYMENT_ACK_MANAGE grant realistically lives on (same shape as
// serviceFeesController's getTreasurers()) — used only to decide who
// gets notified that a final approval is waiting, not to decide who's
// actually allowed to approve (that's requirePermissions in the
// route file, the real security boundary).
// ============================================================
const getFinalApprovers = async () => {
    const result = await query(`
        SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id
        WHERE  r.name IN ('Treasurer', 'Assistant Treasurer', 'Director', 'Admin') AND u.is_active = TRUE
    `);
    return result.rows;
};

// ============================================================
// CREATE A PAYMENT ACKNOWLEDGEMENT (internal — not a route)
// Called from inside another controller's own withTransaction block,
// right after the real payment has been posted, so `client` is that
// same transaction client — this row is created atomically with the
// payment it's acknowledging, never as an afterthought that could be
// silently skipped if something later in the same request fails.
//
// Params: { client, sourceType, sourceId, transactionId, payerId,
//           recipientId, amount, currencyId, purpose }
// Returns { id, referenceCode }.
// ============================================================
const createPaymentAcknowledgement = async (client, {
    sourceType, sourceId, transactionId, payerId, recipientId,
    amount, currencyId, purpose,
}) => {
    const { referenceId, referenceCode } = await generateReference(
        client, MODULE_CODES.PAYMENT_ACK, sourceType.substring(0, 6), 'PAYMENT_ACKNOWLEDGEMENT', payerId
    );

    const result = await client.query(`
        INSERT INTO payment_acknowledgements
            (reference_id, source_type, source_id, transaction_id, payer_id, recipient_id,
             amount, currency_id, purpose, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_ACK')
        RETURNING id
    `, [referenceId, sourceType, sourceId, transactionId || null, payerId, recipientId, amount, currencyId, purpose]);

    const ackId = result.rows[0].id;
    await linkReferenceToRecord(client, referenceId, ackId);

    await logAction(payerId, ACTIONS.PAYMENT_ACK_CREATED, MODULES.FINANCE, {
        recordType:  'payment_acknowledgements',
        recordId:    ackId,
        newValues:   { referenceCode, sourceType, sourceId, amount },
        description: `Payment acknowledgement created: ${referenceCode} (${SOURCE_LABELS[sourceType] || sourceType})`,
        client,
    });

    // Best-effort, non-blocking — same fire-and-forget pattern every
    // other notify() call in this codebase follows (e.g. dividendsController's
    // DIVIDEND_PAID notification, right after the same kind of loop).
    notify({
        userId: recipientId,
        type:   'PAYMENT_ACK_NEEDED',
        title:  'Please confirm a payment you received',
        body:   `You received a payment of ${parseFloat(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ` +
                `(${SOURCE_LABELS[sourceType] || sourceType}). Please review and acknowledge it. Reference: ${referenceCode}.`,
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_acknowledgements',
        recordId:   ackId,
    }).catch(() => {});

    return { id: ackId, referenceCode };
};

// ============================================================
// GET MY ACKNOWLEDGEMENTS
// GET /api/payment-acknowledgements/my
// Self-service — open to any authenticated user (Administrative
// Officer included, since they're a legitimate recipient of service
// fee payments). Everyone sees only their own.
// ============================================================
const getMyAcknowledgements = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT pa.id, pa.source_type, pa.amount, pa.purpose, pa.status,
               pa.acknowledged_at, pa.acknowledgement_note, pa.dispute_reason, pa.disputed_at,
               pa.final_approved_at, pa.created_at,
               r.reference_code, r.public_id,
               c.code AS currency_code,
               payer.first_name || ' ' || payer.last_name AS payer_name,
               approver.first_name || ' ' || approver.last_name AS final_approver_name
        FROM   payment_acknowledgements pa
        JOIN   references_registry r ON r.id = pa.reference_id
        JOIN   currencies c          ON c.id = pa.currency_id
        JOIN   users payer           ON payer.id = pa.payer_id
        LEFT JOIN users approver     ON approver.id = pa.final_approved_by
        WHERE  pa.recipient_id = $1
        ORDER  BY pa.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL ACKNOWLEDGEMENTS (Treasury oversight)
// GET /api/payment-acknowledgements?status=&source_type=
// PAYMENT_ACK_VIEW required (route-level).
// ============================================================
const getAllAcknowledgements = asyncHandler(async (req, res) => {
    const { status, source_type } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status.toUpperCase()); conditions.push(`pa.status = $${params.length}`); }
    if (source_type) { params.push(source_type.toUpperCase()); conditions.push(`pa.source_type = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(`
        SELECT pa.id, pa.source_type, pa.amount, pa.purpose, pa.status,
               pa.acknowledged_at, pa.acknowledgement_note, pa.dispute_reason, pa.disputed_at,
               pa.final_approved_at, pa.created_at,
               r.reference_code, r.public_id,
               c.code AS currency_code,
               payer.first_name || ' ' || payer.last_name AS payer_name,
               recipient.first_name || ' ' || recipient.last_name AS recipient_name,
               approver.first_name || ' ' || approver.last_name AS final_approver_name
        FROM   payment_acknowledgements pa
        JOIN   references_registry r ON r.id = pa.reference_id
        JOIN   currencies c          ON c.id = pa.currency_id
        JOIN   users payer           ON payer.id = pa.payer_id
        JOIN   users recipient       ON recipient.id = pa.recipient_id
        LEFT JOIN users approver     ON approver.id = pa.final_approved_by
        ${where}
        ORDER  BY pa.created_at DESC
    `, params);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET SINGLE ACKNOWLEDGEMENT — full detail, used for the printable
// document. Accessible to the recipient, the payer, or anyone
// holding PAYMENT_ACK_VIEW — everyone else gets a 403, since a
// payment's amount/purpose is exactly the kind of thing that
// shouldn't be readable by a guessed ID.
// ============================================================
const getAcknowledgementById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(`
        SELECT pa.*,
               r.reference_code, r.public_id,
               c.code AS currency_code,
               payer.first_name || ' ' || payer.last_name AS payer_name,
               recipient.first_name || ' ' || recipient.last_name AS recipient_name,
               approver.first_name || ' ' || approver.last_name AS final_approver_name
        FROM   payment_acknowledgements pa
        JOIN   references_registry r ON r.id = pa.reference_id
        JOIN   currencies c          ON c.id = pa.currency_id
        JOIN   users payer           ON payer.id = pa.payer_id
        JOIN   users recipient       ON recipient.id = pa.recipient_id
        LEFT JOIN users approver     ON approver.id = pa.final_approved_by
        WHERE  pa.id = $1
    `, [id]);
    if (result.rows.length === 0) throw createError.notFound('Payment acknowledgement not found');
    const ack = result.rows[0];

    const isParty = ack.recipient_id === req.user.id || ack.payer_id === req.user.id;
    const canViewAll = (req.user.permissions || []).includes('PAYMENT_ACK_VIEW');
    if (!isParty && !canViewAll) {
        throw createError.forbidden('You do not have access to this record');
    }

    sendSuccess(res, { ...ack, source_label: SOURCE_LABELS[ack.source_type] || ack.source_type });
});

// ============================================================
// ACKNOWLEDGE RECEIPT
// POST /api/payment-acknowledgements/:id/acknowledge
// Recipient only. "they approve the amount and of what purpose that
// money served after reviewing it" — the amount/purpose are the
// system's own snapshot, not editable here; an optional note lets the
// recipient add context, but confirming is a binary action.
// ============================================================
const acknowledgeReceipt = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;

    const result = await query(`
        UPDATE payment_acknowledgements
        SET    status = 'ACKNOWLEDGED', acknowledged_at = NOW(), acknowledgement_note = $1,
               dispute_reason = NULL, disputed_at = NULL
        WHERE  id = $2 AND recipient_id = $3 AND status IN ('PENDING_ACK', 'DISPUTED')
        RETURNING id, source_type, amount
    `, [note || null, id, req.user.id]);

    if (result.rows.length === 0) {
        throw createError.badRequest(
            'This acknowledgement was not found, is not yours, or has already been finally approved'
        );
    }
    const ack = result.rows[0];

    await logAction(req.user.id, ACTIONS.PAYMENT_ACK_ACKNOWLEDGED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'payment_acknowledgements',
        recordId:    parseInt(id),
        description: `Payment acknowledged by recipient — ID ${id}`,
    });

    const approvers = await getFinalApprovers();
    notifyMany(approvers, 'PAYMENT_ACK_READY_FOR_APPROVAL', () => ({
        title: 'A payment acknowledgement is ready for final approval',
        body:  `${req.user.first_name} ${req.user.last_name} confirmed receipt of ${parseFloat(ack.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${SOURCE_LABELS[ack.source_type] || ack.source_type}). Final sign-off needed.`,
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_acknowledgements',
        recordId:   parseInt(id),
    })).catch(() => {});

    sendSuccess(res, { status: 'ACKNOWLEDGED' }, 'Payment acknowledged');
});

// ============================================================
// DISPUTE ACKNOWLEDGEMENT
// POST /api/payment-acknowledgements/:id/dispute
// Recipient only. A reason is required — this flags the record for
// Treasury attention, it never automatically reverses or re-posts the
// underlying payment (same "acknowledgement is a paper trail, not a
// re-approval" boundary as the acknowledge action).
// ============================================================
const disputeAcknowledgement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        throw createError.badRequest('A reason is required to dispute a payment acknowledgement');
    }

    const result = await query(`
        UPDATE payment_acknowledgements
        SET    status = 'DISPUTED', dispute_reason = $1, disputed_at = NOW()
        WHERE  id = $2 AND recipient_id = $3 AND status = 'PENDING_ACK'
        RETURNING id, source_type, amount, payer_id
    `, [reason.trim(), id, req.user.id]);

    if (result.rows.length === 0) {
        throw createError.badRequest(
            'This acknowledgement was not found, is not yours, or is not awaiting your review'
        );
    }
    const ack = result.rows[0];

    await logAction(req.user.id, ACTIONS.PAYMENT_ACK_DISPUTED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'payment_acknowledgements',
        recordId:    parseInt(id),
        newValues:   { reason: reason.trim() },
        description: `Payment acknowledgement disputed — ID ${id}: ${reason.trim()}`,
    });

    const approvers = await getFinalApprovers();
    notifyMany(approvers, 'PAYMENT_ACK_DISPUTED', () => ({
        title: 'A payment acknowledgement was disputed',
        body:  `${req.user.first_name} ${req.user.last_name} disputed a payment of ${parseFloat(ack.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${SOURCE_LABELS[ack.source_type] || ack.source_type}): "${reason.trim()}"`,
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_acknowledgements',
        recordId:   parseInt(id),
    })).catch(() => {});

    sendSuccess(res, { status: 'DISPUTED' }, 'Dispute recorded — Treasury has been notified');
});

// ============================================================
// REOPEN A DISPUTED ACKNOWLEDGEMENT
// POST /api/payment-acknowledgements/:id/reopen
// PAYMENT_ACK_MANAGE required. For once the discrepancy behind a
// dispute has been sorted out off-system (a phone call, a corrected
// record elsewhere) — puts it back to PENDING_ACK so the recipient
// can acknowledge it again, without needing a whole new record.
// ============================================================
const reopenAcknowledgement = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE payment_acknowledgements
        SET    status = 'PENDING_ACK', dispute_reason = NULL, disputed_at = NULL
        WHERE  id = $1 AND status = 'DISPUTED'
        RETURNING id, recipient_id, source_type, amount
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('This acknowledgement was not found or is not currently disputed');
    }
    const ack = result.rows[0];

    await logAction(req.user.id, ACTIONS.PAYMENT_ACK_REOPENED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'payment_acknowledgements',
        recordId:    parseInt(id),
        description: `Payment acknowledgement reopened for re-review — ID ${id}`,
    });

    notify({
        userId: ack.recipient_id,
        type:   'PAYMENT_ACK_REOPENED',
        title:  'A disputed payment is ready for your review again',
        body:   `Please review and re-confirm the payment of ${parseFloat(ack.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${SOURCE_LABELS[ack.source_type] || ack.source_type}).`,
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_acknowledgements',
        recordId:   parseInt(id),
    }).catch(() => {});

    sendSuccess(res, { status: 'PENDING_ACK' }, 'Acknowledgement reopened for the recipient to re-review');
});

// ============================================================
// FINAL APPROVE
// POST /api/payment-acknowledgements/:id/final-approve
// PAYMENT_ACK_MANAGE required. The last step — only possible once the
// recipient has already acknowledged. Not required to be a different
// person from the original payer.
// ============================================================
const finalApprove = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        UPDATE payment_acknowledgements
        SET    status = 'FINAL_APPROVED', final_approved_by = $1, final_approved_at = NOW()
        WHERE  id = $2 AND status = 'ACKNOWLEDGED'
        RETURNING id, recipient_id, source_type, amount
    `, [req.user.id, id]);

    if (result.rows.length === 0) {
        throw createError.badRequest(
            'This acknowledgement was not found or is not awaiting final approval (it must be acknowledged by the recipient first)'
        );
    }
    const ack = result.rows[0];

    await logAction(req.user.id, ACTIONS.PAYMENT_ACK_FINAL_APPROVED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'payment_acknowledgements',
        recordId:    parseInt(id),
        description: `Payment acknowledgement finally approved — ID ${id}`,
    });

    notify({
        userId: ack.recipient_id,
        type:   'PAYMENT_ACK_FINAL_APPROVED',
        title:  'Your payment acknowledgement is fully approved',
        body:   `Your acknowledgement of ${parseFloat(ack.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${SOURCE_LABELS[ack.source_type] || ack.source_type}) has been finally approved. A printable copy is now available.`,
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_acknowledgements',
        recordId:   parseInt(id),
    }).catch(() => {});

    sendSuccess(res, { status: 'FINAL_APPROVED' }, 'Final approval recorded');
});

module.exports = {
    SOURCE_LABELS,
    createPaymentAcknowledgement,
    getMyAcknowledgements,
    getAllAcknowledgements,
    getAcknowledgementById,
    acknowledgeReceipt,
    disputeAcknowledgement,
    reopenAcknowledgement,
    finalApprove,
};
