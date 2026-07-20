// ============================================================
// DIVIDENDS & AUTHORITY PAYMENTS CONTROLLER
// Handles dividend declarations, distributions to shareholders,
// and payments to regulatory authorities.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');

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
// Approves the dividend and posts a debit transaction for each
// shareholder distribution from the account.
// ============================================================
const approveDividend = asyncHandler(async (req, res) => {
    const { id } = req.params;

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
            SELECT dd.*, u.first_name, u.last_name
            FROM dividend_distributions dd
            JOIN users u ON u.id = dd.user_id
            WHERE dd.dividend_id = $1
        `, [id]);

        // Generate one transaction for the total dividend payment
        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(
                client,
                resolveModuleCode(dividend),
                'DIVID',
                'TRANSACTION',
                req.user.id
            );

        // Post single debit for total dividend amount
        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       dividend.account_id,
                transactionType: 'DEBIT',
                inflowType:      'EXPENSE',
                amount:          dividend.total_amount,
                currencyId:      dividend.currency_id,
                categoryId:      dividend.category_id,
                description:     `Dividend payment — ${dividend.reference_code}` +
                                 `${dividend.period_label
                                    ? ` (${dividend.period_label})`
                                    : ''}`,
                valueDate:       new Date().toISOString().split('T')[0],
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Mark all distributions as paid
        await client.query(`
            UPDATE dividend_distributions
            SET    status = 'PAID',
                   transaction_id = $1,
                   paid_at = NOW()
            WHERE  dividend_id = $2
        `, [transactionId, id]);

        // Update dividend status
        await client.query(`
            UPDATE dividends
            SET    status      = 'PAID',
                   payment_date = NOW(),
                   approved_by  = $1,
                   approved_at  = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        await logAction(req.user.id, ACTIONS.DIVIDEND_PAID, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'dividends',
            recordId:    parseInt(id),
            newValues:   { txRefCode, balanceBefore, balanceAfter },
            description: `Dividend approved and paid: ${dividend.reference_code}`,
            client,
        });

        sendSuccess(res, {
            status:         'PAID',
            transaction_reference: txRefCode,
            total_paid:     dividend.total_amount,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
            distributions_paid: distributions.rows.length,
        }, 'Dividend approved and payment recorded');
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
             WHERE dd.dividend_id = d.id) AS shareholder_count
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
                        dd.status,
                        dd.paid_at,
                        du.first_name || ' ' || du.last_name AS member_name,
                        du.email AS member_email
                    FROM dividend_distributions dd
                    JOIN users du ON du.id = dd.user_id
                    WHERE dd.dividend_id = d.id
                ) dist
            ) AS distributions
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