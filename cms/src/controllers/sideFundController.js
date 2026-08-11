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
const { applySideFundPayment } = require('../services/sideFundService');

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
// ============================================================
// RECORD A DUE PAYMENT — Treasurer / Assistant Treasurer
// PATCH /api/side-fund/dues/:id/pay
// This is what actually moves the money: posts ONE CREDIT transaction
// on the parent account for the FULL amount paid, and grows the
// envelope balance by that same amount.
//
// v1.25.0 — overpayment is no longer rejected. The amount first
// settles the targeted due (up to its outstanding balance); any
// leftover then cascades to this member's OTHER outstanding dues,
// oldest period first — including past PENDING/PARTIAL/DEFAULTED
// ones, clearing arrears before ever getting to "the future". If
// there's still money left after every existing outstanding due is
// cleared, it's banked as a running credit (side_fund_member_credit)
// which the monthly due-generation job automatically draws down
// against each new due as it's created — this is what "the balance
// is distributed to cater for the following months" means in
// practice, since a future month's due doesn't exist as a row yet
// for it to be applied to directly.
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

        // The due row clicked in the UI just tells us WHO is paying —
        // v1.26.0 always applies the payment oldest-unpaid-period-first
        // across that member's whole side fund standing (see
        // services/sideFundService.js), not only to this one row, for
        // the same reason an overpayment already cascaded that way.
        const dueResult = await client.query(`
            SELECT sfd.user_id, sfd.period, u.first_name, u.last_name, u.email
            FROM   side_fund_dues sfd
            JOIN   users u ON u.id = sfd.user_id
            WHERE  sfd.id = $1
        `, [id]);
        if (dueResult.rows.length === 0) {
            throw createError.notFound('Side fund due not found');
        }
        const due = dueResult.rows[0];

        let payAmount = parseFloat(amount);
        if (payAmount <= 0) {
            throw createError.badRequest('Payment amount must be greater than zero');
        }

        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [config.parent_account_id]
        );
        const parentAccount = account.rows[0];

        const { referenceId, referenceCode } = await generateReference(
            client, resolveModuleCode(parentAccount), 'SF-IN', 'TRANSACTION', req.user.id
        );

        const effectivePaidDate = paid_date || new Date().toISOString().split('T')[0];

        // One transaction for the whole amount, however many dues it
        // ends up settling.
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       config.parent_account_id,
            transactionType: 'CREDIT',
            inflowType:      'SIDE_FUND_CONTRIBUTION_IN',
            amount:          payAmount,
            currencyId:      parentAccount.currency_id,
            categoryId:      category_id,
            description:     `Side fund contribution — ${due.first_name} ${due.last_name} (${due.period})${notes ? ` — ${notes}` : ''}`,
            valueDate:       effectivePaidDate,
            createdBy:       req.user.id,
            referenceId,
        });
        await linkReferenceToRecord(client, referenceId, transactionId);

        const { settled, creditBanked } = await applySideFundPayment(client, {
            userId:       due.user_id,
            amount:       payAmount,
            transactionId,
            referenceCode,
            paidDate:     effectivePaidDate,
            recordedBy:   req.user.id,
        });

        await client.query(`
            UPDATE side_fund_config
            SET    current_balance = current_balance + $1, updated_at = NOW()
            WHERE  id = 1
        `, [payAmount]);

        await logAction(req.user.id, ACTIONS.SIDE_FUND_DUE_PAID, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'side_fund_dues',
            recordId:    parseInt(id),
            newValues:   { referenceCode, amount: payAmount, settled, creditBanked, balanceBefore, balanceAfter },
            description: `Side fund payment recorded: ${due.first_name} ${due.last_name} — ${payAmount} (${referenceCode})` +
                (settled.length > 1 ? `, settling ${settled.length} dues` : '') +
                (creditBanked > 0 ? `, ${creditBanked} banked as credit` : ''),
            client,
        });

        notify({
            userId:     due.user_id,
            type:       'SIDE_FUND_DUE_PAID',
            title:      'Side fund contribution recorded',
            body:       `Your side fund payment of ${payAmount} was recorded (reference ${referenceCode}).` +
                (settled.length > 1 ? ` It settled ${settled.length} months' dues.` : '') +
                (creditBanked > 0 ? ` ${creditBanked} was banked as credit toward future months.` : ''),
            link:       `/side-fund`,
            module:     'FINANCE',
            recordType: 'side_fund_dues',
            recordId:   parseInt(id),
        });

        sendSuccess(res, {
            reference:       referenceCode,
            settled,
            credit_banked:   creditBanked,
            balance_before:  balanceBefore,
            balance_after:   balanceAfter,
        }, `Side fund payment of ${payAmount} recorded. Reference: ${referenceCode}` +
            (settled.length > 1 ? ` — settled ${settled.length} months' dues` : '') +
            (creditBanked > 0 ? ` — ${creditBanked} banked as credit` : ''));
    });
});

