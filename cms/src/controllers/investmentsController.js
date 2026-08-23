// ============================================================
// INVESTMENTS & PROJECTS CONTROLLER
// Handles investment portfolio tracking and project management.
//
// RULES ENFORCED HERE:
//   - Investments are always funded from secondary accounts
//   - Returns always go back to the funding source account
//   - Returns are always in the same currency as the investment
//   - Projects belong to investments
//   - Budget tracking at both investment and project level
//   - Milestones tracked per project
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { generateBondCouponSchedule } = require('../utils/bondSchedule');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');

// ============================================================
// v1.40.0 SHARED HELPERS
// ============================================================

// Statuses in which returns/expenses can still be recorded against an
// investment — normal operation (ACTIVE) plus the termination review
// window (PENDING_TERMINATION), so the responsible person can catch up
// any missing entries before confirming records are up to date.
const MUTABLE_INVESTMENT_STATUSES = ['ACTIVE', 'PENDING_TERMINATION'];

// Every time actual_expenditure grows (capital funding, or an
// operational EXPENSE/TAX entry), figure out how much of THIS increase
// falls beyond planned_budget and should be logged as supplementary
// budget. Handles partial overage correctly (e.g. spend that's half
// within budget, half beyond it) and works whether the investment was
// already over budget or not. Returns the new expenditure total and
// the supplementary delta to add — callers do the actual UPDATE
// themselves (they usually already hold a FOR UPDATE lock on the row).
function computeSupplementaryOverage(plannedBudget, currentExpenditure, amount) {
    const planned    = parseFloat(plannedBudget);
    const before      = parseFloat(currentExpenditure);
    const newExpenditure = before + parseFloat(amount);
    const overageBefore  = Math.max(0, before - planned);
    const overageAfter   = Math.max(0, newExpenditure - planned);
    return {
        newExpenditure,
        supplementaryDelta: overageAfter - overageBefore,
    };
}

function round2(n) {
    return Math.round((parseFloat(n) + Number.EPSILON) * 100) / 100;
}

// ============================================================
// CREATE INVESTMENT
// POST /api/investments
// ============================================================
const createInvestment = asyncHandler(async (req, res) => {
    const {
        name,
        description,
        category_id,
        funding_account_id,
        planned_budget,
        start_date,
        expected_end_date,
        responsible_user_id,
        investment_type,
        face_value,
        coupon_rate,
        coupon_frequency,
        tax_withholding_rate,
        first_coupon_date,
        settlement_value,
    } = req.body;

    const isBond = investment_type === 'BOND';

    if (isBond) {
        // These are also enforced by the DB's bond_fields_required
        // check constraint, but checking here first gives a much
        // friendlier error message than a raw Postgres error.
        if (!face_value || face_value <= 0) {
            throw createError.badRequest('Bond investments require a face value greater than zero');
        }
        if (coupon_rate === undefined || coupon_rate === null || coupon_rate < 0) {
            throw createError.badRequest('Bond investments require an interest (coupon) rate');
        }
        if (!coupon_frequency) {
            throw createError.badRequest('Bond investments require a coupon payment frequency');
        }
        if (!start_date || !expected_end_date) {
            throw createError.badRequest('Bond investments require both an issue date and a maturity date');
        }
    }

    await withTransaction(async (client) => {
        // Verify funding account exists and is secondary
        const account = await client.query(`
            SELECT id, account_type, currency_id, name
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [funding_account_id]);

        if (account.rows.length === 0) {
            throw createError.notFound('Funding account not found');
        }
        if (account.rows[0].account_type !== 'SECONDARY') {
            throw createError.badRequest(
                'Investments must be funded from a secondary operational account'
            );
        }

        // Generate investment reference: INV-INVEST-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.INVESTMENT,
            'INVEST',
            'INVESTMENT',
            req.user.id
        );

        // Create investment record
        const result = await client.query(`
            INSERT INTO investments (
                reference_id,
                name,
                description,
                category_id,
                funding_account_id,
                currency_id,
                planned_budget,
                actual_expenditure,
                returns_account_id,
                total_returns,
                status,
                start_date,
                expected_end_date,
                responsible_user_id,
                created_by,
                investment_type,
                face_value,
                coupon_rate,
                coupon_frequency,
                tax_withholding_rate,
                first_coupon_date,
                settlement_value
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, 0, $5, 0,
                'PENDING', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
            )
            RETURNING id
        `, [
            referenceId,
            name.trim(),
            description || null,
            category_id,
            funding_account_id,
            account.rows[0].currency_id,
            planned_budget,
            start_date || null,
            expected_end_date || null,
            responsible_user_id || null,
            req.user.id,
            investment_type || 'STANDARD',
            isBond ? face_value : null,
            isBond ? coupon_rate : null,
            isBond ? coupon_frequency : null,
            isBond ? (tax_withholding_rate || 0) : 0,
            isBond ? (first_coupon_date || null) : null,
            isBond ? (settlement_value || null) : null,
        ]);

        const investmentId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, investmentId);

        // Bonds get their full coupon (interest payment) schedule
        // generated up front, so the detail page can show expected
        // payment dates and yield before any money has moved.
        if (isBond) {
            const schedule = generateBondCouponSchedule({
                faceValue:           face_value,
                couponRate:          coupon_rate,
                frequency:           coupon_frequency,
                taxWithholdingRate:  tax_withholding_rate || 0,
                issueDate:           start_date,
                maturityDate:        expected_end_date,
                // For a bond the company bought after it was already
                // running, the next coupon date is fixed by the
                // issuer's own schedule, not `frequency` after our
                // start_date — pass it through when supplied.
                firstCouponDate:     first_coupon_date || null,
            });

            for (const coupon of schedule) {
                await client.query(`
                    INSERT INTO bond_coupons (
                        investment_id, coupon_number, due_date,
                        gross_amount, tax_amount, net_amount
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    investmentId, coupon.coupon_number, coupon.due_date,
                    coupon.gross_amount, coupon.tax_amount, coupon.net_amount,
                ]);
            }
        }

        // Create approval workflow
        await client.query(`
            INSERT INTO approval_workflows (
                workflow_type, record_type, record_id,
                required_approvals, initiated_by
            ) VALUES ('INVESTMENT', 'investments', $1, 1, $2)
        `, [investmentId, req.user.id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_CREATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    investmentId,
            newValues:   { referenceCode, name, planned_budget, funding_account_id, investment_type: investment_type || 'STANDARD' },
            description: `Investment created: ${referenceCode} — ${name}`,
            client,
        });

        sendCreated(res, {
            investment_id: investmentId,
            reference:     referenceCode,
            name,
            planned_budget,
            funding_account: account.rows[0].name,
            status:        'PENDING',
        }, `Investment created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT INVESTMENT (before approval)
// PATCH /api/investments/:id
// Only while still PENDING. Editable by whoever created it, or
// anyone who could approve it. For a bond, if any field that
// drives the coupon schedule changes (face value, rate, frequency,
// tax rate, first coupon date), the existing schedule is deleted
// and regenerated — safe at this stage since no coupon can have
// been paid on a not-yet-approved investment.
// ============================================================
const editInvestment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        name, description, category_id, funding_account_id,
        planned_budget, start_date, expected_end_date, responsible_user_id,
        face_value, coupon_rate, coupon_frequency, tax_withholding_rate, first_coupon_date,
        settlement_value,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING') {
            throw createError.badRequest('Only a pending investment can be edited');
        }

        const isCreator = investment.created_by === req.user.id;
        const canApprove = (req.user.permissions || []).includes('INVESTMENT_APPROVE');
        if (!isCreator && !canApprove) {
            throw createError.forbidden(
                'Only the person who created this investment, or someone who can approve it, can edit it'
            );
        }

        const isBond = investment.investment_type === 'BOND';

        let currencyId = investment.currency_id;
        let newFundingAccountId = investment.funding_account_id;
        if (funding_account_id) {
            const account = await client.query(`
                SELECT id, account_type, currency_id FROM accounts
                WHERE  id = $1 AND is_active = TRUE
            `, [funding_account_id]);
            if (account.rows.length === 0) {
                throw createError.notFound('Funding account not found');
            }
            if (account.rows[0].account_type !== 'SECONDARY') {
                throw createError.badRequest(
                    'Investments must be funded from a secondary operational account'
                );
            }
            currencyId = account.rows[0].currency_id;
            newFundingAccountId = funding_account_id;
        }

        const newFaceValue    = isBond ? (face_value           !== undefined ? face_value           : investment.face_value)           : null;
        const newCouponRate   = isBond ? (coupon_rate           !== undefined ? coupon_rate           : investment.coupon_rate)          : null;
        const newFrequency    = isBond ? (coupon_frequency      || investment.coupon_frequency)                                          : null;
        const newTaxRate      = isBond ? (tax_withholding_rate  !== undefined ? tax_withholding_rate  : investment.tax_withholding_rate)  : 0;
        const newStartDate    = start_date        || investment.start_date;
        const newEndDate      = expected_end_date || investment.expected_end_date;
        const newFirstCoupon  = first_coupon_date !== undefined ? first_coupon_date : investment.first_coupon_date;
        const newSettlement   = isBond ? (settlement_value !== undefined ? settlement_value : investment.settlement_value) : null;

        const bondScheduleFieldsChanged = isBond && (
            face_value          !== undefined ||
            coupon_rate          !== undefined ||
            coupon_frequency     !== undefined ||
            tax_withholding_rate !== undefined ||
            first_coupon_date    !== undefined ||
            start_date            !== undefined ||
            expected_end_date     !== undefined
        );

        const updated = await client.query(`
            UPDATE investments
            SET    name                 = COALESCE($1, name),
                   description          = $2,
                   category_id          = COALESCE($3, category_id),
                   funding_account_id   = $4,
                   returns_account_id   = $4,
                   currency_id          = $5,
                   planned_budget       = COALESCE($6, planned_budget),
                   start_date           = $7,
                   expected_end_date    = $8,
                   responsible_user_id  = $9,
                   face_value           = $10,
                   coupon_rate          = $11,
                   coupon_frequency     = $12,
                   tax_withholding_rate = $13,
                   first_coupon_date    = $14,
                   settlement_value     = $15
            WHERE  id = $16
            RETURNING *
        `, [
            name ? name.trim() : null, description !== undefined ? description : investment.description,
            category_id || null, newFundingAccountId, currencyId,
            planned_budget || null, newStartDate, newEndDate,
            responsible_user_id !== undefined ? responsible_user_id : investment.responsible_user_id,
            newFaceValue, newCouponRate, newFrequency, newTaxRate, newFirstCoupon, newSettlement,
            id,
        ]);

        if (bondScheduleFieldsChanged) {
            await client.query('DELETE FROM bond_coupons WHERE investment_id = $1', [id]);
            const schedule = generateBondCouponSchedule({
                faceValue:          newFaceValue,
                couponRate:         newCouponRate,
                frequency:          newFrequency,
                taxWithholdingRate: newTaxRate || 0,
                issueDate:          newStartDate,
                maturityDate:       newEndDate,
                firstCouponDate:    newFirstCoupon || null,
            });
            for (const coupon of schedule) {
                await client.query(`
                    INSERT INTO bond_coupons (
                        investment_id, coupon_number, due_date,
                        gross_amount, tax_amount, net_amount
                    ) VALUES ($1, $2, $3, $4, $5, $6)
                `, [
                    id, coupon.coupon_number, coupon.due_date,
                    coupon.gross_amount, coupon.tax_amount, coupon.net_amount,
                ]);
            }
        }

        await logAction(req.user.id, ACTIONS.INVESTMENT_UPDATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            oldValues:   investment,
            newValues:   updated.rows[0],
            description: `Investment edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Investment updated');
    });
});

