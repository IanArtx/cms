// ============================================================
// REVERSAL LINKS SERVICE (v1.72.0)
//
// A reversal posts an equal-and-opposite ledger entry. Until v1.72 it
// did NOT touch the records other modules keep about that money, so
// e.g. reversing a money market fund (MMF) top-up put the money back in
// the parent account while the MMF still showed it as invested. The
// ledger (Trial Balance, Balance Sheet) was always right — only these
// "sub-ledger" figures drifted.
//
// This service answers three questions for reverseTransaction:
//
//   1. findUnsupportedLink — does this transaction belong to a module
//      whose own records are NOT unwound on reversal yet (loans, grants,
//      transfers, service fees, pledges, fines, savings conversions,
//      tax payments …)? If so the reversal is refused with a message
//      naming the module, instead of silently leaving its records
//      wrong. (Each module is being added one by one — pending list.)
//
//   2. resolveGroup — which transactions must be reversed TOGETHER?
//      Several investment events post more than one ledger entry:
//        • a bond coupon: interest received + tax withheld (+ the face
//          value on the final coupon)
//        • a treasury bill maturity: proceeds + tax deducted
//        • a return with tax deducted at source: return + tax
//      Reversing any one of them reverses the whole event, so the
//      investment never ends up half-reversed.
//
//   3. applySubledger — after the ledger entries are posted, bring the
//      MMF / investment records into line and mark the linked rows as
//      reversed. Refuses (rolling everything back) when:
//        • the fund / investment is closed (CLOSED, COMPLETED,
//          TERMINATED …) — except when the event being reversed is the
//          very one that completed it (a final coupon or a treasury
//          bill maturity), which re-opens it;
//        • reversing an MMF top-up would take the fund below zero (the
//          money was already withdrawn or charged in fees).
//
// The same effect rules (effectOfReturn / effectOfOperation) are used
// by the v1.72.0 migration to repair past reversals and by the Records
// check page, so all three always agree.
// ============================================================

const { createError } = require('../utils/errors');

const MUTABLE_INVESTMENT_STATUSES = ['ACTIVE', 'PENDING_TERMINATION'];

