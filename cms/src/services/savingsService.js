// ============================================================
// SAVINGS SERVICE (v1.31.0; made currency-aware v1.61.0)
// Two tiny, dependency-free helpers extracted out of
// savingsController.js so transactionsController.js can call them
// too (for the new Savings slice on Record Contribution) without
// creating a circular require — savingsController.js already
// requires transactionsController.js (for postTransaction), so
// transactionsController.js requiring savingsController.js back
// would form a cycle. Same reasoning sideFundService.js was split
// out for. savingsController.js still re-exports both of these from
// its own module.exports (unchanged for existing callers like
// dividendsController.js), it just no longer defines them itself.
//
// v1.61.0 — a company can now have one SAVINGS account PER CURRENCY
// (was: exactly one, ever), so a member can hold and move savings
// across several currencies. Both helpers below now take a
// currencyId and are scoped to it throughout — there is no longer
// such a thing as "the" Savings account or "a" member's balance
// without specifying which currency.
// ============================================================

const { createError } = require('../utils/errors');

// ============================================================
// GET (or lazily create) A MEMBER'S savings_balances ROW, for one
// specific currency. A member can hold several of these at once, one
// per currency they've ever touched.
// ============================================================
const getOrCreateSavingsBalance = async (client, userId, currencyId) => {
    if (!currencyId) {
        throw createError.badRequest('A currency is required to look up a savings balance');
    }
    const existing = await client.query(
        'SELECT * FROM savings_balances WHERE user_id = $1 AND currency_id = $2 FOR UPDATE',
        [userId, currencyId]
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
// GET THE SAVINGS ACCOUNT for one specific currency — all savings
// transactions in that currency are always held here (v1.14.0;
// widened to one-per-currency in v1.61.0). Savings have their own
// dedicated account(s) so they never mix with general company funds,
// can never be transferred out, and are permanently exempt from
// floor-limit enforcement.
// ============================================================
const getSavingsAccount = async (client, currencyId) => {
    if (!currencyId) {
        throw createError.badRequest('A currency is required to look up a Savings account');
    }
    const account = await client.query(`
        SELECT id, currency_id, name, account_type, reference_prefix
        FROM   accounts
        WHERE  account_type = 'SAVINGS' AND currency_id = $1 AND is_active = TRUE
    `, [currencyId]);
    if (account.rows.length === 0) {
        const currency = await client.query('SELECT code FROM currencies WHERE id = $1', [currencyId]);
        const code = currency.rows[0]?.code || 'this currency';
        throw createError.badRequest(
            `There is no Savings account set up for ${code} yet. Go to Accounts and set one up first.`
        );
    }
    return account.rows[0];
};

module.exports = { getOrCreateSavingsBalance, getSavingsAccount };
