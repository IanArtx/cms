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

const { query } = require('../config/database');
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

// ============================================================
// GENERATE DUES FOR A PERIOD (v1.28.3)
// Creates one PENDING side_fund_dues row per active shareholder for
// the given period ('YYYY-MM'), using that member's per-member
// override amount if one is set (side_fund_member_overrides),
// otherwise the fund's company-wide monthly_amount. Immediately
// draws down any banked overpayment credit (side_fund_member_credit)
// against each brand-new row, same as a normal payment would.
//
// Shared by two callers so both behave identically:
//   - jobs/scheduler.js's scheduleSideFundDueGeneration — runs
//     automatically at 00:15 on the 1st of every month
//   - sideFundController.generateDues — a manual "Generate Dues Now"
//     trigger (SIDE_FUND_MANAGE) for when that automatic run hasn't
//     happened yet for the current period (e.g. the fund was only
//     just activated, or the backend was redeployed, after the 1st
//     already passed) or a shareholder joined partway through the
//     month
//
// Idempotent: ON CONFLICT (user_id, period) DO NOTHING means running
// this twice for the same period only fills in members who don't
// already have a row — it never touches or duplicates an existing
// due, so it's always safe to re-run.
// ============================================================
const generateDuesForPeriod = async (period) => {
    const configResult = await query('SELECT * FROM side_fund_config WHERE id = 1');
    const config = configResult.rows[0];
    if (!config || !config.is_active) {
        return { created: 0, creditApplied: 0, total: 0, skipped: true, reason: 'The side fund is not currently active' };
    }

    const shareholders = await query(`
        SELECT sr.user_id, smo.monthly_amount AS override_amount
        FROM   shareholding_registry sr
        JOIN   users u ON u.id = sr.user_id
        LEFT JOIN side_fund_member_overrides smo ON smo.user_id = sr.user_id
        WHERE  sr.effective_to IS NULL
        AND    u.is_active = TRUE
    `);

    let created = 0;
    let creditApplied = 0;
    for (const s of shareholders.rows) {
        const dueAmount = s.override_amount != null ? s.override_amount : config.monthly_amount;
        // due_date is always the last day of this due's own period
        // month — the fund is a flat monthly amount, so "overdue" is
        // simply "past that date and still unpaid".
        const result = await query(`
            INSERT INTO side_fund_dues (user_id, period, amount_due, status, due_date)
            VALUES ($1, $2, $3, 'PENDING',
                ($2 || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day')
            ON CONFLICT (user_id, period) DO NOTHING
            RETURNING id
        `, [s.user_id, period, dueAmount]);
        if (result.rows.length === 0) continue;
        created++;
        const newDueId = result.rows[0].id;

        const creditResult = await query(
            'SELECT credit_balance FROM side_fund_member_credit WHERE user_id = $1',
            [s.user_id]
        );
        const creditBalance = parseFloat(creditResult.rows[0]?.credit_balance || 0);
        if (creditBalance > 0) {
            const applied = Math.min(creditBalance, parseFloat(dueAmount));
            const newStatus = applied >= parseFloat(dueAmount) ? 'PAID' : 'PARTIAL';
            await query(`
                UPDATE side_fund_dues
                SET    amount_paid = $1, status = $2, paid_from_credit = TRUE,
                       paid_date = CURRENT_DATE, updated_at = NOW()
                WHERE  id = $3
            `, [applied, newStatus, newDueId]);
            await query(`
                UPDATE side_fund_member_credit
                SET    credit_balance = credit_balance - $1, updated_at = NOW()
                WHERE  user_id = $2
            `, [applied, s.user_id]);
            await query(`
                INSERT INTO side_fund_credit_ledger (user_id, delta, reason, related_due_id)
                VALUES ($1, $2, $3, $4)
            `, [s.user_id, -applied, `Applied automatically to ${period} due`, newDueId]);
            creditApplied++;
        }
    }

    return { created, creditApplied, total: shareholders.rows.length, skipped: false };
};

module.exports = { applySideFundPayment, generateDuesForPeriod };