// ============================================================
// APPROVE INVESTMENT
// POST /api/investments/:id/approve
// ============================================================
const approveInvestment = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const investment = await client.query(`
            SELECT * FROM investments WHERE id = $1 FOR UPDATE
        `, [id]);

        if (investment.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        if (investment.rows[0].status !== 'PENDING') {
            throw createError.badRequest(
                `Investment cannot be approved. Status: ${investment.rows[0].status}`
            );
        }

        await client.query(`
            UPDATE investments
            SET    status      = 'ACTIVE',
                   approved_by = $1,
                   approved_at = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        await client.query(`
            UPDATE approval_workflows
            SET    status            = 'APPROVED',
                   current_approvals = 1,
                   completed_at      = NOW()
            WHERE  record_type = 'investments'
            AND    record_id   = $1
        `, [id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_APPROVED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    parseInt(id),
            description: `Investment approved: ID ${id}`,
            client,
        });

        sendSuccess(res, null, 'Investment approved successfully');
    });
});

// ============================================================
// FUND INVESTMENT
// POST /api/investments/:id/fund
// Records money being allocated from secondary account
// to this investment.
// ============================================================
const fundInvestment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, category_id, description, value_date, project_id } = req.body;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }

        const investment = investResult.rows[0];

        if (investment.status !== 'ACTIVE') {
            throw createError.badRequest(
                'Investment must be active before funding'
            );
        }

        // Generate transaction reference
        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(
                client,
                resolveModuleCode(investment),
                'INVEST-OUT',
                'TRANSACTION',
                req.user.id
            );

        // Post debit transaction on the funding account
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       investment.funding_account_id,
            transactionType: 'DEBIT',
            inflowType:      'EXPENSE',
            amount,
            currencyId:      investment.currency_id,
            categoryId:      category_id || investment.category_id,
            description:     description ||
                             `Investment funding — ${investment.name} (${investment.reference_code})`,
            valueDate:       value_date,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            investmentId:    investment.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Record investment funding link
        await client.query(`
            INSERT INTO investment_funding (
                investment_id, project_id, transaction_id, amount, created_by
            ) VALUES ($1, $2, $3, $4, $5)
        `, [id, project_id || null, transactionId, amount, req.user.id]);

        // Update actual expenditure on investment — and auto-log any
        // portion of this funding that pushes total spend past
        // planned_budget as supplementary budget (v1.40.0).
        const { newExpenditure, supplementaryDelta } = computeSupplementaryOverage(
            investment.planned_budget, investment.actual_expenditure, amount
        );
        await client.query(`
            UPDATE investments
            SET    actual_expenditure   = $1,
                   supplementary_budget = supplementary_budget + $2
            WHERE  id = $3
        `, [newExpenditure, supplementaryDelta, id]);

        // If linked to a project, update project expenditure too
        if (project_id) {
            await client.query(`
                UPDATE projects
                SET    actual_expenditure = actual_expenditure + $1
                WHERE  id = $2
            `, [amount, project_id]);
        }

        sendCreated(res, {
            transaction_reference: txRefCode,
            amount_funded:         amount,
            balance_before:        balanceBefore,
            balance_after:         balanceAfter,
        }, `Investment funded. Reference: ${txRefCode}`);
    });
});

// ============================================================
// RECORD INVESTMENT RETURN
// POST /api/investments/:id/returns
// Records profit/return coming back into the source account.
// ============================================================
const recordReturn = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { amount, return_type, return_date, notes } = req.body;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }

        const investment = investResult.rows[0];

        // Generate return reference
        const { referenceId: retRefId, referenceCode: retRefCode } =
            await generateReference(
                client,
                MODULE_CODES.INVESTMENT,
                'RETURN',
                'INVESTMENT_RETURN',
                req.user.id
            );

        // Generate transaction reference
        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(investment),
            'INVEST-IN',
            'TRANSACTION',
            req.user.id
        );

        // Post credit transaction — return arrives in source account
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       investment.returns_account_id,
            transactionType: 'CREDIT',
            inflowType:      'INVESTMENT_RETURN',
            amount,
            currencyId:      investment.currency_id,
            categoryId:      investment.category_id,
            description:     `Investment return (${return_type}) — ` +
                             `${investment.name} (${investment.reference_code})`,
            valueDate:       return_date,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            investmentId:    investment.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Record the return
        const returnResult = await client.query(`
            INSERT INTO investment_returns (
                reference_id, investment_id, transaction_id,
                return_type, amount, return_date, notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [
            retRefId, id, transactionId,
            return_type, amount, return_date,
            notes || null, req.user.id,
        ]);

        await linkReferenceToRecord(client, retRefId, returnResult.rows[0].id);

        // Update total returns on investment
        await client.query(`
            UPDATE investments
            SET    total_returns = total_returns + $1
            WHERE  id = $2
        `, [amount, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_RETURN, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investment_returns',
            recordId:    returnResult.rows[0].id,
            newValues:   { retRefCode, amount, return_type, balanceBefore, balanceAfter },
            description: `Investment return recorded: ${retRefCode} — ${amount}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_RETURN_RECORDED',
                title:      'Investment return recorded',
                body:       `A ${return_type.toLowerCase()} return of ${amount} was recorded for ${investment.name}. Reference: ${retRefCode}.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investment_returns',
                recordId:   returnResult.rows[0].id,
                email: {
                    subject: `Investment return recorded — ${investment.name}`,
                    html:    await wrapEmail(`
                        <p>A return has been recorded on an investment you're responsible for:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">Investment</td><td style="padding:4px 0; text-align:right;">${investment.name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Return type</td><td style="padding:4px 0; text-align:right;">${return_type}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${retRefCode}</td></tr>
                        </table>
                    `, { preheader: 'An investment return has been recorded' }),
                },
            });
        }

        sendCreated(res, {
            return_reference: retRefCode,
            return_type,
            amount,
            total_returns:    parseFloat(investment.total_returns) + parseFloat(amount),
            balance_before:   balanceBefore,
            balance_after:    balanceAfter,
        }, `Return recorded. Reference: ${retRefCode}`);
    });
});

