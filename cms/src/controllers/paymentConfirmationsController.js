// ============================================================
// PAYMENT CONFIRMATIONS CONTROLLER (v1.39.0)
//
// The mirror image of paymentAcknowledgementsController.js. That
// module always creates its row the INSTANT a payment has ALREADY
// posted — a post-hoc paper trail, never created by hand, never
// gating the money movement itself.
//
// This module is the opposite order: Treasury posts an entry FIRST
// (PENDING_CONFIRMATION), documenting who was paid, how much, and how
// (Cash / Bank Transfer / Mobile Money — MTN/Airtel/Other — with a
// transaction ID required for Bank Transfer/Mobile Money, forbidden
// for Cash). Nothing is posted to the ledger at this point. Only once
// the RECIPIENT reviews it and confirms does postTransaction() ever
// run — confirmation is what CREATES the transaction here, the exact
// reverse of payment_acknowledgements' acknowledgeReceipt(), which
// only ever flips a status flag. If the recipient disputes it instead
// (a reason is required), no transaction is ever created; Treasury
// cancels the entry and reissues a corrected one — there is no
// "reopen" step, since nothing was ever posted to undo.
//
// Three source types today:
//   - GENERAL_PAYMENT — Treasury pays anyone, ad hoc (createPaymentConfirmation,
//     a real route, PAYMENT_ACK_MANAGE).
//   - SERVICE_FEE_PAYMENT — an internal helper (createServiceFeePaymentConfirmation,
//     NOT a route), called from serviceFeesController.recordPayment,
//     replacing that flow's old instant-post behaviour. On confirm, a
//     service_fee_payments row is inserted at that point too — exactly
//     what recordPayment used to do immediately, now deferred until
//     the fee recipient actually confirms they were paid.
//   - SERVICE_FEE_ADVANCE (v1.53.0) — an internal helper
//     (createServiceFeeAdvanceConfirmation, NOT a route), called from
//     serviceFeesController.approveAdvance once a self-service advance
//     request is approved and its recovery breakdown finalised. On
//     confirm, the stored (unapplied) service_fee_advance_recoveries
//     rows are applied as an internal offset against future periods'
//     amount_paid — no separate transaction for the recovery itself,
//     since the cash already moved once, at disbursement.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { notify, notifyMany } = require('../services/notificationService');
const {
    applyPaymentToPeriods,
    getAdvanceRecoverySchedule,
    applyAdvanceRecovery,
} = require('../services/serviceFeeService');

const SOURCE_LABELS = {
    GENERAL_PAYMENT:     'General Payment',
    SERVICE_FEE_PAYMENT: 'Service Fee Payment',
    SERVICE_FEE_ADVANCE: 'Service Fee Advance',
};

const PAYMENT_METHOD_LABELS = {
    CASH:           'Cash',
    BANK_TRANSFER:  'Bank Transfer',
    MOBILE_MONEY:   'Mobile Money',
};

