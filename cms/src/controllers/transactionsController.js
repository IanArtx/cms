// ============================================================
// TRANSACTIONS CONTROLLER
// Handles all money movements on any account.
//
// RULES ENFORCED HERE:
//   - Every transaction is immutable once posted
//   - Primary account cannot go below floor limit
//   - No account can go below zero
//   - Corrections are reversal entries only
//   - Every transaction gets a unique auto-generated reference
//   - Running balance is recorded on every transaction
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');

// ============================================================
// INTERNAL HELPER — GET CURRENT FLOOR LIMIT
// Returns the current floor limit for the given account, if one has
// ever been set (0 otherwise — no floor limit configured behaves
// exactly like before, i.e. no restriction beyond zero).
// The SAVINGS account is a permanent, hard-coded exception: it must
// always be allowed to sit at exactly zero, so no floor limit is ever
// looked up or enforced for it, even if a row somehow exists.
// ============================================================
const getFloorLimit = async (client, accountId, accountType) => {
    if (accountType === 'SAVINGS') return 0;

    const result = await client.query(`
        SELECT floor_amount
        FROM   primary_account_floor_limits
        WHERE  account_id = $1
        AND    effective_to IS NULL
        ORDER  BY effective_from DESC
        LIMIT  1
    `, [accountId]);

    return result.rows.length > 0 ? parseFloat(result.rows[0].floor_amount) : 0;
};

// ============================================================
// INTERNAL HELPER — POST A TRANSACTION
// This is the core function that actually moves money.
// It is called by contributions, expenses, and transfers.
// It enforces all balance rules before committing.
// ============================================================
const postTransaction = async (client, {
    accountId,
    transactionType,
    inflowType,
    amount,
    currencyId,
    categoryId,
    description,
    valueDate,
    createdBy,
    referenceId,
    transferId = null,
    contributionId = null,
    loanReceivedId = null,
    loanGivenId = null,
    investmentId = null,
    grantTrancheId = null,
    reversalOf = null,
    isReversal = false,
}) => {
    // Lock the account row to prevent concurrent balance updates
    const accountResult = await client.query(`
        SELECT id, account_type, current_balance, currency_id
        FROM   accounts
        WHERE  id = $1
        FOR UPDATE
    `, [accountId]);

    if (accountResult.rows.length === 0) {
        throw createError.notFound('Account not found');
    }

    const account = accountResult.rows[0];
    const balanceBefore = parseFloat(account.current_balance);
    const transactionAmount = parseFloat(amount);

    // Calculate new balance
    let balanceAfter;
    if (transactionType === 'CREDIT' || transactionType === 'REVERSAL_CREDIT') {
        balanceAfter = balanceBefore + transactionAmount;
    } else {
        balanceAfter = balanceBefore - transactionAmount;
    }

    // RULE 1: No account can go below zero
    if (balanceAfter < 0) {
        throw createError.badRequest(
            `Insufficient funds. Current balance: ${balanceBefore}. ` +
            `Transaction amount: ${transactionAmount}.`
        );
    }

    // RULE 2: An account with a floor limit set cannot go below it.
    // Any account type can have a floor limit (v1.14.0) except SAVINGS,
    // which is permanently exempt — getFloorLimit returns 0 for it (and
    // for any account with no floor limit configured), so this check is
    // a safe no-op in both of those cases.
    if (account.account_type !== 'SAVINGS') {
        const floorLimit = await getFloorLimit(client, accountId, account.account_type);
        if (balanceAfter < floorLimit) {
            throw createError.badRequest(
                `This transaction would bring this account below its floor limit ` +
                `of ${floorLimit}. Current balance: ${balanceBefore}. ` +
                `Available to spend: ${balanceBefore - floorLimit}.`
            );
        }
    }

    // Insert the transaction record
    const txResult = await client.query(`
        INSERT INTO transactions (
            reference_id, account_id, transaction_type, inflow_type,
            amount, currency_id, balance_before, balance_after,
            category_id, description, value_date,
            transfer_id, contribution_id, loan_received_id,
            loan_given_id, investment_id, grant_tranche_id,
            reversal_of, is_reversal, status,
            created_by, approved_by, approved_at, posted_at
        ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14,
            $15, $16, $17,
            $18, $19, 'POSTED',
            $20, $20, NOW(), NOW()
        )
        RETURNING id
    `, [
        referenceId, accountId, transactionType, inflowType,
        transactionAmount, currencyId, balanceBefore, balanceAfter,
        categoryId, description, valueDate,
        transferId, contributionId, loanReceivedId,
        loanGivenId, investmentId, grantTrancheId,
        reversalOf, isReversal,
        createdBy,
    ]);

    const transactionId = txResult.rows[0].id;

    // Update the account balance
    await client.query(`
        UPDATE accounts
        SET    current_balance = $1
        WHERE  id = $2
    `, [balanceAfter, accountId]);

    return { transactionId, balanceBefore, balanceAfter };
};

