// ============================================================
// SAVINGS FINE SETTLEMENT SERVICE (v1.59.0)
// Pay one or more of a member's own OUTSTANDING fines straight out of
// their savings principal, instead of paying in cash. Requested
// directly: "fines can be settled with savings one has accumulated...
// from both the shareholder's side (through requests) and treasurer's
// side (by entry)."
//
// Two entry points, mirroring the Savings module's own established
// pattern (see savingsController.js's header comment):
//   1. Treasury-direct — a Treasurer/Assistant Treasurer selects a
//      member's outstanding fines on their behalf. Sits
//      PENDING_CONFIRMATION until the member themselves confirms —
//      same "nothing moves until the member agrees" shape as a
//      Savings Handout / v1.58.0's Savings-to-Capital Conversion.
//   2. Member-request — a member selects their own outstanding fines.
//      Sits PENDING_APPROVAL until a Treasurer/Assistant Treasurer
//      approves it — same shape as a self-service Savings Deposit
//      requisition.
//
// Whichever party did NOT initiate a settlement is always the one who
// reviews it, so settle()/decline() below are shared by BOTH
// directions — confirming a Treasury-direct entry and approving a
// member's request run the exact same posting logic; rejecting one
// and denying the other run the exact same decline logic. Only who's
// allowed to call which endpoint differs (enforced in the
// controller/routes), not what happens once called.
//
// Must be called from inside an existing withTransaction block.
// ============================================================

const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('./referenceService');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { notify } = require('./notificationService');
const { postTransaction } = require('../controllers/transactionsController');
const { getOrCreateSavingsBalance } = require('./savingsService');
const { getOrCreateCategory } = require('./categoryService');
const { clearFine, FINES_CATEGORY } = require('./finesService');

MODULE_CODES.SAVINGS_FINE_SETTLEMENT = 'SAV';

// ============================================================
// SETTLE — posts everything. Debits the SAVINGS account once for the
// combined total (own traceable inflow_type
// SAVINGS_FINE_SETTLEMENT_OUT), then clears each selected fine
// individually via the ordinary clearFine() core — same crediting
// logic, same per-fine transaction, as every other fine-clearing path
// (Clear Fine directly, a FINE_PAYMENT requisition acknowledgement).
// Re-checks both the fines' own status and the savings balance at
// settle time, not just entry/request time, in case either moved in
// the meantime.
// ============================================================
const settleFineSettlement = async (client, { settlementId, recordedByUserId }) => {
    const existing = await client.query(`
        SELECT sfs.*, r.reference_code, u.first_name, u.last_name
        FROM   savings_fine_settlements sfs
        JOIN   references_registry r ON r.id = sfs.reference_id
        JOIN   users u ON u.id = sfs.user_id
        WHERE  sfs.id = $1 FOR UPDATE
    `, [settlementId]);
    if (existing.rows.length === 0) {
        throw createError.notFound('Savings fine settlement not found');
    }
    const settlement = existing.rows[0];

    const items = await client.query(`
        SELECT sfsi.*, f.status AS fine_status
        FROM   savings_fine_settlement_items sfsi
        JOIN   fines f ON f.id = sfsi.fine_id
        WHERE  sfsi.settlement_id = $1
    `, [settlementId]);
    if (items.rows.length === 0) {
        throw createError.badRequest('This settlement has no fines attached');
    }
    for (const item of items.rows) {
        if (item.fine_status !== 'OUTSTANDING') {
            throw createError.badRequest(
                `One of the fines in this settlement (${settlement.reference_code}) is no longer outstanding — ` +
                `it may already have been cleared another way. This settlement can no longer be posted as-is.`
            );
        }
    }

    const balance = await getOrCreateSavingsBalance(client, settlement.user_id, settlement.currency_id);
    if (parseFloat(settlement.total_amount) > parseFloat(balance.principal_balance)) {
        throw createError.badRequest(
            `The savings balance has since dropped below this settlement's total. Available: ${balance.principal_balance}.`
        );
    }

    const categoryId = await getOrCreateCategory(client, {
        ...FINES_CATEGORY,
        createdBy: recordedByUserId,
    });

    // Leg 1 — one SAVINGS DEBIT covering the combined total.
    const { referenceId: txRefId, referenceCode: txRefCode } =
        await generateReference(client, (MODULE_CODES.SAVINGS_FINE_SETTLEMENT || 'SAV'), 'SAVFINE-OUT', 'TRANSACTION', recordedByUserId);

    const { transactionId: savingsTxId } = await postTransaction(client, {
        accountId:       settlement.account_id,
        transactionType: 'DEBIT',
        inflowType:      'SAVINGS_FINE_SETTLEMENT_OUT',
        amount:          settlement.total_amount,
        currencyId:      settlement.currency_id,
        categoryId,
        description:     `Savings used to settle ${items.rows.length} fine(s) — ${settlement.first_name} ${settlement.last_name} (${settlement.reference_code})`,
        valueDate:       settlement.settlement_date,
        createdBy:       recordedByUserId,
        referenceId:     txRefId,
    });
    await linkReferenceToRecord(client, txRefId, savingsTxId);

    await client.query(`
        UPDATE savings_balances
        SET    principal_balance = principal_balance - $1,
               updated_at = NOW()
        WHERE  user_id = $2 AND currency_id = $3
    `, [settlement.total_amount, settlement.user_id, settlement.currency_id]);

    // Leg 2 — clear each selected fine individually via the ordinary
    // core, same as any other fine-clearing path.
    for (const item of items.rows) {
        const { transactionId: fineTxId } = await clearFine(client, {
            fineId:              item.fine_id,
            accountId:           settlement.destination_account_id,
            paidDate:            settlement.settlement_date,
            paymentDescription:  `Settled from savings (${settlement.reference_code})`,
            recordedByUserId,
        });
        await client.query(`
            UPDATE savings_fine_settlement_items
            SET    fine_transaction_id = $1
            WHERE  id = $2
        `, [fineTxId, item.id]);
    }

    await client.query(`
        UPDATE savings_fine_settlements
        SET    status = 'SETTLED',
               savings_transaction_id = $1,
               reviewed_by = $2,
               reviewed_at = NOW()
        WHERE  id = $3
    `, [savingsTxId, recordedByUserId, settlementId]);

    await logAction(recordedByUserId, ACTIONS.SAVINGS_FINE_SETTLEMENT_SETTLED, MODULES.FINANCE, {
        recordType:  'savings_fine_settlements',
        recordId:    settlementId,
        newValues:   { txRefCode, total_amount: settlement.total_amount, fineCount: items.rows.length },
        description: `Savings fine settlement posted: ${settlement.reference_code} — ${settlement.first_name} ${settlement.last_name}: ${settlement.total_amount} across ${items.rows.length} fine(s)`,
        client,
    });

    // Whoever did NOT act just now is always the other party — the
    // Treasurer who entered a Treasury-direct settlement once the
    // member confirms it, or the member themselves once a Treasurer
    // approves their own request.
    notify({
        userId:     settlement.initiated_by,
        type:       'SAVINGS_FINE_SETTLEMENT_SETTLED',
        title:      'Savings fine settlement posted',
        body:       `${settlement.first_name} ${settlement.last_name}'s savings fine settlement ${settlement.reference_code} (${settlement.total_amount}) has been posted.`,
        link:       '/fines',
        module:     'FINANCE',
        recordType: 'savings_fine_settlements',
        recordId:   settlementId,
    });

    return { savingsTxId, txRefCode, settlement, itemCount: items.rows.length };
};

