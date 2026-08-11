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
const { postTransaction } = require('./transactionsController');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');

MODULE_CODES.SAVINGS = 'SAV';
MODULE_CODES.SAVINGS_HANDOUT = 'SAVOUT';

// ============================================================
// INTERNAL HELPER — get (or lazily create) a member's savings_balances row
// ============================================================
const getOrCreateSavingsBalance = async (client, userId, currencyId) => {
    const existing = await client.query(
        'SELECT * FROM savings_balances WHERE user_id = $1 FOR UPDATE', [userId]
    );
    if (existing.rows.length > 0) return existing.rows[0];

    const created = await client.query(`
        INSERT INTO savings_balances (user_id, currency_id)
        VALUES ($1, $2)
        RETURNING *
    `, [userId, currencyId]);
    return created.rows[0];
};

// ============================================================
// GET THE SAVINGS ACCOUNT — all savings transactions are always
// held here (v1.14.0). Previously this held the Primary account, but
// savings now have their own dedicated account so they never mix
// with general company funds, can never be transferred out, and are
// permanently exempt from floor-limit enforcement.
// ============================================================
const getSavingsAccount = async (client) => {
    const account = await client.query(`
        SELECT id, currency_id, name, account_type, reference_prefix
        FROM   accounts
        WHERE  account_type = 'SAVINGS' AND is_active = TRUE
    `);
    if (account.rows.length === 0) {
        throw createError.badRequest(
            'The savings account has not been set up yet. Go to Accounts and set it up first.'
        );
    }
    return account.rows[0];
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
    userId, categoryId, amount, depositDate, notes,
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

    const savingsAccount = await getSavingsAccount(client);

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
    const { user_id, category_id, amount, deposit_date, notes } = req.body;

    await withTransaction(async (client) => {
        const { savingsId, referenceCode, member } = await createPendingFlexibleDeposit(client, {
            userId: user_id, categoryId: category_id, amount, depositDate: deposit_date,
            notes, recordedByUserId: req.user.id, source: 'TREASURY_DIRECT',
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

        const balance = await getOrCreateSavingsBalance(client, savings.user_id, savings.currency_id);
        await client.query(`
            UPDATE savings_balances
            SET    principal_balance = principal_balance + $1,
                   currency_id = COALESCE(currency_id, $2),
                   updated_at = NOW()
            WHERE  user_id = $3
        `, [savings.principal_amount, savings.currency_id, savings.user_id]);

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
// ============================================================
const createSavingsHandout = asyncHandler(async (req, res) => {
    const { user_id, account_id, category_id, principal_amount, interest_amount, handout_date, notes } = req.body;

    await withTransaction(async (client) => {
        const memberResult = await client.query(
            'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
            [user_id]
        );
        if (memberResult.rows.length === 0) {
            throw createError.notFound('Member not found');
        }
        const member = memberResult.rows[0];

        const balance = await getOrCreateSavingsBalance(client, user_id, null);

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

        const account = await client.query(
            'SELECT id, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE', [account_id]
        );
        if (account.rows.length === 0) {
            throw createError.notFound('Account not found');
        }

        const total = principal + interest;

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
            referenceId, user_id, account_id, category_id, principal, interest, total,
            account.rows[0].currency_id, handout_date, notes || null, req.user.id,
        ]);

        const handoutId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, handoutId);

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
            body:       `A savings handout of ${total} (${referenceCode}) has been entered for you. Please confirm you received it.`,
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
                        <tr><td style="padding:4px 0; color:#6b7280; font-weight:700;">Total</td><td style="padding:4px 0; text-align:right; font-weight:700;">${total}</td></tr>
                    </table>
                    <p>Please log in and confirm you received this, or reject it if something's wrong.</p>
                `, { preheader: 'Please confirm your savings handout' }),
            },
        });

        sendCreated(res, {
            handout_id: handoutId,
            reference:  referenceCode,
            status:     'PENDING_CONFIRMATION',
        }, `Handout recorded. Reference: ${referenceCode}. Awaiting the member's confirmation.`);
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

        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(client, (MODULE_CODES.SAVINGS || 'SAV'), 'SAV-OUT', 'TRANSACTION', req.user.id);

        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       handout.account_id,
                transactionType: 'DEBIT',
                inflowType:      'SAVINGS_HANDOUT_OUT',
                amount:          handout.total_amount,
                currencyId:      handout.currency_id,
                categoryId:      handout.category_id,
                description:     `Savings handout — ${handout.first_name} ${handout.last_name} (${handout.reference_code})`,
                valueDate:       new Date().toISOString().split('T')[0],
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });
        await linkReferenceToRecord(client, txRefId, transactionId);

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
            WHERE  user_id = $3
        `, [handout.principal_amount, handout.interest_amount, handout.user_id]);

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
    } = req.body;

    await withTransaction(async (client) => {
        const shareholding = await client.query(`
            SELECT id FROM shareholding_registry
            WHERE user_id = $1 AND effective_to IS NULL
        `, [req.user.id]);

        if (shareholding.rows.length === 0) {
            throw createError.forbidden('Only shareholders can open savings accounts');
        }

        const savingsAccount = await getSavingsAccount(client);

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
// ============================================================
const getMySavingsBalance = asyncHandler(async (req, res) => {
    const balanceResult = await query(
        'SELECT * FROM savings_balances WHERE user_id = $1', [req.user.id]
    );
    const balance = balanceResult.rows[0] || {
        principal_balance: 0, accrued_interest: 0, total_interest_paid: 0,
    };

    const pendingDeposits = await query(`
        SELECT COUNT(*) AS n FROM member_savings
        WHERE user_id = $1 AND entry_type = 'FLEXIBLE' AND status = 'PENDING_APPROVAL'
    `, [req.user.id]);

    const pendingHandouts = await query(`
        SELECT COUNT(*) AS n FROM savings_handouts
        WHERE user_id = $1 AND status = 'PENDING_CONFIRMATION'
    `, [req.user.id]);

    sendSuccess(res, {
        ...balance,
        pending_deposits: parseInt(pendingDeposits.rows[0].n),
        pending_handouts: parseInt(pendingHandouts.rows[0].n),
    });
});

// ============================================================
// GET A MEMBER'S SAVINGS BALANCE (Treasurer/Admin)
// GET /api/savings/balance/:userId
// Used to show the treasurer a member's available balance before
// entering a handout for them.
// ============================================================
const getSavingsBalanceByUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const balanceResult = await query(
        'SELECT * FROM savings_balances WHERE user_id = $1', [userId]
    );
    sendSuccess(res, balanceResult.rows[0] || {
        principal_balance: 0, accrued_interest: 0, total_interest_paid: 0,
    });
});

// ============================================================
// GET MY SAVINGS (list, both entry types)
// GET /api/savings/me
// ============================================================
const getMySavings = asyncHandler(async (req, res) => {
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
            END AS days_to_maturity
        FROM  member_savings ms
        JOIN  references_registry r ON r.id  = ms.reference_id
        JOIN  currencies c          ON c.id  = ms.currency_id
        JOIN  categories cat        ON cat.id = ms.category_id
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
    const result = await query(`
        SELECT sh.*, r.reference_code, c.code AS currency_code
        FROM   savings_handouts sh
        JOIN   references_registry r ON r.id = sh.reference_id
        JOIN   currencies c ON c.id = sh.currency_id
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
    const { category_id, amount, value_date, description } = req.body;

    await withTransaction(async (client) => {
        const savingsAccount = await getSavingsAccount(client);

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
};
