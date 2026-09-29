// ============================================================
// MEMBER SAVINGS CONTROLLER
// Handles personal savings accounts for shareholders.
//
// Two entry types (see schema.sql / migration_v1.10.0.sql for the
// full design notes):
//
//   FIXED_TERM — legacy (v1.2.0): a single lump-sum deposit with an
//     agreed rate and a fixed maturity date, self-recorded, no
//     approval, withdrawn in full at/after maturity. Existing rows
//     keep working exactly as before via createSavingsDeposit(FIXED_TERM)
//     and withdrawSavings.
//
//   FLEXIBLE — new (v1.10.0): an ongoing per-member balance
//     (savings_balances) built from many deposits over time.
//       1. DEPOSIT — Treasurer/Assistant Treasurer records one on
//          behalf of any member (source=TREASURY_DIRECT), or a member
//          requests it themself via a SAVINGS_DEPOSIT requisition
//          (source=REQUISITION, handled in requisitionsController.js).
//          Either way it's PENDING_APPROVAL until a Treasurer/Assistant
//          Treasurer (other than whoever recorded it, ideally) approves
//          it — approval is what posts the crediting transaction and
//          adds it to the balance.
//       2. HANDOUT — Treasurer/Assistant Treasurer enters a payout
//          (principal + an interest amount, pre-filled from the
//          member's accrued interest). Nothing moves yet — the
//          receiving member must confirm it themselves before the
//          debit posts and the balance drops. They can reject/dispute
//          it instead.
//     Interest accrues automatically every day at the single
//     company-wide rate in savings_settings (see jobs/scheduler.js).
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction, creditShareholderContribution } = require('./transactionsController');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { createPaymentAcknowledgement } = require('./paymentAcknowledgementsController');
const { getOrCreateSavingsBalance, getSavingsAccount } = require('../services/savingsService');
const { getOrCreateCategory } = require('../services/categoryService');
const taxService = require('../services/taxService');
const { assertNotOwnRecord } = require('../services/approvalGuard'); // v1.72.0

MODULE_CODES.SAVINGS = 'SAV';
MODULE_CODES.SAVINGS_HANDOUT = 'SAVOUT';

// v1.61.0 — the category both legs of an internal currency conversion
// post under. Mirrors FINES_CATEGORY's shape (finesService.js):
// looked up/created once via getOrCreateCategory rather than asking
// the Treasurer to pick one — there's nothing for them to categorize,
// this is purely a currency swap of money already inside Savings.
const SAVINGS_CURRENCY_CONVERSION_CATEGORY = {
    module:       'FINANCE',
    name:         'Savings Currency Conversion',
    abbreviation: 'SAVFX',
    description:  'Internal movement of a member\'s own savings from one currency they hold into another',
};

// ============================================================
// INTERNAL HELPER — create a PENDING_APPROVAL flexible deposit row
// and notify Treasurer/Assistant Treasurer. Shared by:
//   1. createSavingsDeposit below (Treasurer records directly)
//   2. requisitionsController.approveRequisition (a member's
//      SAVINGS_DEPOSIT requisition was approved by the Treasurer,
//      which hands it off here for final financial sign-off)
// Must be called from inside an existing `withTransaction` block.
// ============================================================
const createPendingFlexibleDeposit = async (client, {
    userId, categoryId, amount, depositDate, notes, currencyId,
    recordedByUserId, source = 'TREASURY_DIRECT', requisitionId = null,
}) => {
    const memberResult = await client.query(
        'SELECT id, first_name, last_name FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (memberResult.rows.length === 0) {
        throw createError.notFound('Member not found');
    }
    const member = memberResult.rows[0];

    // v1.61.0 — which currency's Savings account this deposit goes
    // into; a company can now have more than one.
    const savingsAccount = await getSavingsAccount(client, currencyId);

    const { referenceId, referenceCode } = await generateReference(
        client, MODULE_CODES.SAVINGS, 'SAV', 'SAVINGS', recordedByUserId
    );

    const result = await client.query(`
        INSERT INTO member_savings (
            reference_id, user_id, account_id, currency_id, category_id,
            principal_amount, deposit_date, entry_type, source, requisition_id,
            recorded_by, status, notes, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'FLEXIBLE', $8, $9,
            $10, 'PENDING_APPROVAL', $11, $10)
        RETURNING id
    `, [
        referenceId, userId, savingsAccount.id, savingsAccount.currency_id,
        categoryId, amount, depositDate, source, requisitionId,
        recordedByUserId, notes || null,
    ]);

    const savingsId = result.rows[0].id;
    await linkReferenceToRecord(client, referenceId, savingsId);

    // Notify Treasurer / Assistant Treasurer
    const approvers = await client.query(`
        SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id
        WHERE  r.name IN ('Treasurer', 'Assistant Treasurer')
        AND    u.is_active = TRUE
    `);
    const shell = await wrapEmail(`
        <p>Dear {{FIRST_NAME}},</p>
        <p>A savings deposit needs your approval:</p>
        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
            <tr><td style="padding:4px 0; color:#6b7280;">Member</td><td style="padding:4px 0; text-align:right;">${member.first_name} ${member.last_name}</td></tr>
            <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
            <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
        </table>
    `, { preheader: 'A savings deposit needs your approval' });
    notifyMany(approvers.rows, 'SAVINGS_DEPOSIT_PENDING', (approver) => ({
        title:      'Savings deposit awaiting your approval',
        body:       `${member.first_name} ${member.last_name}'s deposit of ${amount} (${referenceCode}) needs approval.`,
        link:       `/savings`,
        module:     'FINANCE',
        recordType: 'member_savings',
        recordId:   savingsId,
        email: {
            subject: `Savings deposit awaiting approval — ${referenceCode}`,
            html:    shell.replace('{{FIRST_NAME}}', approver.first_name),
        },
    }));

    return { savingsId, referenceId, referenceCode, member };
};

// ============================================================
// CREATE SAVINGS DEPOSIT (FLEXIBLE, treasury-direct)
// POST /api/savings
// Treasurer/Assistant Treasurer records a deposit on behalf of any
// member. Sits PENDING_APPROVAL until a Treasurer/Assistant Treasurer approves it.
// ============================================================
const createSavingsDeposit = asyncHandler(async (req, res) => {
    const { user_id, category_id, amount, deposit_date, notes, currency_id } = req.body;

    await withTransaction(async (client) => {
        const { savingsId, referenceCode, member } = await createPendingFlexibleDeposit(client, {
            userId: user_id, categoryId: category_id, amount, depositDate: deposit_date,
            notes, currencyId: currency_id, recordedByUserId: req.user.id, source: 'TREASURY_DIRECT',
        });

        await logAction(req.user.id, ACTIONS.SAVINGS_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'member_savings',
            recordId:    savingsId,
            newValues:   { referenceCode, user_id, amount },
            description: `Savings deposit recorded (pending Treasurer/Assistant Treasurer approval): ${referenceCode} — ${member.first_name} ${member.last_name}: ${amount}`,
            client,
        });

        sendCreated(res, {
            savings_id: savingsId,
            reference:  referenceCode,
            status:     'PENDING_APPROVAL',
        }, `Savings deposit recorded. Reference: ${referenceCode}. Awaiting Treasurer/Assistant Treasurer approval.`);
    });
});