const money = (n) => Math.round((parseFloat(n || 0) + Number.EPSILON) * 100) / 100;
const fmt = (n) => money(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ------------------------------------------------------------
// 1. MODULES WHOSE RECORDS ARE NOT UNWOUND YET
// ------------------------------------------------------------
const UNSUPPORTED_CHECKS = [
    { label: 'a transfer between accounts', page: 'Transfers',
      sql: 'SELECT 1 FROM transfers WHERE debit_transaction_id = $1 OR credit_transaction_id = $1' },
    { label: 'a grant tranche', page: 'Grants',
      sql: 'SELECT 1 FROM grant_tranches WHERE transaction_id = $1' },
    { label: 'a loan repayment', page: 'Loans',
      sql: `SELECT 1 FROM loan_received_repayments WHERE transaction_id = $1
            UNION ALL SELECT 1 FROM loan_given_repayments WHERE transaction_id = $1` },
    { label: 'a capital pledge payment', page: 'Capital goals',
      sql: 'SELECT 1 FROM capital_goal_pledge_payments WHERE transaction_id = $1' },
    { label: 'a fine payment or fine settlement', page: 'Fines',
      sql: `SELECT 1 FROM fines WHERE transaction_id = $1
            UNION ALL SELECT 1 FROM savings_fine_settlements WHERE savings_transaction_id = $1
            UNION ALL SELECT 1 FROM savings_fine_settlement_items WHERE fine_transaction_id = $1` },
    { label: 'a service fee payment, advance or reimbursement', page: 'Service fees',
      sql: `SELECT 1 FROM service_fee_payments WHERE transaction_id = $1
            UNION ALL SELECT 1 FROM service_fee_advances WHERE transaction_id = $1
            UNION ALL SELECT 1 FROM service_reimbursement_requests WHERE transaction_id = $1
            UNION ALL SELECT 1 FROM payment_confirmations WHERE transaction_id = $1` },
    { label: 'a payment acknowledgement', page: 'Acknowledgements',
      sql: 'SELECT 1 FROM payment_acknowledgements WHERE transaction_id = $1' },
    { label: 'a payment to an authority for a dividend', page: 'Dividends',
      sql: 'SELECT 1 FROM authority_payments WHERE transaction_id = $1' },
    { label: 'a refund of share capital credit', page: 'Share capital',
      sql: 'SELECT 1 FROM capital_credit_refunds WHERE transaction_id = $1' },
    { label: 'a deposit refund', page: 'Deposits',
      sql: 'SELECT 1 FROM deposit_exit_events WHERE transaction_id = $1' },
    { label: 'a savings conversion, pool entry or withdrawal', page: 'Savings',
      sql: `SELECT 1 FROM savings_capital_conversions WHERE contribution_transaction_id = $1 OR savings_transaction_id = $1
            UNION ALL SELECT 1 FROM savings_currency_conversions WHERE from_transaction_id = $1 OR to_transaction_id = $1
            UNION ALL SELECT 1 FROM savings_pool_inflows WHERE transaction_id = $1
            UNION ALL SELECT 1 FROM member_savings WHERE withdrawal_transaction_id = $1` },
    { label: 'a side fund expense', page: 'Side fund',
      sql: 'SELECT 1 FROM side_fund_expenses WHERE transaction_id = $1' },
    { label: 'a tax payment to URA', page: 'Tax',
      sql: `SELECT 1 FROM tax_payments WHERE transaction_id = $1
            UNION ALL SELECT 1 FROM wht_remittances WHERE transaction_id = $1` },
];

const tableExistsCache = new Map();
const tableExists = async (client, name) => {
    if (tableExistsCache.has(name)) return tableExistsCache.get(name);
    const r = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${name}`]);
    tableExistsCache.set(name, r.rows[0].ok);
    return r.rows[0].ok;
};

/** Returns { label, page } when the reversal must be refused, else null. */
const findUnsupportedLink = async (client, tx) => {
    if (tx.transfer_id) return UNSUPPORTED_CHECKS[0];
    if (tx.grant_tranche_id) return UNSUPPORTED_CHECKS[1];
    if (tx.loan_received_id || tx.loan_given_id) return { label: 'a loan', page: 'Loans' };
    for (const check of UNSUPPORTED_CHECKS) {
        const tables = [...check.sql.matchAll(/FROM\s+([a-z_]+)/g)].map(m => m[1]);
        let allExist = true;
        for (const t of tables) { if (!(await tableExists(client, t))) { allExist = false; break; } }
        if (!allExist) continue;
        const r = await client.query(check.sql, [tx.id]);
        if (r.rows.length) return check;
    }
    // v1.80.0 — a PAID requisition can now be reversed: its requisition is
    // marked REVERSED by markRequisitionsReversed() below. (Before the
    // v1.80.0 database update the REVERSED status does not exist, so the
    // reversal is still refused then.)
    if (['DEBIT'].includes(tx.transaction_type)) {
        const r = await client.query('SELECT 1 FROM requisitions WHERE transaction_id = $1', [tx.id]);
        if (r.rows.length) {
            const ready = await client.query(`SELECT to_regclass('public.requisition_document_links') IS NOT NULL AS ok`);
            if (!ready.rows[0].ok) return { label: 'a paid requisition (needs the v1.80.0 database update)', page: 'Requisitions' };
        }
    }
    return null;
};

// ------------------------------------------------------------
// 2. WHICH TRANSACTIONS BELONG TOGETHER
// ------------------------------------------------------------
const taxLegsOf = async (client, incomeTxId) => {
    const r = await client.query(`
        SELECT tax_transaction_id FROM tax_at_source
        WHERE  income_transaction_id = $1 AND tax_transaction_id IS NOT NULL
    `, [incomeTxId]);
    return r.rows.map(x => x.tax_transaction_id);
};

const loadInvestment = async (client, id) => {
    const r = await client.query('SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]);
    return r.rows[0] || null;
};

/**
 * Describe the event a transaction belongs to.
 * Returns null for a transaction with no MMF / investment link, else
 *   { kind: 'MMF' | 'FUNDING' | 'OPERATION' | 'RETURN' | 'COUPON' | 'TBILL',
 *     legs: [transactionId …]  (every ledger entry of the event),
 *     … kind-specific rows }
 */
const resolveGroup = async (client, tx) => {
    const mmf = await client.query('SELECT * FROM mmf_transactions WHERE transaction_id = $1', [tx.id]);
    if (mmf.rows.length) return { kind: 'MMF', legs: [tx.id], mmfTx: mmf.rows[0] };

    const funding = await client.query('SELECT * FROM investment_funding WHERE transaction_id = $1', [tx.id]);
    if (funding.rows.length) {
        return { kind: 'FUNDING', legs: [tx.id], funding: funding.rows[0], investmentId: funding.rows[0].investment_id };
    }

    // A tax leg points back at the income it was taken from.
    const tas = await client.query(`
        SELECT income_transaction_id FROM tax_at_source
        WHERE  tax_transaction_id = $1 AND income_transaction_id IS NOT NULL
        LIMIT 1
    `, [tx.id]);
    const anchorTxId = tas.rows[0]?.income_transaction_id || tx.id;

    const ret = await client.query('SELECT * FROM investment_returns WHERE transaction_id = $1', [anchorTxId]);
    if (ret.rows.length) {
        let r = ret.rows[0];
        const inv = await client.query('SELECT id, investment_type FROM investments WHERE id = $1', [r.investment_id]);
        const type = inv.rows[0]?.investment_type;

        // The face value paid with a bond's final coupon belongs to that coupon.
        let coupon = (await client.query('SELECT * FROM bond_coupons WHERE investment_return_id = $1', [r.id])).rows[0];
        if (!coupon && r.return_type === 'PRINCIPAL' && type === 'BOND') {
            const m = /alongside final coupon #(\d+)/.exec(r.notes || '');
            if (m) {
                coupon = (await client.query(
                    'SELECT * FROM bond_coupons WHERE investment_id = $1 AND coupon_number = $2',
                    [r.investment_id, parseInt(m[1])])).rows[0];
                if (coupon && coupon.investment_return_id) {
                    const interest = await client.query('SELECT * FROM investment_returns WHERE id = $1', [coupon.investment_return_id]);
                    if (interest.rows.length) r = interest.rows[0];
                }
            }
        }

        if (coupon) {
            const legs = [r.transaction_id, ...(await taxLegsOf(client, r.transaction_id))];
            const principal = (await client.query(`
                SELECT * FROM investment_returns
                WHERE  investment_id = $1 AND return_type = 'PRINCIPAL'
                  AND  notes LIKE $2
            `, [r.investment_id, `%alongside final coupon #${coupon.coupon_number}`])).rows[0] || null;
            if (principal) legs.push(principal.transaction_id);
            return { kind: 'COUPON', legs: [...new Set(legs)], investmentId: r.investment_id, interestReturn: r, principalReturn: principal, coupon };
        }
        if (type === 'TREASURY_BILL' && r.return_type === 'PRINCIPAL') {
            const legs = [r.transaction_id, ...(await taxLegsOf(client, r.transaction_id))];
            return { kind: 'TBILL', legs: [...new Set(legs)], investmentId: r.investment_id, maturityReturn: r };
        }
        const legs = [r.transaction_id, ...(await taxLegsOf(client, r.transaction_id))];
        return { kind: 'RETURN', legs: [...new Set(legs)], investmentId: r.investment_id, ret: r };
    }

    const op = await client.query('SELECT * FROM investment_transactions WHERE transaction_id = $1', [tx.id]);
    if (op.rows.length) {
        return { kind: 'OPERATION', legs: [tx.id], investmentId: op.rows[0].investment_id, op: op.rows[0] };
    }

    if (tx.investment_id) {
        // Linked to an investment but none of the known events — refuse
        // rather than guess.
        return { kind: 'UNKNOWN_INVESTMENT', legs: [tx.id], investmentId: tx.investment_id };
    }
    return null;
};

