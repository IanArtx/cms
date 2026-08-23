// ============================================================
// DEPOSIT SERVICE (v1.38.1)
// Non-crediting deposit logic: exit refund computation/processing.
// The crediting core itself (creditDepositContribution — used by
// BOTH the Transactions contribution slice AND the standalone entry
// point) lives in transactionsController.js, mirroring exactly where
// creditSideFundContribution/creditSavingsContribution live — see
// that file's own comment on why the "shared, called from two entry
// points" functions sit there rather than in a service file.
//
// v1.38.1 — like the Side Fund, deposits are now an optional feature
// (off by default) "parented" to one specific account chosen when
// activating it in Settings — never chosen per entry or per exit.
// UNLIKE the Side Fund, that parent account is not a separate
// envelope (no current_balance counter) — every deposit stays a
// completely normal transaction into that one account.
// ============================================================

const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord, resolveModuleCode } = require('./referenceService');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { notify } = require('./notificationService');
const { getOrCreateCategory } = require('./categoryService');
const { postTransaction } = require('../controllers/transactionsController');
const { getSavingsAccount, getOrCreateSavingsBalance } = require('./savingsService');
const { createPaymentAcknowledgement } = require('../controllers/paymentAcknowledgementsController');

const DEPOSITS_CATEGORY = {
    module:      'FINANCE',
    name:        'Member Deposits',
    abbreviation: 'DEP',
    description: 'Member deposit contributions and exit refunds',
};

// ============================================================
// COMPUTE EXIT REFUND — pure computation (no DB writes), usable both
// for a read-only preview endpoint and the real processing below, so
// the preview can never disagree with the actual result.
// MUTUAL_AGREEMENT is always exactly 5%; FORCED is entered by the
// admin at exit time and must be >= 50% (and <= 100%) — matches the
// deposit_exit_events CHECK constraint exactly, checked here too so
// the error surfaces with a clear message rather than a raw
// constraint-violation from Postgres.
// ============================================================
const computeExitRefund = (grossBalance, exitType, deductionPercentageInput) => {
    const gross = parseFloat(grossBalance);
    let deductionPercentage;

    if (exitType === 'MUTUAL_AGREEMENT') {
        deductionPercentage = 5;
    } else if (exitType === 'FORCED') {
        const p = deductionPercentageInput !== undefined && deductionPercentageInput !== null
            ? parseFloat(deductionPercentageInput) : NaN;
        if (isNaN(p) || p < 50 || p > 100) {
            throw createError.badRequest(
                'A forced exit deduction percentage must be entered and cannot be less than 50% (up to 100%)'
            );
        }
        deductionPercentage = p;
    } else {
        throw createError.badRequest('exit_type must be MUTUAL_AGREEMENT or FORCED');
    }

    const deductionAmount = parseFloat((gross * (deductionPercentage / 100)).toFixed(4));
    const netPayout = parseFloat((gross - deductionAmount).toFixed(4));
    return { deductionPercentage, deductionAmount, netPayout };
};