// ============================================================
// APPROVE SAVINGS DEPOSIT (FLEXIBLE) — Treasurer / Assistant Treasurer
// PATCH /api/savings/:id/approve
// Posts the crediting transaction and updates the member's balance.
// ============================================================
const approveSavingsDeposit = asyncHandler(async (req, res) => {
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'member_savings', req.params.id, ['user_id', 'recorded_by', 'created_by'], 'savings deposit');
    const { id } = req.params;
    const { review_notes } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT ms.*, r.reference_code, u.first_name, u.last_name
            FROM   member_savings ms
            JOIN   references_registry r ON r.id = ms.reference_id
            JOIN   users u ON u.id = ms.user_id
            WHERE  ms.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings deposit not found');
        }
        const savings = existing.rows[0];

        if (savings.entry_type !== 'FLEXIBLE' || savings.status !== 'PENDING_APPROVAL') {
            throw createError.badRequest('Only a pending flexible savings deposit can be approved');
        }

        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAV-IN', 'TRANSACTION', req.user.id);

        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       savings.account_id,
                transactionType: 'CREDIT',
                inflowType:      'SAVINGS_DEPOSIT_IN',
                amount:          savings.principal_amount,
                currencyId:      savings.currency_id,
                categoryId:      savings.category_id,
                description:     `Savings deposit — ${savings.first_name} ${savings.last_name} (${savings.reference_code})`,
                valueDate:       savings.deposit_date,
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });
        await linkReferenceToRecord(client, txRefId, transactionId);

        await client.query(`
            UPDATE member_savings
            SET    status = 'ACTIVE',
                   transaction_id = $1,
                   secretary_approved_by = $2,
                   secretary_approved_at = NOW(),
                   review_notes = $3
            WHERE  id = $4
        `, [transactionId, req.user.id, review_notes || null, id]);

        // v1.61.0 — a member can hold several currencies' worth of
        // savings_balances rows now, so every update here must be
        // scoped to the SPECIFIC (user, currency) row, never just
        // user_id alone (that would touch every currency they hold).
        await getOrCreateSavingsBalance(client, savings.user_id, savings.currency_id);
        await client.query(`
            UPDATE savings_balances
            SET    principal_balance = principal_balance + $1,
                   updated_at = NOW()
            WHERE  user_id = $2 AND currency_id = $3
        `, [savings.principal_amount, savings.user_id, savings.currency_id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_DEPOSIT_APPROVED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'member_savings',
            recordId:    parseInt(id),
            newValues:   { txRefCode, amount: savings.principal_amount, balanceBefore, balanceAfter },
            description: `Savings deposit approved: ${savings.reference_code} — ${savings.first_name} ${savings.last_name}: ${savings.principal_amount}`,
            client,
        });

        notify({
            userId:     savings.user_id,
            type:       'SAVINGS_DEPOSIT_APPROVED',
            title:      'Your savings deposit was approved',
            body:       `Your deposit of ${savings.principal_amount} (${savings.reference_code}) has been approved and added to your savings.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'member_savings',
            recordId:   parseInt(id),
            email: {
                subject: `Savings deposit approved — ${savings.reference_code}`,
                html: await wrapEmail(`
                    <p>Dear ${savings.first_name},</p>
                    <p>Your savings deposit of <strong>${savings.principal_amount}</strong> (${savings.reference_code}) has been approved and added to your savings balance.</p>
                    ${review_notes ? `<p style="color:#6b7280;">Notes: ${review_notes}</p>` : ''}
                `, { preheader: 'Your savings deposit has been approved' }),
            },
        });

        sendSuccess(res, {
            status: 'ACTIVE',
            transaction_reference: txRefCode,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, 'Savings deposit approved and recorded');
    });
});

// ============================================================
// REJECT SAVINGS DEPOSIT (FLEXIBLE) — Treasurer / Assistant Treasurer
// PATCH /api/savings/:id/reject
// ============================================================
const rejectSavingsDeposit = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { review_notes } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT ms.*, r.reference_code, u.first_name, u.last_name
            FROM   member_savings ms
            JOIN   references_registry r ON r.id = ms.reference_id
            JOIN   users u ON u.id = ms.user_id
            WHERE  ms.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings deposit not found');
        }
        const savings = existing.rows[0];

        if (savings.entry_type !== 'FLEXIBLE' || savings.status !== 'PENDING_APPROVAL') {
            throw createError.badRequest('Only a pending flexible savings deposit can be rejected');
        }

        await client.query(`
            UPDATE member_savings
            SET    status = 'REJECTED',
                   secretary_approved_by = $1,
                   secretary_approved_at = NOW(),
                   review_notes = $2
            WHERE  id = $3
        `, [req.user.id, review_notes || null, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_DEPOSIT_REJECTED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'member_savings',
            recordId:    parseInt(id),
            description: `Savings deposit rejected: ${savings.reference_code} — ${savings.first_name} ${savings.last_name}`,
            client,
        });

        notify({
            userId:     savings.user_id,
            type:       'SAVINGS_DEPOSIT_REJECTED',
            title:      'Your savings deposit was rejected',
            body:       `Your deposit request ${savings.reference_code} was rejected.${review_notes ? ` Reason: ${review_notes}` : ''}`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'member_savings',
            recordId:   parseInt(id),
        });

        sendSuccess(res, { status: 'REJECTED' }, 'Savings deposit rejected');
    });
});

// ============================================================
// CREATE SAVINGS HANDOUT (FLEXIBLE) — Treasurer / Assistant Treasurer
// POST /api/savings/handouts
// Nothing moves yet — sits PENDING_CONFIRMATION until the receiving
// member confirms it (see confirmSavingsHandout).
//
// The source account is never client-supplied — a handout is always
// paid out of the one dedicated SAVINGS account (getSavingsAccount,
// Section 4.11), exactly like a deposit is always credited into it.
// Previously this trusted an `account_id` from the request body,
// which let a handout be recorded against any active account
// (Primary, a Secondary/operational account, etc.) — money that was
// never actually in the member's savings.
// ============================================================
const createSavingsHandout = asyncHandler(async (req, res) => {
    const { user_id, category_id, principal_amount, interest_amount, handout_date, notes, currency_id } = req.body;

    await withTransaction(async (client) => {
        const memberResult = await client.query(
            'SELECT * FROM users WHERE id = $1 AND is_active = TRUE',
            [user_id]
        );
        if (memberResult.rows.length === 0) {
            throw createError.notFound('Member not found');
        }
        const member = memberResult.rows[0];

        // v1.61.0 — which of the member's currency balances this
        // handout pays out of; a member can hold several at once.
        const balance = await getOrCreateSavingsBalance(client, user_id, currency_id);

        const principal = parseFloat(principal_amount);
        const interest  = parseFloat(interest_amount || 0);

        if (principal > parseFloat(balance.principal_balance)) {
            throw createError.badRequest(
                `Cannot hand out more principal than the member has saved. ` +
                `Available: ${balance.principal_balance}.`
            );
        }
        if (interest > parseFloat(balance.accrued_interest)) {
            throw createError.badRequest(
                `Cannot hand out more interest than has accrued. ` +
                `Available: ${balance.accrued_interest}.`
            );
        }

        const savingsAccount = await getSavingsAccount(client, currency_id);

        const total = principal + interest;

        // v1.70.0 — withholding tax on the INTEREST part (Income Tax Act
        // s.117): the member receives the interest net of tax; the tax is
        // kept for URA. The principal is their own money — never taxed.
        // Worked out now for the member to see, and again at confirmation
        // (the day the money actually moves).
        let whtPreview = null;
        if (interest > 0 && await taxService.isMigrated()) {
            const w = await taxService.computeWithholding(client, {
                paymentType: 'SAVINGS_INTEREST', residency: member.tax_residency || 'RESIDENT',
                gross: interest, currencyId: savingsAccount.currency_id, date: handout_date,
            });
            if (w.applies) whtPreview = w;
        }
        const whtAmount = whtPreview ? whtPreview.tax : 0;

        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.SAVINGS_HANDOUT, 'SAVOUT', 'SAVINGS_HANDOUT', req.user.id
        );

        const result = await client.query(`
            INSERT INTO savings_handouts (
                reference_id, user_id, account_id, category_id, principal_amount,
                interest_amount, total_amount, currency_id, handout_date,
                notes, entered_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
        `, [
            referenceId, user_id, savingsAccount.id, category_id, principal, interest, total,
            savingsAccount.currency_id, handout_date, notes || null, req.user.id,
        ]);

        const handoutId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, handoutId);
        if (await taxService.isMigrated()) {
            await client.query(`UPDATE savings_handouts SET wht_rate = $1, wht_amount = $2, net_amount = $3 WHERE id = $4`,
                [whtPreview ? whtPreview.rate : null, whtAmount, total - whtAmount, handoutId]);
        }

        await logAction(req.user.id, ACTIONS.SAVINGS_HANDOUT_ENTERED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_handouts',
            recordId:    handoutId,
            newValues:   { referenceCode, user_id, principal, interest, total },
            description: `Savings handout entered (awaiting member confirmation): ${referenceCode} — ${member.first_name} ${member.last_name}: ${total}`,
            client,
        });

        notify({
            userId:     user_id,
            type:       'SAVINGS_HANDOUT_PENDING',
            title:      'Confirm your savings handout',
            body:       `A savings handout of ${total - whtAmount}${whtAmount > 0 ? ` (${total} less ${whtAmount} withholding tax on the interest)` : ''} (${referenceCode}) has been entered for you. Please confirm you received it.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_handouts',
            recordId:   handoutId,
            email: {
                subject: `Please confirm your savings handout — ${referenceCode}`,
                html: await wrapEmail(`
                    <p>Dear ${member.first_name},</p>
                    <p>A savings handout has been entered for you:</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Principal</td><td style="padding:4px 0; text-align:right;">${principal}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Interest</td><td style="padding:4px 0; text-align:right;">${interest}</td></tr>
                        ${whtAmount > 0 ? `<tr><td style="padding:4px 0; color:#6b7280;">Less withholding tax on interest (${whtPreview.rate}%)</td><td style="padding:4px 0; text-align:right;">-${whtAmount}</td></tr>` : ''}
                        <tr><td style="padding:4px 0; color:#6b7280; font-weight:700;">Total paid to you</td><td style="padding:4px 0; text-align:right; font-weight:700;">${total - whtAmount}</td></tr>
                    </table>
                    <p>Please log in and confirm you received this, or reject it if something's wrong.</p>
                `, { preheader: 'Please confirm your savings handout' }),
            },
        });

        sendCreated(res, {
            handout_id: handoutId,
            reference:  referenceCode,
            status:     'PENDING_CONFIRMATION',
            withholding_tax: whtAmount,
            net_amount: total - whtAmount,
        }, `Handout recorded. Reference: ${referenceCode}. Awaiting the member's confirmation.` +
           (whtAmount > 0 ? ` ${whtAmount} withholding tax on the interest will be kept for URA.` : ''));
    });
});

