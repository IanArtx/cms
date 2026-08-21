// ============================================================
// SAVINGS SERVICE (v1.31.0)
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
// ============================================================

const { createError } = require('../utils/errors');

// ============================================================
// GET (or lazily create) A MEMBER'S savings_balances ROW
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
// held here (v1.14.0). Savings have their own dedicated account so
// they never mix with general company funds, can never be
// transferred out, and are permanently exempt from floor-limit
// enforcement.
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

module.exports = { getOrCreateSavingsBalance, getSavingsAccount };