// ============================================================
// RECORD INVESTMENT OPERATIONAL TRANSACTION
// POST /api/investments/:id/transactions
// Records a dedicated operational entry against ONE investment —
// an EXPENSE (running cost of the investment), an extra INFLOW
// (income beyond the scheduled/manual returns), or TAX withheld
// on the investment. Every entry here also posts automatically to
// the general ledger via postTransaction, so nothing here bypasses
// the universal transactions table — this just tags which ledger
// entries belong to which investment's own operating budget.
// ============================================================
const recordInvestmentTransaction = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { entry_type, amount, description, entry_date, category_id } = req.body;

    if (!['EXPENSE', 'INFLOW', 'TAX'].includes(entry_type)) {
        throw createError.badRequest('entry_type must be EXPENSE, INFLOW, or TAX');
    }

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = investResult.rows[0];

        if (!MUTABLE_INVESTMENT_STATUSES.includes(investment.status)) {
            throw createError.badRequest(
                'Operational transactions can only be recorded against an active investment, ' +
                'or one currently under termination review'
            );
        }

        // INFLOW is money arriving (credit); EXPENSE and TAX are money
        // leaving the investment's operating cash (debit).
        const isInflow = entry_type === 'INFLOW';

        // Generate a reference for the investment_transactions row itself
        const { referenceId: opRefId, referenceCode: opRefCode } =
            await generateReference(
                client,
                MODULE_CODES.INVESTMENT,
                'INV-OP',
                'INVESTMENT_TRANSACTION',
                req.user.id
            );

        // Generate the general-ledger transaction reference
        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(investment),
            isInflow ? 'INVEST-OP-IN' : 'INVEST-OP-OUT',
            'TRANSACTION',
            req.user.id
        );

        const entryLabel = entry_type === 'TAX' ? 'Tax' :
                            entry_type === 'INFLOW' ? 'Inflow' : 'Expense';

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       investment.returns_account_id,
            transactionType: isInflow ? 'CREDIT' : 'DEBIT',
            inflowType:      isInflow ? 'INVESTMENT_RETURN' : 'EXPENSE',
            amount,
            currencyId:      investment.currency_id,
            categoryId:      category_id || investment.category_id,
            description:     description ||
                             `Investment ${entryLabel.toLowerCase()} — ` +
                             `${investment.name} (${investment.reference_code})`,
            valueDate:       entry_date,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            investmentId:    investment.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        const opResult = await client.query(`
            INSERT INTO investment_transactions (
                reference_id, investment_id, transaction_id,
                entry_type, amount, description, entry_date, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
        `, [
            opRefId, id, transactionId,
            entry_type, amount,
            description || `Investment ${entryLabel.toLowerCase()}`,
            entry_date, req.user.id,
        ]);

        await linkReferenceToRecord(client, opRefId, opResult.rows[0].id);

        // v1.40.0 fix: EXPENSE and TAX entries are real money spent on
        // this investment's behalf and must count toward "Spent"
        // (actual_expenditure), same as capital funding already does —
        // previously this money left the funding account but was never
        // reflected in the investment's own spend figure. INFLOW is
        // income, not spend, so it's left out of actual_expenditure
        // (it's already visible via total_income in the operating
        // budget summary). Any portion that pushes total spend past
        // planned_budget is auto-logged as supplementary budget.
        if (!isInflow) {
            const { newExpenditure, supplementaryDelta } = computeSupplementaryOverage(
                investment.planned_budget, investment.actual_expenditure, amount
            );
            await client.query(`
                UPDATE investments
                SET    actual_expenditure   = $1,
                       supplementary_budget = supplementary_budget + $2
                WHERE  id = $3
            `, [newExpenditure, supplementaryDelta, id]);
        }

        await logAction(req.user.id, ACTIONS.INVESTMENT_RETURN, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investment_transactions',
            recordId:    opResult.rows[0].id,
            newValues:   { opRefCode, entry_type, amount, balanceBefore, balanceAfter },
            description: `Investment ${entryLabel.toLowerCase()} recorded: ${opRefCode} — ${amount}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_OPERATION_RECORDED',
                title:      `Investment ${entryLabel.toLowerCase()} recorded`,
                body:       `An ${entryLabel.toLowerCase()} of ${amount} was recorded against ${investment.name}. Reference: ${opRefCode}.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investment_transactions',
                recordId:   opResult.rows[0].id,
                email: {
                    subject: `Investment ${entryLabel.toLowerCase()} recorded — ${investment.name}`,
                    html:    await wrapEmail(`
                        <p>An operational entry has been recorded against an investment you're responsible for:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">Investment</td><td style="padding:4px 0; text-align:right;">${investment.name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Entry type</td><td style="padding:4px 0; text-align:right;">${entryLabel}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${opRefCode}</td></tr>
                        </table>
                    `, { preheader: 'An investment operational entry has been recorded' }),
                },
            });
        }

        sendCreated(res, {
            reference:      opRefCode,
            entry_type,
            amount,
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, `${entryLabel} recorded. Reference: ${opRefCode}`);
    });
});