// ------------------------------------------------------------
// EFFECT RULES — what each record added to the investment's stored
// figures when it was recorded (mirrors investmentsController exactly).
// ------------------------------------------------------------

/** Did this TAX / EXPENSE operation row count toward "Spent"? */
const operationCountsAsSpend = async (client, op) => {
    if (op.entry_type === 'INFLOW') return false;
    if (op.entry_type === 'EXPENSE') return true;
    // TAX: counted when entered on the investment itself or withheld on a
    // bond coupon; NOT counted when it is the tax leg of a manual return
    // or of a treasury bill maturity.
    const src = await client.query('SELECT source_type FROM tax_at_source WHERE tax_transaction_id = $1 LIMIT 1', [op.transaction_id]);
    const t = src.rows[0]?.source_type;
    return !(t === 'INVESTMENT_RETURN' || t === 'TREASURY_BILL');
};

/** How much a return row added to total_returns. */
const returnsEffect = (ret, investment, { isCouponPrincipal = false } = {}) => {
    if (isCouponPrincipal) return 0;                                   // face value at maturity is not income
    if (investment.investment_type === 'TREASURY_BILL' && ret.return_type === 'PRINCIPAL') {
        return Math.max(0, money(parseFloat(ret.amount) - parseFloat(investment.settlement_value || 0)));
    }
    return money(ret.amount);
};