// ============================================================
// BULK PAY-ALL-DUES — Treasurer / Assistant Treasurer (v1.26.0)
// PATCH /api/side-fund/dues/bulk-pay
// For the common case where most/all members paid their monthly due
// on time: one pooled ledger transaction (the treasurer collecting
// or banking several members' cash/mobile-money at once), applied
// per member via the same oldest-first cascade every other payment
// path uses — so the ONE deposit event is what shows in the account
// ledger, while side_fund_dues/side_fund_credit_ledger still track
// every member's own contribution individually. Body:
// { category_id, paid_date, payments: [{ user_id, amount }, ...] }
// ============================================================
const bulkPayDues = asyncHandler(async (req, res) => {
    const { category_id, paid_date, payments } = req.body;

    if (!Array.isArray(payments) || payments.length === 0) {
        throw createError.badRequest('At least one member payment is required');
    }

    await withTransaction(async (client) => {
        const config = await getConfigForUpdate(client);
        if (!config.is_active) {
            throw createError.badRequest('The side fund is not currently active');
        }
        if (!config.parent_account_id) {
            throw createError.badRequest('The side fund has no parent account configured');
        }

        const totalAmount = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
        if (totalAmount <= 0) {
            throw createError.badRequest('The total batch amount must be greater than zero');
        }

        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [config.parent_account_id]
        );
        const parentAccount = account.rows[0];

        const { referenceId, referenceCode } = await generateReference(
            client, resolveModuleCode(parentAccount), 'SF-BULK', 'TRANSACTION', req.user.id
        );

        const effectivePaidDate = paid_date || new Date().toISOString().split('T')[0];

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       config.parent_account_id,
            transactionType: 'CREDIT',
            inflowType:      'SIDE_FUND_CONTRIBUTION_IN',
            amount:          totalAmount,
            currencyId:      parentAccount.currency_id,
            categoryId:      category_id,
            description:     `Bulk side fund payment — ${payments.length} member(s)`,
            valueDate:       effectivePaidDate,
            createdBy:       req.user.id,
            referenceId,
        });
        await linkReferenceToRecord(client, referenceId, transactionId);

        const results = [];
        for (const p of payments) {
            const payAmount = parseFloat(p.amount || 0);
            if (payAmount <= 0) continue;
            const { settled, creditBanked } = await applySideFundPayment(client, {
                userId:       parseInt(p.user_id),
                amount:       payAmount,
                transactionId,
                referenceCode,
                paidDate:     effectivePaidDate,
                recordedBy:   req.user.id,
            });
            results.push({ user_id: parseInt(p.user_id), amount: payAmount, settled, credit_banked: creditBanked });

            notify({
                userId:     parseInt(p.user_id),
                type:       'SIDE_FUND_DUE_PAID',
                title:      'Side fund contribution recorded',
                body:       `Your side fund payment of ${payAmount} was recorded (reference ${referenceCode}).` +
                    (settled.length > 1 ? ` It settled ${settled.length} months' dues.` : '') +
                    (creditBanked > 0 ? ` ${creditBanked} was banked as credit toward future months.` : ''),
                link:       `/side-fund`,
                module:     'FINANCE',
                recordType: 'side_fund_dues',
                recordId:   settled.length > 0 ? settled[0].due_id : null,
            });
        }

        await client.query(`
            UPDATE side_fund_config
            SET    current_balance = current_balance + $1, updated_at = NOW()
            WHERE  id = 1
        `, [totalAmount]);

        await logAction(req.user.id, ACTIONS.SIDE_FUND_BULK_PAYMENT_RECORDED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'side_fund_dues',
            newValues:   { referenceCode, totalAmount, memberCount: results.length, balanceBefore, balanceAfter },
            description: `Bulk side fund payment recorded: ${referenceCode} — ${results.length} member(s), ${totalAmount}`,
            client,
        });

        sendSuccess(res, {
            reference:      referenceCode,
            total_amount:   totalAmount,
            results,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Bulk side fund payment recorded — ${results.length} member(s), ${totalAmount}. Reference: ${referenceCode}`);
    });
});

// ============================================================
// OVERDUE SUMMARY (v1.26.0)
// The side fund is a flat monthly amount from whichever month a
// member started being tracked up to the current one — a due's
// due_date is always the last day of its own period's month, so
// "overdue" means DEFAULTED, or still unpaid past that date.
// ============================================================
const getMyOverdueSummary = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT COUNT(*) AS overdue_count,
               COALESCE(SUM(amount_due - amount_paid), 0) AS overdue_amount
        FROM   side_fund_dues
        WHERE  user_id = $1
        AND    (status = 'DEFAULTED' OR (status IN ('PENDING', 'PARTIAL') AND due_date < CURRENT_DATE))
    `, [req.user.id]);
    const row = result.rows[0];
    sendSuccess(res, {
        overdue_count:  parseInt(row.overdue_count),
        overdue_amount: parseFloat(row.overdue_amount),
    });
});