// ============================================================
// CREATE PROJECT UNDER INVESTMENT
// POST /api/investments/:id/projects
// ============================================================
const createProject = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        name,
        description,
        category_id,
        planned_budget,
        start_date,
        expected_end_date,
        responsible_user_id,
    } = req.body;

    await withTransaction(async (client) => {
        // Verify investment exists and is active
        const investment = await client.query(`
            SELECT id, status, planned_budget, actual_expenditure, name
            FROM   investments
            WHERE  id = $1
        `, [id]);

        if (investment.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        if (investment.rows[0].status === 'CANCELLED') {
            throw createError.badRequest('Cannot add projects to a cancelled investment');
        }

        // Generate project reference: PRJ-PROJECT-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.PROJECT,
            'PROJ',
            'PROJECT',
            req.user.id
        );

        const result = await client.query(`
            INSERT INTO projects (
                reference_id,
                investment_id,
                name,
                description,
                category_id,
                planned_budget,
                actual_expenditure,
                status,
                start_date,
                expected_end_date,
                responsible_user_id,
                created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, 0,
                'PENDING', $7, $8, $9, $10
            )
            RETURNING id
        `, [
            referenceId,
            id,
            name.trim(),
            description || null,
            category_id,
            planned_budget,
            start_date || null,
            expected_end_date || null,
            responsible_user_id || null,
            req.user.id,
        ]);

        const projectId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, projectId);

        await logAction(req.user.id, ACTIONS.PROJECT_CREATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'projects',
            recordId:    projectId,
            newValues:   { referenceCode, name, planned_budget },
            description: `Project created: ${referenceCode} — ${name}`,
            client,
        });

        sendCreated(res, {
            project_id:    projectId,
            reference:     referenceCode,
            name,
            planned_budget,
            investment:    investment.rows[0].name,
            status:        'PENDING',
        }, `Project created. Reference: ${referenceCode}`);
    });
});

// ============================================================
// ADD PROJECT MILESTONE
// POST /api/investments/:id/projects/:projectId/milestones
// ============================================================
const addMilestone = asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    const { name, description, due_date } = req.body;

    const result = await query(`
        INSERT INTO project_milestones (
            project_id, name, description, due_date,
            status, created_by
        ) VALUES ($1, $2, $3, $4, 'PENDING', $5)
        RETURNING *
    `, [projectId, name.trim(), description || null, due_date, req.user.id]);

    sendCreated(res, result.rows[0], 'Milestone added successfully');
});

// ============================================================
// UPDATE MILESTONE STATUS
// PATCH /api/investments/:id/projects/:projectId/milestones/:milestoneId
// ============================================================
const updateMilestone = asyncHandler(async (req, res) => {
    const { milestoneId, projectId } = req.params;
    const { status, completed_at } = req.body;

    const result = await query(`
        UPDATE project_milestones
        SET    status       = $1,
               completed_at = $2
        WHERE  id         = $3
        AND    project_id = $4
        RETURNING *
    `, [status, completed_at || null, milestoneId, projectId]);

    if (result.rows.length === 0) {
        throw createError.notFound('Milestone not found');
    }

    await logAction(req.user.id, ACTIONS.MILESTONE_UPDATED, MODULES.INVESTMENTS, {
        ipAddress:   req.ip,
        recordType:  'project_milestones',
        recordId:    parseInt(milestoneId),
        newValues:   { status, completed_at },
        description: `Milestone updated to ${status}`,
    });

    sendSuccess(res, result.rows[0], 'Milestone updated successfully');
});

// ============================================================
// UPDATE INVESTMENT STATUS
// PATCH /api/investments/:id/status
// ============================================================
const updateInvestmentStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, actual_end_date } = req.body;

    // v1.40.0: PENDING_TERMINATION and TERMINATED are only reachable via
    // the dedicated /terminate/* endpoints below (which enforce the
    // responsible-person-then-Treasurer sign-off workflow) — this
    // generic endpoint must never be used to bypass it. Its own route
    // validator already excludes these two values from the allowed
    // list; this is a second, defense-in-depth check directly in the
    // controller in case that list is ever loosened.
    if (['PENDING_TERMINATION', 'TERMINATED'].includes(status)) {
        throw createError.badRequest(
            'Use the termination workflow (POST /:id/terminate/request, etc.) to close an investment'
        );
    }

    const result = await query(`
        UPDATE investments
        SET    status          = $1,
               actual_end_date = $2
        WHERE  id = $3
        RETURNING id, status, actual_end_date
    `, [status, actual_end_date || null, id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Investment not found');
    }

    sendSuccess(res, result.rows[0], `Investment status updated to ${status}`);
});