// Same arithmetic as computeSupplementaryOverage, used with a negative
// amount to take spend back out.
const adjustSpend = async (client, investment, delta) => {
    if (!delta) return;
    const planned = parseFloat(investment.planned_budget) || 0;
    const before = parseFloat(investment.actual_expenditure) || 0;
    const after = money(before + delta);
    const overBefore = Math.max(0, before - planned);
    const overAfter = Math.max(0, after - planned);
    const supplementary = Math.max(0, money(parseFloat(investment.supplementary_budget || 0) + (overAfter - overBefore)));
    await client.query('UPDATE investments SET actual_expenditure = $1, supplementary_budget = $2 WHERE id = $3',
        [after, supplementary, investment.id]);
    investment.actual_expenditure = after;
    investment.supplementary_budget = supplementary;
};

const markRow = (client, table, id, userId, reversalTxId) => client.query(`
    UPDATE ${table}
    SET    is_reversed = TRUE, reversed_at = NOW(), reversed_by = $2, reversal_transaction_id = $3
    WHERE  id = $1
`, [id, userId, reversalTxId || null]);

// ------------------------------------------------------------
// 3. CHECKS BEFORE POSTING (so the message is friendly)
// ------------------------------------------------------------
const precheck = async (client, group) => {
    if (!group) return;
    if (group.kind === 'UNKNOWN_INVESTMENT') {
        throw createError.badRequest(
            'This entry is linked to an investment in a way the system cannot unwind automatically. ' +
            'Please correct it from the investment\'s own page, or ask the administrator.');
    }
    if (group.kind === 'MMF') {
        const m = (await client.query('SELECT * FROM mmf_accounts WHERE id = $1 FOR UPDATE', [group.mmfTx.mmf_account_id])).rows[0];
        group.mmf = m;
        if (m.status !== 'ACTIVE') {
            throw createError.badRequest(`The money market fund "${m.name}" is closed, so this entry can't be reversed.`);
        }
        if (group.mmfTx.entry_type === 'TOPUP' && parseFloat(group.mmfTx.amount) > parseFloat(m.current_balance) + 0.0001) {
            throw createError.badRequest(
                `The money market fund "${m.name}" now holds only ${fmt(m.current_balance)}, less than this top-up of ` +
                `${fmt(group.mmfTx.amount)} (some was already withdrawn or charged as fees). Reverse or correct the later ` +
                'entries first, so the fund never shows less than zero.');
        }
        return;
    }
    const investment = await loadInvestment(client, group.investmentId);
    group.investment = investment;
    const reopens = (group.kind === 'COUPON' && group.principalReturn) || group.kind === 'TBILL';
    const completedByThis = reopens && investment.status === 'COMPLETED';
    if (!MUTABLE_INVESTMENT_STATUSES.includes(investment.status) && !completedByThis) {
        throw createError.badRequest(
            `The investment "${investment.name}" is ${String(investment.status).toLowerCase().replace(/_/g, ' ')}, ` +
            'so entries against it can\'t be reversed.');
    }
    group.reopen = completedByThis;
};

