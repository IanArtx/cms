// ============================================================
// DEPOSITS CONTROLLER (v1.38.0)
// Member Deposit Tracking — a per-member running total, NOT a
// separate envelope like the Side Fund: money posted for a deposit is
// a normal transaction into whichever real account it was recorded
// against, fully spendable through that account. Does not contribute
// to shareholding. See depositService.js for exit-refund logic and
// transactionsController.js's creditDepositContribution for the
// shared crediting core (contribution slice + standalone entry).
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { getOrCreateCategory } = require('../services/categoryService');
const { creditDepositContribution } = require('./transactionsController');
const { computeExitRefund, processExitRefund, DEPOSITS_CATEGORY } = require('../services/depositService');
const { notify } = require('../services/notificationService');

// ============================================================
// GET DEPOSIT SETTINGS/TARGET
// GET /api/deposits/settings
// Anyone can view — same "the frontend needs to know the target
// before rendering the rest of the page" reasoning as Side Fund
// settings.
// ============================================================
const getDepositConfig = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT dc.*, c.code AS currency_code, c.symbol AS currency_symbol
        FROM   deposit_config dc
        LEFT JOIN currencies c ON c.id = dc.currency_id
        WHERE  dc.id = 1
    `);
    sendSuccess(res, result.rows[0] || { target_amount: 0 });
});

// ============================================================
// UPDATE DEPOSIT TARGET — Admin/Treasurer (DEPOSIT_MANAGE)
// PATCH /api/deposits/settings
// Sets the single company-wide target amount and the currency every
// member's own (normalized) balance is compared against. Changing the
// currency does NOT retroactively re-normalize any past deposit_entries
// row — only the running deposit_balances totals from this point
// forward use the new currency as their comparison basis; a currency
// change is expected to be rare (effectively a one-time setup choice).
// ============================================================
const updateDepositConfig = asyncHandler(async (req, res) => {
    const { target_amount, currency_id } = req.body;

    await withTransaction(async (client) => {
        const result = await client.query(`
            UPDATE deposit_config
            SET    target_amount = COALESCE($1, target_amount),
                   currency_id   = COALESCE($2, currency_id),
                   updated_by    = $3,
                   updated_at    = NOW()
            WHERE  id = 1
            RETURNING *
        `, [
            target_amount !== undefined ? parseFloat(target_amount) : null,
            currency_id ? parseInt(currency_id) : null,
            req.user.id,
        ]);

        await logAction(req.user.id, ACTIONS.DEPOSIT_CONFIG_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'deposit_config',
            recordId:    1,
            newValues:   result.rows[0],
            description: `Deposit target updated to ${result.rows[0].target_amount}`,
            client,
        });

        sendSuccess(res, result.rows[0], 'Deposit target updated');
    });
});

// ============================================================
// GET MY DEPOSIT — self-scoped, open to any authenticated member
// GET /api/deposits/me
// ============================================================
const getMyDeposit = asyncHandler(async (req, res) => {
    const [balanceResult, entriesResult, configResult, excusalResult] = await Promise.all([
        query('SELECT * FROM deposit_balances WHERE user_id = $1', [req.user.id]),
        query(`
            SELECT de.*, a.name AS account_name, c.code AS currency_code
            FROM   deposit_entries de
            JOIN   accounts a   ON a.id = de.account_id
            JOIN   currencies c ON c.id = de.currency_id
            WHERE  de.user_id = $1
            ORDER  BY de.entry_date DESC, de.id DESC
        `, [req.user.id]),
        query(`
            SELECT dc.*, c.code AS currency_code, c.symbol AS currency_symbol
            FROM   deposit_config dc
            LEFT JOIN currencies c ON c.id = dc.currency_id
            WHERE  dc.id = 1
        `),
        query('SELECT * FROM deposit_excusals WHERE user_id = $1', [req.user.id]),
    ]);

    const balance = parseFloat(balanceResult.rows[0]?.balance || 0);
    const config = configResult.rows[0] || { target_amount: 0 };

    sendSuccess(res, {
        balance,
        currency_code:   config.currency_code || null,
        target_amount:   parseFloat(config.target_amount || 0),
        below_target:    !excusalResult.rows[0] && balance < parseFloat(config.target_amount || 0),
        is_excused:      !!excusalResult.rows[0],
        entries:         entriesResult.rows,
    });
});

// ============================================================
// GET ALL DEPOSITS — Treasury oversight (DEPOSIT_VIEW)
// GET /api/deposits
// Every active shareholder's standing, whether or not they've ever
// made a deposit — a member with no deposit_balances row at all is
// still surfaced (as a zero balance), since "cannot be zero unless
// excused" is exactly the case this view exists to catch.
// ============================================================
const getAllDeposits = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT u.id AS user_id, u.first_name, u.last_name, u.email,
               COALESCE(db.balance, 0) AS balance, db.updated_at,
               ex.reason AS excusal_reason, ex.excused_at,
               (ex.user_id IS NOT NULL) AS is_excused
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r       ON r.id = ur.role_id AND r.name = 'Shareholder'
        LEFT JOIN deposit_balances db ON db.user_id = u.id
        LEFT JOIN deposit_excusals ex ON ex.user_id = u.id
        WHERE  u.is_active = TRUE
        ORDER  BY u.first_name, u.last_name
    `);

    const configResult = await query('SELECT target_amount FROM deposit_config WHERE id = 1');
    const targetAmount = parseFloat(configResult.rows[0]?.target_amount || 0);

    const rows = result.rows.map(r => ({
        ...r,
        balance:      parseFloat(r.balance),
        below_target: !r.is_excused && parseFloat(r.balance) < targetAmount,
    }));

    sendSuccess(res, rows);
});