// ============================================================
// GET ALL INVESTMENTS
// GET /api/investments
// ============================================================
const getAllInvestments = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`i.status = $${p}`);
        params.push(status.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM investments i ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            i.id,
            i.name,
            i.description,
            i.planned_budget,
            i.actual_expenditure,
            i.total_returns,
            i.status,
            i.start_date,
            i.expected_end_date,
            i.actual_end_date,
            i.created_at,
            i.created_by,
            i.investment_type,
            i.supplementary_budget,
            r.reference_code,
            r.public_id,
            a.name       AS funding_account,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS responsible_person,
            -- ROI calculation
            CASE
                WHEN i.actual_expenditure > 0 THEN
                    ROUND(((i.total_returns - i.actual_expenditure)
                    / i.actual_expenditure * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage,
            -- v1.40.0: profit/loss flag (see getInvestmentById for the
            -- identical derivation)
            CASE
                WHEN i.actual_expenditure = 0 THEN 'NOT_YET_FUNDED'
                WHEN i.total_returns > i.actual_expenditure THEN 'PROFITABLE'
                WHEN i.total_returns < i.actual_expenditure THEN 'LOSING'
                ELSE 'BREAK_EVEN'
            END AS performance_status,
            -- Project count
            (
                SELECT COUNT(*) FROM projects p
                WHERE  p.investment_id = i.id
            ) AS project_count
        FROM  investments i
        JOIN  references_registry r ON r.id  = i.reference_id
        JOIN  accounts a            ON a.id  = i.funding_account_id
        JOIN  currencies c          ON c.id  = i.currency_id
        JOIN  categories cat        ON cat.id = i.category_id
        JOIN  category_paths cp     ON cp.category_id = i.category_id
        LEFT JOIN users u           ON u.id  = i.responsible_user_id
        ${where}
        ORDER BY i.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET BEST/WORST PERFORMING INVESTMENT
// GET /api/investments/performance-summary
// Lightweight, company-wide summary (name + ROI% only — no budget
// figures) so it's safe to show on every user's dashboard, not just
// those with full INVESTMENT_VIEW access.
//
// v1.28.0: UNIONs in Money Market Fund sub-accounts (a standalone
// module — see mmfController.js) so MMFs compete on ROI right
// alongside every other investment, per the user's explicit
// requirement that MMF performance "should be compared to
// investments and also appear when its ROI is competitively best or
// worst as the other investments." The MMF ROI formula mirrors the
// investment one exactly, substituting principal-in for expenditure
// and (interest − management fees) for returns:
//   ROUND(((total_interest - total_management_fees)
//          / total_principal_in * 100)::numeric, 2)
// ============================================================
const getPerformanceSummary = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, name, investment_type, status, roi_percentage FROM (
            SELECT
                i.id, i.name, i.investment_type, i.status,
                CASE
                    WHEN i.actual_expenditure > 0 THEN
                        ROUND(((i.total_returns - i.actual_expenditure)
                        / i.actual_expenditure * 100)::numeric, 2)
                    ELSE 0
                END AS roi_percentage
            FROM investments i
            WHERE i.status IN ('ACTIVE', 'COMPLETED')
            AND   i.actual_expenditure > 0

            UNION ALL

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
        ) combined
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
// GET SINGLE INVESTMENT WITH FULL DETAILS
// GET /api/investments/:id
// ============================================================
const getInvestmentById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            i.*,
            r.reference_code,
            r.public_id,
            a.name       AS funding_account_name,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            creator.first_name  || ' ' || creator.last_name  AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name,
            responsible.first_name || ' ' || responsible.last_name AS responsible_name,
            term_req.first_name  || ' ' || term_req.last_name  AS termination_requested_by_name,
            term_conf.first_name || ' ' || term_conf.last_name AS records_confirmed_by_name,
            term_appr.first_name || ' ' || term_appr.last_name AS termination_approved_by_name,
            -- ROI
            CASE
                WHEN i.actual_expenditure > 0 THEN
                    ROUND(((i.total_returns - i.actual_expenditure)
                    / i.actual_expenditure * 100)::numeric, 2)
                ELSE 0
            END AS roi_percentage,
            -- v1.40.0: profit/loss flag — derived from the same figures
            -- as roi_percentage, no separate stored field.
            CASE
                WHEN i.actual_expenditure = 0 THEN 'NOT_YET_FUNDED'
                WHEN i.total_returns > i.actual_expenditure THEN 'PROFITABLE'
                WHEN i.total_returns < i.actual_expenditure THEN 'LOSING'
                ELSE 'BREAK_EVEN'
            END AS performance_status,
            -- v1.40.0: bond settlement discount/premium — % of face value
            -- actually paid, and the amount saved (discount, positive)
            -- or paid extra (premium, negative). NULL when no
            -- settlement_value is set (bond bought at par).
            CASE
                WHEN i.settlement_value IS NOT NULL AND i.face_value > 0 THEN
                    ROUND((i.settlement_value / i.face_value * 100)::numeric, 4)
                ELSE NULL
            END AS settlement_percentage,
            CASE
                WHEN i.settlement_value IS NOT NULL THEN i.face_value - i.settlement_value
                ELSE NULL
            END AS settlement_discount_amount,
            -- Projects
            (
                SELECT json_agg(p_data ORDER BY p_data.created_at ASC)
                FROM (
                    SELECT
                        p.id, p.name, p.planned_budget,
                        p.actual_expenditure, p.status,
                        p.start_date, p.expected_end_date, p.created_at,
                        pr.reference_code AS project_reference,
                        -- Milestone summary
                        (SELECT COUNT(*) FROM project_milestones pm
                         WHERE pm.project_id = p.id) AS total_milestones,
                        (SELECT COUNT(*) FROM project_milestones pm
                         WHERE pm.project_id = p.id
                         AND   pm.status = 'COMPLETED') AS completed_milestones
                    FROM projects p
                    JOIN references_registry pr ON pr.id = p.reference_id
                    WHERE p.investment_id = i.id
                ) p_data
            ) AS projects,
            -- Returns summary (profit/income trail — who recorded it, and when)
            (
                SELECT json_agg(ret_data ORDER BY ret_data.return_date ASC)
                FROM (
                    SELECT
                        ir.id, ir.return_type, ir.amount,
                        ir.return_date, ir.notes, ir.created_at,
                        rr.reference_code AS return_reference,
                        retcreator.first_name || ' ' || retcreator.last_name AS recorded_by_name
                    FROM investment_returns ir
                    JOIN references_registry rr ON rr.id = ir.reference_id
                    JOIN users retcreator        ON retcreator.id = ir.created_by
                    WHERE ir.investment_id = i.id
                ) ret_data
            ) AS returns,
            -- Bond coupon schedule (only populated for investment_type = 'BOND')
            (
                SELECT json_agg(bc_data ORDER BY bc_data.coupon_number ASC)
                FROM (
                    SELECT
                        bc.id, bc.coupon_number, bc.due_date,
                        bc.gross_amount, bc.tax_amount, bc.net_amount,
                        bc.status, bc.paid_at,
                        bc.actual_gross_amount, bc.actual_tax_amount, bc.actual_net_amount,
                        bc.adjusted_at,
                        adjuster.first_name || ' ' || adjuster.last_name AS adjusted_by_name
                    FROM bond_coupons bc
                    LEFT JOIN users adjuster ON adjuster.id = bc.adjusted_by
                    WHERE bc.investment_id = i.id
                ) bc_data
            ) AS coupons,
            -- Operational transactions (expenses / extra inflows / tax
            -- recorded directly against this investment's own budget)
            (
                SELECT json_agg(op_data ORDER BY op_data.entry_date ASC)
                FROM (
                    SELECT
                        it.id, it.entry_type, it.amount, it.description,
                        it.entry_date, it.created_at,
                        opr.reference_code AS reference_code,
                        opcreator.first_name || ' ' || opcreator.last_name AS recorded_by_name
                    FROM investment_transactions it
                    JOIN references_registry opr ON opr.id = it.reference_id
                    JOIN users opcreator          ON opcreator.id = it.created_by
                    WHERE it.investment_id = i.id
                ) op_data
            ) AS operations,
            -- Operational budget summary: operating capital funded into the
            -- investment, plus scheduled/manual returns and any extra
            -- operational inflows, minus operational expenses and tax —
            -- gives the running balance of unspent operating capital.
            COALESCE((
                SELECT SUM(it.amount) FROM investment_transactions it
                WHERE it.investment_id = i.id AND it.entry_type = 'INFLOW'
            ), 0) AS operational_inflows,
            COALESCE((
                SELECT SUM(it.amount) FROM investment_transactions it
                WHERE it.investment_id = i.id AND it.entry_type = 'EXPENSE'
            ), 0) AS operational_expenses,
            COALESCE((
                SELECT SUM(it.amount) FROM investment_transactions it
                WHERE it.investment_id = i.id AND it.entry_type = 'TAX'
            ), 0) AS operational_tax
        FROM  investments i
        JOIN  references_registry r    ON r.id  = i.reference_id
        JOIN  accounts a               ON a.id  = i.funding_account_id
        JOIN  currencies c             ON c.id  = i.currency_id
        JOIN  categories cat           ON cat.id = i.category_id
        JOIN  category_paths cp        ON cp.category_id = i.category_id
        JOIN  users creator            ON creator.id = i.created_by
        LEFT JOIN users approver       ON approver.id = i.approved_by
        LEFT JOIN users responsible    ON responsible.id = i.responsible_user_id
        LEFT JOIN users term_req       ON term_req.id  = i.termination_requested_by
        LEFT JOIN users term_conf      ON term_conf.id = i.records_confirmed_by
        LEFT JOIN users term_appr      ON term_appr.id = i.termination_approved_by
        WHERE i.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Investment not found');
    }

    const investment = result.rows[0];

    // Operational budget summary — operating capital funded in, plus all
    // income (scheduled/manual returns + extra operational inflows),
    // minus operational expenses and tax. What's left is the running
    // balance of operating capital not yet spent.
    const operatingCapital     = parseFloat(investment.actual_expenditure) || 0;
    const scheduledReturns     = parseFloat(investment.total_returns) || 0;
    const operationalInflows   = parseFloat(investment.operational_inflows) || 0;
    const operationalExpenses  = parseFloat(investment.operational_expenses) || 0;
    const operationalTax       = parseFloat(investment.operational_tax) || 0;

    investment.operating_budget = {
        operating_capital:    operatingCapital,
        total_income:         scheduledReturns + operationalInflows,
        total_expenses:       operationalExpenses,
        total_tax:            operationalTax,
        running_balance:      operatingCapital + scheduledReturns +
                               operationalInflows - operationalExpenses - operationalTax,
    };

    sendSuccess(res, investment);
});

// ============================================================
// PAY BOND COUPON
// PATCH /api/investments/:id/coupons/:couponId/pay
// Marks one scheduled coupon payment as received. Posts TWO ledger
// entries rather than one: a credit for the GROSS interest (the true
// income earned — recorded as an investment_returns INTEREST row) and,
// if tax was withheld, a debit for the TAX (recorded as an
// investment_transactions TAX entry, the same convention already used
// for a STANDARD investment's own tax entries). The bond issuer never
// actually pays the gross amount into the account — only the net lands
// there — but crediting gross then debiting tax nets to exactly the
// real cash received while keeping interest income and tax withheld
// separately visible and auditable, instead of silently netting them
// into one opaque figure.
// ============================================================
const payBondCoupon = asyncHandler(async (req, res) => {
    const { id, couponId } = req.params;
    const { paid_date, notes, actual_gross_amount } = req.body;

    await withTransaction(async (client) => {
        const investResult = await client.query(`
            SELECT i.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code, r.public_id
            FROM   investments i
            JOIN   accounts a ON a.id = i.funding_account_id
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.id = $1
            FOR UPDATE
        `, [id]);

        if (investResult.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = investResult.rows[0];

        if (investment.investment_type !== 'BOND') {
            throw createError.badRequest('This investment does not have a bond coupon schedule');
        }

        if (!MUTABLE_INVESTMENT_STATUSES.includes(investment.status)) {
            throw createError.badRequest(
                'Coupons can only be paid on an active investment, or one currently under termination review'
            );
        }

        const couponResult = await client.query(`
            SELECT * FROM bond_coupons
            WHERE  id = $1 AND investment_id = $2
            FOR UPDATE
        `, [couponId, id]);

        if (couponResult.rows.length === 0) {
            throw createError.notFound('Coupon not found');
        }
        const coupon = couponResult.rows[0];

        if (coupon.status === 'PAID') {
            throw createError.badRequest('This coupon has already been marked paid');
        }

        // v1.40.0: a coupon can only be paid on or after its due date —
        // this button (and the "Record Actual Payment" variant below)
        // must never be usable to approve a future payment.
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const dueDate = new Date(coupon.due_date); dueDate.setHours(0, 0, 0, 0);
        if (dueDate > today) {
            throw createError.badRequest(
                `This coupon is not due until ${coupon.due_date} — it cannot be marked paid before then`
            );
        }

        const paymentDate = paid_date || coupon.due_date;

        // v1.40.0: "Record Actual Payment" — the amount actually
        // received differs from what was scheduled (a bond can pay out
        // differently from the coupon math for reasons determined
        // outside the system). Tax is auto-recalculated on the new
        // gross amount using the bond's own tax_withholding_rate; the
        // rest of the coupon schedule (other coupons) is untouched.
        const isAdjusted = actual_gross_amount !== undefined && actual_gross_amount !== null;
        const grossAmount = isAdjusted ? parseFloat(actual_gross_amount) : parseFloat(coupon.gross_amount);
        const taxRate     = parseFloat(investment.tax_withholding_rate) || 0;
        const taxAmount   = isAdjusted ? round2(grossAmount * (taxRate / 100)) : (parseFloat(coupon.tax_amount) || 0);
        const netAmount   = isAdjusted ? round2(grossAmount - taxAmount) : parseFloat(coupon.net_amount);

        // --- 1. Gross interest — the true income earned on the bond ---
        const { referenceId: retRefId, referenceCode: retRefCode } =
            await generateReference(
                client,
                MODULE_CODES.INVESTMENT,
                'RETURN',
                'INVESTMENT_RETURN',
                req.user.id
            );

        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(investment),
            'INVEST-IN',
            'TRANSACTION',
            req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       investment.returns_account_id,
            transactionType: 'CREDIT',
            inflowType:      'INVESTMENT_RETURN',
            amount:          grossAmount,
            currencyId:      investment.currency_id,
            categoryId:      investment.category_id,
            description:     `Bond coupon #${coupon.coupon_number} interest — ` +
                             `${investment.name} (${investment.reference_code})`,
            valueDate:       paymentDate,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            investmentId:    investment.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        const returnNotes = notes ||
            (isAdjusted
                ? `Coupon #${coupon.coupon_number} (ACTUAL, scheduled was ${parseFloat(coupon.gross_amount)}): ` +
                  `gross ${grossAmount}, tax withheld ${taxAmount}, net ${netAmount}`
                : `Coupon #${coupon.coupon_number}: gross ${grossAmount}, ` +
                  `tax withheld ${taxAmount}, net ${netAmount}`);

        const returnResult = await client.query(`
            INSERT INTO investment_returns (
                reference_id, investment_id, transaction_id,
                return_type, amount, return_date, notes, created_by
            ) VALUES ($1, $2, $3, 'INTEREST', $4, $5, $6, $7)
            RETURNING id
        `, [
            retRefId, id, transactionId,
            grossAmount, paymentDate,
            returnNotes, req.user.id,
        ]);

        await linkReferenceToRecord(client, retRefId, returnResult.rows[0].id);

        await client.query(`
            UPDATE investments
            SET    total_returns = total_returns + $1
            WHERE  id = $2
        `, [grossAmount, id]);

        // --- 2. Tax withheld — its own debit + investment_transactions
        // TAX entry, only if this bond actually withholds tax ---
        let finalBalanceAfter = balanceAfter;
        if (taxAmount > 0) {
            const { referenceId: taxOpRefId } =
                await generateReference(
                    client,
                    MODULE_CODES.INVESTMENT,
                    'INV-OP',
                    'INVESTMENT_TRANSACTION',
                    req.user.id
                );

            const { referenceId: taxTxRefId } = await generateReference(
                client,
                resolveModuleCode(investment),
                'INVEST-OP-OUT',
                'TRANSACTION',
                req.user.id
            );

            const taxPosted = await postTransaction(client, {
                accountId:       investment.returns_account_id,
                transactionType: 'DEBIT',
                inflowType:      'EXPENSE',
                amount:          taxAmount,
                currencyId:      investment.currency_id,
                categoryId:      investment.category_id,
                description:     `Bond coupon #${coupon.coupon_number} withholding tax — ` +
                                 `${investment.name} (${investment.reference_code})`,
                valueDate:       paymentDate,
                createdBy:       req.user.id,
                referenceId:     taxTxRefId,
                investmentId:    investment.id,
            });
            finalBalanceAfter = taxPosted.balanceAfter;

            await linkReferenceToRecord(client, taxTxRefId, taxPosted.transactionId);

            const taxOpResult = await client.query(`
                INSERT INTO investment_transactions (
                    reference_id, investment_id, transaction_id,
                    entry_type, amount, description, entry_date, created_by
                ) VALUES ($1, $2, $3, 'TAX', $4, $5, $6, $7)
                RETURNING id
            `, [
                taxOpRefId, id, taxPosted.transactionId, taxAmount,
                `Withholding tax on bond coupon #${coupon.coupon_number}`,
                paymentDate, req.user.id,
            ]);

            await linkReferenceToRecord(client, taxOpRefId, taxOpResult.rows[0].id);

            // v1.40.0 fix: withholding tax is real money spent on this
            // investment's behalf — count it toward "Spent", same as
            // any other operational TAX entry (see
            // recordInvestmentTransaction for the identical fix).
            const { newExpenditure, supplementaryDelta } = computeSupplementaryOverage(
                investment.planned_budget, investment.actual_expenditure, taxAmount
            );
            await client.query(`
                UPDATE investments
                SET    actual_expenditure   = $1,
                       supplementary_budget = supplementary_budget + $2
                WHERE  id = $3
            `, [newExpenditure, supplementaryDelta, id]);
        }

        await client.query(`
            UPDATE bond_coupons
            SET    status = 'PAID',
                   investment_return_id = $1,
                   paid_at = NOW(),
                   actual_gross_amount = $2,
                   actual_tax_amount   = $3,
                   actual_net_amount   = $4,
                   adjusted_by         = $5,
                   adjusted_at         = $6
            WHERE  id = $7
        `, [
            returnResult.rows[0].id,
            isAdjusted ? grossAmount : null,
            isAdjusted ? taxAmount   : null,
            isAdjusted ? netAmount   : null,
            isAdjusted ? req.user.id : null,
            isAdjusted ? new Date()  : null,
            couponId,
        ]);

        await logAction(req.user.id, isAdjusted ? ACTIONS.INVESTMENT_COUPON_ADJUSTED : ACTIONS.INVESTMENT_RETURN, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'bond_coupons',
            recordId:    coupon.id,
            newValues:   {
                retRefCode, coupon_number: coupon.coupon_number,
                scheduled_gross_amount: parseFloat(coupon.gross_amount),
                gross_amount: grossAmount, tax_amount: taxAmount, net_amount: netAmount,
                is_adjusted: isAdjusted, balanceBefore, balanceAfter: finalBalanceAfter,
            },
            description: isAdjusted
                ? `Bond coupon #${coupon.coupon_number} paid with ACTUAL amount: ${retRefCode} — gross ${grossAmount} (scheduled ${parseFloat(coupon.gross_amount)}), tax ${taxAmount}, net ${netAmount}`
                : `Bond coupon #${coupon.coupon_number} paid: ${retRefCode} — gross ${grossAmount}, tax ${taxAmount}, net ${netAmount}`,
            client,
        });

        sendSuccess(res, {
            coupon_id:        coupon.id,
            coupon_number:    coupon.coupon_number,
            return_reference: retRefCode,
            gross_amount:     grossAmount,
            tax_amount:       taxAmount,
            net_amount:       netAmount,
            is_adjusted:      isAdjusted,
            balance_before:   balanceBefore,
            balance_after:    finalBalanceAfter,
        }, `Coupon #${coupon.coupon_number} marked paid. Reference: ${retRefCode}`);
    });
});

// ============================================================
// UPDATE FIRST COUPON DATE / RESCHEDULE COUPON SCHEDULE
// PATCH /api/investments/:id/coupon-schedule
// A bond's first coupon date is sometimes not known at the time of
// purchase/settlement. This lets it be filled in or corrected later —
// the WHOLE schedule is regenerated from the new anchor date so every
// later coupon date auto-recalculates too (same math as at creation
// time). Only allowed while no coupon has actually been paid yet —
// once real money has moved against coupon #1, the schedule is locked
// (use editInvestment's normal PENDING-only path is not an option
// post-approval, and this endpoint deliberately doesn't touch amounts
// already paid).
// ============================================================
const updateCouponSchedule = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { first_coupon_date } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.investment_type !== 'BOND') {
            throw createError.badRequest('This investment does not have a bond coupon schedule');
        }

        const paidCount = await client.query(`
            SELECT COUNT(*) AS n FROM bond_coupons
            WHERE  investment_id = $1 AND status = 'PAID'
        `, [id]);
        if (parseInt(paidCount.rows[0].n) > 0) {
            throw createError.badRequest(
                'The coupon schedule cannot be rescheduled once a coupon has already been paid'
            );
        }

        const schedule = generateBondCouponSchedule({
            faceValue:          parseFloat(investment.face_value),
            couponRate:         parseFloat(investment.coupon_rate),
            frequency:          investment.coupon_frequency,
            taxWithholdingRate: parseFloat(investment.tax_withholding_rate) || 0,
            issueDate:          investment.start_date,
            maturityDate:       investment.expected_end_date,
            firstCouponDate:    first_coupon_date,
        });

        await client.query('DELETE FROM bond_coupons WHERE investment_id = $1', [id]);
        for (const coupon of schedule) {
            await client.query(`
                INSERT INTO bond_coupons (
                    investment_id, coupon_number, due_date,
                    gross_amount, tax_amount, net_amount
                ) VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                id, coupon.coupon_number, coupon.due_date,
                coupon.gross_amount, coupon.tax_amount, coupon.net_amount,
            ]);
        }

        await client.query(
            'UPDATE investments SET first_coupon_date = $1 WHERE id = $2',
            [first_coupon_date, id]
        );

        await logAction(req.user.id, ACTIONS.INVESTMENT_COUPON_SCHEDULE_UPDATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            oldValues:   { first_coupon_date: investment.first_coupon_date },
            newValues:   { first_coupon_date },
            description: `Bond coupon schedule rescheduled from first coupon date ${first_coupon_date}: investment ID ${id}`,
            client,
        });

        sendSuccess(res, { coupons: schedule }, 'Coupon schedule updated');
    });
});

// ============================================================
// MID-TERM TERMINATION WORKFLOW
//
// Step 1 — REQUEST (INVESTMENT_MANAGE): status -> PENDING_TERMINATION.
// Step 2 — CONFIRM RECORDS (the investment's own responsible person,
//          or an approver if none is set): attests every return,
//          expense and transaction against this investment is up to
//          date. Returns/expenses can still be recorded while
//          PENDING_TERMINATION (see MUTABLE_INVESTMENT_STATUSES) so
//          anything missing can be caught up first.
// Step 3 — APPROVE (INVESTMENT_APPROVE, same permission as initial
//          investment approval): final Treasurer/Director sign-off.
//          Locks in status -> TERMINATED, actual_end_date -> today,
//          and a termination_report stating whether the investment
//          profited or lost money, and by how much. Any coupons still
//          PENDING are marked MISSED since they'll never be paid now.
//
// REJECT (either step's approver) can be used at any point while
// PENDING_TERMINATION to abandon the request and restore the
// investment to exactly the status it was in before (status_before_
// termination), clearing all termination_* fields.
// ============================================================

const requestTermination = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (!['ACTIVE', 'ON_HOLD'].includes(investment.status)) {
            throw createError.badRequest(
                `Only an active (or on-hold) investment can be put up for termination. Status: ${investment.status}`
            );
        }

        await client.query(`
            UPDATE investments
            SET    status                     = 'PENDING_TERMINATION',
                   status_before_termination   = $1,
                   termination_requested_by    = $2,
                   termination_requested_at    = NOW(),
                   termination_reason          = $3,
                   records_confirmed_by        = NULL,
                   records_confirmed_at        = NULL,
                   termination_approved_by     = NULL,
                   termination_approved_at     = NULL,
                   termination_report          = NULL
            WHERE  id = $4
        `, [investment.status, req.user.id, reason.trim(), id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_TERMINATION_REQUESTED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            newValues:   { reason },
            description: `Termination requested for investment ID ${id}: ${reason}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_TERMINATION_REQUESTED',
                title:      'Investment termination requested — please confirm records',
                body:       `${investment.name} has been put up for termination. Please confirm all returns, expenses and transactions against it are up to date.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investments',
                recordId:   id,
                email: {
                    subject: `Please confirm records — ${investment.name} is being terminated`,
                    html:    await wrapEmail(`
                        <p>An investment you're responsible for has been put up for mid-term termination:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">Investment</td><td style="padding:4px 0; text-align:right;">${investment.name}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Reason</td><td style="padding:4px 0; text-align:right;">${reason}</td></tr>
                        </table>
                        <p>Please review its records and confirm they are up to date before it can be formally closed.</p>
                    `, { preheader: 'Please confirm investment records before termination' }),
                },
            });
        }

        sendSuccess(res, null, 'Termination requested — awaiting records confirmation');
    });
});

const confirmTerminationRecords = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING_TERMINATION') {
            throw createError.badRequest('This investment is not currently under termination review');
        }

        const canApprove = (req.user.permissions || []).includes('INVESTMENT_APPROVE');
        if (investment.responsible_user_id) {
            if (investment.responsible_user_id !== req.user.id) {
                throw createError.forbidden(
                    'Only this investment\'s responsible person can confirm its records are up to date'
                );
            }
        } else if (!canApprove) {
            // No responsible person on file — fall back to whoever can
            // approve investments, rather than blocking the workflow.
            throw createError.forbidden(
                'This investment has no responsible person on file — an investment approver must confirm records instead'
            );
        }

        await client.query(`
            UPDATE investments
            SET    records_confirmed_by = $1,
                   records_confirmed_at = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_RECORDS_CONFIRMED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            description: `Records confirmed up to date for investment ID ${id}, ahead of termination`,
            client,
        });

        sendSuccess(res, null, 'Records confirmed — awaiting final approval to close');
    });
});

