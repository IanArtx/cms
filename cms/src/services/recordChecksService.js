// ============================================================
// RECORDS CHECK (v1.72.0) — Reports & ledger › Records check
//
// Compares the figures STORED on each money market fund and investment
// with the same figures WORKED OUT again from the entries that still
// stand (reversed entries excluded). A difference means the stored
// figure is out of step with its own history.
//
//   • Money market funds: balance, money put in, withdrawn, interest,
//     fees — rebuilt from the fund's entries.
//   • Investments: "Spent" (funding + running costs + counted tax) and
//     "Returns" (income; a treasury bill counts only its discount; the
//     face value paid with a bond's final coupon is not income).
//     Note: investments recorded before v1.40.0 did not count running
//     costs as spend, so an old investment may show a difference that
//     is simply that history — it is listed, not changed.
//
// Also returns the log of automatic corrections (record_corrections),
// e.g. the ones made by the v1.72.0 migration when it repaired past
// reversals.
// ============================================================

const { query } = require('../config/database');

const num = (v) => Math.round((parseFloat(v || 0) + Number.EPSILON) * 100) / 100;

const getRecordChecks = async () => {
    const funds = await query(`
        SELECT m.id, m.name, m.status, c.code AS currency_code,
               m.current_balance, m.total_principal_in, m.total_withdrawn, m.total_interest, m.total_management_fees,
               COALESCE(SUM(CASE WHEN mt.entry_type = 'TOPUP' AND NOT mt.is_reversed THEN mt.amount END), 0)          AS topups,
               COALESCE(SUM(CASE WHEN mt.entry_type = 'WITHDRAWAL' AND NOT mt.is_reversed THEN mt.amount END), 0)     AS withdrawals,
               COALESCE(SUM(CASE WHEN mt.entry_type = 'INTEREST' AND NOT mt.is_reversed THEN mt.amount END), 0)       AS interest,
               COALESCE(SUM(CASE WHEN mt.entry_type = 'MANAGEMENT_FEE' AND NOT mt.is_reversed THEN mt.amount END), 0) AS fees,
               COUNT(*) FILTER (WHERE mt.is_reversed) AS reversed_entries
        FROM   mmf_accounts m
        JOIN   currencies c ON c.id = m.currency_id
        LEFT JOIN mmf_transactions mt ON mt.mmf_account_id = m.id
        GROUP  BY m.id, c.code
        ORDER  BY m.name
    `);
    const fundRows = funds.rows.map(f => {
        const expected = {
            current_balance: num(f.topups) + num(f.interest) - num(f.withdrawals) - num(f.fees),
            total_principal_in: num(f.topups),
            total_withdrawn: num(f.withdrawals),
            total_interest: num(f.interest),
            total_management_fees: num(f.fees),
        };
        const differences = Object.entries(expected)
            .filter(([k, v]) => Math.abs(num(f[k]) - v) > 0.005)
            .map(([k, v]) => ({ field: k, stored: num(f[k]), expected: v }));
        return {
            id: f.id, name: f.name, status: f.status, currency_code: f.currency_code,
            stored_balance: num(f.current_balance), expected_balance: num(expected.current_balance),
            reversed_entries: parseInt(f.reversed_entries, 10) || 0,
            ok: differences.length === 0, differences,
        };
    });

    const inv = await query(`
        SELECT i.id, i.name, i.status, i.investment_type, c.code AS currency_code,
               i.actual_expenditure, i.total_returns, i.settlement_value,
               COALESCE((SELECT SUM(amount) FROM investment_funding f WHERE f.investment_id = i.id AND NOT f.is_reversed), 0) AS funding,
               COALESCE((SELECT SUM(x.amount) FROM investment_transactions x
                         WHERE x.investment_id = i.id AND NOT x.is_reversed
                         AND (x.entry_type = 'EXPENSE'
                              OR (x.entry_type = 'TAX' AND NOT EXISTS (
                                  SELECT 1 FROM tax_at_source s WHERE s.tax_transaction_id = x.transaction_id
                                  AND s.source_type IN ('INVESTMENT_RETURN', 'TREASURY_BILL'))))), 0) AS running_costs,
               COALESCE((SELECT SUM(CASE
                            WHEN r.return_type = 'PRINCIPAL' AND i.investment_type = 'BOND'
                                 AND r.notes LIKE '%alongside final coupon #%' THEN 0
                            WHEN r.return_type = 'PRINCIPAL' AND i.investment_type = 'TREASURY_BILL'
                                 THEN GREATEST(0, r.amount - COALESCE(i.settlement_value, 0))
                            ELSE r.amount END)
                         FROM investment_returns r WHERE r.investment_id = i.id AND NOT r.is_reversed), 0) AS returns_expected,
               (SELECT COUNT(*) FROM investment_returns r WHERE r.investment_id = i.id AND r.is_reversed)
             + (SELECT COUNT(*) FROM investment_funding f WHERE f.investment_id = i.id AND f.is_reversed)
             + (SELECT COUNT(*) FROM investment_transactions x WHERE x.investment_id = i.id AND x.is_reversed) AS reversed_entries
        FROM   investments i
        JOIN   currencies c ON c.id = i.currency_id
        ORDER  BY i.name
    `);
    const invRows = inv.rows.map(i => {
        const expSpend = num(i.funding) + num(i.running_costs);
        const expReturns = num(i.returns_expected);
        const differences = [];
        if (Math.abs(num(i.actual_expenditure) - expSpend) > 0.005) {
            differences.push({ field: 'actual_expenditure', stored: num(i.actual_expenditure), expected: expSpend });
        }
        if (Math.abs(num(i.total_returns) - expReturns) > 0.005) {
            differences.push({ field: 'total_returns', stored: num(i.total_returns), expected: expReturns });
        }
        return {
            id: i.id, name: i.name, status: i.status, investment_type: i.investment_type, currency_code: i.currency_code,
            stored_spent: num(i.actual_expenditure), expected_spent: expSpend,
            stored_returns: num(i.total_returns), expected_returns: expReturns,
            reversed_entries: parseInt(i.reversed_entries, 10) || 0,
            ok: differences.length === 0, differences,
        };
    });

    const corrections = await query(`
        SELECT id, run_label, record_type, record_id, record_name, field_name, old_value, new_value,
               note, needs_attention, created_at
        FROM   record_corrections
        ORDER  BY id DESC
        LIMIT  500
    `);

    return {
        funds: fundRows,
        investments: invRows,
        corrections: corrections.rows,
        summary: {
            funds_with_differences: fundRows.filter(r => !r.ok).length,
            investments_with_differences: invRows.filter(r => !r.ok).length,
            corrections_needing_attention: corrections.rows.filter(r => r.needs_attention).length,
        },
    };
};

module.exports = { getRecordChecks };