// ============================================================
// INTERNAL HELPER — everyone holding Treasurer, Assistant Treasurer,
// Director, or Admin, active accounts only. Same shape as
// paymentAcknowledgementsController's getFinalApprovers() — used only
// to decide who gets notified of a dispute/cancellation, not to gate
// who's actually allowed to act (that's requirePermissions in the
// route file).
// ============================================================
const getTreasuryContacts = async () => {
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
// INTERNAL VALIDATION — shared by both entry points. Throws a clear
// error rather than letting the CHECK constraint reject it with a
// raw Postgres message.
// ============================================================
const validatePaymentMethod = (paymentMethod, mobileMoneyProvider, externalReference) => {
    if (!['CASH', 'BANK_TRANSFER', 'MOBILE_MONEY'].includes(paymentMethod)) {
        throw createError.badRequest('payment_method must be CASH, BANK_TRANSFER, or MOBILE_MONEY');
    }
    if (paymentMethod === 'MOBILE_MONEY' && !mobileMoneyProvider) {
        throw createError.badRequest('A mobile money provider (MTN, Airtel, or Other) is required');
    }
    if (paymentMethod !== 'MOBILE_MONEY' && mobileMoneyProvider) {
        throw createError.badRequest('A mobile money provider only applies to Mobile Money payments');
    }
    if (paymentMethod === 'CASH' && externalReference) {
        throw createError.badRequest('Cash payments don\'t have a transaction ID — leave it blank');
    }
    if ((paymentMethod === 'BANK_TRANSFER' || paymentMethod === 'MOBILE_MONEY') &&
        (!externalReference || !externalReference.trim())) {
        throw createError.badRequest('A transaction ID is required for Bank Transfer and Mobile Money payments');
    }
};

// ============================================================
// CREATE A GENERAL PAYMENT CONFIRMATION
// POST /api/payment-confirmations — Treasury/Admin (PAYMENT_ACK_MANAGE)
// Treasury pays any active user, ad hoc — not tied to any other
// module's own record. source_id is left NULL.
// ============================================================
const createPaymentConfirmation = asyncHandler(async (req, res) => {
    const {
        recipient_id, account_id, category_id, amount, entry_date,
        payment_method, mobile_money_provider, external_reference, purpose,
    } = req.body;

    validatePaymentMethod(payment_method, mobile_money_provider, external_reference);

    await withTransaction(async (client) => {
        const recipientResult = await client.query(
            'SELECT id, first_name, last_name FROM users WHERE id = $1 AND is_active = TRUE',
            [recipient_id]
        );
        if (recipientResult.rows.length === 0) {
            throw createError.notFound('Recipient not found or is inactive');
        }
        const recipient = recipientResult.rows[0];

        const accountResult = await client.query(
            'SELECT id, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE',
            [account_id]
        );
        if (accountResult.rows.length === 0) {
            throw createError.notFound('Account not found or is inactive');
        }
        const account = accountResult.rows[0];

        const categoryResult = await client.query(
            'SELECT id FROM categories WHERE id = $1 AND is_active = TRUE', [category_id]
        );
        if (categoryResult.rows.length === 0) {
            throw createError.notFound('Category not found');
        }

        const { id, referenceCode } = await createPaymentConfirmationRow(client, {
            sourceType:  'GENERAL_PAYMENT',
            sourceId:    null,
            accountId:   account.id,
            categoryId:  category_id,
            payerId:     req.user.id,
            recipientId: recipient.id,
            amount:      parseFloat(amount),
            currencyId:  account.currency_id,
            paymentMethod: payment_method,
            mobileMoneyProvider: mobile_money_provider || null,
            externalReference:   external_reference || null,
            purpose,
            entryDate:   entry_date || new Date().toISOString().split('T')[0],
        });

        sendCreated(res, {
            id, reference_code: referenceCode, status: 'PENDING_CONFIRMATION',
        }, `Payment entry created for ${recipient.first_name} ${recipient.last_name} — awaiting their confirmation. Reference: ${referenceCode}`);
    });
});

// ============================================================
// INTERNAL — SERVICE FEE PAYMENT CONFIRMATION (not a route)
// Called from serviceFeesController.recordPayment, inside that same
// withTransaction block, in place of what used to be an immediate
// postTransaction()+service_fee_payments insert. Recipient/account/
// category/currency are all derived from the agreement, never chosen
// again here.
// Params: { client, agreement, amount, entryDate, paymentMethod,
//           mobileMoneyProvider, externalReference, purpose, payerId,
//           periodBreakdown }
// periodBreakdown (v1.52.0) — optional array of { period_id, amount },
// the monthly-period(s) this payment is meant to settle (recordPayment's
// oldest-first cascade for a normal single payment, or an edited
// bulk "settle past months" breakdown). Persisted to
// service_fee_payment_confirmation_periods so confirmPayment can
// apply the real service_fee_payments row across the right period(s)
// once the recipient actually confirms — payment_confirmations itself
// has no column to carry this (only a single source_id, the
// agreement, not a period).
// Returns { id, referenceCode }.
// ============================================================
const createServiceFeePaymentConfirmation = async (client, {
    agreement, amount, entryDate, paymentMethod, mobileMoneyProvider, externalReference, purpose, payerId,
    periodBreakdown,
}) => {
    validatePaymentMethod(paymentMethod, mobileMoneyProvider, externalReference);

    const { id, referenceCode } = await createPaymentConfirmationRow(client, {
        sourceType:  'SERVICE_FEE_PAYMENT',
        sourceId:    agreement.id,
        accountId:   agreement.account_id,
        categoryId:  agreement.category_id,
        payerId,
        recipientId: agreement.user_id,
        amount,
        currencyId:  agreement.currency_id,
        paymentMethod,
        mobileMoneyProvider: mobileMoneyProvider || null,
        externalReference:   externalReference || null,
        purpose,
        entryDate,
    });

    if (periodBreakdown && periodBreakdown.length > 0) {
        for (const line of periodBreakdown) {
            await client.query(`
                INSERT INTO service_fee_payment_confirmation_periods (confirmation_id, period_id, amount)
                VALUES ($1, $2, $3)
            `, [id, line.period_id, line.amount]);
        }
    }

    return { id, referenceCode };
};

// ============================================================
// INTERNAL — SERVICE FEE ADVANCE CONFIRMATION (not a route, v1.53.0)
// Called from serviceFeesController.approveAdvance, inside that same
// withTransaction block, once the Treasurer has approved a
// self-service advance request and finalised its (editable) recovery
// breakdown. Mirrors createServiceFeePaymentConfirmation, but the
// eventual real transaction represents money going OUT as an advance
// (SERVICE_FEE_ADVANCE_OUT), not a settlement of already-earned
// periods — recovery of that advance happens separately, later, as
// an internal offset against future periods' amount_paid once this
// confirmation is actually confirmed received (see confirmPayment's
// SERVICE_FEE_ADVANCE branch below), never at approval time.
// Params: { client, agreement, amount, entryDate, paymentMethod,
//           mobileMoneyProvider, externalReference, purpose, payerId,
//           advanceId, recoveryBreakdown }
// recoveryBreakdown — array of { period_id, amount }, the future
// month(s) that will absorb this advance once confirmed. Persisted to
// service_fee_advance_recoveries (unapplied — applied_at stays NULL
// until confirmPayment runs applyAdvanceRecovery).
// Returns { id, referenceCode }.
// ============================================================
const createServiceFeeAdvanceConfirmation = async (client, {
    agreement, amount, entryDate, paymentMethod, mobileMoneyProvider, externalReference, purpose, payerId,
    advanceId, recoveryBreakdown,
}) => {
    validatePaymentMethod(paymentMethod, mobileMoneyProvider, externalReference);

    const { id, referenceCode } = await createPaymentConfirmationRow(client, {
        sourceType:  'SERVICE_FEE_ADVANCE',
        sourceId:    advanceId,
        accountId:   agreement.account_id,
        categoryId:  agreement.category_id,
        payerId,
        recipientId: agreement.user_id,
        amount,
        currencyId:  agreement.currency_id,
        paymentMethod,
        mobileMoneyProvider: mobileMoneyProvider || null,
        externalReference:   externalReference || null,
        purpose,
        entryDate,
    });

    await client.query(
        'UPDATE service_fee_advances SET confirmation_id = $1 WHERE id = $2',
        [id, advanceId]
    );

    if (recoveryBreakdown && recoveryBreakdown.length > 0) {
        for (const line of recoveryBreakdown) {
            await client.query(`
                INSERT INTO service_fee_advance_recoveries (advance_id, period_id, amount)
                VALUES ($1, $2, $3)
                ON CONFLICT (advance_id, period_id) DO UPDATE SET amount = EXCLUDED.amount
            `, [advanceId, line.period_id, line.amount]);
        }
    }

    return { id, referenceCode };
};

// ============================================================
// SHARED ROW-INSERT CORE (internal — not exported as a route)
// Generates the confirmation's OWN reference (separate from whatever
// reference the eventual transaction gets once confirmed, exactly the
// same "two references, one for the paper trail record and one for
// the money movement" shape payment_acknowledgements already uses),
// inserts the PENDING_CONFIRMATION row, logs, and notifies the
// recipient. Must be called from inside an existing withTransaction
// block.
// ============================================================
const createPaymentConfirmationRow = async (client, {
    sourceType, sourceId, accountId, categoryId, payerId, recipientId,
    amount, currencyId, paymentMethod, mobileMoneyProvider, externalReference, purpose, entryDate,
}) => {
    const categoryAbbrev = sourceType === 'SERVICE_FEE_PAYMENT' ? 'SVC'
        : sourceType === 'SERVICE_FEE_ADVANCE' ? 'ADV'
        : 'GEN';
    const { referenceId, referenceCode } = await generateReference(
        client, MODULE_CODES.PAYMENT_ACK, categoryAbbrev,
        'PAYMENT_CONFIRMATION', payerId
    );

    const result = await client.query(`
        INSERT INTO payment_confirmations
            (reference_id, source_type, source_id, account_id, category_id, payer_id, recipient_id,
             amount, currency_id, payment_method, mobile_money_provider, external_reference,
             purpose, entry_date, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'PENDING_CONFIRMATION')
        RETURNING id
    `, [
        referenceId, sourceType, sourceId, accountId, categoryId, payerId, recipientId,
        amount, currencyId, paymentMethod, mobileMoneyProvider, externalReference,
        purpose, entryDate,
    ]);

    const id = result.rows[0].id;
    await linkReferenceToRecord(client, referenceId, id);

    await logAction(payerId, ACTIONS.PAYMENT_CONFIRMATION_CREATED, MODULES.FINANCE, {
        recordType:  'payment_confirmations',
        recordId:    id,
        newValues:   { referenceCode, sourceType, amount, paymentMethod },
        description: `Payment confirmation entry created: ${referenceCode} (${SOURCE_LABELS[sourceType] || sourceType}, ${PAYMENT_METHOD_LABELS[paymentMethod]})`,
        client,
    });

    notify({
        userId: recipientId,
        type:   'PAYMENT_CONFIRMATION_NEEDED',
        title:  'Please confirm a payment you received',
        body:   `Treasury recorded a payment of ${parseFloat(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ` +
                `to you via ${PAYMENT_METHOD_LABELS[paymentMethod]}. Please review and confirm it. Reference: ${referenceCode}.`,
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_confirmations',
        recordId:   id,
    }).catch(() => {});

    return { id, referenceCode };
};

// ============================================================
// GET MY PENDING/HISTORY
// GET /api/payment-confirmations/my
// Self-service — open to any authenticated user.
// ============================================================
const getMyPaymentConfirmations = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT pc.id, pc.source_type, pc.amount, pc.purpose, pc.status,
               pc.payment_method, pc.mobile_money_provider, pc.external_reference,
               pc.entry_date, pc.confirmed_at, pc.confirmation_note,
               pc.dispute_reason, pc.disputed_at, pc.created_at,
               r.reference_code, r.public_id,
               c.code AS currency_code,
               a.name AS account_name,
               payer.first_name || ' ' || payer.last_name AS payer_name
        FROM   payment_confirmations pc
        JOIN   references_registry r ON r.id = pc.reference_id
        JOIN   currencies c          ON c.id = pc.currency_id
        JOIN   accounts a            ON a.id = pc.account_id
        JOIN   users payer           ON payer.id = pc.payer_id
        WHERE  pc.recipient_id = $1
        ORDER  BY pc.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL (Treasury oversight)
// GET /api/payment-confirmations?status=&source_type=
// PAYMENT_ACK_VIEW required (route-level).
// ============================================================
const getAllPaymentConfirmations = asyncHandler(async (req, res) => {
    const { status, source_type } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status.toUpperCase()); conditions.push(`pc.status = $${params.length}`); }
    if (source_type) { params.push(source_type.toUpperCase()); conditions.push(`pc.source_type = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await query(`
        SELECT pc.id, pc.source_type, pc.amount, pc.purpose, pc.status,
               pc.payment_method, pc.mobile_money_provider, pc.external_reference,
               pc.entry_date, pc.confirmed_at, pc.dispute_reason, pc.disputed_at,
               pc.cancellation_reason, pc.cancelled_at, pc.created_at,
               r.reference_code, r.public_id,
               c.code AS currency_code,
               a.name AS account_name,
               payer.first_name || ' ' || payer.last_name AS payer_name,
               recipient.first_name || ' ' || recipient.last_name AS recipient_name
        FROM   payment_confirmations pc
        JOIN   references_registry r ON r.id = pc.reference_id
        JOIN   currencies c          ON c.id = pc.currency_id
        JOIN   accounts a            ON a.id = pc.account_id
        JOIN   users payer           ON payer.id = pc.payer_id
        JOIN   users recipient       ON recipient.id = pc.recipient_id
        ${where}
        ORDER  BY pc.created_at DESC
    `, params);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET SINGLE — recipient, payer, or PAYMENT_ACK_VIEW only.
// GET /api/payment-confirmations/:id
// ============================================================
const getPaymentConfirmationById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(`
        SELECT pc.*,
               r.reference_code, r.public_id,
               c.code AS currency_code,
               a.name AS account_name,
               payer.first_name || ' ' || payer.last_name AS payer_name,
               recipient.first_name || ' ' || recipient.last_name AS recipient_name
        FROM   payment_confirmations pc
        JOIN   references_registry r ON r.id = pc.reference_id
        JOIN   currencies c          ON c.id = pc.currency_id
        JOIN   accounts a            ON a.id = pc.account_id
        JOIN   users payer           ON payer.id = pc.payer_id
        JOIN   users recipient       ON recipient.id = pc.recipient_id
        WHERE  pc.id = $1
    `, [id]);
    if (result.rows.length === 0) throw createError.notFound('Payment confirmation not found');
    const pc = result.rows[0];

    const isParty = pc.recipient_id === req.user.id || pc.payer_id === req.user.id;
    const canViewAll = (req.user.permissions || []).includes('PAYMENT_ACK_VIEW');
    if (!isParty && !canViewAll) {
        throw createError.forbidden('You do not have access to this record');
    }

    sendSuccess(res, { ...pc, source_label: SOURCE_LABELS[pc.source_type] || pc.source_type });
});

// ============================================================
// CONFIRM RECEIPT — this is what actually posts the transaction.
// POST /api/payment-confirmations/:id/confirm
// Recipient only, from PENDING_CONFIRMATION. Locks the row first so
// two simultaneous confirm attempts can't both post a transaction.
// ============================================================
const confirmPayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;

    await withTransaction(async (client) => {
        const pcResult = await client.query(`
            SELECT pc.*, recipient.first_name, recipient.last_name
            FROM   payment_confirmations pc
            JOIN   users recipient ON recipient.id = pc.recipient_id
            WHERE  pc.id = $1 FOR UPDATE
        `, [id]);
        if (pcResult.rows.length === 0) throw createError.notFound('Payment confirmation not found');
        const pc = pcResult.rows[0];

        if (pc.recipient_id !== req.user.id) {
            throw createError.forbidden('Only the recipient can confirm this payment');
        }
        if (pc.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This entry is already ${pc.status.toLowerCase().replace('_', ' ')}`);
        }

        const accountResult = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1 AND is_active = TRUE',
            [pc.account_id]
        );
        if (accountResult.rows.length === 0) {
            throw createError.badRequest('The account this payment was recorded against is no longer active');
        }
        const account = accountResult.rows[0];

        const methodDetail = pc.payment_method === 'CASH'
            ? 'Cash'
            : `${PAYMENT_METHOD_LABELS[pc.payment_method]} (${pc.payment_method === 'MOBILE_MONEY' ? pc.mobile_money_provider + ', ' : ''}ref ${pc.external_reference})`;

        const txCategoryAbbrev = pc.source_type === 'SERVICE_FEE_PAYMENT' ? 'SVC'
            : pc.source_type === 'SERVICE_FEE_ADVANCE' ? 'ADV'
            : 'GEN';
        const txInflowType = pc.source_type === 'SERVICE_FEE_PAYMENT' ? 'SERVICE_FEE_OUT'
            : pc.source_type === 'SERVICE_FEE_ADVANCE' ? 'SERVICE_FEE_ADVANCE_OUT'
            : 'GENERAL_PAYMENT_OUT';

        const { referenceId: txRefId, referenceCode: txRefCode } = await generateReference(
            client, resolveModuleCode(account), txCategoryAbbrev, 'TRANSACTION', pc.payer_id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       account.id,
            transactionType: 'DEBIT',
            inflowType:      txInflowType,
            amount:          parseFloat(pc.amount),
            currencyId:      pc.currency_id,
            categoryId:      pc.category_id,
            description:     `${pc.purpose} — ${methodDetail}`,
            valueDate:       pc.entry_date,
            createdBy:       pc.payer_id,
            referenceId:     txRefId,
        });
        await linkReferenceToRecord(client, txRefId, transactionId);

        await client.query(`
            UPDATE payment_confirmations
            SET    status = 'CONFIRMED', transaction_id = $1, confirmed_at = NOW(), confirmation_note = $2
            WHERE  id = $3
        `, [transactionId, note || null, id]);

        if (pc.source_type === 'SERVICE_FEE_PAYMENT') {
            const paymentResult = await client.query(`
                INSERT INTO service_fee_payments (agreement_id, amount, payment_date, transaction_id, notes, paid_by)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
            `, [pc.source_id, pc.amount, pc.entry_date, transactionId, note || null, pc.payer_id]);
            const serviceFeePaymentId = paymentResult.rows[0].id;

            // v1.52.0 — apply this now-confirmed payment across
            // whichever monthly period(s) were decided when the
            // confirmation was created (recordPayment's oldest-first
            // cascade, or a bulk settle-past-months breakdown),
            // updating each period's cached amount_paid/status and
            // writing the append-only service_fee_payment_applications
            // trail. Pre-v1.52.0 confirmations have no breakdown rows
            // and are simply skipped — no periods existed for them.
            const breakdownResult = await client.query(
                `SELECT period_id, amount FROM service_fee_payment_confirmation_periods WHERE confirmation_id = $1`,
                [pc.id]
            );
            if (breakdownResult.rows.length > 0) {
                await applyPaymentToPeriods(client, { paymentId: serviceFeePaymentId, breakdown: breakdownResult.rows });
            }
        } else if (pc.source_type === 'SERVICE_FEE_ADVANCE') {
            // v1.53.0 — the advance is only actually "disbursed" once the
            // recipient confirms receipt here, mirroring SERVICE_FEE_PAYMENT
            // above. The recovery schedule (which future period(s) will
            // absorb it) was already decided and stored, unapplied, when
            // the Treasurer approved the advance — apply it now as an
            // internal offset (each period's amount_paid incremented, no
            // separate transaction, since the cash already moved via the
            // transaction just posted above).
            const recoverySchedule = await getAdvanceRecoverySchedule(pc.source_id);
            if (recoverySchedule.length > 0) {
                await applyAdvanceRecovery(client, { advanceId: pc.source_id, breakdown: recoverySchedule });
            }
            const totalRecovery = recoverySchedule.reduce((sum, r) => sum + parseFloat(r.amount), 0);
            await client.query(`
                UPDATE service_fee_advances
                SET    disbursed_at = NOW(), transaction_id = $1,
                       outstanding_balance = $2
                WHERE  id = $3
            `, [transactionId, totalRecovery, pc.source_id]);
        }

        await logAction(req.user.id, ACTIONS.PAYMENT_CONFIRMATION_CONFIRMED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'payment_confirmations',
            recordId:    parseInt(id),
            newValues:   { txRefCode, balanceBefore, balanceAfter },
            description: `Payment confirmed and posted: ${txRefCode} — ${pc.amount}`,
            client,
        });

        notify({
            userId: pc.payer_id,
            type:   'PAYMENT_CONFIRMATION_CONFIRMED',
            title:  'A payment you recorded was confirmed',
            body:   `${pc.first_name} ${pc.last_name} confirmed receipt of ${parseFloat(pc.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}. Reference: ${txRefCode}.`,
            link:       '/payment-acknowledgements',
            module:     'FINANCE',
            recordType: 'payment_confirmations',
            recordId:   parseInt(id),
        }).catch(() => {});

        sendSuccess(res, {
            status: 'CONFIRMED', transaction_reference: txRefCode,
            balance_before: balanceBefore, balance_after: balanceAfter,
        }, 'Payment confirmed and posted');
    });
});