const approveTermination = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { closing_note } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING_TERMINATION') {
            throw createError.badRequest('This investment is not currently under termination review');
        }
        if (!investment.records_confirmed_at) {
            throw createError.badRequest(
                'Records must be confirmed up to date by the responsible person before final approval'
            );
        }

        const totalReturns     = parseFloat(investment.total_returns);
        const totalExpenditure = parseFloat(investment.actual_expenditure);
        const netResult        = totalReturns - totalExpenditure;
        const outcome = netResult > 0 ? 'a profit' : netResult < 0 ? 'a loss' : 'break-even';

        const report =
            `Investment "${investment.name}" (${investment.investment_type}) terminated mid-term.\n` +
            `Reason: ${investment.termination_reason || 'Not stated'}\n` +
            `Planned budget: ${investment.planned_budget}\n` +
            `Total spent: ${totalExpenditure}${parseFloat(investment.supplementary_budget) > 0 ? ` (of which ${investment.supplementary_budget} was supplementary, beyond the planned budget)` : ''}\n` +
            `Total returns received: ${totalReturns}\n` +
            `Result: ${outcome} of ${Math.abs(netResult).toFixed(2)}\n` +
            (closing_note ? `Closing note: ${closing_note}` : '');

        await client.query(`
            UPDATE investments
            SET    status                   = 'TERMINATED',
                   actual_end_date           = CURRENT_DATE,
                   termination_approved_by   = $1,
                   termination_approved_at   = NOW(),
                   termination_report        = $2
            WHERE  id = $3
        `, [req.user.id, report, id]);

        // Coupons still pending will never be paid now — mark them
        // MISSED so the schedule reads accurately rather than showing
        // stale "Pending" rows on a closed bond.
        await client.query(`
            UPDATE bond_coupons
            SET    status = 'MISSED'
            WHERE  investment_id = $1 AND status = 'PENDING'
        `, [id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_TERMINATED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            newValues:   { totalReturns, totalExpenditure, netResult, report },
            description: `Investment ID ${id} terminated — ${outcome} of ${Math.abs(netResult).toFixed(2)}`,
            client,
        });

        if (investment.responsible_user_id) {
            notify({
                userId:     investment.responsible_user_id,
                type:       'INVESTMENT_TERMINATED',
                title:      'Investment terminated',
                body:       `${investment.name} has been formally closed — ${outcome} of ${Math.abs(netResult).toFixed(2)}.`,
                link:       `/investments/${id}`,
                module:     'INVESTMENTS',
                recordType: 'investments',
                recordId:   id,
            });
        }

        sendSuccess(res, { report, net_result: netResult }, 'Investment terminated');
    });
});

