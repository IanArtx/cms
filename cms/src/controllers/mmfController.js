// ============================================================
// MONEY MARKET FUND (MMF) SUB-ACCOUNTS CONTROLLER
// v1.28.0, Section 4.31
//
// A Money Market Fund sub-account represents money moved OUT of a
// parent account (Primary or Secondary) into an external MMF
// provider. That money stops counting toward the parent account's
// real/spendable current_balance the moment it's topped up — it's
// genuinely gone from the parent account's cash — and instead lives
// in its own running balance here (current_balance on mmf_accounts).
//
// RULES ENFORCED HERE:
//   - Top-up debits the parent account for real (via postTransaction)
//     and credits the MMF's own balance.
//   - Withdrawal credits the parent account for real and debits the
//     MMF's own balance. Cannot withdraw more than the MMF holds.
//   - Interest is entered manually, once per calendar month
//     (interest_period), and only ever increases the MMF's own
//     balance — it never touches the parent account directly.
//   - The management fee is the ONLY expense this sub-account can
//     have. It's deducted straight from the MMF's own balance (that's
//     how MMF providers actually charge it — netted off the fund,
//     not separately invoiced to the parent account).
//   - Multiple MMFs are allowed at once, each tied to exactly one
//     parent account, inheriting that account's currency.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');

// ============================================================
// INTERNAL HELPER — PERFORM A TOP-UP
// Shared by createMmfAccount (optional initial funding) and the
// dedicated top-up endpoint, so both go through identical logic.
// ============================================================
const performTopUp = async (client, { mmfAccount, amount, categoryId, description, entryDate, userId }) => {
    // Look up the parent account's module code (reference_prefix, if any)
    const parentAccount = await client.query(`
        SELECT id, account_type, reference_prefix FROM accounts WHERE id = $1
    `, [mmfAccount.parent_account_id]);

    const { referenceId: realTxRefId } = await generateReference(
        client,
        resolveModuleCode(parentAccount.rows[0]),
        'MMF-OUT',
        'TRANSACTION',
        userId
    );

    const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
        accountId:       mmfAccount.parent_account_id,
        transactionType: 'DEBIT',
        inflowType:      'MMF_TOPUP_OUT',
        amount,
        currencyId:      mmfAccount.currency_id,
        categoryId,
        description:     description || `MMF top-up — ${mmfAccount.name}`,
        valueDate:       entryDate,
        createdBy:       userId,
        referenceId:     realTxRefId,
    });

    await linkReferenceToRecord(client, realTxRefId, transactionId);

    const { referenceId: mmfTxRefId, referenceCode: mmfTxRefCode } = await generateReference(
        client,
        MODULE_CODES.MMF,
        'TOPUP',
        'MMF_TRANSACTION',
        userId
    );

    const mmfTxResult = await client.query(`
        INSERT INTO mmf_transactions (
            reference_id, mmf_account_id, transaction_id,
            entry_type, amount, description, entry_date, created_by
        ) VALUES ($1, $2, $3, 'TOPUP', $4, $5, $6, $7)
        RETURNING id
    `, [mmfTxRefId, mmfAccount.id, transactionId, amount, description || null, entryDate, userId]);

    await linkReferenceToRecord(client, mmfTxRefId, mmfTxResult.rows[0].id);

    await client.query(`
        UPDATE mmf_accounts
        SET    current_balance    = current_balance + $1,
               total_principal_in = total_principal_in + $1
        WHERE  id = $2
    `, [amount, mmfAccount.id]);

    return { mmfTxRefCode, transactionId, balanceBefore, balanceAfter };
};