// ------------------------------------------------------------
// 4. BRING THE RECORDS INTO LINE (after the ledger entries exist)
//    reversalOf: Map(originalTxId -> reversalTxId)
// ------------------------------------------------------------
const applySubledger = async (client, group, { userId, reversalOf }) => {
    if (!group) return null;
    const note = [];

    if (group.kind === 'MMF') {
        const e = group.mmfTx;
        const amt = money(e.amount);
        if (e.entry_type === 'TOPUP') {
            await client.query(`UPDATE mmf_accounts SET current_balance = current_balance - $1,
                                total_principal_in = total_principal_in - $1 WHERE id = $2`, [amt, e.mmf_account_id]);
            note.push(`MMF balance and money put in reduced by ${fmt(amt)}`);
        } else if (e.entry_type === 'WITHDRAWAL') {
            await client.query(`UPDATE mmf_accounts SET current_balance = current_balance + $1,
                                total_withdrawn = GREATEST(0, total_withdrawn - $1) WHERE id = $2`, [amt, e.mmf_account_id]);
            note.push(`MMF balance restored by ${fmt(amt)}`);
        }
        await markRow(client, 'mmf_transactions', e.id, userId, reversalOf.get(e.transaction_id));
        return { summary: note.join('; ') };
    }

    const inv = group.investment || await loadInvestment(client, group.investmentId);

    if (group.kind === 'FUNDING') {
        const f = group.funding;
        await adjustSpend(client, inv, -money(f.amount));
        if (f.project_id) {
            await client.query('UPDATE projects SET actual_expenditure = GREATEST(0, actual_expenditure - $1) WHERE id = $2', [money(f.amount), f.project_id]);
        }
        await markRow(client, 'investment_funding', f.id, userId, reversalOf.get(f.transaction_id));
        note.push(`investment spend reduced by ${fmt(f.amount)}`);
    }

    if (group.kind === 'OPERATION') {
        const op = group.op;
        if (await operationCountsAsSpend(client, op)) {
            await adjustSpend(client, inv, -money(op.amount));
            note.push(`investment spend reduced by ${fmt(op.amount)}`);
        }
        await markRow(client, 'investment_transactions', op.id, userId, reversalOf.get(op.transaction_id));
    }

    if (['RETURN', 'COUPON', 'TBILL'].includes(group.kind)) {
        const rows = [];
        if (group.kind === 'RETURN') rows.push({ r: group.ret });
        if (group.kind === 'COUPON') {
            rows.push({ r: group.interestReturn });
            if (group.principalReturn) rows.push({ r: group.principalReturn, isCouponPrincipal: true });
        }
        if (group.kind === 'TBILL') rows.push({ r: group.maturityReturn });
        let returnsDown = 0;
        for (const { r, isCouponPrincipal } of rows) {
            returnsDown += returnsEffect(r, inv, { isCouponPrincipal });
            await markRow(client, 'investment_returns', r.id, userId, reversalOf.get(r.transaction_id));
        }
        if (returnsDown) {
            await client.query('UPDATE investments SET total_returns = total_returns - $1 WHERE id = $2', [money(returnsDown), inv.id]);
            note.push(`investment returns reduced by ${fmt(returnsDown)}`);
        }
        // Tax legs recorded as operation rows
        for (const legId of group.legs) {
            const op = (await client.query('SELECT * FROM investment_transactions WHERE transaction_id = $1', [legId])).rows[0];
            if (!op) continue;
            if (await operationCountsAsSpend(client, op)) {
                await adjustSpend(client, inv, -money(op.amount));
                note.push(`tax taken back out of spend: ${fmt(op.amount)}`);
            }
            await markRow(client, 'investment_transactions', op.id, userId, reversalOf.get(legId));
        }
        if (group.kind === 'COUPON') {
            await client.query(`
                UPDATE bond_coupons
                SET    status = 'PENDING', investment_return_id = NULL, paid_at = NULL,
                       actual_gross_amount = NULL, actual_tax_amount = NULL, actual_net_amount = NULL,
                       adjusted_by = NULL, adjusted_at = NULL
                WHERE  id = $1
            `, [group.coupon.id]);
            note.push(`coupon #${group.coupon.coupon_number} is unpaid again`);
        }
        if (group.reopen) {
            await client.query(`UPDATE investments SET status = 'ACTIVE', actual_end_date = NULL WHERE id = $1`, [inv.id]);
            note.push('investment re-opened (it had been completed by this event)');
        }
    }
    return { summary: note.join('; ') };
};

// ------------------------------------------------------------
// v1.80.0 — requisitions paid by the reversed entries become REVERSED.
// Returns a sentence for the effect summary, or null.
// ------------------------------------------------------------
const markRequisitionsReversed = async (client, { reversalOf, reason, userId }) => {
    const ids = [...reversalOf.keys()];
    if (!ids.length) return null;
    const ready = await client.query(`SELECT to_regclass('public.requisition_document_links') IS NOT NULL AS ok`);
    if (!ready.rows[0].ok) return null;
    const r = await client.query(`
        SELECT q.id, q.transaction_id, rr.reference_code FROM requisitions q
        JOIN references_registry rr ON rr.id = q.reference_id
        WHERE q.transaction_id = ANY($1::int[]) AND q.status = 'APPROVED' FOR UPDATE OF q`, [ids]);
    for (const q of r.rows) {
        await client.query(`
            UPDATE requisitions SET status = 'REVERSED', reversed_at = NOW(), reversed_by = $2,
                   reversal_reason = $3, reversal_transaction_id = $4
            WHERE id = $1`, [q.id, userId, reason, reversalOf.get(q.transaction_id) || null]);
    }
    return r.rows.length ? `requisition ${r.rows.map(q => q.reference_code).join(', ')} marked reversed` : null;
};

module.exports = {
    markRequisitionsReversed,
    findUnsupportedLink,
    resolveGroup,
    precheck,
    applySubledger,
    // shared with the migration's check page
    operationCountsAsSpend,
    returnsEffect,
    UNSUPPORTED_CHECKS,
};
