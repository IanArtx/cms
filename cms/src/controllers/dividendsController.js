// ============================================================
// DIVIDENDS & AUTHORITY PAYMENTS CONTROLLER
// Handles dividend declarations, distributions to shareholders,
// and payments to regulatory authorities.
//
// v1.22.0: approving a dividend now actually pays shareholders,
// inside the system, rather than just producing a calculated record
// for someone to action externally. Each shareholder's proportional
// share (already calculated at declaration time, off live shareholding
// percentages — unchanged) is credited to their own savings_balances
// row, the same ledger the Savings module uses, so it becomes real,
// withdrawable money via the existing Savings handout flow.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { getSavingsAccount, getOrCreateSavingsBalance } = require('./savingsController');
const { notify, notifyMany } = require('../services/notificationService');

// Add module codes for dividends and authority payments
MODULE_CODES.DIVIDEND          = 'DIV';
MODULE_CODES.AUTHORITY_PAYMENT = 'AUTH';

// ============================================================
// DECLARE DIVIDEND
// POST /api/dividends
// Creates a dividend record and calculates each shareholder's share.
// ============================================================
const declareDividend = asyncHandler(async (req, res) => {
    const {
        account_id,
        category_id,
        total_amount,
        period_label,
        declaration_date,
        notes,
    } = req.body;

    await withTransaction(async (client) => {
        // Get the account
        const account = await client.query(
            'SELECT id, currency_id, name FROM accounts WHERE id = $1 AND is_active = TRUE',
            [account_id]
        );
        if (account.rows.length === 0) {
            throw createError.notFound('Account not found');
        }

        // Get all active shareholders with their percentages
        const shareholders = await client.query(`
            SELECT
                sr.user_id,
                sr.shares_held,
                sr.percentage,
                u.first_name,
                u.last_name,
                u.email
            FROM shareholding_registry sr
            JOIN users u ON u.id = sr.user_id
            WHERE sr.effective_to IS NULL
            AND   sr.percentage IS NOT NULL
            AND   u.is_active = TRUE
            ORDER BY sr.percentage DESC
        `);

        if (shareholders.rows.length === 0) {
            throw createError.badRequest(
                'No shareholders with assigned percentages found. ' +
                'Please assign shareholding percentages before declaring dividends.'
            );
        }

        // Verify percentages add up to 100
        const totalPercentage = shareholders.rows.reduce(
            (sum, s) => sum + parseFloat(s.percentage), 0
        );
        if (Math.abs(totalPercentage - 100) > 0.01) {
            throw createError.badRequest(
                `Shareholder percentages total ${totalPercentage.toFixed(2)}% ` +
                `but must equal 100%. Please update shareholding records.`
            );
        }

        // Generate dividend reference
        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.DIVIDEND, 'DIVID', 'DIVIDEND', req.user.id
        );

        // Create the dividend record
        const dividendResult = await client.query(`
            INSERT INTO dividends (
                reference_id, account_id, currency_id, category_id,
                total_amount, period_label, declaration_date,
                status, notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)
            RETURNING id
        `, [
            referenceId, account_id, account.rows[0].currency_id,
            category_id, total_amount, period_label || null,
            declaration_date, notes || null, req.user.id,
        ]);

        const dividendId = dividendResult.rows[0].id;
        await linkReferenceToRecord(client, referenceId, dividendId);

        // Calculate and create distribution records for each shareholder
        const distributions = [];
        for (const shareholder of shareholders.rows) {
            const shareAmount = parseFloat(
                (parseFloat(total_amount) *
                parseFloat(shareholder.percentage) / 100).toFixed(4)
            );

            await client.query(`
                INSERT INTO dividend_distributions (
                    dividend_id, user_id, shares_at_time,
                    percentage_at_time, amount, status
                ) VALUES ($1, $2, $3, $4, $5, 'PENDING')
            `, [
                dividendId, shareholder.user_id,
                shareholder.shares_held, shareholder.percentage,
                shareAmount,
            ]);

            distributions.push({
                name:       `${shareholder.first_name} ${shareholder.last_name}`,
                percentage: shareholder.percentage,
                amount:     shareAmount,
            });
        }

        await logAction(req.user.id, ACTIONS.DIVIDEND_DECLARED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'dividends',
            recordId:    dividendId,
            newValues:   { referenceCode, total_amount, period_label, distributions },
            description: `Dividend declared: ${referenceCode} — Total: ${total_amount}`,
            client,
        });

        sendCreated(res, {
            dividend_id:   dividendId,
            reference:     referenceCode,
            total_amount,
            period_label,
            status:        'PENDING',
            distributions,
        }, `Dividend declared. Reference: ${referenceCode}`);
    });
});