// ============================================================
// DISPUTE — recipient only, from PENDING_CONFIRMATION. A reason is
// required. No transaction is ever created for a disputed entry.
// POST /api/payment-confirmations/:id/dispute
// ============================================================
const disputePayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        throw createError.badRequest('A reason is required to dispute a payment entry');
    }

    const result = await query(`
        UPDATE payment_confirmations
        SET    status = 'DISPUTED', dispute_reason = $1, disputed_at = NOW()
        WHERE  id = $2 AND recipient_id = $3 AND status = 'PENDING_CONFIRMATION'
        RETURNING id, source_type, amount, payer_id
    `, [reason.trim(), id, req.user.id]);

    if (result.rows.length === 0) {
        throw createError.badRequest(
            'This entry was not found, is not yours, or is not awaiting your review'
        );
    }
    const pc = result.rows[0];

    await logAction(req.user.id, ACTIONS.PAYMENT_CONFIRMATION_DISPUTED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'payment_confirmations',
        recordId:    parseInt(id),
        newValues:   { reason: reason.trim() },
        description: `Payment confirmation disputed — ID ${id}: ${reason.trim()}`,
    });

    const contacts = await getTreasuryContacts();
    notifyMany(contacts, 'PAYMENT_CONFIRMATION_DISPUTED', () => ({
        title: 'A payment entry was disputed',
        body:  `${req.user.first_name} ${req.user.last_name} disputed a payment of ${parseFloat(pc.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${SOURCE_LABELS[pc.source_type] || pc.source_type}): "${reason.trim()}"`,
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_confirmations',
        recordId:   parseInt(id),
    })).catch(() => {});

    sendSuccess(res, { status: 'DISPUTED' }, 'Dispute recorded — Treasury has been notified');
});