// GET /api/side-fund/overdue — Treasurer/Admin, every member with an
// overdue balance right now.
const getAllOverdueSummary = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT sfd.user_id,
               u.first_name || ' ' || u.last_name AS member_name,
               COUNT(*) AS overdue_count,
               SUM(sfd.amount_due - sfd.amount_paid) AS overdue_amount
        FROM   side_fund_dues sfd
        JOIN   users u ON u.id = sfd.user_id
        WHERE  sfd.status = 'DEFAULTED'
               OR (sfd.status IN ('PENDING', 'PARTIAL') AND sfd.due_date < CURRENT_DATE)
        GROUP  BY sfd.user_id, u.first_name, u.last_name
        HAVING SUM(sfd.amount_due - sfd.amount_paid) > 0
        ORDER  BY overdue_amount DESC
    `);
    sendSuccess(res, result.rows.map(r => ({
        user_id:        r.user_id,
        member_name:    r.member_name,
        overdue_count:  parseInt(r.overdue_count),
        overdue_amount: parseFloat(r.overdue_amount),
    })));
});

// ============================================================
// GET MEMBER OVERRIDES — Treasurer/Admin (v1.25.0)
// GET /api/side-fund/overrides
// Every active shareholder alongside their custom monthly amount, if
// any — no row for a member means they're on the company default.
// ============================================================
const getMemberOverrides = asyncHandler(async (req, res) => {
    // Starts from every active shareholder (not from the overrides table)
    // so members without a custom amount still show up — with
    // monthly_amount = null, meaning "on the company default".
    const result = await query(`
        SELECT u.id AS user_id,
               u.first_name || ' ' || u.last_name AS member_name,
               smo.monthly_amount, smo.set_at,
               setter.first_name || ' ' || setter.last_name AS set_by_name
        FROM   users u
        JOIN   shareholding_registry sr ON sr.user_id = u.id AND sr.effective_to IS NULL
        LEFT JOIN side_fund_member_overrides smo ON smo.user_id = u.id
        LEFT JOIN users setter ON setter.id = smo.set_by
        WHERE  u.is_active = TRUE
        ORDER  BY u.first_name, u.last_name
    `);
    sendSuccess(res, result.rows);
});

// ============================================================
// SET A MEMBER'S OVERRIDE AMOUNT — Treasurer/Admin (v1.25.0)
// PUT /api/side-fund/overrides/:userId
// Body: { monthly_amount }. Only affects dues generated AFTER this
// is set — same "changes are forward-only" rule as the company-wide
// default (side_fund_config.monthly_amount).
// ============================================================
const setMemberOverride = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { monthly_amount } = req.body;

    const userResult = await query('SELECT id, first_name, last_name FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
        throw createError.notFound('Member not found');
    }
    const member = userResult.rows[0];

    const result = await query(`
        INSERT INTO side_fund_member_overrides (user_id, monthly_amount, set_by, set_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET monthly_amount = $2, set_by = $3, set_at = NOW()
        RETURNING *
    `, [userId, monthly_amount, req.user.id]);

    await logAction(req.user.id, ACTIONS.SIDE_FUND_MEMBER_OVERRIDE_SET, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'side_fund_member_overrides',
        recordId:    parseInt(userId),
        newValues:   result.rows[0],
        description: `Side fund monthly amount override set for ${member.first_name} ${member.last_name}: ${monthly_amount}`,
    });

    sendSuccess(res, result.rows[0], 'Override saved — takes effect for dues generated from now on');
});

// ============================================================
// CLEAR A MEMBER'S OVERRIDE — Treasurer/Admin (v1.25.0)
// DELETE /api/side-fund/overrides/:userId
// Back to the company-wide default for dues generated from now on.
// ============================================================
const clearMemberOverride = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const result = await query('DELETE FROM side_fund_member_overrides WHERE user_id = $1 RETURNING user_id', [userId]);
    if (result.rows.length === 0) {
        throw createError.notFound('This member has no override set');
    }

    await logAction(req.user.id, ACTIONS.SIDE_FUND_MEMBER_OVERRIDE_CLEARED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'side_fund_member_overrides',
        recordId:    parseInt(userId),
        description: `Side fund monthly amount override cleared for user ${userId} — back to company default`,
    });

    sendSuccess(res, { user_id: parseInt(userId) }, 'Override cleared — back to the company default');
});

// ============================================================
// GET MY CREDIT BALANCE (v1.25.0)
// GET /api/side-fund/credit/me
// ============================================================
const getMyCredit = asyncHandler(async (req, res) => {
    const result = await query(
        'SELECT credit_balance, updated_at FROM side_fund_member_credit WHERE user_id = $1',
        [req.user.id]
    );
    sendSuccess(res, result.rows[0] || { credit_balance: 0, updated_at: null });
});

// ============================================================
// GET ALL MEMBERS' CREDIT BALANCES — Treasurer/Admin (v1.25.0)
// GET /api/side-fund/credit
// ============================================================
const getAllCredit = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT smc.user_id, smc.credit_balance, smc.updated_at,
               u.first_name || ' ' || u.last_name AS member_name
        FROM   side_fund_member_credit smc
        JOIN   users u ON u.id = smc.user_id
        WHERE  smc.credit_balance > 0
        ORDER  BY u.first_name, u.last_name
    `);
    sendSuccess(res, result.rows);
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
    bulkPayDues,
    getMyOverdueSummary,
    getAllOverdueSummary,
    getSideFundExpenses,
    recordSideFundExpense,
    getMemberOverrides,
    setMemberOverride,
    clearMemberOverride,
    getMyCredit,
    getAllCredit,
};
