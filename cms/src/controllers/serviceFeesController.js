// ============================================================
// SERVICE FEES CONTROLLER (v1.21.0; payment flow updated v1.39.0)
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
//
// v1.39.0 — recordPayment() no longer posts its transaction
// immediately. It creates a pending payment_confirmations entry
// (Cash / Bank Transfer / Mobile Money, transaction ID required for
// the latter two) via paymentConfirmationsController.createServiceFeePaymentConfirmation;
// the real transaction only posts once the fee recipient confirms it
// (paymentConfirmationsController.confirmPayment). approveReimbursement
// is unchanged — it still posts immediately, followed by the original
// post-hoc payment_acknowledgements signoff.
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
const { createServiceFeePaymentConfirmation } = require('./paymentConfirmationsController');
const serviceFeeService = require('../services/serviceFeeService');

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
    const { user_id, monthly_amount, account_id, category_id, start_date, notes, payment_day } = req.body;

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

    // v1.52.0 — payment_day drives the monthly period generator below
    // and the due-date reminder job; falls back to the day of the
    // month the agreement itself starts on if not explicitly given,
    // clamped to 28 (mirrors capital_goals.call_deadline_day) so every
    // month can resolve a real calendar due date.
    const resolvedPaymentDay = payment_day
        ? parseInt(payment_day)
        : Math.min(new Date(`${start_date}T00:00:00Z`).getUTCDate(), 28);

    const agreementId = await withTransaction(async (client) => {
        const result = await client.query(`
            INSERT INTO service_fee_agreements
                (user_id, monthly_amount, currency_id, account_id, category_id, start_date, notes, payment_day, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `, [user_id, monthly_amount, currency_id, account_id, category_id, start_date, notes || null, resolvedPaymentDay, req.user.id]);

        const agreement = result.rows[0];

        // v1.52.0 — every agreement immediately gets its full run of
        // monthly periods from start_date through the current month,
        // so the breakdown table has something to show from the
        // moment the agreement is created, not just going forward.
        await serviceFeeService.generateMonthlyPeriodsForAgreement(client, agreement);

        return agreement.id;
    });

    await logAction(req.user.id, ACTIONS.SERVICE_FEE_AGREEMENT_CREATED, MODULES.STAFF, {
        ipAddress:   req.ip,
        recordType:  'service_fee_agreements',
        recordId:    agreementId,
        newValues:   { user_id, monthly_amount, start_date, payment_day: resolvedPaymentDay },
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
               a.start_date, a.end_date, a.status, a.notes, a.payment_day, a.created_at,
               u.first_name || ' ' || u.last_name AS user_name,
               c.code AS currency_code,
               acc.name AS account_name,
               (SELECT MAX(payment_date) FROM service_fee_payments WHERE agreement_id = a.id) AS last_paid_date,
               (SELECT COUNT(*) FROM service_fee_monthly_periods WHERE agreement_id = a.id AND status != 'PAID') AS unpaid_period_count
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
               c.code AS currency_code, acc.name AS account_name,
               cat.name AS category_name, cp.full_path AS category_trail,
               creator.first_name || ' ' || creator.last_name AS created_by_name
        FROM   service_fee_agreements a
        JOIN   users u        ON u.id = a.user_id
        JOIN   currencies c   ON c.id = a.currency_id
        JOIN   accounts acc   ON acc.id = a.account_id
        JOIN   categories cat ON cat.id = a.category_id
        JOIN   category_paths cp ON cp.category_id = a.category_id
        JOIN   users creator  ON creator.id = a.created_by
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

    // v1.47.0 — full amendment history for the agreement detail page:
    // every past change to the monthly amount, with its effective date
    // and who made it. Newest change first.
    const amendmentsResult = await query(`
        SELECT am.id, am.previous_amount, am.new_amount, am.reason,
               am.effective_from, am.created_at,
               u.first_name || ' ' || u.last_name AS amended_by_name
        FROM   service_fee_agreement_amendments am
        JOIN   users u ON u.id = am.amended_by
        WHERE  am.agreement_id = $1
        ORDER BY am.effective_from DESC, am.created_at DESC
    `, [id]);

    // v1.52.0 — full monthly breakdown (paid/partial/unpaid, due date,
    // any per-month override) for the agreement detail page's new
    // breakdown table, plus the stats this specific person's chart
    // needs (paid/unpaid months, most/least paid, total earned).
    const { periods, summary } = await serviceFeeService.computeAgreementStats(id);

    sendSuccess(res, {
        ...agreementResult.rows[0],
        payments: paymentsResult.rows,
        amendments: amendmentsResult.rows,
        periods,
        stats: summary,
    });
});