// ============================================================
// CREATE MMF SUB-ACCOUNT
// POST /api/mmf
// Registers the sub-account against a chosen parent account. If
// initial_amount is supplied, it's immediately topped up as part of
// the same request ("activating" it with money in one step) —
// otherwise it's created empty and funded later via /:id/topup.
// ============================================================
const createMmfAccount = asyncHandler(async (req, res) => {
    const {
        parent_account_id, name, provider, description,
        initial_amount, category_id, entry_date,
    } = req.body;

    await withTransaction(async (client) => {
        const account = await client.query(`
            SELECT id, account_type, currency_id, name
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [parent_account_id]);

        if (account.rows.length === 0) {
            throw createError.notFound('Parent account not found');
        }
        if (!['PRIMARY', 'SECONDARY'].includes(account.rows[0].account_type)) {
            throw createError.badRequest(
                'An MMF sub-account can only be attached to a Primary or Secondary account'
            );
        }

        if (initial_amount && !category_id) {
            throw createError.badRequest('A category is required when funding the MMF on creation');
        }
        if (initial_amount && !entry_date) {
            throw createError.badRequest('An entry date is required when funding the MMF on creation');
        }

        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.MMF,
            'ACCOUNT',
            'MMF_ACCOUNT',
            req.user.id
        );

        const result = await client.query(`
            INSERT INTO mmf_accounts (
                reference_id, parent_account_id, name, provider, description,
                currency_id, status, opened_date, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', CURRENT_DATE, $7)
            RETURNING id, opened_date
        `, [
            referenceId, parent_account_id, name.trim(), provider || null,
            description || null, account.rows[0].currency_id, req.user.id,
        ]);

        const mmfAccountId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, mmfAccountId);

        await logAction(req.user.id, ACTIONS.MMF_ACCOUNT_CREATED, MODULES.MMF, {
            ipAddress:   req.ip,
            recordType:  'mmf_accounts',
            recordId:    mmfAccountId,
            newValues:   { referenceCode, name, parent_account_id, provider },
            description: `MMF sub-account created: ${referenceCode} — ${name}`,
            client,
        });

        let topUpResult = null;
        if (initial_amount) {
            const mmfAccount = {
                id: mmfAccountId, name: name.trim(),
                parent_account_id, currency_id: account.rows[0].currency_id,
            };
            topUpResult = await performTopUp(client, {
                mmfAccount, amount: initial_amount, categoryId: category_id,
                description: `Initial funding — ${name.trim()}`,
                entryDate: entry_date, userId: req.user.id,
            });

            await logAction(req.user.id, ACTIONS.MMF_TOPUP, MODULES.MMF, {
                ipAddress:   req.ip,
                recordType:  'mmf_accounts',
                recordId:    mmfAccountId,
                newValues:   { amount: initial_amount, ...topUpResult },
                description: `MMF initial top-up: ${referenceCode} — ${initial_amount}`,
                client,
            });
        }

        sendCreated(res, {
            mmf_account_id: mmfAccountId,
            reference:      referenceCode,
            name,
            parent_account: account.rows[0].name,
            opened_date:    result.rows[0].opened_date,
            initial_amount: initial_amount || 0,
            balance_after:  topUpResult ? topUpResult.balanceAfter : null,
        }, `MMF sub-account created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// TOP UP MMF SUB-ACCOUNT
// POST /api/mmf/:id/topup
// ============================================================
const topUpMmfAccount = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, category_id, description, entry_date } = req.body;

    await withTransaction(async (client) => {
        const mmfResult = await client.query(`
            SELECT m.*, r.reference_code
            FROM   mmf_accounts m
            JOIN   references_registry r ON r.id = m.reference_id
            WHERE  m.id = $1
            FOR UPDATE
        `, [id]);

        if (mmfResult.rows.length === 0) {
            throw createError.notFound('MMF sub-account not found');
        }
        const mmfAccount = mmfResult.rows[0];

        if (mmfAccount.status !== 'ACTIVE') {
            throw createError.badRequest('This MMF sub-account is closed');
        }

        const topUpResult = await performTopUp(client, {
            mmfAccount, amount, categoryId: category_id,
            description, entryDate: entry_date, userId: req.user.id,
        });

        await logAction(req.user.id, ACTIONS.MMF_TOPUP, MODULES.MMF, {
            ipAddress:   req.ip,
            recordType:  'mmf_accounts',
            recordId:    parseInt(id),
            newValues:   { amount, ...topUpResult },
            description: `MMF top-up: ${mmfAccount.reference_code} — ${amount}`,
            client,
        });

        sendCreated(res, {
            reference:      topUpResult.mmfTxRefCode,
            amount,
            parent_balance_before: topUpResult.balanceBefore,
            parent_balance_after:  topUpResult.balanceAfter,
        }, `MMF topped up. Reference: ${topUpResult.mmfTxRefCode}`);
    });
});

// ============================================================
// WITHDRAW FROM MMF SUB-ACCOUNT
// POST /api/mmf/:id/withdraw
// Credits the money back to the parent account for real.
// ============================================================
const withdrawFromMmfAccount = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, category_id, description, entry_date } = req.body;

    await withTransaction(async (client) => {
        const mmfResult = await client.query(`
            SELECT m.*, r.reference_code
            FROM   mmf_accounts m
            JOIN   references_registry r ON r.id = m.reference_id
            WHERE  m.id = $1
            FOR UPDATE
        `, [id]);

        if (mmfResult.rows.length === 0) {
            throw createError.notFound('MMF sub-account not found');
        }
        const mmfAccount = mmfResult.rows[0];

        if (mmfAccount.status !== 'ACTIVE') {
            throw createError.badRequest('This MMF sub-account is closed');
        }
        if (parseFloat(amount) > parseFloat(mmfAccount.current_balance)) {
            throw createError.badRequest(
                `Cannot withdraw more than the MMF currently holds. Current MMF balance: ${mmfAccount.current_balance}.`
            );
        }

        const parentAccount = await client.query(`
            SELECT id, account_type, reference_prefix FROM accounts WHERE id = $1
        `, [mmfAccount.parent_account_id]);

        const { referenceId: realTxRefId } = await generateReference(
            client,
            resolveModuleCode(parentAccount.rows[0]),
            'MMF-IN',
            'TRANSACTION',
            req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       mmfAccount.parent_account_id,
            transactionType: 'CREDIT',
            inflowType:      'MMF_WITHDRAWAL_IN',
            amount,
            currencyId:      mmfAccount.currency_id,
            categoryId:      category_id,
            description:     description || `MMF withdrawal — ${mmfAccount.name}`,
            valueDate:       entry_date,
            createdBy:       req.user.id,
            referenceId:     realTxRefId,
        });

        await linkReferenceToRecord(client, realTxRefId, transactionId);

        const { referenceId: mmfTxRefId, referenceCode: mmfTxRefCode } = await generateReference(
            client,
            MODULE_CODES.MMF,
            'WD',
            'MMF_TRANSACTION',
            req.user.id
        );

        const mmfTxResult = await client.query(`
            INSERT INTO mmf_transactions (
                reference_id, mmf_account_id, transaction_id,
                entry_type, amount, description, entry_date, created_by
            ) VALUES ($1, $2, $3, 'WITHDRAWAL', $4, $5, $6, $7)
            RETURNING id
        `, [mmfTxRefId, id, transactionId, amount, description || null, entry_date, req.user.id]);

        await linkReferenceToRecord(client, mmfTxRefId, mmfTxResult.rows[0].id);

        await client.query(`
            UPDATE mmf_accounts
            SET    current_balance = current_balance - $1,
                   total_withdrawn = total_withdrawn + $1
            WHERE  id = $2
        `, [amount, id]);

        await logAction(req.user.id, ACTIONS.MMF_WITHDRAWAL, MODULES.MMF, {
            ipAddress:   req.ip,
            recordType:  'mmf_accounts',
            recordId:    parseInt(id),
            newValues:   { amount, mmfTxRefCode, balanceBefore, balanceAfter },
            description: `MMF withdrawal: ${mmfAccount.reference_code} — ${amount}`,
            client,
        });

        sendCreated(res, {
            reference:              mmfTxRefCode,
            amount,
            parent_balance_before:  balanceBefore,
            parent_balance_after:   balanceAfter,
        }, `Withdrawal recorded. Reference: ${mmfTxRefCode}`);
    });
});