// ============================================================
// CANCEL — Treasury/Admin (PAYMENT_ACK_MANAGE). From
// PENDING_CONFIRMATION or DISPUTED only — a CONFIRMED entry has
// already posted a real transaction and can't be cancelled here.
// POST /api/payment-confirmations/:id/cancel
// ============================================================
const cancelPaymentConfirmation = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    const result = await query(`
        UPDATE payment_confirmations
        SET    status = 'CANCELLED', cancellation_reason = $1, cancelled_by = $2, cancelled_at = NOW()
        WHERE  id = $3 AND status IN ('PENDING_CONFIRMATION', 'DISPUTED')
        RETURNING id, recipient_id, source_type, amount
    `, [reason || null, req.user.id, id]);

    if (result.rows.length === 0) {
        throw createError.badRequest(
            'This entry was not found, or is already confirmed/cancelled — a confirmed payment has already posted a real transaction and can\'t be cancelled here'
        );
    }
    const pc = result.rows[0];

    await logAction(req.user.id, ACTIONS.PAYMENT_CONFIRMATION_CANCELLED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'payment_confirmations',
        recordId:    parseInt(id),
        description: `Payment confirmation cancelled — ID ${id}` + (reason ? `: ${reason}` : ''),
    });

    notify({
        userId: pc.recipient_id,
        type:   'PAYMENT_CONFIRMATION_CANCELLED',
        title:  'A pending payment entry was cancelled',
        body:   `Treasury cancelled a payment entry of ${parseFloat(pc.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${SOURCE_LABELS[pc.source_type] || pc.source_type}) that was waiting for your confirmation.` +
                (reason ? ` Reason: ${reason}` : ''),
        link:       '/payment-acknowledgements',
        module:     'FINANCE',
        recordType: 'payment_confirmations',
        recordId:   parseInt(id),
    }).catch(() => {});

    sendSuccess(res, { status: 'CANCELLED' }, 'Payment entry cancelled');
});

module.exports = {
    SOURCE_LABELS,
    PAYMENT_METHOD_LABELS,
    createPaymentConfirmation,
    createServiceFeePaymentConfirmation,
    createServiceFeeAdvanceConfirmation,
    getMyPaymentConfirmations,
    getAllPaymentConfirmations,
    getPaymentConfirmationById,
    confirmPayment,
    disputePayment,
    cancelPaymentConfirmation,
};
