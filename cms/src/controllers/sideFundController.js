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
const { applySideFundPayment, generateDuesForPeriod, backfillDuesFromPeriod } = require('../services/sideFundService');
const { getSavingsAccount, getOrCreateSavingsBalance } = require('../services/savingsService');
const { createPaymentAcknowledgement } = require('./paymentAcknowledgementsController');

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
    // v1.32.0 — the tx_* columns carry the linked transaction's own
    // details (reference, account, balances) so the frontend can
    // preview/print each paid due as a proper transaction statement
    // (transactionTemplate) without a separate round-trip to
    // GET /transactions/:id, which this member may not have
    // FINANCE_VIEW_ALL to call. NULL on any due that hasn't been
    // paid yet (no transaction_id) — the frontend simply omits the
    // preview button for those rows.
    const result = await query(`
        SELECT sfd.*, r.first_name || ' ' || r.last_name AS recorded_by_name,
               rr.reference_code   AS tx_reference_code,
               t.description       AS tx_description,
               t.value_date        AS tx_value_date,
               t.transaction_type  AS tx_transaction_type,
               t.amount            AS tx_amount,
               cur.code            AS tx_currency_code,
               acc.name            AS tx_account_name,
               cat.name            AS tx_category_name,
               t.balance_before    AS tx_balance_before,
               t.balance_after     AS tx_balance_after
        FROM   side_fund_dues sfd
        LEFT JOIN users r ON r.id = sfd.recorded_by
        LEFT JOIN transactions t         ON t.id = sfd.transaction_id
        LEFT JOIN references_registry rr ON rr.id = t.reference_id
        LEFT JOIN accounts acc           ON acc.id = t.account_id
        LEFT JOIN currencies cur         ON cur.id = t.currency_id
        LEFT JOIN categories cat         ON cat.id = t.category_id
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
// GENERATE DUES NOW — Treasurer/Admin (SIDE_FUND_MANAGE) (v1.28.3)
// POST /api/side-fund/dues/generate
// Runs the exact same pipeline the monthly cron job runs (jobs/
// scheduler.js's scheduleSideFundDueGeneration, 00:15 on the 1st) —
// creates one PENDING due per active shareholder for the given
// period, defaulting to the current month. Exists for the gap that
// pure-cron generation leaves open: if the fund was only just
// activated, or the backend was freshly deployed, after the 1st of
// the month had already passed, no automatic run ever happens for
// that month, and Bulk Pay Dues has nothing to show ("No outstanding
// dues") even though members genuinely owe one. Also useful when a
// shareholder joins partway through a month. Safe to run more than
// once for the same period — existing due rows are never touched or
// duplicated (see generateDuesForPeriod's ON CONFLICT DO NOTHING).
// ============================================================
const generateDues = asyncHandler(async (req, res) => {
    const now = new Date();
    const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const period = req.body.period || defaultPeriod;

    const result = await generateDuesForPeriod(period);

    if (result.skipped) {
        throw createError.badRequest(result.reason);
    }

    await logAction(req.user.id, ACTIONS.SIDE_FUND_DUES_GENERATED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'side_fund_dues',
        newValues:   { period, ...result },
        description: `Side fund dues generated for ${period}: ${result.created}/${result.total} member(s)` +
            (result.total > result.created ? ` (${result.total - result.created} already existed)` : ''),
    });

    sendSuccess(res, { period, ...result },
        result.total === 0
            ? `No active shareholders found to generate dues for ${period}`
            : `Generated ${result.created} due(s) for ${period}` +
              (result.total > result.created ? ` — ${result.total - result.created} already existed` : ''));
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

    const userResult = await query('SELECT id, first_name, last_name FROM users WHERE id = $1 AND is_active = TRUE', [userId]);
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

// ============================================================
// SIDE FUND MEMBERSHIP CHECKLIST (v1.32.0, Section 4.10)
// Not every member subscribes to the side fund — this checklist is
// the actual eligibility gate generateDuesForPeriod reads from. Being
// "in" means: (a) monthly dues are generated for you from your own
// start_period onward, and (b) you're eligible for a settlement
// payout if/when you're later taken back "out". Eligible candidates
// are everyone holding the Shareholder role (same eligibility rule
// GET /users/shareholders uses, v1.27.3) — a member doesn't need any
// contribution history to be added.
// ============================================================

// ============================================================
// GET THE CHECKLIST — Treasurer/Admin (SIDE_FUND_VIEW)
// GET /api/side-fund/members
// Every active Shareholder, whether or not they've ever been added,
// alongside their current in/out status and (if in) how much they
// currently owe, so the treasurer can see coverage/overdue standing
// right here without switching to the dues history.
// ============================================================
const getMembershipChecklist = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            u.id AS user_id,
            u.first_name || ' ' || u.last_name AS member_name,
            u.email,
            COALESCE(sm.is_in, FALSE) AS is_in,
            sm.start_period,
            sm.added_at,
            sm.removed_at,
            adder.first_name || ' ' || adder.last_name AS added_by_name,
            COALESCE(od.overdue_count, 0)  AS overdue_count,
            COALESCE(od.overdue_amount, 0) AS overdue_amount
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id AND r.name = 'Shareholder' AND r.is_active = TRUE
        LEFT JOIN side_fund_members sm ON sm.user_id = u.id
        LEFT JOIN users adder ON adder.id = sm.added_by
        LEFT JOIN (
            SELECT user_id,
                   COUNT(*) AS overdue_count,
                   SUM(amount_due - amount_paid) AS overdue_amount
            FROM   side_fund_dues
            WHERE  status = 'DEFAULTED' OR (status IN ('PENDING', 'PARTIAL') AND due_date < CURRENT_DATE)
            GROUP  BY user_id
        ) od ON od.user_id = u.id
        WHERE  u.is_active = TRUE
        ORDER  BY u.first_name, u.last_name
    `);
    sendSuccess(res, result.rows.map(r => ({
        ...r,
        overdue_count:  parseInt(r.overdue_count),
        overdue_amount: parseFloat(r.overdue_amount),
    })));
});