// ============================================================
// APPROVE AND PAY DIVIDEND
// POST /api/dividends/:id/approve
//
// Two ledger legs, both posted here:
//   1. DEBIT the declaring account for the total dividend amount
//      (inflow_type DIVIDEND_OUT) — unchanged in spirit from before,
//      this is the company's side of "the dividend was paid".
//   2. CREDIT the single Savings account with that same total,
//      converted into the Savings account's currency if it differs
//      from the dividend's own currency (inflow_type
//      DIVIDEND_SAVINGS_IN) — this is the new part. Every
//      shareholder's proportional share (already calculated at
//      declaration time) is then added to their own savings_balances
//      row, making it real, withdrawable money via the existing
//      Savings handout flow.
//
// Currency conversion is manual, not automatic: this system's
// currency_exchange_rates table is documented as display-only and
// deliberately never used for real money calculations (Section 4.4)
// — the same reasoning cross-currency Transfers already follow. If
// the dividend's currency differs from the Savings account's
// currency, the caller must supply `exchange_rate` (dividend currency
// -> Savings currency); if they already match, no rate is needed and
// 1 is used.
// ============================================================
const approveDividend = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { exchange_rate } = req.body;

    await withTransaction(async (client) => {
        // Get the dividend
        const dividendResult = await client.query(`
            SELECT d.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code
            FROM dividends d
            JOIN accounts a ON a.id = d.account_id
            JOIN references_registry r ON r.id = d.reference_id
            WHERE d.id = $1 FOR UPDATE
        `, [id]);

        if (dividendResult.rows.length === 0) {
            throw createError.notFound('Dividend not found');
        }
        const dividend = dividendResult.rows[0];

        if (dividend.status !== 'PENDING') {
            throw createError.badRequest(
                `Dividend cannot be approved. Status: ${dividend.status}`
            );
        }

        // Get all distributions
        const distributions = await client.query(`
            SELECT dd.*, u.first_name, u.last_name, u.email
            FROM dividend_distributions dd
            JOIN users u ON u.id = dd.user_id
            WHERE dd.dividend_id = $1
        `, [id]);

        // The one dedicated Savings account every shareholder's share
        // is credited into (Section 4.11) — approval fails cleanly with
        // a clear message if it hasn't been set up yet, same as every
        // other Savings-module action.
        const savingsAccount = await getSavingsAccount(client);
        const savingsCurrency = await client.query(
            'SELECT code FROM currencies WHERE id = $1', [savingsAccount.currency_id]
        );
        const savingsCurrencyCode = savingsCurrency.rows[0]?.code || '';

        const sameCurrency = dividend.currency_id === savingsAccount.currency_id;
        let effectiveRate = 1;
        if (!sameCurrency) {
            if (exchange_rate === undefined || exchange_rate === null || exchange_rate === '') {
                throw createError.badRequest(
                    `This dividend is declared in a different currency than the Savings account (${savingsCurrencyCode}). ` +
                    `Enter the exchange rate to convert it before approving.`
                );
            }
            effectiveRate = parseFloat(exchange_rate);
            if (!(effectiveRate > 0)) {
                throw createError.badRequest('Exchange rate must be a positive number');
            }
        }

        // ---- Leg 1: debit the declaring account for the total ----
        const { referenceId: debitRefId, referenceCode: debitRefCode } =
            await generateReference(
                client, resolveModuleCode(dividend), 'DIVID', 'TRANSACTION', req.user.id
            );

        const debitPosting = await postTransaction(client, {
            accountId:       dividend.account_id,
            transactionType: 'DEBIT',
            inflowType:      'DIVIDEND_OUT',
            amount:          dividend.total_amount,
            currencyId:      dividend.currency_id,
            categoryId:      dividend.category_id,
            description:     `Dividend payment — ${dividend.reference_code}` +
                             `${dividend.period_label
                                ? ` (${dividend.period_label})`
                                : ''}`,
            valueDate:       new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId:     debitRefId,
        });
        await linkReferenceToRecord(client, debitRefId, debitPosting.transactionId);

        // ---- Leg 2: credit the Savings account with the converted total ----
        const savingsTotal = parseFloat(
            (parseFloat(dividend.total_amount) * effectiveRate).toFixed(4)
        );

        const { referenceId: creditRefId, referenceCode: creditRefCode } =
            await generateReference(
                client, resolveModuleCode(savingsAccount), 'DIVSAV', 'TRANSACTION', req.user.id
            );

        const creditPosting = await postTransaction(client, {
            accountId:       savingsAccount.id,
            transactionType: 'CREDIT',
            inflowType:      'DIVIDEND_SAVINGS_IN',
            amount:          savingsTotal,
            currencyId:      savingsAccount.currency_id,
            categoryId:      dividend.category_id,
            description:     `Dividend distributed to shareholder savings — ${dividend.reference_code}` +
                             `${dividend.period_label
                                ? ` (${dividend.period_label})`
                                : ''}`,
            valueDate:       new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId:     creditRefId,
        });
        await linkReferenceToRecord(client, creditRefId, creditPosting.transactionId);

        // ---- Credit each shareholder's own savings balance ----
        const notifyList = [];
        for (const dist of distributions.rows) {
            const creditedAmount = parseFloat(
                (parseFloat(dist.amount) * effectiveRate).toFixed(4)
            );

            await getOrCreateSavingsBalance(client, dist.user_id, savingsAccount.currency_id);
            await client.query(`
                UPDATE savings_balances
                SET    principal_balance = principal_balance + $1,
                       currency_id = COALESCE(currency_id, $2),
                       updated_at = NOW()
                WHERE  user_id = $3
            `, [creditedAmount, savingsAccount.currency_id, dist.user_id]);

            await client.query(`
                UPDATE dividend_distributions
                SET    status          = 'PAID',
                       transaction_id  = $1,
                       credited_amount = $2,
                       exchange_rate   = $3,
                       paid_at         = NOW()
                WHERE  id = $4
            `, [creditPosting.transactionId, creditedAmount, effectiveRate, dist.id]);

            // notifyMany() below treats `id` as the recipient's user id —
            // dist.id is the dividend_distributions row's own PK, not the
            // user's, so it's kept separately as distributionId instead.
            notifyList.push({
                id: dist.user_id,
                distributionId: dist.id,
                first_name: dist.first_name,
                last_name: dist.last_name,
                email: dist.email,
                creditedAmount,
            });
        }

        // Update dividend status — both legs and the rate used
        await client.query(`
            UPDATE dividends
            SET    status                  = 'PAID',
                   payment_date             = NOW(),
                   approved_by              = $1,
                   approved_at              = NOW(),
                   transaction_id           = $2,
                   savings_transaction_id   = $3,
                   exchange_rate            = $4
            WHERE  id = $5
        `, [req.user.id, debitPosting.transactionId, creditPosting.transactionId, effectiveRate, id]);

        await logAction(req.user.id, ACTIONS.DIVIDEND_PAID, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'dividends',
            recordId:    parseInt(id),
            newValues:   {
                debitRefCode, creditRefCode, effectiveRate,
                balanceBefore: debitPosting.balanceBefore, balanceAfter: debitPosting.balanceAfter,
                savingsTotal,
            },
            description: `Dividend approved and paid into shareholder savings: ${dividend.reference_code}` +
                         `${!sameCurrency ? ` (converted at rate ${effectiveRate})` : ''}`,
            client,
        });

        // Best-effort, non-blocking — same pattern as every other
        // notify()/notifyMany() call in this codebase (e.g.
        // serviceFeesController's SERVICE_FEE_PAID notification).
        notifyMany(notifyList, 'DIVIDEND_PAID', (recipient) => ({
            title: 'Dividend credited to your savings',
            body:  `Your dividend share of ${recipient.creditedAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${savingsCurrencyCode} ` +
                   `(${dividend.reference_code}) has been added to your Savings balance.`,
            link:       '/savings',
            module:     'FINANCE',
            recordType: 'dividend_distributions',
            recordId:   recipient.distributionId,
        })).catch(() => {});

        sendSuccess(res, {
            status:                 'PAID',
            debit_reference:        debitRefCode,
            savings_reference:      creditRefCode,
            total_amount:           dividend.total_amount,
            total_credited_savings: savingsTotal,
            exchange_rate:          effectiveRate,
            savings_currency:       savingsCurrencyCode,
            balance_before:         debitPosting.balanceBefore,
            balance_after:          debitPosting.balanceAfter,
            distributions_paid:     distributions.rows.length,
        }, 'Dividend approved and credited to shareholder savings balances');
    });
});