// ============================================================
// CREDIT SHAREHOLDER CONTRIBUTION (shared core logic)
// Money coming INTO the primary account from a shareholder.
// Used by two entry points:
//   1. recordContribution below — Treasurer/Assistant Treasurer
//      recording a contribution directly.
//   2. requisitionsController.approveRequisition — when a member's
//      CONTRIBUTION_ACKNOWLEDGEMENT requisition is approved, this
//      same logic runs so both paths stay perfectly consistent
//      (same shareholding recalculation, same audit trail shape).
// Must be called from inside an existing `withTransaction` block —
// it does not open its own transaction.
// ============================================================
const creditShareholderContribution = async (client, {
    contributorId,
    amount,
    contributionDate,
    categoryId,
    notes,
    recordedByUserId, // who is performing this action (Treasurer/Assistant Treasurer)
}) => {
    // Get the contributor's details
    const contributorResult = await client.query(`
        SELECT id, first_name, last_name, email
        FROM   users
        WHERE  id = $1 AND is_active = TRUE
    `, [contributorId]);

    if (contributorResult.rows.length === 0) {
        throw createError.notFound('Contributing member not found');
    }
    const contributor = contributorResult.rows[0];

    // Verify contributor is a shareholder
    const shareholding = await client.query(`
        SELECT id FROM shareholding_registry
        WHERE  user_id = $1 AND effective_to IS NULL
    `, [contributorId]);

    if (shareholding.rows.length === 0) {
        // Auto-create shareholding record if not exists
        await client.query(`
            INSERT INTO shareholding_registry
                (user_id, shares_held, effective_from, updated_by, notes)
            VALUES ($1, 0, $2, $3, 'Auto-created on first contribution')
            ON CONFLICT DO NOTHING
        `, [contributorId, contributionDate, recordedByUserId]);
    }

    // Get the primary account
    const accountResult = await client.query(`
        SELECT id, currency_id, account_type, reference_prefix
        FROM   accounts
        WHERE  account_type = 'PRIMARY'
        AND    is_active = TRUE
    `);
    if (accountResult.rows.length === 0) {
        throw createError.badRequest('Primary account has not been set up yet');
    }
    const account = accountResult.rows[0];

    // Generate reference: PA-CONTRIB-YYYYMM-00001 (or the primary
    // account's own reference_prefix, if one has been set)
    const { referenceId, referenceCode } = await generateReference(
        client,
        resolveModuleCode(account),
        'CONTRIB',
        'TRANSACTION',
        recordedByUserId
    );

    // Record the contribution details
    const contribResult = await client.query(`
        INSERT INTO shareholder_contributions
            (reference_id, user_id, account_id, amount, currency_id,
             contribution_date, category_id, notes, status, created_by)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, 'APPROVED', $9)
        RETURNING id
    `, [
        referenceId,
        contributorId,
        account.id,
        amount,
        account.currency_id,
        contributionDate,
        categoryId,
        notes || null,
        recordedByUserId,
    ]);

    const contributionId = contribResult.rows[0].id;

    // Post the transaction — includes contributed_by for traceability
    const { transactionId, balanceBefore, balanceAfter } =
        await postTransaction(client, {
            accountId:       account.id,
            transactionType: 'CREDIT',
            inflowType:      'CONTRIBUTION',
            amount,
            currencyId:      account.currency_id,
            categoryId,
            description:     `Capital contribution — ${contributor.first_name} ${contributor.last_name}${notes ? ` (${notes})` : ''}`,
            valueDate:       contributionDate,
            createdBy:       recordedByUserId,
            referenceId,
            contributionId,
            contributedBy:   contributorId,
        });

    // Store contributed_by on the transaction record
    await client.query(`
        UPDATE transactions
        SET contributed_by = $1
        WHERE id = $2
    `, [contributorId, transactionId]);

    // Link reference to the transaction
    await linkReferenceToRecord(client, referenceId, transactionId);

    // --------------------------------------------------------
    // AUTO-RECALCULATE SHAREHOLDING PERCENTAGES
    // Based on total contributions per member
    // --------------------------------------------------------

    // Get total contributions per shareholder
    const totalsResult = await client.query(`
        SELECT
            sc.user_id,
            SUM(sc.amount) AS total_contributed
        FROM shareholder_contributions sc
        WHERE sc.status = 'APPROVED'
        GROUP BY sc.user_id
    `);

    // Calculate grand total
    const grandTotal = totalsResult.rows.reduce(
        (sum, r) => sum + parseFloat(r.total_contributed), 0
    );

    // Update each shareholder's percentage and shares
    for (const row of totalsResult.rows) {
        const percentage = grandTotal > 0
            ? ((parseFloat(row.total_contributed) / grandTotal) * 100).toFixed(4)
            : '0.0000';

        await client.query(`
            UPDATE shareholding_registry
            SET
                shares_held    = $1,
                percentage     = $2,
                updated_by     = $3,
                notes          = 'Auto-calculated from contributions'
            WHERE user_id = $4
            AND   effective_to IS NULL
        `, [
            row.total_contributed,
            percentage,
            recordedByUserId,
            row.user_id,
        ]);
    }

    // --------------------------------------------------------
    // NOTIFY THE CONTRIBUTOR
    // Bell notification + auto-email confirming their contribution
    // was recorded — the flagship example the notifications system
    // was built for. Best-effort: never blocks or rolls back the
    // transaction above if the email/notification insert fails.
    // --------------------------------------------------------
    notify({
        userId:     contributorId,
        type:       'CONTRIBUTION_RECORDED',
        title:      'Contribution recorded',
        body:       `Your contribution of ${amount} on ${contributionDate} was recorded. Reference: ${referenceCode}.`,
        link:       `/transactions/${transactionId}`,
        module:     'FINANCE',
        recordType: 'transactions',
        recordId:   transactionId,
        email: {
            to:      contributor.email,
            subject: `Contribution recorded — ${referenceCode}`,
            html:    await wrapEmail(`
                <p>Dear ${contributor.first_name},</p>
                <p>Your contribution has been recorded on your account:</p>
                <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                    <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
                    <tr><td style="padding:4px 0; color:#6b7280;">Date</td><td style="padding:4px 0; text-align:right;">${contributionDate}</td></tr>
                    <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
                </table>
                <p>You can view this in your account statement at any time.</p>
            `, { preheader: 'Your contribution has been recorded' }),
        },
    });

    return {
        transactionId, balanceBefore, balanceAfter,
        referenceCode, contributor, account,
    };
};