// ============================================================
// CREATE STANDALONE DEPOSIT — Treasurer/Assistant Treasurer/Admin
// (DEPOSIT_MANAGE)
// POST /api/deposits
// The second of the two entry points sharing creditDepositContribution
// — a deposit entered on its own, not sliced out of a Transactions
// contribution. Auto-provisions a "Member Deposits" category on first
// use, same reasoning as Fines' auto-provisioned category — the
// Treasurer only needs to pick a member, account, amount, and date.
// ============================================================
const createStandaloneDeposit = asyncHandler(async (req, res) => {
    const { user_id, account_id, amount, entry_date, description } = req.body;

    if (!user_id || !account_id || !amount || parseFloat(amount) <= 0) {
        throw createError.badRequest('A member, account, and a positive amount are all required');
    }

    await withTransaction(async (client) => {
        const categoryId = await getOrCreateCategory(client, {
            ...DEPOSITS_CATEGORY,
            createdBy: req.user.id,
        });

        const deposit = await creditDepositContribution(client, {
            userId:            parseInt(user_id),
            amount:            parseFloat(amount),
            accountId:         parseInt(account_id),
            entryDate:         entry_date || new Date().toISOString().split('T')[0],
            categoryId,
            source:            'STANDALONE',
            recordedByUserId:  req.user.id,
        });

        sendCreated(res, {
            transaction_id:        deposit.transactionId,
            transaction_reference: deposit.referenceCode,
            balance_before:        deposit.balanceBefore,
            balance_after:         deposit.balanceAfter,
            normalized_amount:     deposit.normalizedAmount,
        }, `Deposit recorded for ${deposit.member.first_name} ${deposit.member.last_name}. Reference: ${deposit.referenceCode}`);
    });
});

