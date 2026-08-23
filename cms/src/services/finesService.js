// ============================================================
// FINES SERVICE (v1.37.0)
// Shared core for clearing a fine — called from BOTH the direct
// Treasurer-clears-it action (finesController.clearFineDirect) AND the
// Requisitions FINE_PAYMENT approval branch (requisitionsController),
// mirroring the "same crediting logic, two entry points" pattern
// already established for creditSideFundContribution/
// creditShareholderContribution. Must be called from inside an
// existing withTransaction block.
// ============================================================

const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord, resolveModuleCode } = require('./referenceService');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { notify } = require('./notificationService');
const { getOrCreateCategory } = require('./categoryService');
const { postTransaction } = require('../controllers/transactionsController');

const FINES_CATEGORY = {
    module:      'FINANCE',
    name:        'Fines & Penalties',
    abbreviation: 'FINE',
    description: 'Income from fines and penalties assigned to shareholders',
};

// ============================================================
// CLEAR A FINE — posts the real income transaction and flips the
// fine to PAID. `accountId` must be an active account in the SAME
// currency the fine was posted in ("can be paid in any account but
// following the currency of posting", per the brief) — any other
// currency is rejected outright rather than silently converting,
// same reasoning as every other place in this system that refuses to
// guess at money (see sharePricingService's FX-coverage guard).
// ============================================================
const clearFine = async (client, {
    fineId, accountId, paidDate, paymentDescription, recordedByUserId,
}) => {
    const fineResult = await client.query('SELECT * FROM fines WHERE id = $1 FOR UPDATE', [fineId]);
    if (fineResult.rows.length === 0) {
        throw createError.notFound('Fine not found');
    }
    const fine = fineResult.rows[0];
    if (fine.status === 'PAID') {
        throw createError.badRequest('This fine has already been cleared');
    }

    const memberResult = await client.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1', [fine.user_id]
    );
    if (memberResult.rows.length === 0) {
        throw createError.notFound('Fined member not found');
    }
    const member = memberResult.rows[0];

    const accountResult = await client.query(
        'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1 AND is_active = TRUE',
        [accountId]
    );
    if (accountResult.rows.length === 0) {
        throw createError.badRequest('The selected account was not found or is inactive');
    }
    const account = accountResult.rows[0];

    if (account.currency_id !== fine.currency_id) {
        throw createError.badRequest(
            'This fine must be paid into an account in the same currency it was posted in.'
        );
    }

    const categoryId = await getOrCreateCategory(client, {
        ...FINES_CATEGORY,
        createdBy: recordedByUserId,
    });

    const { referenceId, referenceCode } = await generateReference(
        client, resolveModuleCode(account), 'FINE-IN', 'TRANSACTION', recordedByUserId
    );

    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       account.id,
        transactionType: 'CREDIT',
        inflowType:      'FINE_PAYMENT_IN',
        amount:          fine.amount,
        currencyId:      account.currency_id,
        categoryId,
        description:     `Fine payment — ${member.first_name} ${member.last_name}` +
            (paymentDescription ? ` — ${paymentDescription}` : ''),
        valueDate:       paidDate,
        createdBy:       recordedByUserId,
        referenceId,
    });
    await linkReferenceToRecord(client, referenceId, transactionId);

    await client.query(`
        UPDATE fines
        SET    status               = 'PAID',
               account_id           = $1,
               transaction_id       = $2,
               paid_date            = $3,
               payment_description  = $4,
               cleared_by           = $5,
               cleared_at           = NOW()
        WHERE  id = $6
    `, [account.id, transactionId, paidDate, paymentDescription || null, recordedByUserId, fineId]);

    await logAction(recordedByUserId, ACTIONS.FINE_CLEARED, MODULES.FINANCE, {
        recordType:  'fines',
        recordId:    fineId,
        newValues:   { referenceCode, amount: fine.amount, balanceBefore, balanceAfter },
        description: `Fine cleared: ${referenceCode} — ${member.first_name} ${member.last_name}: ${fine.amount}`,
        client,
    });

    notify({
        userId:     fine.user_id,
        type:       'FINE_CLEARED',
        title:      'Fine payment recorded',
        body:       `Your fine of ${fine.amount} was recorded as paid (reference ${referenceCode}).`,
        link:       '/fines',
        module:     'FINANCE',
        recordType: 'fines',
        recordId:   fineId,
    });

    return { transactionId, balanceBefore, balanceAfter, referenceCode, member, fine };
};

module.exports = { clearFine, FINES_CATEGORY };