// ============================================================
// CONFIRM SAVINGS HANDOUT — only the receiving member
// PATCH /api/savings/handouts/:id/confirm
// This is what actually moves the money and drops the balance.
// ============================================================
const confirmSavingsHandout = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT sh.*, r.reference_code, u.first_name, u.last_name
            FROM   savings_handouts sh
            JOIN   references_registry r ON r.id = sh.reference_id
            JOIN   users u ON u.id = sh.user_id
            WHERE  sh.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings handout not found');
        }
        const handout = existing.rows[0];

        if (handout.user_id !== req.user.id) {
            throw createError.forbidden('Only the receiving member can confirm this handout');
        }
        if (handout.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This handout cannot be confirmed. Status: ${handout.status}`);
        }

        // v1.70.0 — withholding tax on the interest part, worked out on
        // the day the money moves; only the net amount leaves the account.
        const today = new Date().toISOString().split('T')[0];
        const interestPart = parseFloat(handout.interest_amount) || 0;
        let wht = null;
        const taxReady = await taxService.isMigrated();
        if (interestPart > 0 && taxReady) {
            const member = await client.query('SELECT tax_residency FROM users WHERE id = $1', [handout.user_id]);
            const w = await taxService.computeWithholding(client, {
                paymentType: 'SAVINGS_INTEREST', residency: member.rows[0]?.tax_residency || 'RESIDENT',
                gross: interestPart, currencyId: handout.currency_id, date: today,
            });
            if (w.applies) wht = w;
        }
        const whtAmount = wht ? wht.tax : 0;
        const netPaid = parseFloat((parseFloat(handout.total_amount) - whtAmount).toFixed(4));

        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAV-OUT', 'TRANSACTION', req.user.id);

        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       handout.account_id,
                transactionType: 'DEBIT',
                inflowType:      'SAVINGS_HANDOUT_OUT',
                amount:          netPaid,
                currencyId:      handout.currency_id,
                categoryId:      handout.category_id,
                description:     `Savings handout — ${handout.first_name} ${handout.last_name} (${handout.reference_code})` +
                                 (whtAmount > 0 ? ` — interest ${interestPart} less withholding tax ${whtAmount}` : ''),
                valueDate:       today,
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });
        await linkReferenceToRecord(client, txRefId, transactionId);

        if (taxReady) {
            await client.query(`UPDATE savings_handouts SET wht_rate = $1, wht_amount = $2, net_amount = $3 WHERE id = $4`,
                [wht ? wht.rate : null, whtAmount, netPaid, id]);
        }
        if (wht) {
            const who = await client.query('SELECT tin, tax_residency FROM users WHERE id = $1', [handout.user_id]);
            await taxService.recordWithholding(client, {
                paymentType: 'SAVINGS_INTEREST', payeeUserId: handout.user_id,
                payeeName: `${handout.first_name} ${handout.last_name}`, payeeTin: who.rows[0]?.tin || null,
                payeeResidency: who.rows[0]?.tax_residency || 'RESIDENT',
                rateCode: wht.rateCode, rate: wht.rate, gross: interestPart, tax: whtAmount,
                currencyId: handout.currency_id, date: today, debitGlCode: '2100',
                sourceTransactionId: transactionId, savingsHandoutId: parseInt(id), userId: req.user.id,
                notes: `Interest paid with savings handout ${handout.reference_code}`,
            });
        }

        await client.query(`
            UPDATE savings_handouts
            SET    status = 'CONFIRMED', transaction_id = $1, confirmed_at = NOW()
            WHERE  id = $2
        `, [transactionId, id]);

        await client.query(`
            UPDATE savings_balances
            SET    principal_balance   = principal_balance - $1,
                   accrued_interest    = accrued_interest - $2,
                   total_interest_paid = total_interest_paid + $2,
                   updated_at = NOW()
            WHERE  user_id = $3 AND currency_id = $4
        `, [handout.principal_amount, handout.interest_amount, handout.user_id, handout.currency_id]);

        // v1.30.2 (Section 4.35) — same Payment Acknowledgement flow as
        // dividends/service fees/reimbursements, now covering savings
        // handouts too. Note req.user.id here is the RECIPIENT (only
        // they can call this endpoint) — the payer is whoever entered
        // the handout (handout.entered_by), not the caller.
        await createPaymentAcknowledgement(client, {
            sourceType:    'SAVINGS_HANDOUT',
            sourceId:      parseInt(id),
            transactionId,
            payerId:       handout.entered_by,
            recipientId:   handout.user_id,
            amount:        netPaid,
            currencyId:    handout.currency_id,
            purpose:       `Savings handout — ${handout.reference_code}` +
                           (whtAmount > 0 ? ` (net of ${whtAmount} withholding tax on interest)` : '') +
                           `${handout.notes ? `: ${handout.notes}` : ''}`,
        });

        await logAction(req.user.id, ACTIONS.SAVINGS_HANDOUT_CONFIRMED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_handouts',
            recordId:    parseInt(id),
            newValues:   { txRefCode, balanceBefore, balanceAfter },
            description: `Savings handout confirmed: ${handout.reference_code} — ${handout.total_amount}`,
            client,
        });

        notify({
            userId:     handout.entered_by,
            type:       'SAVINGS_HANDOUT_CONFIRMED',
            title:      'Savings handout confirmed',
            body:       `${handout.first_name} ${handout.last_name} confirmed the handout ${handout.reference_code}.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_handouts',
            recordId:   parseInt(id),
        });

        sendSuccess(res, {
            status: 'CONFIRMED',
            transaction_reference: txRefCode,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, 'Handout confirmed');
    });
});

// ============================================================
// REJECT SAVINGS HANDOUT — only the receiving member
// PATCH /api/savings/handouts/:id/reject
// ============================================================
const rejectSavingsHandout = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT sh.*, r.reference_code, u.first_name, u.last_name
            FROM   savings_handouts sh
            JOIN   references_registry r ON r.id = sh.reference_id
            JOIN   users u ON u.id = sh.user_id
            WHERE  sh.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings handout not found');
        }
        const handout = existing.rows[0];

        if (handout.user_id !== req.user.id) {
            throw createError.forbidden('Only the receiving member can reject this handout');
        }
        if (handout.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This handout cannot be rejected. Status: ${handout.status}`);
        }

        await client.query(`
            UPDATE savings_handouts
            SET    status = 'REJECTED', rejected_reason = $1, rejected_at = NOW()
            WHERE  id = $2
        `, [reason || null, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_HANDOUT_REJECTED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_handouts',
            recordId:    parseInt(id),
            description: `Savings handout disputed by recipient: ${handout.reference_code}`,
            client,
        });

        notify({
            userId:     handout.entered_by,
            type:       'SAVINGS_HANDOUT_REJECTED',
            title:      'Savings handout disputed',
            body:       `${handout.first_name} ${handout.last_name} rejected handout ${handout.reference_code}.${reason ? ` Reason: ${reason}` : ''}`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_handouts',
            recordId:   parseInt(id),
        });

        sendSuccess(res, { status: 'REJECTED' }, 'Handout rejected');
    });
});

// ============================================================
// CREATE SAVINGS-TO-CAPITAL CONVERSION (v1.58.0) — Treasurer / Assistant Treasurer
// POST /api/savings/capital-conversions
// Requested directly: "the treasurer can decide to take money out of
// one's savings account and top it up to their capital contributions
// with an approval... to post the money on the usable account funds."
// Its own standalone flow (not a Handout variant) — the destination is
// a capital contribution, not a cash payout, and it produces a second
// record (shareholder_contributions) that changes the member's
// shares_held/percentage. Nothing moves yet — this is still the
// member's own savings, so their own confirmation is required before
// anything posts (confirmSavingsCapitalConversion below), exactly the
// same shape as a Handout.
// ============================================================
const createSavingsCapitalConversion = asyncHandler(async (req, res) => {
    const { user_id, category_id, amount, conversion_date, notes, destination_account_id, currency_id } = req.body;

    await withTransaction(async (client) => {
        const memberResult = await client.query(
            'SELECT * FROM users WHERE id = $1 AND is_active = TRUE',
            [user_id]
        );
        if (memberResult.rows.length === 0) {
            throw createError.notFound('Member not found');
        }
        const member = memberResult.rows[0];

        // v1.61.0 — which of the member's currency balances this
        // conversion draws from; a member can hold several at once.
        const balance = await getOrCreateSavingsBalance(client, user_id, currency_id);
        const principal = parseFloat(amount);

        if (principal > parseFloat(balance.principal_balance)) {
            throw createError.badRequest(
                `Cannot convert more principal than the member has saved. Available: ${balance.principal_balance}.`
            );
        }

        const savingsAccount = await getSavingsAccount(client, currency_id);

        // Destination defaults to Primary (same default creditShareholderContribution
        // itself uses for an ordinary Record Contribution) — validated to share the
        // Savings account's own currency. This system never silently blends or
        // converts currencies across a real money movement (same convention as
        // Transfers/Record Contribution), so a mismatch fails fast here rather than
        // quietly recording a contribution worth a different amount than what left
        // savings.
        const destAccountResult = destination_account_id
            ? await client.query(`
                SELECT id, currency_id, account_type
                FROM   accounts
                WHERE  id = $1 AND is_active = TRUE AND account_type != 'SAVINGS'
            `, [destination_account_id])
            : await client.query(`
                SELECT id, currency_id, account_type
                FROM   accounts
                WHERE  account_type = 'PRIMARY' AND is_active = TRUE
            `);
        if (destAccountResult.rows.length === 0) {
            throw createError.badRequest(
                destination_account_id
                    ? 'The selected destination account was not found, is inactive, or is a Savings account'
                    : 'Primary account has not been set up yet'
            );
        }
        const destAccount = destAccountResult.rows[0];

        if (destAccount.currency_id !== savingsAccount.currency_id) {
            throw createError.badRequest(
                'The destination account must be in the same currency as the Savings account — ' +
                'this system does not automatically convert currencies when moving real money between accounts.'
            );
        }

        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.SAVINGS, 'SAVCAP', 'SAVINGS_CAPITAL_CONVERSION', req.user.id
        );

        const result = await client.query(`
            INSERT INTO savings_capital_conversions (
                reference_id, user_id, account_id, destination_account_id, category_id,
                amount, currency_id, conversion_date, notes, entered_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
        `, [
            referenceId, user_id, savingsAccount.id, destAccount.id, category_id,
            principal, savingsAccount.currency_id, conversion_date, notes || null, req.user.id,
        ]);

        const conversionId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, conversionId);

        await logAction(req.user.id, ACTIONS.SAVINGS_CAPITAL_CONVERSION_ENTERED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_capital_conversions',
            recordId:    conversionId,
            newValues:   { referenceCode, user_id, amount: principal },
            description: `Savings-to-capital conversion entered (awaiting member confirmation): ${referenceCode} — ${member.first_name} ${member.last_name}: ${principal}`,
            client,
        });

        notify({
            userId:     user_id,
            type:       'SAVINGS_CAPITAL_CONVERSION_PENDING',
            title:      'Confirm redirecting your savings into capital',
            body:       `The Treasurer wants to move ${principal} from your savings into a capital contribution (${referenceCode}). Nothing has moved yet — please confirm or reject.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_capital_conversions',
            recordId:   conversionId,
            email: {
                subject: `Confirm: savings to be converted to capital — ${referenceCode}`,
                html: await wrapEmail(`
                    <p>Dear ${member.first_name},</p>
                    <p>The Treasurer has entered a request to move part of your savings into a capital contribution:</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${principal}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
                    </table>
                    <p>Nothing has moved yet — please log in and confirm you agree, or reject it if something's wrong.</p>
                `, { preheader: 'Confirm your savings-to-capital conversion' }),
            },
        });

        sendCreated(res, {
            conversion_id: conversionId,
            reference:     referenceCode,
            status:        'PENDING_CONFIRMATION',
        }, `Savings-to-capital conversion recorded. Reference: ${referenceCode}. Awaiting the member's confirmation.`);
    });
});