// ============================================================
// GET ALL DIVIDENDS
// GET /api/dividends
// ============================================================
const getAllDividends = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`d.status = $${p}`);
        params.push(status.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM dividends d ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            d.id,
            d.total_amount,
            d.period_label,
            d.declaration_date,
            d.payment_date,
            d.status,
            d.notes,
            d.created_at,
            d.created_by,
            d.account_id,
            d.category_id,
            r.reference_code,
            r.public_id,
            a.name       AS account_name,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            u.first_name || ' ' || u.last_name AS created_by_name,
            (SELECT COUNT(*) FROM dividend_distributions dd
             WHERE dd.dividend_id = d.id) AS shareholder_count,
            d.exchange_rate,
            -- Lets the frontend show "needs an exchange rate" on a
            -- PENDING row without a second round trip: TRUE if this
            -- dividend's currency differs from the single Savings
            -- account's currency (Section 4.12).
            (
                SELECT sa.currency_id IS DISTINCT FROM d.currency_id
                FROM   accounts sa
                WHERE  sa.account_type = 'SAVINGS' AND sa.is_active = TRUE
                LIMIT 1
            ) AS needs_exchange_rate
        FROM  dividends d
        JOIN  references_registry r ON r.id  = d.reference_id
        JOIN  accounts a            ON a.id  = d.account_id
        JOIN  currencies c          ON c.id  = d.currency_id
        JOIN  categories cat        ON cat.id = d.category_id
        JOIN  users u               ON u.id  = d.created_by
        ${where}
        ORDER BY d.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE DIVIDEND WITH DISTRIBUTIONS
// GET /api/dividends/:id
// ============================================================
const getDividendById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            d.*,
            r.reference_code,
            a.name       AS account_name,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            u.first_name || ' ' || u.last_name AS created_by_name,
            (
                SELECT json_agg(dist ORDER BY dist.amount DESC)
                FROM (
                    SELECT
                        dd.id,
                        dd.shares_at_time,
                        dd.percentage_at_time,
                        dd.amount,
                        dd.credited_amount,
                        dd.exchange_rate,
                        dd.status,
                        dd.paid_at,
                        du.first_name || ' ' || du.last_name AS member_name,
                        du.email AS member_email
                    FROM dividend_distributions dd
                    JOIN users du ON du.id = dd.user_id
                    WHERE dd.dividend_id = d.id
                ) dist
            ) AS distributions,
            (SELECT sa.id FROM accounts sa WHERE sa.account_type = 'SAVINGS' AND sa.is_active = TRUE LIMIT 1) AS savings_account_id,
            (SELECT sc.code FROM accounts sa JOIN currencies sc ON sc.id = sa.currency_id
             WHERE sa.account_type = 'SAVINGS' AND sa.is_active = TRUE LIMIT 1) AS savings_currency_code,
            (
                SELECT sa.currency_id IS DISTINCT FROM d.currency_id
                FROM   accounts sa
                WHERE  sa.account_type = 'SAVINGS' AND sa.is_active = TRUE
                LIMIT 1
            ) AS needs_exchange_rate
        FROM  dividends d
        JOIN  references_registry r ON r.id  = d.reference_id
        JOIN  accounts a            ON a.id  = d.account_id
        JOIN  currencies c          ON c.id  = d.currency_id
        JOIN  categories cat        ON cat.id = d.category_id
        JOIN  users u               ON u.id  = d.created_by
        WHERE d.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Dividend not found');
    }

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// RECORD AUTHORITY PAYMENT
// POST /api/dividends/authority-payments
// Records a payment to URA, URSB, or any regulatory body.
// ============================================================
const recordAuthorityPayment = asyncHandler(async (req, res) => {
    const {
        account_id,
        category_id,
        authority_type,
        authority_name,
        payment_type,
        authority_ref,
        amount,
        payment_date,
        notes,
    } = req.body;

    await withTransaction(async (client) => {
        // Get the account
        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1 AND is_active = TRUE',
            [account_id]
        );
        if (account.rows.length === 0) {
            throw createError.notFound('Account not found');
        }

        // Generate reference
        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.AUTHORITY_PAYMENT, 'AUTHPAY',
            'AUTHORITY_PAYMENT', req.user.id
        );

        // Generate transaction reference
        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(
                client, resolveModuleCode(account.rows[0]), 'AUTH', 'TRANSACTION', req.user.id
            );

        // Post the debit transaction
        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       account_id,
                transactionType: 'DEBIT',
                inflowType:      'EXPENSE',
                amount,
                currencyId:      account.rows[0].currency_id,
                categoryId:      category_id,
                description:     `${authority_type} Payment — ${authority_name}` +
                                 `${payment_type ? ` (${payment_type})` : ''}` +
                                 `${authority_ref ? ` Ref: ${authority_ref}` : ''}`,
                valueDate:       payment_date,
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Record the authority payment
        const payResult = await client.query(`
            INSERT INTO authority_payments (
                reference_id, account_id, currency_id, category_id,
                transaction_id, authority_type, authority_name,
                payment_type, authority_ref, amount, payment_date,
                notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id
        `, [
            referenceId, account_id, account.rows[0].currency_id,
            category_id, transactionId, authority_type, authority_name,
            payment_type || null, authority_ref || null, amount,
            payment_date, notes || null, req.user.id,
        ]);

        await linkReferenceToRecord(client, referenceId, payResult.rows[0].id);

        await logAction(req.user.id, ACTIONS.AUTHORITY_PAYMENT_MADE, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'authority_payments',
            recordId:    payResult.rows[0].id,
            newValues:   { referenceCode, amount, authority_name, balanceBefore, balanceAfter },
            description: `Authority payment: ${referenceCode} — ${authority_name}: ${amount}`,
            client,
        });

        sendCreated(res, {
            payment_id:            payResult.rows[0].id,
            reference:             referenceCode,
            transaction_reference: txRefCode,
            authority_name,
            authority_type,
            amount,
            balance_before:        balanceBefore,
            balance_after:         balanceAfter,
        }, `Authority payment recorded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// GET ALL AUTHORITY PAYMENTS
// GET /api/dividends/authority-payments
// ============================================================
const getAllAuthorityPayments = asyncHandler(async (req, res) => {
    const { authority_type } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (authority_type) {
        p++; conditions.push(`ap.authority_type = $${p}`);
        params.push(authority_type.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM authority_payments ap ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            ap.id,
            ap.authority_type,
            ap.authority_name,
            ap.payment_type,
            ap.authority_ref,
            ap.amount,
            ap.payment_date,
            ap.notes,
            ap.created_at,
            r.reference_code,
            a.name       AS account_name,
            c.code       AS currency_code,
            cat.name     AS category_name,
            u.first_name || ' ' || u.last_name AS created_by_name
        FROM  authority_payments ap
        JOIN  references_registry r ON r.id  = ap.reference_id
        JOIN  accounts a            ON a.id  = ap.account_id
        JOIN  currencies c          ON c.id  = ap.currency_id
        JOIN  categories cat        ON cat.id = ap.category_id
        JOIN  users u               ON u.id  = ap.created_by
        ${where}
        ORDER BY ap.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// EDIT A DIVIDEND (before approval)
// PATCH /api/dividends/:id
// Only while still PENDING. Editable by whoever declared it, or
// any Treasurer. If total_amount changes, every shareholder's
// distribution is recalculated from scratch using today's
// shareholding percentages — safe because nothing has been paid
// out yet at this stage.
// ============================================================
const editDividend = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        account_id, category_id, total_amount,
        period_label, declaration_date, notes,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM dividends WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Dividend not found');
        }
        const dividend = existing.rows[0];

        if (dividend.status !== 'PENDING') {
            throw createError.badRequest('Only a pending dividend can be edited');
        }

        const isCreator = dividend.created_by === req.user.id;
        const isTreasurer = (req.user.roles || []).includes('Treasurer');
        if (!isCreator && !isTreasurer) {
            throw createError.forbidden(
                'Only the person who declared this dividend, or a Treasurer, can edit it'
            );
        }

        let currencyId = dividend.currency_id;
        if (account_id) {
            const account = await client.query(
                'SELECT id, currency_id FROM accounts WHERE id = $1 AND is_active = TRUE', [account_id]
            );
            if (account.rows.length === 0) {
                throw createError.notFound('Account not found');
            }
            currencyId = account.rows[0].currency_id;
        }

        const newTotal = total_amount !== undefined ? parseFloat(total_amount) : parseFloat(dividend.total_amount);

        const updated = await client.query(`
            UPDATE dividends
            SET    account_id       = COALESCE($1, account_id),
                   currency_id      = $2,
                   category_id      = COALESCE($3, category_id),
                   total_amount     = $4,
                   period_label     = COALESCE($5, period_label),
                   declaration_date = COALESCE($6, declaration_date),
                   notes            = COALESCE($7, notes)
            WHERE  id = $8
            RETURNING *
        `, [
            account_id || null, currencyId, category_id || null, newTotal,
            period_label !== undefined ? period_label : null,
            declaration_date || null, notes !== undefined ? notes : null,
            id,
        ]);

        // Recalculate the distribution list if the total changed
        let distributions = null;
        if (total_amount !== undefined && newTotal !== parseFloat(dividend.total_amount)) {
            const shareholders = await client.query(`
                SELECT sr.user_id, sr.shares_held, sr.percentage,
                       u.first_name, u.last_name
                FROM   shareholding_registry sr
                JOIN   users u ON u.id = sr.user_id
                WHERE  sr.effective_to IS NULL
                AND    sr.percentage IS NOT NULL
                AND    u.is_active = TRUE
            `);

            await client.query('DELETE FROM dividend_distributions WHERE dividend_id = $1', [id]);

            distributions = [];
            for (const shareholder of shareholders.rows) {
                const shareAmount = parseFloat(
                    (newTotal * parseFloat(shareholder.percentage) / 100).toFixed(4)
                );
                await client.query(`
                    INSERT INTO dividend_distributions (
                        dividend_id, user_id, shares_at_time,
                        percentage_at_time, amount, status
                    ) VALUES ($1, $2, $3, $4, $5, 'PENDING')
                `, [
                    id, shareholder.user_id,
                    shareholder.shares_held, shareholder.percentage, shareAmount,
                ]);
                distributions.push({
                    name:       `${shareholder.first_name} ${shareholder.last_name}`,
                    percentage: shareholder.percentage,
                    amount:     shareAmount,
                });
            }
        }

        await logAction(req.user.id, ACTIONS.DIVIDEND_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'dividends',
            recordId:    id,
            oldValues:   dividend,
            newValues:   { ...updated.rows[0], distributions },
            description: `Dividend edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, { ...updated.rows[0], distributions }, 'Dividend updated');
    });
});

module.exports = {
    declareDividend,
    editDividend,
    approveDividend,
    getAllDividends,
    getDividendById,
    recordAuthorityPayment,
    getAllAuthorityPayments,
};