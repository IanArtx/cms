// ============================================================
// SIDE FUND SERVICE (v1.26.0)
// Shared "apply a payment to a member's side fund obligations" logic
// — always oldest-unpaid-period-first (PENDING, PARTIAL, and
// DEFAULTED all count), then any remainder banked as a running
// credit for future months (side_fund_member_credit /
// side_fund_credit_ledger).
//
// Every entry point that can put money into an individual member's
// side fund standing goes through this same function, so cascading/
// crediting behaviour is identical everywhere regardless of how the
// money physically got here:
//   - sideFundController.recordDuePayment (Treasurer records a single
//     member's payment against a specific due row)
//   - sideFundController.bulkPayDues (mark-all-as-paid batch entry)
//   - transactionsController.recordContribution (a contribution that
//     includes a side fund portion sliced out of the total)
//   - requisitionsController.approveRequisition (the SIDE_FUND_
//     CONTRIBUTION requisition type)
//
// Callers are responsible for posting the actual ledger transaction
// (a CREDIT into the side fund's parent account) and incrementing
// side_fund_config.current_balance by the same amount — this
// function only ever touches side_fund_dues / side_fund_member_credit
// / side_fund_credit_ledger, and must always be called from inside an
// existing DB transaction (it takes `client`, never opens its own).
// ============================================================

const { logAction, ACTIONS, MODULES } = require('./auditService');

const applySideFundPayment = async (client, {
    userId, amount, transactionId, referenceCode, paidDate, recordedBy,
}) => {
    let remaining = parseFloat(amount);
    const settled = []; // { due_id, period, amount_applied, new_status }
    if (remaining <= 0) return { settled, creditBanked: 0 };

    const outstanding = await client.query(`
        SELECT id, period, amount_due, amount_paid
        FROM   side_fund_dues
        WHERE  user_id = $1 AND status IN ('PENDING', 'PARTIAL', 'DEFAULTED')
        ORDER  BY period ASC
        FOR UPDATE
    `, [userId]);

    for (const due of outstanding.rows) {
        if (remaining <= 0) break;
        const dueOutstanding = parseFloat(due.amount_due) - parseFloat(due.amount_paid);
        if (dueOutstanding <= 0) continue;
        const applied = Math.min(remaining, dueOutstanding);
        const newPaid = parseFloat(due.amount_paid) + applied;
        const newStatus = newPaid >= parseFloat(due.amount_due) ? 'PAID' : 'PARTIAL';
        await client.query(`
            UPDATE side_fund_dues
            SET    amount_paid      = $1,
                   status           = $2,
                   transaction_id   = $3,
                   paid_date        = $4,
                   recorded_by      = $5,
                   paid_from_credit = FALSE,
                   updated_at       = NOW()
            WHERE  id = $6
        `, [newPaid, newStatus, transactionId, paidDate, recordedBy, due.id]);
        settled.push({ due_id: due.id, period: due.period, amount_applied: applied, new_status: newStatus });
        remaining = parseFloat((remaining - applied).toFixed(4));
    }

    // Anything left over (every existing outstanding due is now
    // clear) gets banked as credit for future months — automatically
    // drawn down by the monthly due-generation job as each new due
    // is created (jobs/scheduler.js).
    let creditBanked = 0;
    if (remaining > 0) {
        creditBanked = remaining;
        await client.query(`
            INSERT INTO side_fund_member_credit (user_id, credit_balance, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (user_id) DO UPDATE
            SET credit_balance = side_fund_member_credit.credit_balance + $2, updated_at = NOW()
        `, [userId, creditBanked]);
        await client.query(`
            INSERT INTO side_fund_credit_ledger (user_id, delta, reason, related_due_id)
            VALUES ($1, $2, $3, $4)
        `, [userId, creditBanked,
            `Overpayment banked beyond all outstanding dues (reference ${referenceCode})`,
            settled.length > 0 ? settled[settled.length - 1].due_id : null]);
        await logAction(recordedBy, ACTIONS.SIDE_FUND_CREDIT_BANKED, MODULES.FINANCE, {
            recordType:  'side_fund_member_credit',
            recordId:    userId,
            newValues:   { credit_banked: creditBanked, referenceCode },
            description: `${creditBanked} banked as side fund credit for future months (reference ${referenceCode})`,
            client,
        });
    }

    return { settled, creditBanked };
};

module.exports = { applySideFundPayment };