// ============================================================
// RECORD MONTHLY INTEREST
// POST /api/mmf/:id/interest
// Manual entry — the Treasurer/Admin types in the actual interest
// credited by the MMF provider that month. Only one entry allowed
// per (mmf_account, interest_period) — enforced by a unique partial
// index; a repeat attempt for the same month is rejected here with a
// friendly message instead of a raw constraint error.
// ============================================================
const recordInterest = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, interest_period, description, entry_date } = req.body;

    // Normalise interest_period to the first of its month, so
    // "2026-08-17" and "2026-08-01" are treated as the same period.
    const periodDate = new Date(interest_period);
    const normalisedPeriod = `${periodDate.getFullYear()}-${String(periodDate.getMonth() + 1).padStart(2, '0')}-01`;

    await withTransaction(async (client) => {
        const mmfResult = await client.query(`
            SELECT m.*, r.reference_code
            FROM   mmf_accounts m
            JOIN   references_registry r ON r.id = m.reference_id
            WHERE  m.id = $1
            FOR UPDATE
        `, [id]);

        if (mmfResult.rows.length === 0) {
            throw createError.notFound('MMF sub-account not found');
        }
        const mmfAccount = mmfResult.rows[0];

        if (mmfAccount.status !== 'ACTIVE') {
            throw createError.badRequest('This MMF sub-account is closed');
        }

        const existing = await client.query(`
            SELECT 1 FROM mmf_transactions
            WHERE  mmf_account_id = $1 AND entry_type = 'INTEREST' AND interest_period = $2
        `, [id, normalisedPeriod]);
        if (existing.rows.length > 0) {
            throw createError.badRequest(
                `Interest has already been recorded for ${normalisedPeriod.slice(0, 7)}`
            );
        }

        const { referenceId: mmfTxRefId, referenceCode: mmfTxRefCode } = await generateReference(
            client,
            MODULE_CODES.MMF,
            'INT',
            'MMF_TRANSACTION',
            req.user.id
        );

        const mmfTxResult = await client.query(`
            INSERT INTO mmf_transactions (
                reference_id, mmf_account_id, entry_type,
                amount, interest_period, description, entry_date, created_by
            ) VALUES ($1, $2, 'INTEREST', $3, $4, $5, $6, $7)
            RETURNING id
        `, [mmfTxRefId, id, amount, normalisedPeriod, description || null, entry_date, req.user.id]);

        await linkReferenceToRecord(client, mmfTxRefId, mmfTxResult.rows[0].id);

        const updated = await client.query(`
            UPDATE mmf_accounts
            SET    current_balance = current_balance + $1,
                   total_interest  = total_interest + $1
            WHERE  id = $2
            RETURNING current_balance
        `, [amount, id]);

        await logAction(req.user.id, ACTIONS.MMF_INTEREST_RECORDED, MODULES.MMF, {
            ipAddress:   req.ip,
            recordType:  'mmf_accounts',
            recordId:    parseInt(id),
            newValues:   { amount, interest_period: normalisedPeriod, mmfTxRefCode },
            description: `MMF interest recorded: ${mmfAccount.reference_code} — ${amount} for ${normalisedPeriod.slice(0, 7)}`,
            client,
        });

        sendCreated(res, {
            reference:       mmfTxRefCode,
            amount,
            interest_period: normalisedPeriod,
            new_balance:     updated.rows[0].current_balance,
        }, `Interest recorded. Reference: ${mmfTxRefCode}`);
    });
});