// ============================================================
// ADD (OR RE-ADD) A MEMBER — Treasurer/Admin (SIDE_FUND_MANAGE)
// POST /api/side-fund/members/:userId
// Body: { start_period } — 'YYYY-MM', can be in the past. If it is,
// PENDING dues are immediately backfilled for every month from then
// to the current one, so overdue reflects the true historical
// obligation from day one instead of only whatever accrues from the
// next cron run. Re-adding a member who previously left starts a
// brand-new cycle — their prior side_fund_dues history stays exactly
// as it was (already settled by that earlier exit payout, if any),
// and the new start_period becomes the floor the NEXT time they leave.
// ============================================================
const addMember = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { start_period } = req.body;

    if (!start_period || !/^\d{4}-\d{2}$/.test(start_period)) {
        throw createError.badRequest('start_period is required and must be in YYYY-MM format');
    }

    const userResult = await query(
        'SELECT id, first_name, last_name FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (userResult.rows.length === 0) {
        throw createError.notFound('Member not found');
    }
    const member = userResult.rows[0];

    const result = await query(`
        INSERT INTO side_fund_members (user_id, is_in, start_period, added_by, added_at, removed_by, removed_at, updated_at)
        VALUES ($1, TRUE, $2, $3, NOW(), NULL, NULL, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET is_in = TRUE, start_period = $2, added_by = $3, added_at = NOW(),
            removed_by = NULL, removed_at = NULL, updated_at = NOW()
        RETURNING *
    `, [userId, start_period, req.user.id]);

    await query(`
        INSERT INTO side_fund_membership_events (user_id, event_type, start_period, performed_by)
        VALUES ($1, 'JOINED', $2, $3)
    `, [userId, start_period, req.user.id]);

    await logAction(req.user.id, ACTIONS.SIDE_FUND_MEMBER_ADDED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'side_fund_members',
        recordId:    parseInt(userId),
        newValues:   result.rows[0],
        description: `${member.first_name} ${member.last_name} added to the side fund, starting ${start_period}`,
    });

    notify({
        userId:     parseInt(userId),
        type:       'SIDE_FUND_MEMBER_ADDED',
        title:      'Added to the side fund',
        body:       `You've been added to the side fund, starting ${start_period}.`,
        link:       '/side-fund',
        module:     'FINANCE',
        recordType: 'side_fund_members',
        recordId:   parseInt(userId),
    });

    // Runs AFTER the checklist row is committed, so generateDuesForPeriod
    // (which reads side_fund_members fresh on every call) already sees
    // this member as eligible for every period it processes.
    const backfill = await backfillDuesFromPeriod(start_period);
    const duesCreated = backfill.reduce((sum, r) => sum + (r.created || 0), 0);

    sendSuccess(res, { ...result.rows[0], dues_backfilled: duesCreated },
        `${member.first_name} ${member.last_name} added to the side fund, starting ${start_period}` +
        (duesCreated > 0 ? ` — ${duesCreated} month(s) of dues generated` : ''));
});