// ============================================================
// EXCUSALS — Treasurer/Admin (DEPOSIT_MANAGE)
// ============================================================
const getExcusals = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT ex.*, u.first_name, u.last_name, u.email,
               setter.first_name || ' ' || setter.last_name AS excused_by_name
        FROM   deposit_excusals ex
        JOIN   users u      ON u.id = ex.user_id
        LEFT JOIN users setter ON setter.id = ex.excused_by
        ORDER  BY ex.excused_at DESC
    `);
    sendSuccess(res, result.rows);
});

const setExcusal = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        await client.query(`
            INSERT INTO deposit_excusals (user_id, excused_by, reason)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE
            SET    excused_by = $2, excused_at = NOW(), reason = $3
        `, [userId, req.user.id, reason || null]);

        await logAction(req.user.id, ACTIONS.DEPOSIT_EXCUSAL_SET, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'deposit_excusals',
            recordId:    parseInt(userId),
            description: `Member excused from the deposit requirement: user #${userId}`,
            client,
        });

        sendSuccess(res, null, 'Member excused from the deposit requirement');
    });
});

const clearExcusal = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const result = await query('DELETE FROM deposit_excusals WHERE user_id = $1 RETURNING user_id', [userId]);
    if (result.rows.length === 0) {
        throw createError.notFound('No excusal found for this member');
    }

    await logAction(req.user.id, ACTIONS.DEPOSIT_EXCUSAL_CLEARED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'deposit_excusals',
        recordId:    parseInt(userId),
        description: `Deposit excusal cleared: user #${userId}`,
    });

    sendSuccess(res, null, 'Excusal cleared');
});

// ============================================================
// EXIT REFUND PREVIEW — Treasurer/Admin (DEPOSIT_MANAGE)
// GET /api/deposits/:userId/exit-preview?exit_type=&deduction_percentage=
// Read-only — uses the identical computeExitRefund() the real
// processing below calls, so the preview can never disagree with the
// actual result.
// ============================================================
const getExitRefundPreview = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { exit_type, deduction_percentage } = req.query;

    const balanceResult = await query('SELECT balance FROM deposit_balances WHERE user_id = $1', [userId]);
    const grossBalance = parseFloat(balanceResult.rows[0]?.balance || 0);

    if (grossBalance <= 0) {
        return sendSuccess(res, { gross_balance: 0, deduction_amount: 0, net_payout: 0 });
    }

    const { deductionPercentage, deductionAmount, netPayout } =
        computeExitRefund(grossBalance, exit_type, deduction_percentage);

    sendSuccess(res, {
        gross_balance:        grossBalance,
        deduction_percentage: deductionPercentage,
        deduction_amount:     deductionAmount,
        net_payout:           netPayout,
    });
});

// ============================================================
// PROCESS EXIT REFUND — Treasurer/Admin (DEPOSIT_MANAGE)
// PATCH /api/deposits/:userId/exit-refund
// ============================================================
const processExitRefundHandler = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { exit_type, deduction_percentage, source_account_id, exchange_rate, notes } = req.body;

    await withTransaction(async (client) => {
        const result = await processExitRefund(client, {
            userId:              parseInt(userId),
            exitType:            exit_type,
            deductionPercentage: deduction_percentage,
            sourceAccountId:     source_account_id ? parseInt(source_account_id) : undefined,
            exchangeRate:        exchange_rate,
            notes,
            processedByUserId:   req.user.id,
        });

        sendSuccess(res, {
            gross_balance:        result.grossBalance,
            deduction_percentage: result.deductionPercentage,
            deduction_amount:     result.deductionAmount,
            net_payout:           result.netPayout,
            savings_credited:     result.savingsCredited,
            payment_ack_id:       result.paymentAckId,
        }, `${result.member.first_name} ${result.member.last_name}'s deposit refund processed` +
            (result.netPayout > 0 ? ` — ${result.netPayout} paid out to savings` : ' — no net payout was due'));
    });
});

module.exports = {
    getDepositConfig,
    updateDepositConfig,
    getMyDeposit,
    getAllDeposits,
    createStandaloneDeposit,
    getExcusals,
    setExcusal,
    clearExcusal,
    getExitRefundPreview,
    processExitRefundHandler,
};