// ============================================================
// RECORD MANAGEMENT FEE
// POST /api/mmf/:id/fee
// The one allowed expense — deducted straight from the MMF's own
// balance (this is how providers actually charge it), not posted
// against the parent account's ledger.
// ============================================================
const recordManagementFee = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, description, entry_date } = req.body;

    await withTransaction(async (client) => {
        const mmfResult = await client.query(`
            SELECT m.*, r.reference_code
            FROM   mmf_accounts m
            JOIN   references_registry r ON r.id = m.reference_id
            WHERE  m.id = $1
            FOR UPDATE
        `, [id]);

        if (mmfResult.rows.length === 0) {
            throw createError.notFound('MMF sub-account not found');
        }
        const mmfAccount = mmfResult.rows[0];

        if (parseFloat(amount) > parseFloat(mmfAccount.current_balance)) {
            throw createError.badRequest(
                `Management fee cannot exceed the MMF's current balance of ${mmfAccount.current_balance}.`
            );
        }

        const { referenceId: mmfTxRefId, referenceCode: mmfTxRefCode } = await generateReference(
            client,
            MODULE_CODES.MMF,
            'FEE',
            'MMF_TRANSACTION',
            req.user.id
        );

        const mmfTxResult = await client.query(`
            INSERT INTO mmf_transactions (
                reference_id, mmf_account_id, entry_type,
                amount, description, entry_date, created_by
            ) VALUES ($1, $2, 'MANAGEMENT_FEE', $3, $4, $5, $6)
            RETURNING id
        `, [mmfTxRefId, id, amount, description || 'MMF management fee', entry_date, req.user.id]);

        await linkReferenceToRecord(client, mmfTxRefId, mmfTxResult.rows[0].id);

        const updated = await client.query(`
            UPDATE mmf_accounts
            SET    current_balance       = current_balance - $1,
                   total_management_fees = total_management_fees + $1
            WHERE  id = $2
            RETURNING current_balance
        `, [amount, id]);

        await logAction(req.user.id, ACTIONS.MMF_FEE_RECORDED, MODULES.MMF, {
            ipAddress:   req.ip,
            recordType:  'mmf_accounts',
            recordId:    parseInt(id),
            newValues:   { amount, mmfTxRefCode },
            description: `MMF management fee recorded: ${mmfAccount.reference_code} — ${amount}`,
            client,
        });

        sendCreated(res, {
            reference:   mmfTxRefCode,
            amount,
            new_balance: updated.rows[0].current_balance,
        }, `Management fee recorded. Reference: ${mmfTxRefCode}`);
    });
});

