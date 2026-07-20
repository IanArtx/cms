// ============================================================
// SIDE FUND CONTROLLER
// Optional shared petty-cash-style pool for day-to-day simple
// activities. It is NOT its own bank account — it's an "envelope"
// balance layered inside an existing Primary or Secondary account
// (side_fund_config.parent_account_id), which is why activating it
// means picking that parent account (and therefore its currency).
//
// Every contribution or expense is dual-posted, in the same DB
// transaction, so the two numbers can never drift apart:
//   1. A completely normal transaction on the parent account — the
//      account's real balance is always correct, and expenses show
//      up in the ordinary Transactions ledger exactly like any other
//      expense (deliberately posted with inflow_type 'EXPENSE')
//   2. An increment/decrement of side_fund_config.current_balance
//      (the envelope) by the exact same amount
//
// Each active shareholder owes a monthly due (side_fund_config.
// monthly_amount, changeable at any time — a change only affects
// dues generated from that point on). Dues are auto-generated on the
// 1st of each month by a cron job (jobs/scheduler.js); any due still
// unpaid when the following month's job runs is marked DEFAULTED.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { notify } = require('../services/notificationService');

// ============================================================
// INTERNAL HELPER — lock and fetch the singleton config row
// ============================================================
const getConfigForUpdate = async (client) => {
    const result = await client.query('SELECT * FROM side_fund_config WHERE id = 1 FOR UPDATE');
    return result.rows[0];
};