// ============================================================
// CONFIRM SAVINGS-TO-CAPITAL CONVERSION — only the member whose savings this is
// PATCH /api/savings/capital-conversions/:id/confirm
// This is what actually moves the money: debits the SAVINGS account
// (identical mechanics to confirmSavingsHandout), then runs the
// ordinary creditShareholderContribution() flow into the destination
// account — same shareholding recalculation and capital-goal
// auto-attribution as any other contribution.
// ============================================================
const confirmSavingsCapitalConversion = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT scc.*, r.reference_code, u.first_name, u.last_name
            FROM   savings_capital_conversions scc
            JOIN   references_registry r ON r.id = scc.reference_id
            JOIN   users u ON u.id = scc.user_id
            WHERE  scc.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings-to-capital conversion not found');
        }
        const conversion = existing.rows[0];

        if (conversion.user_id !== req.user.id) {
            throw createError.forbidden('Only the member whose savings this is can confirm this conversion');
        }
        if (conversion.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This conversion cannot be confirmed. Status: ${conversion.status}`);
        }

        // Re-check the balance at confirm time too — it may have moved
        // (e.g. a handout, or another conversion) since the Treasurer
        // entered this.
        const balance = await getOrCreateSavingsBalance(client, conversion.user_id, conversion.currency_id);
        if (parseFloat(conversion.amount) > parseFloat(balance.principal_balance)) {
            throw createError.badRequest(
                `Your savings balance has since dropped below this amount. Available: ${balance.principal_balance}.`
            );
        }

        // Leg 1 — debit the SAVINGS account, identical mechanics to
        // confirmSavingsHandout's own DEBIT.
        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAVCAP-OUT', 'TRANSACTION', req.user.id);

        const { transactionId: savingsTxId } =
            await postTransaction(client, {
                accountId:       conversion.account_id,
                transactionType: 'DEBIT',
                inflowType:      'SAVINGS_TO_CAPITAL_OUT',
                amount:          conversion.amount,
                currencyId:      conversion.currency_id,
                categoryId:      conversion.category_id,
                description:     `Savings redirected to capital contribution — ${conversion.first_name} ${conversion.last_name} (${conversion.reference_code})`,
                valueDate:       new Date().toISOString().split('T')[0],
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });
        await linkReferenceToRecord(client, txRefId, savingsTxId);

        await client.query(`
            UPDATE savings_balances
            SET    principal_balance = principal_balance - $1,
                   updated_at = NOW()
            WHERE  user_id = $2 AND currency_id = $3
        `, [conversion.amount, conversion.user_id, conversion.currency_id]);

        // Leg 2 — the ordinary contribution flow: posts the CREDIT into
        // the destination account, records shareholder_contributions,
        // recalculates every shareholder's shares_held/percentage, and
        // auto-attributes to the member's primary capital goal — all
        // via the exact same shared core every other contribution path
        // (Record Contribution, a CONTRIBUTION_ACKNOWLEDGEMENT
        // requisition) already uses, so this stays perfectly consistent
        // with them.
        const { transactionId: contribTxId, contributionId } =
            await creditShareholderContribution(client, {
                contributorId:     conversion.user_id,
                amount:            conversion.amount,
                contributionDate:  conversion.conversion_date,
                categoryId:        conversion.category_id,
                notes:             `Redirected from savings (${conversion.reference_code})${conversion.notes ? ` — ${conversion.notes}` : ''}`,
                recordedByUserId:  req.user.id,
                accountId:         conversion.destination_account_id,
            });

        await client.query(`
            UPDATE savings_capital_conversions
            SET    status = 'CONFIRMED',
                   savings_transaction_id = $1,
                   contribution_id = $2,
                   contribution_transaction_id = $3,
                   confirmed_at = NOW()
            WHERE  id = $4
        `, [savingsTxId, contributionId, contribTxId, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_CAPITAL_CONVERSION_CONFIRMED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_capital_conversions',
            recordId:    parseInt(id),
            newValues:   { txRefCode, amount: conversion.amount },
            description: `Savings-to-capital conversion confirmed: ${conversion.reference_code} — ${conversion.amount}`,
            client,
        });

        notify({
            userId:     conversion.entered_by,
            type:       'SAVINGS_CAPITAL_CONVERSION_CONFIRMED',
            title:      'Savings-to-capital conversion confirmed',
            body:       `${conversion.first_name} ${conversion.last_name} confirmed the savings-to-capital conversion ${conversion.reference_code}.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_capital_conversions',
            recordId:   parseInt(id),
        });

        sendSuccess(res, {
            status: 'CONFIRMED',
            savings_transaction_reference: txRefCode,
        }, 'Conversion confirmed — your savings have been added to your capital contributions');
    });
});

// ============================================================
// REJECT SAVINGS-TO-CAPITAL CONVERSION — only the member whose savings this is
// PATCH /api/savings/capital-conversions/:id/reject
// ============================================================
const rejectSavingsCapitalConversion = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT scc.*, r.reference_code, u.first_name, u.last_name
            FROM   savings_capital_conversions scc
            JOIN   references_registry r ON r.id = scc.reference_id
            JOIN   users u ON u.id = scc.user_id
            WHERE  scc.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings-to-capital conversion not found');
        }
        const conversion = existing.rows[0];

        if (conversion.user_id !== req.user.id) {
            throw createError.forbidden('Only the member whose savings this is can reject this conversion');
        }
        if (conversion.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This conversion cannot be rejected. Status: ${conversion.status}`);
        }

        await client.query(`
            UPDATE savings_capital_conversions
            SET    status = 'REJECTED', rejected_reason = $1, rejected_at = NOW()
            WHERE  id = $2
        `, [reason || null, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_CAPITAL_CONVERSION_REJECTED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_capital_conversions',
            recordId:    parseInt(id),
            description: `Savings-to-capital conversion rejected by member: ${conversion.reference_code}`,
            client,
        });

        notify({
            userId:     conversion.entered_by,
            type:       'SAVINGS_CAPITAL_CONVERSION_REJECTED',
            title:      'Savings-to-capital conversion rejected',
            body:       `${conversion.first_name} ${conversion.last_name} rejected the conversion ${conversion.reference_code}.${reason ? ` Reason: ${reason}` : ''}`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_capital_conversions',
            recordId:   parseInt(id),
        });

        sendSuccess(res, { status: 'REJECTED' }, 'Conversion rejected');
    });
});

// ============================================================
// GET MY SAVINGS-TO-CAPITAL CONVERSIONS
// GET /api/savings/capital-conversions/me
// ============================================================
const getMySavingsCapitalConversions = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT scc.*, r.reference_code, c.code AS currency_code,
               en.first_name || ' ' || en.last_name AS entered_by_name
        FROM   savings_capital_conversions scc
        JOIN   references_registry r ON r.id = scc.reference_id
        JOIN   currencies c ON c.id = scc.currency_id
        JOIN   users en ON en.id = scc.entered_by
        WHERE  scc.user_id = $1
        ORDER BY scc.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL SAVINGS-TO-CAPITAL CONVERSIONS — Treasurer/Admin
// GET /api/savings/capital-conversions
// ============================================================
const getAllSavingsCapitalConversions = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;
    if (status) { p++; conditions.push(`scc.status = $${p}`); params.push(status.toUpperCase()); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM savings_capital_conversions scc ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            scc.*, r.reference_code, c.code AS currency_code,
            u.first_name || ' ' || u.last_name AS member_name,
            en.first_name || ' ' || en.last_name AS entered_by_name
        FROM  savings_capital_conversions scc
        JOIN  references_registry r ON r.id = scc.reference_id
        JOIN  currencies c ON c.id = scc.currency_id
        JOIN  users u ON u.id = scc.user_id
        JOIN  users en ON en.id = scc.entered_by
        ${where}
        ORDER BY scc.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// CREATE SAVINGS CURRENCY CONVERSION (v1.61.0) — Treasurer / Assistant Treasurer
// POST /api/savings/currency-conversions
// Requested directly: "the savings account have allowance to hold
// multiple currencies... money can be transferred within the savings
// account at an exchange rate just like the normal transfer except
// that no charges apply here." Own standalone flow, structurally the
// closest sibling to Savings-to-Capital Conversion (v1.58.0) — same
// "Treasurer enters it, member confirms" shape, since this is still
// entirely the member's own money either way, just changing which of
// their own currency balances it sits in. Unlike a real Transfer,
// there are NO bank charges — nothing ever leaves the club's own
// accounts, both legs are the club's own SAVINGS-type accounts.
// ============================================================
const createSavingsCurrencyConversion = asyncHandler(async (req, res) => {
    const {
        user_id, from_currency_id, to_currency_id, from_amount,
        exchange_rate, conversion_date, notes,
    } = req.body;

    await withTransaction(async (client) => {
        const memberResult = await client.query(
            'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
            [user_id]
        );
        if (memberResult.rows.length === 0) {
            throw createError.notFound('Member not found');
        }
        const member = memberResult.rows[0];

        if (parseInt(from_currency_id) === parseInt(to_currency_id)) {
            throw createError.badRequest('Choose two different currencies to convert between');
        }

        const fromAmount = parseFloat(from_amount);
        const rate = parseFloat(exchange_rate);
        if (!(rate > 0)) {
            throw createError.badRequest('Exchange rate must be a positive number');
        }
        const toAmount = parseFloat((fromAmount * rate).toFixed(4));

        const balance = await getOrCreateSavingsBalance(client, user_id, from_currency_id);
        if (fromAmount > parseFloat(balance.principal_balance)) {
            throw createError.badRequest(
                `Cannot convert more than the member has saved in that currency. Available: ${balance.principal_balance}.`
            );
        }

        const fromAccount = await getSavingsAccount(client, from_currency_id);
        const toAccount   = await getSavingsAccount(client, to_currency_id);

        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.SAVINGS, 'SAVFX', 'SAVINGS_CURRENCY_CONVERSION', req.user.id
        );

        const result = await client.query(`
            INSERT INTO savings_currency_conversions (
                reference_id, user_id, from_account_id, from_currency_id, from_amount,
                to_account_id, to_currency_id, to_amount, exchange_rate,
                exchange_rate_entered_by, conversion_date, notes, entered_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id
        `, [
            referenceId, user_id, fromAccount.id, from_currency_id, fromAmount,
            toAccount.id, to_currency_id, toAmount, rate,
            req.user.id, conversion_date, notes || null, req.user.id,
        ]);

        const conversionId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, conversionId);

        await logAction(req.user.id, ACTIONS.SAVINGS_CURRENCY_CONVERSION_ENTERED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_currency_conversions',
            recordId:    conversionId,
            newValues:   { referenceCode, user_id, fromAmount, toAmount, rate },
            description: `Savings currency conversion entered (awaiting member confirmation): ${referenceCode} — ${member.first_name} ${member.last_name}: ${fromAmount} → ${toAmount}`,
            client,
        });

        notify({
            userId:     user_id,
            type:       'SAVINGS_CURRENCY_CONVERSION_PENDING',
            title:      'Confirm converting your savings currency',
            body:       `The Treasurer wants to convert ${fromAmount} of your savings into ${toAmount} (${referenceCode}). Nothing has moved yet — please confirm or reject.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_currency_conversions',
            recordId:   conversionId,
            email: {
                subject: `Confirm: savings currency conversion — ${referenceCode}`,
                html: await wrapEmail(`
                    <p>Dear ${member.first_name},</p>
                    <p>The Treasurer has entered a request to convert part of your savings into a different currency:</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Converting</td><td style="padding:4px 0; text-align:right; font-weight:700;">${fromAmount}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">You'll receive</td><td style="padding:4px 0; text-align:right; font-weight:700;">${toAmount}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Rate</td><td style="padding:4px 0; text-align:right;">${rate}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
                    </table>
                    <p>Nothing has moved yet — please log in and confirm you agree, or reject it if something's wrong.</p>
                `, { preheader: 'Confirm your savings currency conversion' }),
            },
        });

        sendCreated(res, {
            conversion_id: conversionId,
            reference:     referenceCode,
            from_amount:   fromAmount,
            to_amount:     toAmount,
            status:        'PENDING_CONFIRMATION',
        }, `Currency conversion recorded. Reference: ${referenceCode}. Awaiting the member's confirmation.`);
    });
});