// ============================================================
// CLOSE MMF SUB-ACCOUNT
// POST /api/mmf/:id/close
// Only once the balance has been fully withdrawn to zero — closing
// is a record-keeping step, not a way to move money, so there is
// deliberately no "auto-withdraw remaining balance" shortcut here.
// ============================================================
const closeMmfAccount = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const mmfResult = await client.query(`
            SELECT m.*, r.reference_code
            FROM   mmf_accounts m
            JOIN   references_registry r ON r.id = m.reference_id
            WHERE  m.id = $1
            FOR UPDATE
        `, [id]);

        if (mmfResult.rows.length === 0) {
            throw createError.notFound('MMF sub-account not found');
        }
        const mmfAccount = mmfResult.rows[0];

        if (mmfAccount.status === 'CLOSED') {
            throw createError.badRequest('This MMF sub-account is already closed');
        }
        if (parseFloat(mmfAccount.current_balance) !== 0) {
            throw createError.badRequest(
                `Withdraw the remaining balance of ${mmfAccount.current_balance} before closing this MMF sub-account`
            );
        }

        await client.query(`
            UPDATE mmf_accounts
            SET    status      = 'CLOSED',
                   closed_date = CURRENT_DATE
            WHERE  id = $1
        `, [id]);

        await logAction(req.user.id, ACTIONS.MMF_ACCOUNT_CLOSED, MODULES.MMF, {
            ipAddress:   req.ip,
            recordType:  'mmf_accounts',
            recordId:    parseInt(id),
            description: `MMF sub-account closed: ${mmfAccount.reference_code}`,
            client,
        });

        sendSuccess(res, null, 'MMF sub-account closed');
    });
});