// ============================================================
// GET SIDE FUND SETTINGS/SUMMARY
// GET /api/side-fund/settings
// Anyone can view — the frontend uses this to know whether the
// fund is active at all before showing the rest of the page.
// ============================================================
const getSideFundConfig = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            sfc.*,
            a.name AS parent_account_name,
            a.account_type AS parent_account_type,
            c.code AS currency_code,
            c.symbol AS currency_symbol
        FROM   side_fund_config sfc
        LEFT JOIN accounts a   ON a.id = sfc.parent_account_id
        LEFT JOIN currencies c ON c.id = sfc.currency_id
        WHERE  sfc.id = 1
    `);
    sendSuccess(res, result.rows[0] || {
        is_active: false, monthly_amount: 0, current_balance: 0,
    });
});

// ============================================================
// UPDATE SIDE FUND SETTINGS — Admin / Treasurer
// PATCH /api/side-fund/settings
// Activates/deactivates the fund, sets its parent account
// (and therefore currency), and/or the monthly due amount.
// ============================================================
const updateSideFundConfig = asyncHandler(async (req, res) => {
    const { is_active, parent_account_id, monthly_amount } = req.body;

    await withTransaction(async (client) => {
        const config = await getConfigForUpdate(client);

        let currencyId = config.currency_id;
        let accountName = null;

        if (parent_account_id !== undefined && parent_account_id !== null &&
            parseInt(parent_account_id) !== config.parent_account_id) {
            // Changing which account the envelope lives inside is only
            // safe while the envelope is empty — otherwise that money
            // would silently be "moved" without an actual transaction.
            if (parseFloat(config.current_balance) > 0) {
                throw createError.badRequest(
                    `Cannot change the parent account while the side fund still holds a balance ` +
                    `(${config.current_balance}). Spend it down to zero first, or hand it out as an expense.`
                );
            }

            const accountResult = await client.query(
                'SELECT id, name, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE',
                [parent_account_id]
            );
            if (accountResult.rows.length === 0) {
                throw createError.notFound('Account not found');
            }
            currencyId  = accountResult.rows[0].currency_id;
            accountName = accountResult.rows[0].name;
        }

        if (is_active === true && !parent_account_id && !config.parent_account_id) {
            throw createError.badRequest(
                'Choose a parent account for the side fund before activating it.'
            );
        }

        const result = await client.query(`
            UPDATE side_fund_config
            SET    is_active         = COALESCE($1, is_active),
                   parent_account_id = COALESCE($2, parent_account_id),
                   currency_id       = COALESCE($3, currency_id),
                   monthly_amount    = COALESCE($4, monthly_amount),
                   updated_by        = $5,
                   updated_at        = NOW()
            WHERE  id = 1
            RETURNING *
        `, [
            is_active, parent_account_id ? parseInt(parent_account_id) : null,
            currencyId, monthly_amount !== undefined ? monthly_amount : null,
            req.user.id,
        ]);

        await logAction(req.user.id, ACTIONS.SIDE_FUND_SETTINGS_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'side_fund_config',
            recordId:    1,
            newValues:   result.rows[0],
            description: `Side fund settings updated${accountName ? ` — now inside ${accountName}` : ''}`,
            client,
        });

        sendSuccess(res, result.rows[0], 'Side fund settings updated');
    });
});

// ============================================================
// GET MY DUES — a member's own side fund due history
// GET /api/side-fund/dues/me
// ============================================================
const getMyDues = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT sfd.*, r.first_name || ' ' || r.last_name AS recorded_by_name
        FROM   side_fund_dues sfd
        LEFT JOIN users r ON r.id = sfd.recorded_by
        WHERE  sfd.user_id = $1
        ORDER BY sfd.period DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL DUES — Treasurer/Admin
// GET /api/side-fund/dues
// ============================================================
const getAllDues = asyncHandler(async (req, res) => {
    const { period, status, user_id } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (period)  { p++; conditions.push(`sfd.period = $${p}`); params.push(period); }
    if (status)  { p++; conditions.push(`sfd.status = $${p}`); params.push(status.toUpperCase()); }
    if (user_id) { p++; conditions.push(`sfd.user_id = $${p}`); params.push(user_id); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM side_fund_dues sfd ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            sfd.*,
            u.first_name || ' ' || u.last_name AS member_name,
            u.email AS member_email,
            rec.first_name || ' ' || rec.last_name AS recorded_by_name
        FROM   side_fund_dues sfd
        JOIN   users u ON u.id = sfd.user_id
        LEFT JOIN users rec ON rec.id = sfd.recorded_by
        ${where}
        ORDER BY sfd.period DESC, u.first_name ASC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// RECORD A DUE PAYMENT — Treasurer / Assistant Treasurer
// PATCH /api/side-fund/dues/:id/pay
// This is what actually moves the money: posts a CREDIT transaction
// on the parent account and grows the envelope balance by the same
// amount. Supports partial payment.
// ============================================================
const recordDuePayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, category_id, paid_date, notes } = req.body;

    await withTransaction(async (client) => {
        const config = await getConfigForUpdate(client);
        if (!config.is_active) {
            throw createError.badRequest('The side fund is not currently active');
        }
        if (!config.parent_account_id) {
            throw createError.badRequest('The side fund has no parent account configured');
        }

        const dueResult = await client.query(`
            SELECT sfd.*, u.first_name, u.last_name, u.email
            FROM   side_fund_dues sfd
            JOIN   users u ON u.id = sfd.user_id
            WHERE  sfd.id = $1 FOR UPDATE
        `, [id]);
        if (dueResult.rows.length === 0) {
            throw createError.notFound('Side fund due not found');
        }
        const due = dueResult.rows[0];

        if (due.status === 'PAID') {
            throw createError.badRequest('This due has already been paid in full');
        }

        const outstanding = parseFloat(due.amount_due) - parseFloat(due.amount_paid);
        const payAmount = parseFloat(amount);
        if (payAmount <= 0) {
            throw createError.badRequest('Payment amount must be greater than zero');
        }
        if (payAmount > outstanding) {
            throw createError.badRequest(
                `Payment (${payAmount}) exceeds the outstanding balance on this due (${outstanding})`
            );
        }

        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [config.parent_account_id]
        );
        const parentAccount = account.rows[0];

        const { referenceId, referenceCode } = await generateReference(
            client, resolveModuleCode(parentAccount), 'SF-IN', 'TRANSACTION', req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       config.parent_account_id,
            transactionType: 'CREDIT',
            inflowType:      'SIDE_FUND_CONTRIBUTION_IN',
            amount:          payAmount,
            currencyId:      parentAccount.currency_id,
            categoryId:      category_id,
            description:     `Side fund contribution — ${due.first_name} ${due.last_name} (${due.period})${notes ? ` — ${notes}` : ''}`,
            valueDate:       paid_date || new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId,
        });
        await linkReferenceToRecord(client, referenceId, transactionId);

        const newPaid   = parseFloat(due.amount_paid) + payAmount;
        const newStatus = newPaid >= parseFloat(due.amount_due) ? 'PAID' : 'PARTIAL';

        await client.query(`
            UPDATE side_fund_dues
            SET    amount_paid    = $1,
                   status         = $2,
                   transaction_id = $3,
                   paid_date      = $4,
                   recorded_by    = $5,
                   updated_at     = NOW()
            WHERE  id = $6
        `, [newPaid, newStatus, transactionId, paid_date || new Date().toISOString().split('T')[0], req.user.id, id]);

        await client.query(`
            UPDATE side_fund_config
            SET    current_balance = current_balance + $1, updated_at = NOW()
            WHERE  id = 1
        `, [payAmount]);

        await logAction(req.user.id, ACTIONS.SIDE_FUND_DUE_PAID, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'side_fund_dues',
            recordId:    parseInt(id),
            newValues:   { referenceCode, amount: payAmount, newStatus, balanceBefore, balanceAfter },
            description: `Side fund due paid: ${due.first_name} ${due.last_name} — ${due.period}: ${payAmount} (${referenceCode})`,
            client,
        });

        notify({
            userId:     due.user_id,
            type:       'SIDE_FUND_DUE_PAID',
            title:      'Side fund contribution recorded',
            body:       `Your side fund due for ${due.period} (${payAmount}) was recorded. Reference: ${referenceCode}.`,
            link:       `/side-fund`,
            module:     'FINANCE',
            recordType: 'side_fund_dues',
            recordId:   parseInt(id),
        });

        sendSuccess(res, {
            status:          newStatus,
            amount_paid:     newPaid,
            reference:       referenceCode,
            balance_before:  balanceBefore,
            balance_after:   balanceAfter,
        }, `Side fund due payment recorded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// RECORD A DIRECT / BATCH INFLOW — Treasurer / Assistant Treasurer