// ============================================================
// CONFIRM SAVINGS CURRENCY CONVERSION — only the member whose savings this is
// PATCH /api/savings/currency-conversions/:id/confirm
// Posts both legs atomically: a DEBIT on the source currency's
// SAVINGS account and a CREDIT on the destination currency's SAVINGS
// account, each moving that specific currency's savings_balances row
// by its own amount. No bank charges — see the header comment above.
// ============================================================
const confirmSavingsCurrencyConversion = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT scc.*, r.reference_code, u.first_name, u.last_name
            FROM   savings_currency_conversions scc
            JOIN   references_registry r ON r.id = scc.reference_id
            JOIN   users u ON u.id = scc.user_id
            WHERE  scc.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings currency conversion not found');
        }
        const conversion = existing.rows[0];

        if (conversion.user_id !== req.user.id) {
            throw createError.forbidden('Only the member whose savings this is can confirm this conversion');
        }
        if (conversion.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This conversion cannot be confirmed. Status: ${conversion.status}`);
        }

        // Re-check the source balance at confirm time too — it may
        // have moved since the Treasurer entered this.
        const fromBalance = await getOrCreateSavingsBalance(client, conversion.user_id, conversion.from_currency_id);
        if (parseFloat(conversion.from_amount) > parseFloat(fromBalance.principal_balance)) {
            throw createError.badRequest(
                `Your balance in that currency has since dropped below this amount. Available: ${fromBalance.principal_balance}.`
            );
        }
        // Make sure the destination row exists (currency this member
        // may never have held before) before crediting it below.
        await getOrCreateSavingsBalance(client, conversion.user_id, conversion.to_currency_id);

        // Both legs post under the same dedicated category — there's
        // nothing for anyone to categorize here, this is purely a
        // currency swap of money already inside Savings.
        const categoryId = await getOrCreateCategory(client, {
            ...SAVINGS_CURRENCY_CONVERSION_CATEGORY,
            createdBy: req.user.id,
        });

        // Leg 1 — debit the source currency's SAVINGS account.
        const { referenceId: outRefId, referenceCode: outRefCode } =
            await generateReference(client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAVFX-OUT', 'TRANSACTION', req.user.id);

        const { transactionId: fromTxId } =
            await postTransaction(client, {
                accountId:       conversion.from_account_id,
                transactionType: 'DEBIT',
                inflowType:      'SAVINGS_CURRENCY_CONV_OUT',
                amount:          conversion.from_amount,
                currencyId:      conversion.from_currency_id,
                categoryId,
                description:     `Savings currency conversion (out) — ${conversion.first_name} ${conversion.last_name} (${conversion.reference_code})`,
                valueDate:       new Date().toISOString().split('T')[0],
                createdBy:       req.user.id,
                referenceId:     outRefId,
            });
        await linkReferenceToRecord(client, outRefId, fromTxId);

        await client.query(`
            UPDATE savings_balances
            SET    principal_balance = principal_balance - $1,
                   updated_at = NOW()
            WHERE  user_id = $2 AND currency_id = $3
        `, [conversion.from_amount, conversion.user_id, conversion.from_currency_id]);

        // Leg 2 — credit the destination currency's SAVINGS account.
        const { referenceId: inRefId, referenceCode: inRefCode } =
            await generateReference(client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAVFX-IN', 'TRANSACTION', req.user.id);

        const { transactionId: toTxId } =
            await postTransaction(client, {
                accountId:       conversion.to_account_id,
                transactionType: 'CREDIT',
                inflowType:      'SAVINGS_CURRENCY_CONV_IN',
                amount:          conversion.to_amount,
                currencyId:      conversion.to_currency_id,
                categoryId,
                description:     `Savings currency conversion (in) — ${conversion.first_name} ${conversion.last_name} (${conversion.reference_code})`,
                valueDate:       new Date().toISOString().split('T')[0],
                createdBy:       req.user.id,
                referenceId:     inRefId,
            });
        await linkReferenceToRecord(client, inRefId, toTxId);

        await client.query(`
            UPDATE savings_balances
            SET    principal_balance = principal_balance + $1,
                   updated_at = NOW()
            WHERE  user_id = $2 AND currency_id = $3
        `, [conversion.to_amount, conversion.user_id, conversion.to_currency_id]);

        await client.query(`
            UPDATE savings_currency_conversions
            SET    status = 'CONFIRMED',
                   from_transaction_id = $1,
                   to_transaction_id   = $2,
                   confirmed_at = NOW()
            WHERE  id = $3
        `, [fromTxId, toTxId, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_CURRENCY_CONVERSION_CONFIRMED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_currency_conversions',
            recordId:    parseInt(id),
            newValues:   { outRefCode, inRefCode, from_amount: conversion.from_amount, to_amount: conversion.to_amount },
            description: `Savings currency conversion confirmed: ${conversion.reference_code} — ${conversion.from_amount} → ${conversion.to_amount}`,
            client,
        });

        notify({
            userId:     conversion.entered_by,
            type:       'SAVINGS_CURRENCY_CONVERSION_CONFIRMED',
            title:      'Savings currency conversion confirmed',
            body:       `${conversion.first_name} ${conversion.last_name} confirmed the currency conversion ${conversion.reference_code}.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_currency_conversions',
            recordId:   parseInt(id),
        });

        sendSuccess(res, {
            status: 'CONFIRMED',
            from_transaction_reference: outRefCode,
            to_transaction_reference:   inRefCode,
        }, 'Confirmed — your savings have been converted');
    });
});