// ============================================================
// GET ALL MMF SUB-ACCOUNTS
// GET /api/mmf?status=ACTIVE
// ============================================================
const getAllMmfAccounts = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`m.status = $${p}`);
        params.push(status.toUpperCase());
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM mmf_accounts m ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            m.id, m.name, m.provider, m.current_balance, m.total_principal_in,
            m.total_withdrawn, m.total_interest, m.total_management_fees,
            m.status, m.opened_date, m.closed_date, m.created_at,
            r.reference_code, r.public_id,
            a.name       AS parent_account_name,
            a.account_type AS parent_account_type,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            CASE
                WHEN m.total_principal_in > 0 THEN
                    ROUND(((m.total_interest - m.total_management_fees)
                    / m.total_principal_in * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage
        FROM  mmf_accounts m
        JOIN  references_registry r ON r.id = m.reference_id
        JOIN  accounts a            ON a.id = m.parent_account_id
        JOIN  currencies c          ON c.id = m.currency_id
        ${where}
        ORDER BY m.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// BEST/WORST PERFORMING MMF (dashboard/comparison summary)
// GET /api/mmf/performance-summary
// Mirrors investments' /performance-summary shape exactly, so the
// two can be combined for a single company-wide ROI comparison.
// ============================================================
const getMmfPerformanceSummary = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            m.id, m.name, 'MMF' AS investment_type, m.status,
            CASE
                WHEN m.total_principal_in > 0 THEN
                    ROUND(((m.total_interest - m.total_management_fees)
                    / m.total_principal_in * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage
        FROM mmf_accounts m
        WHERE m.status IN ('ACTIVE', 'CLOSED')
        AND   m.total_principal_in > 0
        ORDER BY roi_percentage DESC
    `);

    const rows = result.rows;

    sendSuccess(res, {
        best:  rows.length > 0 ? rows[0] : null,
        worst: rows.length > 1 ? rows[rows.length - 1] : null,
        count: rows.length,
    });
});

// ============================================================
// GET SINGLE MMF SUB-ACCOUNT WITH FULL TRANSACTION HISTORY
// GET /api/mmf/:id
// Includes everything the dedicated MMF page's return/funding
// chart needs: every top-up, withdrawal, interest and fee entry in
// date order.
// ============================================================
const getMmfById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            m.*,
            r.reference_code,
            r.public_id,
            a.name          AS parent_account_name,
            a.account_type  AS parent_account_type,
            c.code          AS currency_code,
            c.symbol        AS currency_symbol,
            creator.first_name || ' ' || creator.last_name AS created_by_name,
            CASE
                WHEN m.total_principal_in > 0 THEN
                    ROUND(((m.total_interest - m.total_management_fees)
                    / m.total_principal_in * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage,
            (
                SELECT json_agg(tx_data ORDER BY tx_data.entry_date ASC, tx_data.id ASC)
                FROM (
                    SELECT
                        mt.id, mt.entry_type, mt.amount, mt.interest_period,
                        mt.description, mt.entry_date, mt.created_at,
                        tr.reference_code,
                        txcreator.first_name || ' ' || txcreator.last_name AS recorded_by_name
                    FROM mmf_transactions mt
                    JOIN references_registry tr ON tr.id = mt.reference_id
                    JOIN users txcreator         ON txcreator.id = mt.created_by
                    WHERE mt.mmf_account_id = m.id
                ) tx_data
            ) AS transactions
        FROM  mmf_accounts m
        JOIN  references_registry r ON r.id = m.reference_id
        JOIN  accounts a            ON a.id = m.parent_account_id
        JOIN  currencies c          ON c.id = m.currency_id
        JOIN  users creator         ON creator.id = m.created_by
        WHERE m.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('MMF sub-account not found');
    }

    sendSuccess(res, result.rows[0]);
});

module.exports = {
    createMmfAccount,
    topUpMmfAccount,
    withdrawFromMmfAccount,
    recordInterest,
    recordManagementFee,
    closeMmfAccount,
    getAllMmfAccounts,
    getMmfPerformanceSummary,
    getMmfById,
};