// ============================================================
// INTERNAL HELPER — compute a member's exit-payout breakdown.
// `runner` is either `query` (top-level, read-only preview) or
// `client.query.bind(client)` (inside the real removal transaction,
// after the relevant rows are locked FOR UPDATE) — same formula
// either way, so the preview a Treasurer sees before confirming can
// never drift from what actually gets paid out.
//
// payout = (this member's own side_fund_dues.amount_paid, summed over
//           every period >= their CURRENT start_period — i.e. this
//           membership cycle only, so a past cycle already settled by
//           an earlier exit payout is never counted twice)
//        + (any side_fund_member_credit still banked)
//        - (all-time side_fund_expenses, split evenly across every
//           member currently marked is_in = TRUE, INCLUDING the one
//           leaving)
// floored at zero — a member is never asked to pay money back through
// this mechanism; they simply receive nothing if their expense share
// exceeds what they've paid in.
// ============================================================
const computeExitPayout = async (runner, userId) => {
    const memberResult = await runner('SELECT * FROM side_fund_members WHERE user_id = $1', [userId]);
    const member = memberResult.rows[0];
    if (!member || !member.is_in) {
        throw createError.badRequest('This member is not currently in the side fund');
    }

    const duesResult = await runner(`
        SELECT COALESCE(SUM(amount_paid), 0) AS total
        FROM   side_fund_dues
        WHERE  user_id = $1 AND period >= $2
    `, [userId, member.start_period]);
    const duesPaid = parseFloat(duesResult.rows[0].total);

    const creditResult = await runner(
        'SELECT credit_balance FROM side_fund_member_credit WHERE user_id = $1', [userId]
    );
    const bankedCredit = parseFloat(creditResult.rows[0]?.credit_balance || 0);

    const countResult = await runner('SELECT COUNT(*) AS c FROM side_fund_members WHERE is_in = TRUE');
    const memberCount = parseInt(countResult.rows[0].c);

    const expenseResult = await runner('SELECT COALESCE(SUM(amount), 0) AS total FROM side_fund_expenses');
    const totalExpenses = parseFloat(expenseResult.rows[0].total);

    const expenseShare = memberCount > 0 ? parseFloat((totalExpenses / memberCount).toFixed(4)) : 0;
    const rawPayout = duesPaid + bankedCredit - expenseShare;
    const payoutAmount = Math.max(0, parseFloat(rawPayout.toFixed(4)));

    return { member, duesPaid, bankedCredit, memberCount, totalExpenses, expenseShare, payoutAmount };
};

// ============================================================
// EXIT PAYOUT PREVIEW — Treasurer/Admin (SIDE_FUND_MANAGE)
// GET /api/side-fund/members/:userId/payout-preview
// Read-only — shows exactly what removing this member right now would
// pay out, before it's confirmed. Uses the identical computeExitPayout()
// the real removal below calls, so the preview can never disagree with
// the actual result.
// ============================================================
const getExitPayoutPreview = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const breakdown = await computeExitPayout(query, userId);
    const userResult = await query('SELECT first_name, last_name FROM users WHERE id = $1', [userId]);
    sendSuccess(res, {
        user_id:        parseInt(userId),
        member_name:    userResult.rows[0] ? `${userResult.rows[0].first_name} ${userResult.rows[0].last_name}` : null,
        start_period:   breakdown.member.start_period,
        dues_paid:      breakdown.duesPaid,
        banked_credit:  breakdown.bankedCredit,
        member_count:   breakdown.memberCount,
        total_expenses: breakdown.totalExpenses,
        expense_share:  breakdown.expenseShare,
        payout_amount:  breakdown.payoutAmount,
    });
});