// ============================================================
// REJECT SAVINGS CURRENCY CONVERSION — only the member whose savings this is
// PATCH /api/savings/currency-conversions/:id/reject
// ============================================================
const rejectSavingsCurrencyConversion = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT scc.*, r.reference_code, u.first_name, u.last_name
            FROM   savings_currency_conversions scc
            JOIN   references_registry r ON r.id = scc.reference_id
            JOIN   users u ON u.id = scc.user_id
            WHERE  scc.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings currency conversion not found');
        }
        const conversion = existing.rows[0];

        if (conversion.user_id !== req.user.id) {
            throw createError.forbidden('Only the member whose savings this is can reject this conversion');
        }
        if (conversion.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This conversion cannot be rejected. Status: ${conversion.status}`);
        }

        await client.query(`
            UPDATE savings_currency_conversions
            SET    status = 'REJECTED', rejected_reason = $1, rejected_at = NOW()
            WHERE  id = $2
        `, [reason || null, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_CURRENCY_CONVERSION_REJECTED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_currency_conversions',
            recordId:    parseInt(id),
            description: `Savings currency conversion rejected by member: ${conversion.reference_code}`,
            client,
        });

        notify({
            userId:     conversion.entered_by,
            type:       'SAVINGS_CURRENCY_CONVERSION_REJECTED',
            title:      'Savings currency conversion rejected',
            body:       `${conversion.first_name} ${conversion.last_name} rejected the currency conversion ${conversion.reference_code}.${reason ? ` Reason: ${reason}` : ''}`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_currency_conversions',
            recordId:   parseInt(id),
        });

        sendSuccess(res, { status: 'REJECTED' }, 'Conversion rejected');
    });
});

// ============================================================
// GET MY SAVINGS CURRENCY CONVERSIONS
// GET /api/savings/currency-conversions/me
// ============================================================
const getMySavingsCurrencyConversions = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT scc.*, r.reference_code,
               fc.code AS from_currency_code, tc.code AS to_currency_code,
               en.first_name || ' ' || en.last_name AS entered_by_name
        FROM   savings_currency_conversions scc
        JOIN   references_registry r ON r.id = scc.reference_id
        JOIN   currencies fc ON fc.id = scc.from_currency_id
        JOIN   currencies tc ON tc.id = scc.to_currency_id
        JOIN   users en ON en.id = scc.entered_by
        WHERE  scc.user_id = $1
        ORDER BY scc.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL SAVINGS CURRENCY CONVERSIONS — Treasurer/Admin
// GET /api/savings/currency-conversions
// ============================================================
const getAllSavingsCurrencyConversions = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;
    if (status) { p++; conditions.push(`scc.status = $${p}`); params.push(status.toUpperCase()); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM savings_currency_conversions scc ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            scc.*, r.reference_code,
            fc.code AS from_currency_code, tc.code AS to_currency_code,
            u.first_name || ' ' || u.last_name AS member_name,
            en.first_name || ' ' || en.last_name AS entered_by_name
        FROM  savings_currency_conversions scc
        JOIN  references_registry r ON r.id = scc.reference_id
        JOIN  currencies fc ON fc.id = scc.from_currency_id
        JOIN  currencies tc ON tc.id = scc.to_currency_id
        JOIN  users u ON u.id = scc.user_id
        JOIN  users en ON en.id = scc.entered_by
        ${where}
        ORDER BY scc.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// WITHDRAW SAVINGS (FIXED_TERM legacy, at maturity)
// POST /api/savings/:id/withdraw
// ============================================================
const withdrawSavings = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const savingsResult = await client.query(`
            SELECT ms.*, r.reference_code,
                   u.first_name, u.last_name
            FROM   member_savings ms
            JOIN   references_registry r ON r.id = ms.reference_id
            JOIN   users u ON u.id = ms.user_id
            WHERE  ms.id = $1 FOR UPDATE
        `, [id]);

        if (savingsResult.rows.length === 0) {
            throw createError.notFound('Savings record not found');
        }

        const savings = savingsResult.rows[0];

        if (savings.entry_type !== 'FIXED_TERM') {
            throw createError.badRequest(
                'Flexible savings are paid out through a Handout, not a Withdrawal — use "Record Handout" instead.'
            );
        }

        if (savings.status !== 'ACTIVE') {
            throw createError.badRequest(
                `Savings cannot be withdrawn. Status: ${savings.status}`
            );
        }

        const today        = new Date();
        const maturityDate = new Date(savings.maturity_date);

        if (today < maturityDate) {
            throw createError.badRequest(
                `Savings have not matured yet. Maturity date: ` +
                `${maturityDate.toLocaleDateString('en-GB')}. ` +
                `Early withdrawal requires special approval.`
            );
        }

        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(
                client, (MODULE_CODES.SAVINGS || 'SAV'),
                'SAV-OUT', 'TRANSACTION', req.user.id
            );

        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       savings.account_id,
                transactionType: 'DEBIT',
                inflowType:      'SAVINGS_HANDOUT_OUT',
                amount:          savings.amount_at_maturity,
                currencyId:      savings.currency_id,
                categoryId:      savings.category_id,
                description:     `Savings withdrawal — ${savings.first_name} ${savings.last_name} (${savings.reference_code})`,
                valueDate:       new Date().toISOString().split('T')[0],
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });

        await linkReferenceToRecord(client, txRefId, transactionId);

        await client.query(`
            UPDATE member_savings
            SET    status = 'WITHDRAWN',
                   withdrawal_transaction_id = $1,
                   withdrawn_at = NOW(),
                   withdrawn_by = $2
            WHERE  id = $3
        `, [transactionId, req.user.id, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_WITHDRAWN, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'member_savings',
            recordId:    parseInt(id),
            newValues:   { txRefCode, amount_at_maturity: savings.amount_at_maturity,
                balanceBefore, balanceAfter },
            description: `Savings withdrawn: ${savings.reference_code} — ${savings.amount_at_maturity}`,
            client,
        });

        sendSuccess(res, {
            status:             'WITHDRAWN',
            amount_withdrawn:   savings.amount_at_maturity,
            transaction_reference: txRefCode,
            balance_before:     balanceBefore,
            balance_after:      balanceAfter,
        }, 'Savings withdrawn successfully');
    });
});

// ============================================================
// CREATE FIXED-TERM SAVINGS (legacy path, kept for completeness)
// POST /api/savings/fixed-term
// ============================================================
const createFixedTermSavings = asyncHandler(async (req, res) => {
    const {
        category_id,
        principal_amount,
        interest_rate,
        interest_period,
        deposit_date,
        maturity_date,
        notes,
        currency_id,
    } = req.body;

    await withTransaction(async (client) => {
        const shareholding = await client.query(`
            SELECT id FROM shareholding_registry
            WHERE user_id = $1 AND effective_to IS NULL
        `, [req.user.id]);

        if (shareholding.rows.length === 0) {
            throw createError.forbidden('Only shareholders can open savings accounts');
        }

        // v1.61.0 — a company can now have more than one Savings
        // account, so a fixed-term deposit must say which currency's
        // account it's going into. Fixed-term deposits are out of
        // scope for the new multi-currency-holding/conversion feature
        // itself (a lump sum with its own fixed maturity doesn't fit
        // that model), but they still need an unambiguous account to
        // post against now that there's no longer a single default.
        const savingsAccount = await getSavingsAccount(client, currency_id);

        const rate   = parseFloat(interest_rate || 0) / 100;
        const start  = new Date(deposit_date);
        const end    = new Date(maturity_date);
        const days   = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
        const years  = days / 365;
        const amountAtMaturity = parseFloat(principal_amount) * (1 + rate * years);

        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.SAVINGS, 'SAV', 'SAVINGS', req.user.id
        );
        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(
                client, resolveModuleCode(savingsAccount), 'SAV-IN', 'TRANSACTION', req.user.id
            );

        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       savingsAccount.id,
                transactionType: 'CREDIT',
                inflowType:      'SAVINGS_DEPOSIT_IN',
                amount:          principal_amount,
                currencyId:      savingsAccount.currency_id,
                categoryId:      category_id,
                description:     `Member savings deposit — ${req.user.first_name} ${req.user.last_name} (${referenceCode})`,
                valueDate:       deposit_date,
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });

        await linkReferenceToRecord(client, txRefId, transactionId);

        const savingsResult = await client.query(`
            INSERT INTO member_savings (
                reference_id, user_id, account_id, currency_id,
                category_id, principal_amount, interest_rate,
                interest_period, deposit_date, maturity_date,
                amount_at_maturity, entry_type, source, recorded_by,
                status, notes, transaction_id, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                'FIXED_TERM', 'TREASURY_DIRECT', $12, 'ACTIVE', $13, $14, $12)
            RETURNING id
        `, [
            referenceId, req.user.id, savingsAccount.id,
            savingsAccount.currency_id, category_id,
            principal_amount, interest_rate || 0,
            interest_period || 'ANNUALLY', deposit_date,
            maturity_date, amountAtMaturity.toFixed(4),
            req.user.id, notes || null, transactionId,
        ]);

        const savingsId = savingsResult.rows[0].id;
        await linkReferenceToRecord(client, referenceId, savingsId);

        await logAction(req.user.id, ACTIONS.SAVINGS_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'member_savings',
            recordId:    savingsId,
            newValues:   { referenceCode, principal_amount, maturity_date },
            description: `Fixed-term savings deposit: ${referenceCode} — ${principal_amount}`,
            client,
        });

        sendCreated(res, {
            savings_id:        savingsId,
            reference:         referenceCode,
            principal_amount,
            interest_rate:     interest_rate || 0,
            deposit_date,
            maturity_date,
            amount_at_maturity: amountAtMaturity.toFixed(4),
            balance_before:    balanceBefore,
            balance_after:     balanceAfter,
        }, `Savings deposit recorded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// GET SAVINGS CURRENCIES — every currency that already has an active
// SAVINGS account set up (Accounts page). v1.61.0: every Savings
// action now needs to pick a currency, and getSavingsAccount()
// throws for any currency that doesn't have an account yet, so the
// frontend needs this list to only ever offer valid choices. Kept
// separate from the general accounts list (GET /api/accounts, which
// needs FINANCE_VIEW_ALL) so any member with a Savings-related
// permission — not just Treasurer/Director — can load the picker.
// GET /api/savings/currencies
// ============================================================
const getSavingsCurrencies = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT c.id, c.code, c.name, c.symbol
        FROM   currencies c
        JOIN   accounts a ON a.currency_id = c.id
        WHERE  a.account_type = 'SAVINGS' AND a.is_active = TRUE AND c.is_active = TRUE
        ORDER  BY c.code
    `);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET / UPDATE SAVINGS SETTINGS — company-wide interest rate
// ============================================================
const getSavingsSettings = asyncHandler(async (req, res) => {
    const result = await query('SELECT * FROM savings_settings WHERE id = 1');
    sendSuccess(res, result.rows[0] || { interest_rate: 0, interest_period: 'ANNUALLY', interest_calculation: 'SIMPLE' });
});

const updateSavingsSettings = asyncHandler(async (req, res) => {
    const { interest_rate, interest_period, interest_calculation } = req.body;

    const result = await query(`
        UPDATE savings_settings
        SET    interest_rate        = COALESCE($1, interest_rate),
               interest_period      = COALESCE($2, interest_period),
               interest_calculation = COALESCE($3, interest_calculation),
               updated_by           = $4,
               updated_at           = NOW()
        WHERE  id = 1
        RETURNING *
    `, [interest_rate, interest_period, interest_calculation, req.user.id]);

    await logAction(req.user.id, ACTIONS.SAVINGS_SETTINGS_UPDATED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'savings_settings',
        recordId:    1,
        newValues:   result.rows[0],
        description: `Savings interest settings updated: ${result.rows[0].interest_rate}% ${result.rows[0].interest_period}`,
    });

    sendSuccess(res, result.rows[0], 'Savings settings updated');
});

// ============================================================
// GET MY SAVINGS BALANCE — for the individual member's own summary
// GET /api/savings/balance/me
// v1.61.0 — a member can now hold savings in more than one currency
// at once, so this returns a `balances` ARRAY (one row per currency
// they've ever touched, possibly empty) instead of a single object.
// The pending-* counts stay whole-member totals (not split by
// currency) — they're just "how many things need your attention"
// badges, not money figures.
// ============================================================
const getMySavingsBalance = asyncHandler(async (req, res) => {
    const balancesResult = await query(`
        SELECT sb.*, c.code AS currency_code, c.symbol AS currency_symbol
        FROM   savings_balances sb
        JOIN   currencies c ON c.id = sb.currency_id
        WHERE  sb.user_id = $1
        ORDER  BY c.code
    `, [req.user.id]);

    const pendingDeposits = await query(`
        SELECT COUNT(*) AS n FROM member_savings
        WHERE user_id = $1 AND entry_type = 'FLEXIBLE' AND status = 'PENDING_APPROVAL'
    `, [req.user.id]);

    const pendingHandouts = await query(`
        SELECT COUNT(*) AS n FROM savings_handouts
        WHERE user_id = $1 AND status = 'PENDING_CONFIRMATION'
    `, [req.user.id]);

    // v1.58.0
    const pendingCapitalConversions = await query(`
        SELECT COUNT(*) AS n FROM savings_capital_conversions
        WHERE user_id = $1 AND status = 'PENDING_CONFIRMATION'
    `, [req.user.id]);

    // v1.61.0
    const pendingCurrencyConversions = await query(`
        SELECT COUNT(*) AS n FROM savings_currency_conversions
        WHERE user_id = $1 AND status = 'PENDING_CONFIRMATION'
    `, [req.user.id]);

    sendSuccess(res, {
        balances: balancesResult.rows,
        pending_deposits: parseInt(pendingDeposits.rows[0].n),
        pending_handouts: parseInt(pendingHandouts.rows[0].n),
        pending_capital_conversions: parseInt(pendingCapitalConversions.rows[0].n),
        pending_currency_conversions: parseInt(pendingCurrencyConversions.rows[0].n),
    });
});

// ============================================================
// GET A MEMBER'S SAVINGS BALANCE (Treasurer/Admin)
// GET /api/savings/balance/:userId
// Used to show the treasurer a member's available balance before
// entering a handout for them. v1.61.0 — same shape change as
// getMySavingsBalance above: an array, one row per currency.
// ============================================================
const getSavingsBalanceByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const balancesResult = await query(`
        SELECT sb.*, c.code AS currency_code, c.symbol AS currency_symbol
        FROM   savings_balances sb
        JOIN   currencies c ON c.id = sb.currency_id
        WHERE  sb.user_id = $1
        ORDER  BY c.code
    `, [userId]);
    sendSuccess(res, { balances: balancesResult.rows });
});

// ============================================================
// GET MY SAVINGS (list, both entry types)
// GET /api/savings/me
// ============================================================
const getMySavings = asyncHandler(async (req, res) => {
    // v1.32.0 — tx_* columns carry the linked deposit transaction's own
    // details (reference, account, balances) so the frontend can
    // preview/print each deposit as a proper transaction statement
    // without a separate GET /transactions/:id round-trip (which this
    // member may not have FINANCE_VIEW_ALL to call). NULL until the
    // deposit is actually approved (no transaction_id yet).
    const result = await query(`
        SELECT
            ms.id, ms.entry_type, ms.status, ms.principal_amount,
            ms.interest_rate, ms.interest_period, ms.deposit_date,
            ms.maturity_date, ms.amount_at_maturity, ms.notes,
            ms.review_notes, ms.created_at, ms.withdrawn_at,
            r.reference_code,
            c.code   AS currency_code,
            c.symbol AS currency_symbol,
            cat.name AS category_name,
            CASE
                WHEN ms.maturity_date IS NOT NULL AND ms.maturity_date <= CURRENT_DATE AND ms.status = 'ACTIVE'
                THEN TRUE ELSE FALSE
            END AS is_matured,
            CASE
                WHEN ms.maturity_date IS NOT NULL
                THEN GREATEST(0, ms.maturity_date - CURRENT_DATE)
                ELSE NULL
            END AS days_to_maturity,
            txr.reference_code AS tx_reference_code,
            tx.description      AS tx_description,
            tx.value_date       AS tx_value_date,
            tx.transaction_type AS tx_transaction_type,
            tx.amount           AS tx_amount,
            txc.code            AS tx_currency_code,
            txa.name            AS tx_account_name,
            txcat.name          AS tx_category_name,
            tx.balance_before   AS tx_balance_before,
            tx.balance_after    AS tx_balance_after
        FROM  member_savings ms
        JOIN  references_registry r ON r.id  = ms.reference_id
        JOIN  currencies c          ON c.id  = ms.currency_id
        JOIN  categories cat        ON cat.id = ms.category_id
        LEFT JOIN transactions tx         ON tx.id = ms.transaction_id
        LEFT JOIN references_registry txr ON txr.id = tx.reference_id
        LEFT JOIN accounts txa             ON txa.id = tx.account_id
        LEFT JOIN currencies txc           ON txc.id = tx.currency_id
        LEFT JOIN categories txcat         ON txcat.id = tx.category_id
        WHERE ms.user_id = $1
        ORDER BY ms.created_at DESC
    `, [req.user.id]);

    sendSuccess(res, result.rows);
});

// ============================================================
// GET MY SAVINGS HANDOUTS
// GET /api/savings/handouts/me
// ============================================================
const getMySavingsHandouts = asyncHandler(async (req, res) => {
    // v1.32.0 — tx_* columns, same purpose/reasoning as getMySavings
    // above: preview/print each handout as a transaction statement
    // without needing FINANCE_VIEW_ALL.
    const result = await query(`
        SELECT sh.*, r.reference_code, c.code AS currency_code,
               txr.reference_code AS tx_reference_code,
               tx.description      AS tx_description,
               tx.value_date       AS tx_value_date,
               tx.transaction_type AS tx_transaction_type,
               tx.amount           AS tx_amount,
               txc.code            AS tx_currency_code,
               txa.name            AS tx_account_name,
               txcat.name          AS tx_category_name,
               tx.balance_before   AS tx_balance_before,
               tx.balance_after    AS tx_balance_after
        FROM   savings_handouts sh
        JOIN   references_registry r ON r.id = sh.reference_id
        JOIN   currencies c ON c.id = sh.currency_id
        LEFT JOIN transactions tx         ON tx.id = sh.transaction_id
        LEFT JOIN references_registry txr ON txr.id = tx.reference_id
        LEFT JOIN accounts txa             ON txa.id = tx.account_id
        LEFT JOIN currencies txc           ON txc.id = tx.currency_id
        LEFT JOIN categories txcat         ON txcat.id = tx.category_id
        WHERE  sh.user_id = $1
        ORDER BY sh.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL SAVINGS (Treasurer/Admin)
// GET /api/savings
// ============================================================
const getAllSavings = asyncHandler(async (req, res) => {
    const { status, user_id, entry_type } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) { p++; conditions.push(`ms.status = $${p}`); params.push(status.toUpperCase()); }
    if (user_id) { p++; conditions.push(`ms.user_id = $${p}`); params.push(user_id); }
    if (entry_type) { p++; conditions.push(`ms.entry_type = $${p}`); params.push(entry_type.toUpperCase()); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM member_savings ms ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            ms.id, ms.entry_type, ms.status, ms.source, ms.principal_amount,
            ms.interest_rate, ms.deposit_date, ms.maturity_date,
            ms.amount_at_maturity, ms.created_at,
            r.reference_code,
            c.code AS currency_code,
            u.first_name || ' ' || u.last_name AS member_name,
            u.email AS member_email,
            rec.first_name || ' ' || rec.last_name AS recorded_by_name,
            CASE
                WHEN ms.maturity_date IS NOT NULL AND ms.maturity_date <= CURRENT_DATE AND ms.status = 'ACTIVE'
                THEN TRUE ELSE FALSE
            END AS is_matured,
            CASE
                WHEN ms.maturity_date IS NOT NULL
                THEN GREATEST(0, ms.maturity_date - CURRENT_DATE)
                ELSE NULL
            END AS days_to_maturity
        FROM  member_savings ms
        JOIN  references_registry r ON r.id  = ms.reference_id
        JOIN  currencies c          ON c.id  = ms.currency_id
        JOIN  users u               ON u.id  = ms.user_id
        LEFT JOIN users rec         ON rec.id = ms.recorded_by
        ${where}
        ORDER BY ms.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET ALL SAVINGS HANDOUTS (Treasurer/Admin)
// GET /api/savings/handouts
// ============================================================
const getAllSavingsHandouts = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;
    if (status) { p++; conditions.push(`sh.status = $${p}`); params.push(status.toUpperCase()); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM savings_handouts sh ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            sh.*, r.reference_code, c.code AS currency_code,
            u.first_name || ' ' || u.last_name AS member_name,
            en.first_name || ' ' || en.last_name AS entered_by_name
        FROM  savings_handouts sh
        JOIN  references_registry r ON r.id = sh.reference_id
        JOIN  currencies c ON c.id = sh.currency_id
        JOIN  users u ON u.id = sh.user_id
        JOIN  users en ON en.id = sh.entered_by
        ${where}
        ORDER BY sh.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// CREATE SAVINGS POOL "OTHER" INFLOW — Treasurer / Assistant Treasurer
// POST /api/savings/pool-inflows
// A non-member credit into the savings pool — e.g. the fund was
// invested and the investment paid a profit back into the pool. This
// is deliberately NOT a member deposit (no user_id, doesn't touch any
// savings_balances row) and there is no equivalent expense — the
// SAVINGS account never takes a DEBIT. Sits PENDING_APPROVAL until a
// second Treasurer/Assistant Treasurer approves it, same pipeline as
// a member deposit (reuses SAVINGS_CREATE / SAVINGS_APPROVE).
// ============================================================
const createSavingsPoolInflow = asyncHandler(async (req, res) => {
    const { category_id, amount, value_date, description, currency_id } = req.body;

    await withTransaction(async (client) => {
        const savingsAccount = await getSavingsAccount(client, currency_id);

        const { referenceId, referenceCode } = await generateReference(
            client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAVPOOL', 'SAVINGS_POOL_INFLOW', req.user.id
        );

        const result = await client.query(`
            INSERT INTO savings_pool_inflows (
                reference_id, account_id, currency_id, category_id,
                amount, value_date, description, status, recorded_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_APPROVAL', $8)
            RETURNING id
        `, [
            referenceId, savingsAccount.id, savingsAccount.currency_id, category_id,
            amount, value_date, description, req.user.id,
        ]);

        const inflowId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, inflowId);

        await logAction(req.user.id, ACTIONS.SAVINGS_POOL_INFLOW_RECORDED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_pool_inflows',
            recordId:    inflowId,
            newValues:   { referenceCode, amount, description },
            description: `Savings pool inflow recorded (pending Treasurer/Assistant Treasurer approval): ${referenceCode} — ${amount}`,
            client,
        });

        // Notify Treasurer / Assistant Treasurer
        const approvers = await client.query(`
            SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
            FROM   users u
            JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            JOIN   roles r       ON r.id = ur.role_id
            WHERE  r.name IN ('Treasurer', 'Assistant Treasurer')
            AND    u.is_active = TRUE
        `);
        notifyMany(approvers.rows, 'SAVINGS_POOL_INFLOW_PENDING', () => ({
            title:      'Savings pool inflow awaiting your approval',
            body:       `A savings pool inflow of ${amount} (${referenceCode}) needs approval.`,
            link:       `/savings`,
            module:     'FINANCE',
            recordType: 'savings_pool_inflows',
            recordId:   inflowId,
        }));

        sendCreated(res, {
            inflow_id: inflowId,
            reference: referenceCode,
            status:    'PENDING_APPROVAL',
        }, `Savings pool inflow recorded. Reference: ${referenceCode}. Awaiting Treasurer/Assistant Treasurer approval.`);
    });
});

// ============================================================
// APPROVE SAVINGS POOL INFLOW — Treasurer / Assistant Treasurer
// PATCH /api/savings/pool-inflows/:id/approve
// ============================================================
const approveSavingsPoolInflow = asyncHandler(async (req, res) => {
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'savings_pool_inflows', req.params.id, ['recorded_by'], 'savings pool entry');
    const { id } = req.params;
    const { review_notes } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT spi.*, r.reference_code
            FROM   savings_pool_inflows spi
            JOIN   references_registry r ON r.id = spi.reference_id
            WHERE  spi.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings pool inflow not found');
        }
        const inflow = existing.rows[0];

        if (inflow.status !== 'PENDING_APPROVAL') {
            throw createError.badRequest('Only a pending savings pool inflow can be approved');
        }

        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAVPOOL-IN', 'TRANSACTION', req.user.id);

        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       inflow.account_id,
                transactionType: 'CREDIT',
                inflowType:      'SAVINGS_POOL_OTHER_IN',
                amount:          inflow.amount,
                currencyId:      inflow.currency_id,
                categoryId:      inflow.category_id,
                description:     `Savings pool inflow — ${inflow.description} (${inflow.reference_code})`,
                valueDate:       inflow.value_date,
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });
        await linkReferenceToRecord(client, txRefId, transactionId);

        await client.query(`
            UPDATE savings_pool_inflows
            SET    status = 'ACTIVE',
                   transaction_id = $1,
                   approved_by = $2,
                   approved_at = NOW(),
                   review_notes = $3
            WHERE  id = $4
        `, [transactionId, req.user.id, review_notes || null, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_POOL_INFLOW_APPROVED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_pool_inflows',
            recordId:    parseInt(id),
            newValues:   { txRefCode, amount: inflow.amount, balanceBefore, balanceAfter },
            description: `Savings pool inflow approved: ${inflow.reference_code} — ${inflow.amount}`,
            client,
        });

        sendSuccess(res, {
            status: 'ACTIVE',
            transaction_reference: txRefCode,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, 'Savings pool inflow approved and recorded');
    });
});