// ============================================================
// RECORD SHAREHOLDER CONTRIBUTION
// POST /api/transactions/contributions
// Treasurer/Assistant Treasurer only. contributed_by: the member
// making the contribution — defaults to the logged-in user if not
// provided, or can be set to record on behalf of any member.
// Shareholding % is auto-recalculated after every contribution.
// ============================================================
const recordContribution = asyncHandler(async (req, res) => {
    const {
        amount,
        contribution_date,
        category_id,
        notes,
        contributed_by, // user_id of the contributing member
    } = req.body;

    await withTransaction(async (client) => {
        const contributorId = contributed_by
            ? parseInt(contributed_by)
            : req.user.id;

        const { transactionId, balanceBefore, balanceAfter, referenceCode, contributor } =
            await creditShareholderContribution(client, {
                contributorId,
                amount,
                contributionDate: contribution_date,
                categoryId:       category_id,
                notes,
                recordedByUserId: req.user.id,
            });

        await logAction(req.user.id, ACTIONS.CONTRIBUTION_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transactions',
            recordId:    transactionId,
            newValues:   {
                amount, referenceCode, balanceBefore, balanceAfter,
                contributorId,
                contributorName: `${contributor.first_name} ${contributor.last_name}`,
            },
            description: `Contribution: ${referenceCode} — ${contributor.first_name} ${contributor.last_name}: ${amount}`,
            client,
        });

        sendCreated(res, {
            reference:        referenceCode,
            transaction_id:   transactionId,
            contributor_name: `${contributor.first_name} ${contributor.last_name}`,
            amount,
            balance_before:   balanceBefore,
            balance_after:    balanceAfter,
        }, `Contribution recorded for ${contributor.first_name} ${contributor.last_name}. Reference: ${referenceCode}`);
    });
});