// ============================================================
// REMOVE A MEMBER — settles and pays out — Treasurer/Admin (SIDE_FUND_MANAGE)
// PATCH /api/side-fund/members/:userId/remove
// Computes the exit payout (computeExitPayout above) and, if positive,
// transfers it straight into the member's own Savings balance: a
// normal two-leg posting (DEBIT the side fund's parent account with
// inflow_type SIDE_FUND_PAYOUT_OUT, CREDIT the Savings account) —
// exactly the same shape as a Dividend approval. A Payment
// Acknowledgement (source_type SIDE_FUND_PAYOUT) is then created for
// the two-party sign-off, the same paper-trail pattern as every other
// money-paid-OUT-to-an-individual flow in this system. If the payout
// is zero, no transaction or acknowledgement is created — the member
// is simply taken off the checklist. Body: { category_id,
// exchange_rate } — exchange_rate only required if the side fund's
// parent account and the Savings account are in different currencies
// (same "display-only conversion is never used for real money" rule
// as Dividends/Transfers).
// ============================================================
const removeMember = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { category_id, exchange_rate } = req.body;

    await withTransaction(async (client) => {
        const config = await getConfigForUpdate(client);
        if (!config.is_active) {
            throw createError.badRequest('The side fund is not currently active');
        }
        if (!config.parent_account_id) {
            throw createError.badRequest('The side fund has no parent account configured');
        }

        await client.query('SELECT * FROM side_fund_members WHERE user_id = $1 FOR UPDATE', [userId]);
        await client.query(
            'SELECT credit_balance FROM side_fund_member_credit WHERE user_id = $1 FOR UPDATE', [userId]
        );

        const breakdown = await computeExitPayout(client.query.bind(client), userId);
        const { duesPaid, bankedCredit, memberCount, totalExpenses, expenseShare, payoutAmount } = breakdown;

        const userResult = await client.query(
            'SELECT first_name, last_name FROM users WHERE id = $1', [userId]
        );
        const memberUser = userResult.rows[0];

        // The REMOVED event row is created up front — its breakdown
        // fields are already fully known — so a Payment Acknowledgement
        // created below (if any) has a real event id to point its
        // source_id at, no placeholder/backfill needed.
        const eventResult = await client.query(`
            INSERT INTO side_fund_membership_events (
                user_id, event_type, dues_paid, credit_applied, member_count,
                total_expenses, expense_share, payout_amount, performed_by
            ) VALUES ($1, 'REMOVED', $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [userId, duesPaid, bankedCredit, memberCount, totalExpenses, expenseShare, payoutAmount, req.user.id]);
        const eventId = eventResult.rows[0].id;

        let paymentAckId = null;
        let creditRefCode = null;
        let savingsTotal = 0;

        if (payoutAmount > 0) {
            const parentAccountResult = await client.query(
                'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
                [config.parent_account_id]
            );
            const parentAccount = parentAccountResult.rows[0];

            const savingsAccount = await getSavingsAccount(client);

            const sameCurrency = parentAccount.currency_id === savingsAccount.currency_id;
            let effectiveRate = 1;
            if (!sameCurrency) {
                if (!exchange_rate) {
                    throw createError.badRequest(
                        'The side fund and Savings accounts are in different currencies — an exchange rate is required.'
                    );
                }
                effectiveRate = parseFloat(exchange_rate);
            }

            const today = new Date().toISOString().split('T')[0];

            // ---- Leg 1: debit the side fund's parent account ----
            const { referenceId: debitRefId, referenceCode: debitRefCode } = await generateReference(
                client, resolveModuleCode(parentAccount), 'SF-OUT', 'TRANSACTION', req.user.id
            );
            const debitPosting = await postTransaction(client, {
                accountId:       config.parent_account_id,
                transactionType: 'DEBIT',
                inflowType:      'SIDE_FUND_PAYOUT_OUT',
                amount:          payoutAmount,
                currencyId:      parentAccount.currency_id,
                categoryId:      category_id,
                description:     `Side fund exit payout — ${memberUser.first_name} ${memberUser.last_name}`,
                valueDate:       today,
                createdBy:       req.user.id,
                referenceId:     debitRefId,
            });
            await linkReferenceToRecord(client, debitRefId, debitPosting.transactionId);

            await client.query(`
                UPDATE side_fund_config
                SET    current_balance = current_balance - $1, updated_at = NOW()
                WHERE  id = 1
            `, [payoutAmount]);

            // ---- Leg 2: credit the member's Savings balance ----
            savingsTotal = parseFloat((payoutAmount * effectiveRate).toFixed(4));

            const { referenceId: creditRefId, referenceCode: creditRefCodeGenerated } = await generateReference(
                client, resolveModuleCode(savingsAccount), 'SFSAV', 'TRANSACTION', req.user.id
            );
            creditRefCode = creditRefCodeGenerated;
            const creditPosting = await postTransaction(client, {
                accountId:       savingsAccount.id,
                transactionType: 'CREDIT',
                inflowType:      'SAVINGS_DEPOSIT_IN',
                amount:          savingsTotal,
                currencyId:      savingsAccount.currency_id,
                categoryId:      category_id,
                description:     `Side fund exit payout credited to savings — ${memberUser.first_name} ${memberUser.last_name}`,
                valueDate:       today,
                createdBy:       req.user.id,
                referenceId:     creditRefId,
            });
            await linkReferenceToRecord(client, creditRefId, creditPosting.transactionId);

            await getOrCreateSavingsBalance(client, userId, savingsAccount.currency_id);
            await client.query(`
                UPDATE savings_balances
                SET    principal_balance = principal_balance + $1,
                       currency_id = COALESCE(currency_id, $2),
                       updated_at = NOW()
                WHERE  user_id = $3
            `, [savingsTotal, savingsAccount.currency_id, userId]);

            const ack = await createPaymentAcknowledgement(client, {
                sourceType:    'SIDE_FUND_PAYOUT',
                sourceId:      eventId,
                transactionId: creditPosting.transactionId,
                payerId:       req.user.id,
                recipientId:   parseInt(userId),
                amount:        savingsTotal,
                currencyId:    savingsAccount.currency_id,
                purpose:       `Side fund exit payout — ${debitRefCode}`,
            });
            paymentAckId = ack.id;

            await client.query(
                'UPDATE side_fund_membership_events SET payment_ack_id = $1 WHERE id = $2',
                [paymentAckId, eventId]
            );
        }

        // Zero out any remaining banked credit — it's already folded
        // into payoutAmount above, so it can't be left sitting there to
        // be drawn down against a due that will now never exist.
        if (bankedCredit > 0) {
            await client.query(`
                UPDATE side_fund_member_credit
                SET    credit_balance = 0, updated_at = NOW()
                WHERE  user_id = $1
            `, [userId]);
            await client.query(`
                INSERT INTO side_fund_credit_ledger (user_id, delta, reason)
                VALUES ($1, $2, $3)
            `, [userId, -bankedCredit, 'Rolled into exit payout — member removed from the side fund']);
        }

        await client.query(`
            UPDATE side_fund_members
            SET    is_in = FALSE, removed_by = $1, removed_at = NOW(), updated_at = NOW()
            WHERE  user_id = $2
        `, [req.user.id, userId]);

        await logAction(req.user.id, ACTIONS.SIDE_FUND_MEMBER_REMOVED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'side_fund_members',
            recordId:    parseInt(userId),
            newValues:   { duesPaid, bankedCredit, memberCount, totalExpenses, expenseShare, payoutAmount, creditRefCode },
            description: `${memberUser.first_name} ${memberUser.last_name} removed from the side fund` +
                (payoutAmount > 0 ? ` — ${payoutAmount} paid out to savings (${creditRefCode})` : ' — no payout was due'),
            client,
        });

        notify({
            userId:     parseInt(userId),
            type:       'SIDE_FUND_MEMBER_REMOVED',
            title:      'Removed from the side fund',
            body:       payoutAmount > 0
                ? `You've been taken off the side fund. ${savingsTotal} was credited to your savings — please review and acknowledge it.`
                : `You've been taken off the side fund. No settlement amount was due.`,
            link:       '/side-fund',
            module:     'FINANCE',
            recordType: 'side_fund_members',
            recordId:   parseInt(userId),
        });

        sendSuccess(res, {
            user_id:        parseInt(userId),
            dues_paid:      duesPaid,
            banked_credit:  bankedCredit,
            member_count:   memberCount,
            total_expenses: totalExpenses,
            expense_share:  expenseShare,
            payout_amount:  payoutAmount,
            payment_ack_id: paymentAckId,
        }, `${memberUser.first_name} ${memberUser.last_name} removed from the side fund` +
            (payoutAmount > 0 ? ` — ${payoutAmount} paid out to savings, pending acknowledgement` : ' — no payout was due'));
    });
});

module.exports = {
    getSideFundConfig,
    updateSideFundConfig,
    getMyDues,
    getAllDues,
    generateDues,
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
    getMembershipChecklist,
    addMember,
    getExitPayoutPreview,
    removeMember,
};