// ============================================================
// REJECT SAVINGS POOL INFLOW — Treasurer / Assistant Treasurer
// PATCH /api/savings/pool-inflows/:id/reject
// ============================================================
const rejectSavingsPoolInflow = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { review_notes } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(`
            SELECT spi.*, r.reference_code
            FROM   savings_pool_inflows spi
            JOIN   references_registry r ON r.id = spi.reference_id
            WHERE  spi.id = $1 FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {
            throw createError.notFound('Savings pool inflow not found');
        }
        const inflow = existing.rows[0];

        if (inflow.status !== 'PENDING_APPROVAL') {
            throw createError.badRequest('Only a pending savings pool inflow can be rejected');
        }

        await client.query(`
            UPDATE savings_pool_inflows
            SET    status = 'REJECTED',
                   approved_by = $1,
                   approved_at = NOW(),
                   review_notes = $2
            WHERE  id = $3
        `, [req.user.id, review_notes || null, id]);

        await logAction(req.user.id, ACTIONS.SAVINGS_POOL_INFLOW_REJECTED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_pool_inflows',
            recordId:    parseInt(id),
            description: `Savings pool inflow rejected: ${inflow.reference_code}`,
            client,
        });

        sendSuccess(res, { status: 'REJECTED' }, 'Savings pool inflow rejected');
    });
});

// ============================================================
// GET SAVINGS POOL INFLOWS — Treasurer/Admin
// GET /api/savings/pool-inflows
// ============================================================
const getSavingsPoolInflows = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;
    if (status) { p++; conditions.push(`spi.status = $${p}`); params.push(status.toUpperCase()); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM savings_pool_inflows spi ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            spi.*, r.reference_code,
            c.code AS currency_code,
            cat.name AS category_name,
            rec.first_name || ' ' || rec.last_name AS recorded_by_name,
            appr.first_name || ' ' || appr.last_name AS approved_by_name
        FROM   savings_pool_inflows spi
        JOIN   references_registry r ON r.id = spi.reference_id
        JOIN   currencies c ON c.id = spi.currency_id
        JOIN   categories cat ON cat.id = spi.category_id
        JOIN   users rec ON rec.id = spi.recorded_by
        LEFT JOIN users appr ON appr.id = spi.approved_by
        ${where}
        ORDER BY spi.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

module.exports = {
    createPendingFlexibleDeposit,
    createSavingsDeposit,
    approveSavingsDeposit,
    rejectSavingsDeposit,
    createSavingsHandout,
    confirmSavingsHandout,
    rejectSavingsHandout,
    withdrawSavings,
    createFixedTermSavings,
    getSavingsCurrencies,
    getSavingsSettings,
    updateSavingsSettings,
    getMySavingsBalance,
    getSavingsBalanceByUser,
    getMySavings,
    getMySavingsHandouts,
    getAllSavings,
    getAllSavingsHandouts,
    getOrCreateSavingsBalance,
    getSavingsAccount,
    createSavingsPoolInflow,
    approveSavingsPoolInflow,
    rejectSavingsPoolInflow,
    getSavingsPoolInflows,
    // v1.58.0 — savings-to-capital conversion
    createSavingsCapitalConversion,
    confirmSavingsCapitalConversion,
    rejectSavingsCapitalConversion,
    getMySavingsCapitalConversions,
    getAllSavingsCapitalConversions,
    // v1.61.0 — savings currency conversion
    createSavingsCurrencyConversion,
    confirmSavingsCurrencyConversion,
    rejectSavingsCurrencyConversion,
    getMySavingsCurrencyConversions,
    getAllSavingsCurrencyConversions,
};