// POST /api/side-fund/inflows
// For adding money straight into the side fund that ISN'T a member's
// monthly due — e.g. a balance that already existed before the fund
// was tracked here, or a lump-sum top-up. Not linked to any
// side_fund_dues row. Dual-posted exactly like a due payment: a
// normal CREDIT transaction on the parent account (inflow_type
// 'SIDE_FUND_DIRECT_IN', fully visible in that account's own
// transaction ledger) plus the same increment to the envelope
// balance (side_fund_config.current_balance) in the same DB
// transaction, so the two numbers can never drift.
// ============================================================
const recordDirectInflow = asyncHandler(async (req, res) => {
    const { amount, category_id, value_date, description, notes } = req.body;

    await withTransaction(async (client) => {
        const config = await getConfigForUpdate(client);
        if (!config.is_active) {
            throw createError.badRequest('The side fund is not currently active');
        }
        if (!config.parent_account_id) {
            throw createError.badRequest('The side fund has no parent account configured');
        }

        const inflowAmount = parseFloat(amount);
        if (inflowAmount <= 0) {
            throw createError.badRequest('Amount must be greater than zero');
        }

        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [config.parent_account_id]
        );
        const parentAccount = account.rows[0];

        const { referenceId, referenceCode } = await generateReference(
            client, resolveModuleCode(parentAccount), 'SF-DIRECT', 'TRANSACTION', req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       config.parent_account_id,
            transactionType: 'CREDIT',
            inflowType:      'SIDE_FUND_DIRECT_IN',
            amount:          inflowAmount,
            currencyId:      parentAccount.currency_id,
            categoryId:      category_id,
            description:     description || `Side fund direct top-up${notes ? ` — ${notes}` : ''}`,
            valueDate:       value_date || new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId,
        });
        await linkReferenceToRecord(client, referenceId, transactionId);

        await client.query(`
            UPDATE side_fund_config
            SET    current_balance = current_balance + $1, updated_at = NOW()
            WHERE  id = 1
        `, [inflowAmount]);

        await logAction(req.user.id, ACTIONS.SIDE_FUND_DIRECT_INFLOW_RECORDED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'side_fund_config',
            recordId:    1,
            newValues:   { referenceCode, amount: inflowAmount, balanceBefore, balanceAfter },
            description: `Side fund direct/batch inflow recorded: ${referenceCode} — ${inflowAmount}`,
            client,
        });

        sendCreated(res, {
            reference:      referenceCode,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
            new_side_fund_balance: parseFloat(config.current_balance) + inflowAmount,
        }, `Side fund direct inflow recorded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// GET SIDE FUND EXPENSES
// GET /api/side-fund/expenses
// ============================================================
const getSideFundExpenses = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);

    const countResult = await query('SELECT COUNT(*) AS total FROM side_fund_expenses');
    const total = parseInt(countResult.rows[0].total);

    const result = await query(`
        SELECT
            sfe.*, r.reference_code,
            rec.first_name || ' ' || rec.last_name AS recorded_by_name,
            t.category_id, cat.name AS category_name
        FROM   side_fund_expenses sfe
        JOIN   references_registry r ON r.id = sfe.reference_id
        JOIN   users rec ON rec.id = sfe.recorded_by
        JOIN   transactions t ON t.id = sfe.transaction_id
        LEFT JOIN categories cat ON cat.id = t.category_id
        ORDER BY sfe.created_at DESC
        LIMIT $1 OFFSET $2
    `, [limit, offset]);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// RECORD A SIDE FUND EXPENSE — Treasurer / Assistant Treasurer
// POST /api/side-fund/expenses
// Posts a completely normal EXPENSE transaction against the parent
// account (shows up in the general Transactions ledger exactly like
// any other expense) and decrements the envelope balance by the
// same amount.
// ============================================================
const recordSideFundExpense = asyncHandler(async (req, res) => {
    const { amount, category_id, description, expense_date } = req.body;

    await withTransaction(async (client) => {
        const config = await getConfigForUpdate(client);
        if (!config.is_active) {
            throw createError.badRequest('The side fund is not currently active');
        }
        if (!config.parent_account_id) {
            throw createError.badRequest('The side fund has no parent account configured');
        }

        const expenseAmount = parseFloat(amount);
        if (expenseAmount > parseFloat(config.current_balance)) {
            throw createError.badRequest(
                `This would overdraw the side fund. Available: ${config.current_balance}.`
            );
        }

        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [config.parent_account_id]
        );
        const parentAccount = account.rows[0];

        const { referenceId, referenceCode } = await generateReference(
            client, resolveModuleCode(parentAccount), 'EXPENSE', 'TRANSACTION', req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       config.parent_account_id,
            transactionType: 'DEBIT',
            inflowType:      'EXPENSE',
            amount:          expenseAmount,
            currencyId:      parentAccount.currency_id,
            categoryId:      category_id,
            description,
            valueDate:       expense_date,
            createdBy:       req.user.id,
            referenceId,
        });
        await linkReferenceToRecord(client, referenceId, transactionId);

        const expenseResult = await client.query(`
            INSERT INTO side_fund_expenses (
                reference_id, transaction_id, amount, description, expense_date, recorded_by
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `, [referenceId, transactionId, expenseAmount, description, expense_date, req.user.id]);

        await client.query(`
            UPDATE side_fund_config
            SET    current_balance = current_balance - $1, updated_at = NOW()
            WHERE  id = 1
        `, [expenseAmount]);

        await logAction(req.user.id, ACTIONS.SIDE_FUND_EXPENSE_RECORDED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'side_fund_expenses',
            recordId:    expenseResult.rows[0].id,
            newValues:   { referenceCode, amount: expenseAmount, balanceBefore, balanceAfter },
            description: `Side fund expense recorded: ${referenceCode} — ${description}: ${expenseAmount}`,
            client,
        });

        sendCreated(res, {
            expense_id:     expenseResult.rows[0].id,
            reference:      referenceCode,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Side fund expense recorded. Reference: ${referenceCode}`);
    });
});

module.exports = {
    getSideFundConfig,
    updateSideFundConfig,
    getMyDues,
    getAllDues,
    recordDuePayment,
    recordDirectInflow,
    getSideFundExpenses,
    recordSideFundExpense,
};