// ============================================================
// RECORD GENERAL INFLOW
// POST /api/transactions/inflows
// Money coming INTO any account that isn't one of the dedicated
// inflow types (contribution, grant, loan, savings deposit, etc) —
// e.g. miscellaneous income recorded directly from an account's own
// detail page. Posted with inflow_type 'OTHER_INCOME'.
// ============================================================
const recordInflow = asyncHandler(async (req, res) => {
    const {
        account_id,
        amount,
        category_id,
        description,
        value_date,
    } = req.body;

    await withTransaction(async (client) => {
        const accountResult = await client.query(`
            SELECT id, currency_id, account_type, reference_prefix
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [account_id]);

        if (accountResult.rows.length === 0) {
            throw createError.notFound('Account not found');
        }
        const account = accountResult.rows[0];

        const moduleCode = resolveModuleCode(account);

        const { referenceId, referenceCode } = await generateReference(
            client,
            moduleCode,
            'INFLOW',
            'TRANSACTION',
            req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       account_id,
            transactionType: 'CREDIT',
            inflowType:      'OTHER_INCOME',
            amount,
            currencyId:      account.currency_id,
            categoryId:      category_id,
            description,
            valueDate:       value_date,
            createdBy:       req.user.id,
            referenceId,
        });

        await linkReferenceToRecord(client, referenceId, transactionId);

        await logAction(req.user.id, ACTIONS.TRANSACTION_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transactions',
            recordId:    transactionId,
            newValues:   { amount, referenceCode, balanceBefore, balanceAfter },
            description: `Inflow recorded: ${referenceCode} — ${description}`,
            client,
        });

        sendCreated(res, {
            reference:      referenceCode,
            transaction_id: transactionId,
            amount,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Inflow recorded successfully. Reference: ${referenceCode}`);
    });
});