// ============================================================
// DECLINE — either the member rejecting a Treasury-direct entry, or a
// Treasurer denying a member's own request. Nothing has moved either
// way (both directions sit PENDING_* until this or settle() runs), so
// this only ever changes status/bookkeeping.
// ============================================================
const declineFineSettlement = async (client, { settlementId, recordedByUserId, reason }) => {
    const existing = await client.query(`
        SELECT sfs.*, r.reference_code, u.first_name, u.last_name
        FROM   savings_fine_settlements sfs
        JOIN   references_registry r ON r.id = sfs.reference_id
        JOIN   users u ON u.id = sfs.user_id
        WHERE  sfs.id = $1 FOR UPDATE
    `, [settlementId]);
    if (existing.rows.length === 0) {
        throw createError.notFound('Savings fine settlement not found');
    }
    const settlement = existing.rows[0];

    await client.query(`
        UPDATE savings_fine_settlements
        SET    status = 'REJECTED', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
        WHERE  id = $3
    `, [recordedByUserId, reason || null, settlementId]);

    await logAction(recordedByUserId, ACTIONS.SAVINGS_FINE_SETTLEMENT_REJECTED, MODULES.FINANCE, {
        recordType:  'savings_fine_settlements',
        recordId:    settlementId,
        description: `Savings fine settlement declined: ${settlement.reference_code} — ${settlement.first_name} ${settlement.last_name}`,
        client,
    });

    notify({
        userId:     settlement.initiated_by,
        type:       'SAVINGS_FINE_SETTLEMENT_REJECTED',
        title:      'Savings fine settlement declined',
        body:       `${settlement.first_name} ${settlement.last_name}'s savings fine settlement ${settlement.reference_code} was declined.${reason ? ` Reason: ${reason}` : ''}`,
        link:       '/fines',
        module:     'FINANCE',
        recordType: 'savings_fine_settlements',
        recordId:   settlementId,
    });

    return { settlement };
};

module.exports = { settleFineSettlement, declineFineSettlement };