const rejectTermination = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM investments WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Investment not found');
        }
        const investment = existing.rows[0];

        if (investment.status !== 'PENDING_TERMINATION') {
            throw createError.badRequest('This investment is not currently under termination review');
        }

        const restoredStatus = investment.status_before_termination || 'ACTIVE';

        await client.query(`
            UPDATE investments
            SET    status                     = $1,
                   status_before_termination   = NULL,
                   termination_requested_by    = NULL,
                   termination_requested_at    = NULL,
                   termination_reason          = NULL,
                   records_confirmed_by        = NULL,
                   records_confirmed_at        = NULL,
                   termination_approved_by     = NULL,
                   termination_approved_at     = NULL,
                   termination_report          = NULL
            WHERE  id = $2
        `, [restoredStatus, id]);

        await logAction(req.user.id, ACTIONS.INVESTMENT_TERMINATION_REJECTED, MODULES.INVESTMENTS, {
            ipAddress:   req.ip,
            recordType:  'investments',
            recordId:    id,
            newValues:   { reason },
            description: `Termination request rejected for investment ID ${id}, restored to ${restoredStatus}: ${reason || 'No reason given'}`,
            client,
        });

        sendSuccess(res, null, `Termination request rejected — investment restored to ${restoredStatus}`);
    });
});