// ============================================================
// RECORD DIRECT EXPENSE
// POST /api/transactions/expenses
// Money going OUT of any account for operational expenses.
// Primary account enforces floor limit.
// ============================================================
const recordExpense = asyncHandler(async (req, res) => {
    const {
        account_id,
        amount,
        category_id,
        description,
        value_date,
    } = req.body;

    await withTransaction(async (client) => {
        // Get the account
        const accountResult = await client.query(`
            SELECT id, currency_id, account_type, reference_prefix
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [account_id]);

        if (accountResult.rows.length === 0) {
            throw createError.notFound('Account not found');
        }
        const account = accountResult.rows[0];

        // Determine module code for reference — the account's own
        // reference_prefix if it has one, else the generic PA/SA code
        const moduleCode = resolveModuleCode(account);

        // Generate reference: PA-EXPENSE-YYYYMM-00001 (or tailored prefix)
        const { referenceId, referenceCode } = await generateReference(
            client,
            moduleCode,
            'EXPENSE',
            'TRANSACTION',
            req.user.id
        );

        // Post the transaction
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       account_id,
            transactionType: 'DEBIT',
            inflowType:      'EXPENSE',
            amount,
            currencyId:      account.currency_id,
            categoryId:      category_id,
            description,
            valueDate:       value_date,
            createdBy:       req.user.id,
            referenceId,
        });

        await linkReferenceToRecord(client, referenceId, transactionId);

        await logAction(req.user.id, ACTIONS.TRANSACTION_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transactions',
            recordId:    transactionId,
            newValues:   { amount, referenceCode, balanceBefore, balanceAfter },
            description: `Expense recorded: ${referenceCode} — ${description}`,
            client,
        });

        sendCreated(res, {
            reference:      referenceCode,
            transaction_id: transactionId,
            amount,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `Expense recorded successfully. Reference: ${referenceCode}`);
    });
});

// ============================================================
// REVERSE A TRANSACTION
// POST /api/transactions/:id/reverse
// Creates a new reversal entry linked to the original.
// The original transaction is never modified.
// ============================================================
const reverseTransaction = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        // Get the original transaction
        const original = await client.query(`
            SELECT t.*, a.account_type, a.currency_id, a.reference_prefix
            FROM   transactions t
            JOIN   accounts a ON a.id = t.account_id
            WHERE  t.id = $1
        `, [id]);

        if (original.rows.length === 0) {
            throw createError.notFound('Transaction not found');
        }

        const tx = original.rows[0];

        // Cannot reverse an already reversed transaction
        if (tx.is_reversed) {
            throw createError.badRequest('This transaction has already been reversed');
        }

        // Cannot reverse a reversal
        if (tx.is_reversal) {
            throw createError.badRequest('Cannot reverse a reversal entry');
        }

        // Determine the reversal type — opposite of original
        const reversalType = tx.transaction_type === 'CREDIT'
            ? 'REVERSAL_DEBIT'
            : 'REVERSAL_CREDIT';

        // Generate reversal reference — uses the account's own tailored
        // prefix if it has one, else falls back to the generic PA/SA code
        const { referenceId, referenceCode } = await generateReference(
            client,
            resolveModuleCode(tx),
            'REV',
            'TRANSACTION',
            req.user.id
        );

        // Post the reversal transaction
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       tx.account_id,
            transactionType: reversalType,
            inflowType:      tx.inflow_type,
            amount:          tx.amount,
            currencyId:      tx.currency_id,
            categoryId:      tx.category_id,
            description:     `REVERSAL of ${tx.description} — Reason: ${reason}`,
            valueDate:       new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId,
            reversalOf:      tx.id,
            isReversal:      true,
        });

        await linkReferenceToRecord(client, referenceId, transactionId);

        // Mark the original as reversed
        await client.query(`
            UPDATE transactions
            SET    is_reversed = TRUE
            WHERE  id = $1
        `, [tx.id]);

        await logAction(req.user.id, ACTIONS.TRANSACTION_REVERSED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'transactions',
            recordId:    transactionId,
            oldValues:   { original_transaction_id: tx.id },
            newValues:   { referenceCode, reason, balanceBefore, balanceAfter },
            description: `Transaction reversed: ${referenceCode} — Reason: ${reason}`,
            client,
        });

        sendCreated(res, {
            reversal_reference: referenceCode,
            reversal_id:        transactionId,
            original_id:        tx.id,
            balance_before:     balanceBefore,
            balance_after:      balanceAfter,
        }, `Transaction reversed successfully. Reference: ${referenceCode}`);
    });
});

// ============================================================
// GET TRANSACTION LEDGER
// GET /api/transactions?account_id=1&page=1&limit=20
// Returns paginated transaction history for an account.
// ============================================================
const getTransactions = asyncHandler(async (req, res) => {
    const { account_id, inflow_type, from_date, to_date } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (account_id) {
        p++; conditions.push(`t.account_id = $${p}`);
        params.push(account_id);
    }
    if (inflow_type) {
        p++; conditions.push(`t.inflow_type = $${p}`);
        params.push(inflow_type.toUpperCase());
    }
    if (from_date) {
        p++; conditions.push(`t.value_date >= $${p}`);
        params.push(from_date);
    }
    if (to_date) {
        p++; conditions.push(`t.value_date <= $${p}`);
        params.push(to_date);
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    // Count total
    const countResult = await query(
        `SELECT COUNT(*) AS total FROM transactions t ${where}`,
        params
    );
    const total = parseInt(countResult.rows[0].total);

    // Fetch page
    params.push(limit, offset);
    const result = await query(`
        SELECT
            t.id,
            t.transaction_type,
            t.inflow_type,
            t.amount,
            t.balance_before,
            t.balance_after,
            t.description,
            t.value_date,
            t.is_reversal,
            t.is_reversed,
            t.status,
            t.posted_at,
            r.reference_code,
            r.public_id,
            c.code   AS currency_code,
            c.symbol AS currency_symbol,
            cat.name AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            a.name AS account_name
        FROM  transactions t
        JOIN  references_registry r  ON r.id  = t.reference_id
        JOIN  currencies c           ON c.id  = t.currency_id
        JOIN  categories cat         ON cat.id = t.category_id
        JOIN  category_paths cp      ON cp.category_id = t.category_id
        JOIN  users u                ON u.id  = t.created_by
        JOIN  accounts a             ON a.id  = t.account_id
        ${where}
        ORDER BY t.posted_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE TRANSACTION
// GET /api/transactions/:id
// ============================================================
const getTransactionById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            t.*,
            r.reference_code,
            r.public_id,
            c.code   AS currency_code,
            c.symbol AS currency_symbol,
            cat.name AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            a.name AS account_name,
            a.account_type
        FROM  transactions t
        JOIN  references_registry r  ON r.id  = t.reference_id
        JOIN  currencies c           ON c.id  = t.currency_id
        JOIN  categories cat         ON cat.id = t.category_id
        JOIN  category_paths cp      ON cp.category_id = t.category_id
        JOIN  users u                ON u.id  = t.created_by
        JOIN  accounts a             ON a.id  = t.account_id
        WHERE t.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Transaction not found');
    }

    sendSuccess(res, result.rows[0]);
});

module.exports = {
    recordContribution,
    creditShareholderContribution,
    recordExpense,
    recordInflow,
    reverseTransaction,
    getTransactions,
    getTransactionById,
    postTransaction,
};