// ============================================================
// PROCESS EXIT REFUND — Treasurer/Admin (DEPOSIT_MANAGE)
// Locks the member's deposit balance, computes the refund
// (computeExitRefund above), and — if the net payout is positive —
// transfers it into the member's own Savings balance via the same
// two-leg posting shape as the Side Fund exit payout (DEBIT the
// configured deposit parent account, CREDIT Savings), followed by a
// Payment Acknowledgement (source_type DEPOSIT_REFUND) for two-party
// sign-off. v1.38.1 — like the Side Fund, the account to debit is no
// longer chosen by the Treasurer at exit time; it's always
// deposit_config.parent_account_id, the one account deposits are
// activated against. deposit_balances.balance is always zeroed on
// exit, even if the net payout worked out to zero. Must be called
// from inside an existing `withTransaction` block.
// ============================================================
const processExitRefund = async (client, {
    userId, exitType, deductionPercentage, exchangeRate, notes, processedByUserId,
}) => {
    const configResult = await client.query('SELECT * FROM deposit_config WHERE id = 1');
    const config = configResult.rows[0];
    if (!config || !config.is_active || !config.parent_account_id) {
        throw createError.badRequest(
            'Deposits are not active for this company yet — an Admin/Treasurer must activate it and choose a parent account in Settings > Deposits first.'
        );
    }

    const balanceResult = await client.query(
        'SELECT balance FROM deposit_balances WHERE user_id = $1 FOR UPDATE', [userId]
    );
    const grossBalance = parseFloat(balanceResult.rows[0]?.balance || 0);
    if (grossBalance <= 0) {
        throw createError.badRequest('This member has no deposit balance to refund');
    }

    const memberResult = await client.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1', [userId]
    );
    const member = memberResult.rows[0];
    if (!member) throw createError.notFound('Member not found');

    const { deductionPercentage: pct, deductionAmount, netPayout } =
        computeExitRefund(grossBalance, exitType, deductionPercentage);

    // The event row is created up front — its breakdown fields are
    // already fully known — so a Payment Acknowledgement created
    // below (if any) has a real event id to point its source_id at,
    // the same reasoning sideFundController.removeMember's own
    // up-front event insert already established.
    const eventResult = await client.query(`
        INSERT INTO deposit_exit_events (
            user_id, exit_type, deduction_percentage, gross_balance, deduction_amount,
            net_payout, processed_by, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
    `, [userId, exitType, pct, grossBalance, deductionAmount, netPayout, processedByUserId, notes || null]);
    const eventId = eventResult.rows[0].id;

    let transactionId = null;
    let paymentAckId = null;
    let savingsTotal = 0;
    let debitRefCode = null;

    if (netPayout > 0) {
        const sourceAccountResult = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1 AND is_active = TRUE',
            [config.parent_account_id]
        );
        if (sourceAccountResult.rows.length === 0) {
            throw createError.badRequest('The configured deposit parent account was not found or is inactive');
        }
        const sourceAccount = sourceAccountResult.rows[0];
        const savingsAccount = await getSavingsAccount(client);

        const sameCurrency = sourceAccount.currency_id === savingsAccount.currency_id;
        let effectiveRate = 1;
        if (!sameCurrency) {
            if (!exchangeRate) {
                throw createError.badRequest(
                    'The chosen source account and Savings account are in different currencies — an exchange rate is required.'
                );
            }
            effectiveRate = parseFloat(exchangeRate);
        }

        const today = new Date().toISOString().split('T')[0];
        const categoryId = await getOrCreateCategory(client, {
            ...DEPOSITS_CATEGORY,
            createdBy: processedByUserId,
        });

        // ---- Leg 1: debit the Treasurer-chosen source account ----
        const { referenceId: debitRefId, referenceCode: debitRefCodeGenerated } = await generateReference(
            client, resolveModuleCode(sourceAccount), 'DEP-OUT', 'TRANSACTION', processedByUserId
        );
        debitRefCode = debitRefCodeGenerated;
        const debitPosting = await postTransaction(client, {
            accountId:       sourceAccount.id,
            transactionType: 'DEBIT',
            inflowType:      'DEPOSIT_REFUND_OUT',
            amount:          netPayout,
            currencyId:      sourceAccount.currency_id,
            categoryId,
            description:     `Deposit exit refund (${exitType === 'MUTUAL_AGREEMENT' ? 'mutual agreement' : 'forced'}, ${pct}% deduction) — ${member.first_name} ${member.last_name}`,
            valueDate:       today,
            createdBy:       processedByUserId,
            referenceId:     debitRefId,
        });
        transactionId = debitPosting.transactionId;
        await linkReferenceToRecord(client, debitRefId, transactionId);

        // ---- Leg 2: credit the member's Savings balance ----
        savingsTotal = parseFloat((netPayout * effectiveRate).toFixed(4));
        const { referenceId: creditRefId, referenceCode: creditRefCode } = await generateReference(
            client, resolveModuleCode(savingsAccount), 'DEPSAV', 'TRANSACTION', processedByUserId
        );
        const creditPosting = await postTransaction(client, {
            accountId:       savingsAccount.id,
            transactionType: 'CREDIT',
            inflowType:      'SAVINGS_DEPOSIT_IN',
            amount:          savingsTotal,
            currencyId:      savingsAccount.currency_id,
            categoryId,
            description:     `Deposit exit refund credited to savings — ${member.first_name} ${member.last_name}`,
            valueDate:       today,
            createdBy:       processedByUserId,
            referenceId:     creditRefId,
        });
        await linkReferenceToRecord(client, creditRefId, creditPosting.transactionId);

        await getOrCreateSavingsBalance(client, userId, savingsAccount.currency_id);
        await client.query(`
            UPDATE savings_balances
            SET    principal_balance = principal_balance + $1,
                   currency_id = COALESCE(currency_id, $2),
                   updated_at = NOW()
            WHERE  user_id = $3
        `, [savingsTotal, savingsAccount.currency_id, userId]);

        const ack = await createPaymentAcknowledgement(client, {
            sourceType:    'DEPOSIT_REFUND',
            sourceId:      eventId,
            transactionId: creditPosting.transactionId,
            payerId:       processedByUserId,
            recipientId:   userId,
            amount:        savingsTotal,
            currencyId:    savingsAccount.currency_id,
            purpose:       `Deposit exit refund — ${debitRefCode}`,
        });
        paymentAckId = ack.id;

        await client.query(`
            UPDATE deposit_exit_events
            SET    source_account_id = $1, transaction_id = $2, payment_ack_id = $3
            WHERE  id = $4
        `, [config.parent_account_id, transactionId, paymentAckId, eventId]);
    }

    await client.query(`
        UPDATE deposit_balances SET balance = 0, updated_at = NOW() WHERE user_id = $1
    `, [userId]);

    await logAction(processedByUserId, ACTIONS.DEPOSIT_EXIT_REFUND_PROCESSED, MODULES.FINANCE, {
        recordType:  'deposit_exit_events',
        recordId:    eventId,
        newValues:   { exitType, pct, grossBalance, deductionAmount, netPayout, debitRefCode },
        description: `Deposit exit refund: ${member.first_name} ${member.last_name} — ` +
            `gross ${grossBalance}, ${pct}% deducted, net ${netPayout}` +
            (netPayout > 0 ? ` (${debitRefCode})` : ''),
        client,
    });

    notify({
        userId,
        type:       'DEPOSIT_EXIT_REFUND_PROCESSED',
        title:      'Deposit exit refund processed',
        body:       netPayout > 0
            ? `Your deposit was refunded. ${savingsTotal} was credited to your savings — please review and acknowledge it.`
            : `Your deposit exit was processed. No net refund was due after the deduction.`,
        link:       '/deposits',
        module:     'FINANCE',
        recordType: 'deposit_exit_events',
        recordId:   eventId,
    });

    return {
        eventId, grossBalance, deductionPercentage: pct, deductionAmount, netPayout,
        savingsCredited: savingsTotal, transactionId, paymentAckId, member,
    };
};

module.exports = { computeExitRefund, processExitRefund, DEPOSITS_CATEGORY };