// ============================================================
// GET PROJECT WITH FULL DETAILS INCLUDING MILESTONES
// GET /api/investments/:id/projects/:projectId
// ============================================================
const getProjectById = asyncHandler(async (req, res) => {
    const { id, projectId } = req.params;

    const result = await query(`
        SELECT
            p.*,
            r.reference_code,
            r.public_id,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            -- Milestones
            (
                SELECT json_agg(m ORDER BY m.due_date ASC)
                FROM (
                    SELECT id, name, description, due_date,
                           status, completed_at
                    FROM project_milestones
                    WHERE project_id = p.id
                ) m
            ) AS milestones,
            -- Funding transactions
            (
                SELECT json_agg(f_data ORDER BY f_data.amount DESC)
                FROM (
                    SELECT
                        inf.amount,
                        tr.reference_code AS transaction_reference,
                        t.value_date,
                        t.description
                    FROM investment_funding inf
                    JOIN transactions t ON t.id = inf.transaction_id
                    JOIN references_registry tr ON tr.id = t.reference_id
                    WHERE inf.project_id = p.id
                ) f_data
            ) AS funding_transactions
        FROM  projects p
        JOIN  references_registry r ON r.id  = p.reference_id
        JOIN  categories cat        ON cat.id = p.category_id
        JOIN  category_paths cp     ON cp.category_id = p.category_id
        JOIN  users u               ON u.id  = p.created_by
        WHERE p.id = $1
        AND   p.investment_id = $2
    `, [projectId, id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Project not found');
    }

    sendSuccess(res, result.rows[0]);
});

module.exports = {
    createInvestment,
    editInvestment,
    approveInvestment,
    fundInvestment,
    recordReturn,
    recordInvestmentTransaction,
    payBondCoupon,
    updateCouponSchedule,
    requestTermination,
    confirmTerminationRecords,
    approveTermination,
    rejectTermination,
    createProject,
    addMilestone,
    updateMilestone,
    updateInvestmentStatus,
    getAllInvestments,
    getInvestmentById,
    getPerformanceSummary,
    getProjectById,
};