// GET /api/service-fees/agreements/:id/outstanding-periods
// Read-only preview (no row locking) of every UNPAID/PARTIAL period,
// oldest first, with its own remaining balance — this is what
// pre-fills the "Settle Past Months" modal's editable breakdown
// before the Treasurer submits it.
const getOutstandingPeriods = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await query(`
        SELECT id AS period_id, period, amount_due, amount_paid,
               (amount_due - amount_paid) AS amount_remaining, status, due_date
        FROM   service_fee_monthly_periods
        WHERE  agreement_id = $1 AND status IN ('UNPAID', 'PARTIAL')
        ORDER  BY period ASC
    `, [id]);
    sendSuccess(res, result.rows);
});

// PATCH /api/service-fees/agreements/:id
// Covers both amending an active agreement (monthly amount, paying
// account, category, notes) and terminating one (status='ENDED' with
// an end_date). If the paying account changes, currency_id is
// recomputed from the new account server-side — same reasoning as
// createAgreement above, an account can only ever hold one currency.
//
// v1.47.0 — whenever monthly_amount is actually changing (not just
// resent unchanged), a reason and an effective_from date are now
// required, and the change is recorded as an append-only row in
// service_fee_agreement_amendments (previous amount, new amount,
// reason, effective date, who made the change) — the original amount
// is never overwritten without a trace, mirroring how
// loan_received_rate_amendments tracks penalty-rate changes.
const updateAgreement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { monthly_amount, account_id, category_id, notes, status, end_date, reason, effective_from, payment_day } = req.body;

    const existing = await query('SELECT * FROM service_fee_agreements WHERE id = $1', [id]);
    if (existing.rows.length === 0) throw createError.notFound('Service fee agreement not found');

    if (status === 'ENDED' && !end_date) {
        throw createError.badRequest('An end date is required to end an agreement');
    }

    const isAmountChanging = monthly_amount !== undefined && monthly_amount !== null &&
        parseFloat(monthly_amount) !== parseFloat(existing.rows[0].monthly_amount);

    if (isAmountChanging && (!reason || !reason.trim() || !effective_from)) {
        throw createError.badRequest('A reason and an effective date are required when changing the monthly amount');
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

    const updated = await withTransaction(async (client) => {
        const result = await client.query(`
            UPDATE service_fee_agreements
            SET    monthly_amount = COALESCE($1, monthly_amount),
                   account_id     = COALESCE($2, account_id),
                   currency_id    = COALESCE($3, currency_id),
                   category_id    = COALESCE($4, category_id),
                   notes          = COALESCE($5, notes),
                   status         = COALESCE($6, status),
                   end_date       = COALESCE($7, end_date),
                   payment_day    = COALESCE($8, payment_day)
            WHERE  id = $9
            RETURNING *
        `, [monthly_amount || null, account_id || null, currency_id, category_id || null,
            notes !== undefined ? notes : null, status || null, end_date || null,
            payment_day ? parseInt(payment_day) : null, id]);

        if (isAmountChanging) {
            await client.query(`
                INSERT INTO service_fee_agreement_amendments
                    (agreement_id, previous_amount, new_amount, reason, effective_from, amended_by)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [id, existing.rows[0].monthly_amount, monthly_amount, reason.trim(), effective_from, req.user.id]);

            // v1.52.0 — a going-forward amendment updates every future
            // period's amount_due (any period an Treasurer has already
            // individually overridden is left untouched — see
            // applyAmendmentToFuturePeriods).
            await serviceFeeService.applyAmendmentToFuturePeriods(client, {
                agreementId: parseInt(id),
                newAmount: monthly_amount,
                effectiveFrom: effective_from,
            });
        }

        // v1.52.0 — if the agreement is ending, or if this update is
        // simply arriving in a new calendar month, this call also
        // backfills any month between the last-generated period and
        // now/end_date that doesn't exist yet — same idempotent
        // ON CONFLICT DO NOTHING generator used at creation time.
        await serviceFeeService.generateMonthlyPeriodsForAgreement(client, result.rows[0]);

        return result.rows[0];
    });

    await logAction(req.user.id, ACTIONS.SERVICE_FEE_AGREEMENT_UPDATED, MODULES.STAFF, {
        ipAddress:   req.ip,
        recordType:  'service_fee_agreements',
        recordId:    parseInt(id),
        oldValues:   existing.rows[0],
        newValues:   updated,
        description: isAmountChanging
            ? `Service fee agreement ID ${id} amended: monthly amount ${existing.rows[0].monthly_amount} -> ${monthly_amount}, effective ${effective_from} (${reason.trim()})`
            : `Service fee agreement ID ${id} updated`,
    });

    sendSuccess(res, updated, 'Service fee agreement updated');
});

// POST /api/service-fees/agreements/:id/pay
//
// v1.39.0 — this no longer posts the transaction immediately. It
// creates a pending payment_confirmations entry instead (source_type
// SERVICE_FEE_PAYMENT), stating how the fee was actually paid (Cash /
// Bank Transfer / Mobile Money, with a transaction ID required for
// the latter two) — the real transaction, and the service_fee_payments
// row, are only created once the recipient confirms it (see
// paymentConfirmationsController.confirmPayment). This replaced the
// old instant-post + post-hoc payment_acknowledgements signoff flow.
const recordPayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, payment_date, notes, payment_method, mobile_money_provider, external_reference } = req.body;

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

        const payAmount = parseFloat(amount || agreement.monthly_amount);
        const entryDate = payment_date || new Date().toISOString().split('T')[0];

        // Make sure this month's own period exists before cascading —
        // normally kept current by the daily sweep (jobs/scheduler.js)
        // and by updateAgreement, but a payment can arrive in between
        // those, so this call (idempotent, ON CONFLICT DO NOTHING)
        // guards against cascading into a month that hasn't been
        // generated yet.
        await serviceFeeService.generateMonthlyPeriodsForAgreement(client, agreement);

        // v1.52.0 — oldest-unpaid-period-first cascade (per the
        // Treasurer's confirmed answer: NOT matched to the payment's
        // own calendar month). A single recordPayment call always
        // settles whichever month(s) have been outstanding longest;
        // a specific historical month is instead handled via the
        // per-month override endpoint, and settling several months at
        // once via the bulk settlePastMonths endpoint below.
        const outstandingPeriods = await serviceFeeService.getOutstandingPeriodsForUpdate(client, agreement.id);
        const { breakdown } = serviceFeeService.cascadeAmountAcrossPeriods(outstandingPeriods, payAmount);

        const { id: confirmationId, referenceCode } = await createServiceFeePaymentConfirmation(client, {
            agreement,
            amount:               payAmount,
            entryDate,
            paymentMethod:        payment_method,
            mobileMoneyProvider:  mobile_money_provider,
            externalReference:    external_reference,
            purpose:              `Monthly service fee — ${agreement.first_name} ${agreement.last_name} (agreement ID ${id})`,
            payerId:              req.user.id,
            periodBreakdown:      breakdown,
        });

        await logAction(req.user.id, ACTIONS.SERVICE_FEE_PAYMENT_RECORDED, MODULES.STAFF, {
            ipAddress:   req.ip,
            recordType:  'payment_confirmations',
            recordId:    confirmationId,
            newValues:   { referenceCode, payAmount, payment_method },
            description: `Service fee payment entry created, awaiting confirmation: ${referenceCode} — ${agreement.first_name} ${agreement.last_name}: ${payAmount}`,
            client,
        });

        sendCreated(res, {
            confirmation_id: confirmationId,
            reference: referenceCode,
            status: 'PENDING_CONFIRMATION',
        }, `Service fee payment entry created for ${agreement.first_name} ${agreement.last_name} — awaiting their confirmation. Reference: ${referenceCode}`);
    });
});

// POST /api/service-fees/agreements/:id/settle
//
// v1.52.0 — "issue to settle all past months" (the Treasurer's own
// wording from the feature request): one lump-sum payment covering
// several outstanding periods at once. breakdown is the auto-filled,
// per-month figure the Treasurer can edit before submitting (each
// period's own amount_due - amount_paid) — the client is expected to
// have started from GET .../outstanding-periods and may adjust any
// line before posting here. The total (sum of breakdown) is what
// becomes the single payment_confirmations entry the recipient
// reviews; per-period application only happens once they confirm it
// (same two-step flow as a normal single-month recordPayment).
const settlePastMonths = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { breakdown, payment_date, notes, payment_method, mobile_money_provider, external_reference } = req.body;

    if (!Array.isArray(breakdown) || breakdown.length === 0) {
        throw createError.badRequest('At least one month to settle is required');
    }
    for (const line of breakdown) {
        if (!line.period_id || !(parseFloat(line.amount) > 0)) {
            throw createError.badRequest('Each month in the breakdown needs a valid period and a positive amount');
        }
    }

    await withTransaction(async (client) => {
        const agreementResult = await client.query(`
            SELECT a.*, u.first_name, u.last_name
            FROM   service_fee_agreements a
            JOIN   users u ON u.id = a.user_id
            WHERE  a.id = $1 FOR UPDATE
        `, [id]);
        if (agreementResult.rows.length === 0) throw createError.notFound('Service fee agreement not found');
        const agreement = agreementResult.rows[0];

        await serviceFeeService.generateMonthlyPeriodsForAgreement(client, agreement);

        // Confirm every period referenced actually belongs to this
        // agreement — guards against a stale/tampered client payload
        // pointing at someone else's period.
        const periodIds = breakdown.map(l => parseInt(l.period_id));
        const ownedPeriods = await client.query(
            `SELECT id FROM service_fee_monthly_periods WHERE id = ANY($1::int[]) AND agreement_id = $2`,
            [periodIds, id]
        );
        if (ownedPeriods.rows.length !== new Set(periodIds).size) {
            throw createError.badRequest('One or more selected months do not belong to this agreement');
        }

        const totalAmount = breakdown.reduce((sum, l) => sum + parseFloat(l.amount), 0);
        const entryDate = payment_date || new Date().toISOString().split('T')[0];
        const monthLabels = breakdown.map(l => l.period).filter(Boolean).join(', ');

        const { id: confirmationId, referenceCode } = await createServiceFeePaymentConfirmation(client, {
            agreement,
            amount:               totalAmount,
            entryDate,
            paymentMethod:        payment_method,
            mobileMoneyProvider:  mobile_money_provider,
            externalReference:    external_reference,
            purpose:              `Service fee settlement (${monthLabels || breakdown.length + ' month(s)'}) — ${agreement.first_name} ${agreement.last_name} (agreement ID ${id})`,
            payerId:              req.user.id,
            periodBreakdown:      breakdown.map(l => ({ period_id: parseInt(l.period_id), amount: parseFloat(l.amount) })),
        });

        await logAction(req.user.id, ACTIONS.SERVICE_FEE_MONTHS_SETTLED, MODULES.STAFF, {
            ipAddress:   req.ip,
            recordType:  'payment_confirmations',
            recordId:    confirmationId,
            newValues:   { referenceCode, totalAmount, months: breakdown.map(l => l.period) },
            description: `Bulk service fee settlement created, awaiting confirmation: ${referenceCode} — ${agreement.first_name} ${agreement.last_name}: ${totalAmount} across ${breakdown.length} month(s)`,
            client,
        });

        sendCreated(res, {
            confirmation_id: confirmationId,
            reference: referenceCode,
            status: 'PENDING_CONFIRMATION',
            total_amount: totalAmount,
        }, `Settlement entry created for ${agreement.first_name} ${agreement.last_name} — awaiting their confirmation. Reference: ${referenceCode}`);
    });
});

// PATCH /api/service-fees/agreements/:id/periods/:periodId/override
//
// v1.52.0 — changes ONE historical month's amount_due without
// touching the agreement's ongoing monthly_amount (that's what
// amending the agreement, above, is for — a going-forward change).
// Requires a reason, same convention as amendments and disputes
// elsewhere in this codebase.
const overridePeriod = asyncHandler(async (req, res) => {
    const { id, periodId } = req.params;
    const { amount_due, reason } = req.body;

    if (!(parseFloat(amount_due) >= 0)) {
        throw createError.badRequest('A valid amount is required');
    }
    if (!reason || !reason.trim()) {
        throw createError.badRequest('A reason is required to override a month\'s amount');
    }

    const updated = await withTransaction(async (client) => {
        return serviceFeeService.setPeriodOverride(client, {
            periodId:    parseInt(periodId),
            agreementId: parseInt(id),
            newAmountDue: parseFloat(amount_due),
            reason:      reason.trim(),
            overrideBy:  req.user.id,
        });
    });

    if (!updated) throw createError.notFound('That month was not found on this agreement');

    sendSuccess(res, updated, `${updated.period} amount overridden to ${amount_due}`);
});

// GET /api/service-fees/stats
// Treasury-wide aggregate — every agreement's paid/partial/unpaid
// period counts and totals, for the treasury-side chart section
// (SERVICE_FEE_VIEW, route-level).
const getTreasuryStats = asyncHandler(async (req, res) => {
    const stats = await serviceFeeService.computeTreasuryAggregateStats();
    sendSuccess(res, stats);
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

    // v1.52.0 — this person's own monthly breakdown + stats (paid/
    // unpaid months, most/least paid, total earned) for their "My
    // Service Fee" chart tab.
    const { periods, summary } = await serviceFeeService.computeAgreementStats(agreement.id);

    sendSuccess(res, { ...agreement, payments: paymentsResult.rows, periods, stats: summary });
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
    getOutstandingPeriods,
    settlePastMonths,
    overridePeriod,
    getTreasuryStats,
    getMyAgreement,
    requestReimbursement,
    getMyReimbursements,
    listReimbursements,
    previewReceipt,
    approveReimbursement,
    rejectReimbursement,
    getTreasurers,
};
