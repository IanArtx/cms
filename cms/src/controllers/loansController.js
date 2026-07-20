// ============================================================
// LOANS CONTROLLER
// Handles both loans received (company borrows) and
// loans given (company lends).
//
// RULES ENFORCED HERE:
//   - Interest switches automatically from fixed to penalty
//     rate on the due date
//   - Penalty rate amendments are never overwritten
//   - Repayments split into penalty, interest, principal
//   - Member loans require witnesses
//   - Repayments return to source account
//   - Daily interest accrual tracked per loan
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction } = require('./transactionsController');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const {
    generateRepaymentSchedule,
    calculateDailyAccrual,
    splitRepayment,
    determineLoanStatus,
} = require('../services/loanService');

// ============================================================
// CREATE LOAN RECEIVED
// POST /api/loans/received
// Records a loan the company has received from any lender.
// ============================================================
const createLoanReceived = asyncHandler(async (req, res) => {
    const {
        account_id,
        category_id,
        lender_type,
        lender_name,
        lender_contact,
        is_member_lender,
        member_lender_id,
        principal_amount,
        fixed_interest_rate,
        penalty_interest_rate,
        interest_period,
        interest_calculation,
        disbursement_date,
        due_date,
        instalments,
        witnesses,
        external_witness_name,
        external_witness_contact,
    } = req.body;

    await withTransaction(async (client) => {
        // Verify account exists
        const account = await client.query(`
            SELECT id, currency_id, name
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE
        `, [account_id]);

        if (account.rows.length === 0) {
            throw createError.notFound('Account not found');
        }

        // Member lender requires witnesses
        const requiresWitnesses = lender_type === 'MEMBER' || is_member_lender;
        if (requiresWitnesses) {
            if (!external_witness_name) {
                throw createError.badRequest(
                    'Member loans require at least one external witness'
                );
            }
            if (!witnesses || witnesses.filter(w => w.type === 'DIRECTOR').length < 2) {
                throw createError.badRequest(
                    'Member loans require at least two Director witnesses'
                );
            }
        }

        // Generate loan reference: LNR-LOAN-YYYYMM-00001
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.LOAN_RECEIVED,
            'LOAN',
            'LOAN_RECEIVED',
            req.user.id
        );

        // Create the loan record
        const loanResult = await client.query(`
            INSERT INTO loans_received (
                reference_id,
                account_id,
                currency_id,
                category_id,
                lender_type,
                lender_name,
                lender_contact,
                is_member_lender,
                member_lender_id,
                principal_amount,
                amount_received,
                outstanding_principal,
                outstanding_interest,
                fixed_interest_rate,
                penalty_interest_rate,
                interest_period,
                interest_calculation,
                disbursement_date,
                due_date,
                requires_witnesses,
                external_witness_name,
                external_witness_contact,
                status,
                created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                0, $10, 0, $11, $12, $13, $14, $15, $16,
                $17, $18, $19, 'PENDING', $20
            )
            RETURNING id
        `, [
            referenceId,
            account_id,
            account.rows[0].currency_id,
            category_id,
            lender_type,
            lender_name.trim(),
            lender_contact || null,
            is_member_lender || false,
            member_lender_id || null,
            principal_amount,
            fixed_interest_rate,
            penalty_interest_rate,
            interest_period || 'MONTHLY',
            interest_calculation || 'SIMPLE',
            disbursement_date || null,
            due_date,
            requiresWitnesses,
            external_witness_name || null,
            external_witness_contact || null,
            req.user.id,
        ]);

        const loanId = loanResult.rows[0].id;
        await linkReferenceToRecord(client, referenceId, loanId);

        // Add witnesses if required
        if (requiresWitnesses && witnesses) {
            // External witness
            await client.query(`
                INSERT INTO loan_received_witnesses
                    (loan_received_id, witness_type, witness_name,
                     witness_contact, witness_id_number)
                VALUES ($1, 'EXTERNAL', $2, $3, $4)
            `, [
                loanId,
                external_witness_name,
                external_witness_contact || null,
                null,
            ]);

            // Director witnesses
            for (const witness of witnesses.filter(w => w.type === 'DIRECTOR')) {
                await client.query(`
                    INSERT INTO loan_received_witnesses
                        (loan_received_id, witness_type, user_id)
                    VALUES ($1, 'DIRECTOR', $2)
                `, [loanId, witness.user_id]);
            }
        }

        // Generate repayment schedule
        if (instalments && instalments > 0 && disbursement_date) {
            const scheduleData = generateRepaymentSchedule(
                principal_amount,
                fixed_interest_rate,
                interest_period || 'MONTHLY',
                interest_calculation || 'SIMPLE',
                disbursement_date,
                due_date,
                instalments
            );

            for (const instalment of scheduleData.schedule) {
                await client.query(`
                    INSERT INTO loan_received_schedule
                        (loan_received_id, instalment_number, due_date,
                         principal_due, interest_due)
                    VALUES ($1, $2, $3, $4, $5)
                `, [
                    loanId,
                    instalment.instalment_number,
                    instalment.due_date,
                    instalment.principal_due,
                    instalment.interest_due,
                ]);
            }
        }

        // Create approval workflow
        await client.query(`
            INSERT INTO approval_workflows (
                workflow_type, record_type, record_id,
                required_approvals, initiated_by
            ) VALUES ('LOAN_RECEIVED', 'loans_received', $1, 1, $2)
        `, [loanId, req.user.id]);

        await logAction(req.user.id, ACTIONS.LOAN_RECEIVED_CREATED, MODULES.LOANS, {
            ipAddress:   req.ip,
            recordType:  'loans_received',
            recordId:    loanId,
            newValues:   { referenceCode, principal_amount, lender_name, due_date },
            description: `Loan received created: ${referenceCode} — ${lender_name}`,
            client,
        });

        sendCreated(res, {
            loan_id:        loanId,
            reference:      referenceCode,
            lender:         lender_name,
            principal:      principal_amount,
            fixed_rate:     fixed_interest_rate,
            penalty_rate:   penalty_interest_rate,
            due_date,
            status:         'PENDING',
            requires_witnesses: requiresWitnesses,
        }, `Loan received recorded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT LOAN RECEIVED (before approval)
// PATCH /api/loans/received/:id
// Only while still PENDING. Editable by whoever created it, or
// anyone who could approve it. If any field that drives the
// repayment schedule changes (principal, rate, dates, instalment
// count), the existing schedule is deleted and regenerated —
// safe at this stage since nothing has been disbursed yet.
// Witness list itself isn't editable here — external witness
// contact details are; for a Director witness change, reject and
// recreate.
// ============================================================
const editLoanReceived = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        category_id, lender_type, lender_name, lender_contact,
        principal_amount, fixed_interest_rate, penalty_interest_rate,
        interest_period, interest_calculation, disbursement_date,
        due_date, instalments, external_witness_name, external_witness_contact,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM loans_received WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Loan not found');
        }
        const loan = existing.rows[0];

        if (loan.status !== 'PENDING') {
            throw createError.badRequest('Only a pending loan can be edited');
        }

        const isCreator = loan.created_by === req.user.id;
        const canApprove = (req.user.permissions || []).includes('LOAN_APPROVE');
        if (!isCreator && !canApprove) {
            throw createError.forbidden(
                'Only the person who created this loan, or someone who can approve it, can edit it'
            );
        }

        const newPrincipal   = principal_amount        !== undefined ? parseFloat(principal_amount)        : parseFloat(loan.principal_amount);
        const newFixedRate   = fixed_interest_rate      !== undefined ? parseFloat(fixed_interest_rate)     : parseFloat(loan.fixed_interest_rate);
        const newPenaltyRate = penalty_interest_rate    !== undefined ? parseFloat(penalty_interest_rate)   : parseFloat(loan.penalty_interest_rate);
        const newPeriod      = interest_period          || loan.interest_period;
        const newCalc        = interest_calculation     || loan.interest_calculation;
        const newDisbDate    = disbursement_date        !== undefined ? disbursement_date : loan.disbursement_date;
        const newDueDate     = due_date                 || loan.due_date;

        const scheduleFieldsChanged = (
            principal_amount   !== undefined ||
            fixed_interest_rate !== undefined ||
            interest_period     !== undefined ||
            interest_calculation !== undefined ||
            disbursement_date   !== undefined ||
            due_date             !== undefined ||
            instalments          !== undefined
        );

        const updated = await client.query(`
            UPDATE loans_received
            SET    category_id             = COALESCE($1, category_id),
                   lender_type              = COALESCE($2, lender_type),
                   lender_name              = COALESCE($3, lender_name),
                   lender_contact           = COALESCE($4, lender_contact),
                   principal_amount         = $5,
                   outstanding_principal    = $5,
                   fixed_interest_rate      = $6,
                   penalty_interest_rate    = $7,
                   interest_period          = $8,
                   interest_calculation     = $9,
                   disbursement_date        = $10,
                   due_date                 = $11,
                   external_witness_name    = COALESCE($12, external_witness_name),
                   external_witness_contact = COALESCE($13, external_witness_contact)
            WHERE  id = $14
            RETURNING *
        `, [
            category_id || null, lender_type || null,
            lender_name ? lender_name.trim() : null, lender_contact !== undefined ? lender_contact : null,
            newPrincipal, newFixedRate, newPenaltyRate, newPeriod, newCalc,
            newDisbDate, newDueDate,
            external_witness_name !== undefined ? external_witness_name : null,
            external_witness_contact !== undefined ? external_witness_contact : null,
            id,
        ]);

        // Regenerate the repayment schedule if any driving field changed
        if (scheduleFieldsChanged) {
            let finalInstalments = instalments;
            if (finalInstalments === undefined) {
                const countResult = await client.query(
                    'SELECT COUNT(*) AS n FROM loan_received_schedule WHERE loan_received_id = $1', [id]
                );
                finalInstalments = parseInt(countResult.rows[0].n) || null;
            }
            await client.query('DELETE FROM loan_received_schedule WHERE loan_received_id = $1', [id]);
            if (finalInstalments && finalInstalments > 0 && newDisbDate) {
                const scheduleData = generateRepaymentSchedule(
                    newPrincipal, newFixedRate, newPeriod, newCalc, newDisbDate, newDueDate, finalInstalments
                );
                for (const instalment of scheduleData.schedule) {
                    await client.query(`
                        INSERT INTO loan_received_schedule
                            (loan_received_id, instalment_number, due_date, principal_due, interest_due)
                        VALUES ($1, $2, $3, $4, $5)
                    `, [id, instalment.instalment_number, instalment.due_date,
                        instalment.principal_due, instalment.interest_due]);
                }
            }
        }

        await logAction(req.user.id, ACTIONS.LOAN_RECEIVED_UPDATED, MODULES.LOANS, {
            ipAddress:   req.ip,
            recordType:  'loans_received',
            recordId:    id,
            oldValues:   loan,
            newValues:   updated.rows[0],
            description: `Loan received edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Loan updated');
    });
});

// ============================================================
// APPROVE AND DISBURSE LOAN RECEIVED
// POST /api/loans/received/:id/approve
// Approves the loan and records the money arriving
// in the account as a transaction.
// ============================================================
const approveLoanReceived = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const loanResult = await client.query(`
            SELECT lr.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code
            FROM   loans_received lr
            JOIN   accounts a ON a.id = lr.account_id
            JOIN   references_registry r ON r.id = lr.reference_id
            WHERE  lr.id = $1
            FOR UPDATE
        `, [id]);

        if (loanResult.rows.length === 0) {
            throw createError.notFound('Loan not found');
        }

        const loan = loanResult.rows[0];

        if (loan.status !== 'PENDING') {
            throw createError.badRequest(
                `Loan cannot be approved. Current status: ${loan.status}`
            );
        }

        // Generate transaction reference
        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(loan),
            'LOAN-IN',
            'TRANSACTION',
            req.user.id
        );

        // Post the transaction — money arrives in account
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       loan.account_id,
            transactionType: 'CREDIT',
            inflowType:      'LOAN_RECEIVED',
            amount:          loan.principal_amount,
            currencyId:      loan.currency_id,
            categoryId:      loan.category_id,
            description:     `Loan received from ${loan.lender_name} — ${loan.reference_code}`,
            valueDate:       loan.disbursement_date || new Date().toISOString().split('T')[0],
            createdBy:       req.user.id,
            referenceId:     txRefId,
            loanReceivedId:  loan.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Update loan status and amount received
        await client.query(`
            UPDATE loans_received
            SET    status           = 'ACTIVE',
                   amount_received  = principal_amount,
                   approved_by      = $1,
                   approved_at      = NOW()
            WHERE  id = $2
        `, [req.user.id, id]);

        // Update workflow
        await client.query(`
            UPDATE approval_workflows
            SET    status            = 'APPROVED',
                   current_approvals = 1,
                   completed_at      = NOW()
            WHERE  record_type = 'loans_received'
            AND    record_id   = $1
        `, [id]);

        await logAction(req.user.id, ACTIONS.LOAN_RECEIVED_APPROVED, MODULES.LOANS, {
            ipAddress:   req.ip,
            recordType:  'loans_received',
            recordId:    parseInt(id),
            newValues:   { balanceBefore, balanceAfter },
            description: `Loan received approved and disbursed: ${loan.reference_code}`,
            client,
        });

        notify({
            userId:     loan.created_by,
            type:       'LOAN_RECEIVED_APPROVED',
            title:      'Loan approved and disbursed',
            body:       `The loan from ${loan.lender_name} (${loan.reference_code}) was approved and ${loan.principal_amount} credited to the account.`,
            link:       `/loans/received/${id}`,
            module:     'LOANS',
            recordType: 'loans_received',
            recordId:   parseInt(id),
            email: {
                subject: `Loan approved — ${loan.reference_code}`,
                html:    await wrapEmail(`
                    <p>The loan you recorded has been approved and disbursed:</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Lender</td><td style="padding:4px 0; text-align:right;">${loan.lender_name}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Principal amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${loan.principal_amount}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${loan.reference_code}</td></tr>
                    </table>
                `, { preheader: 'Your loan has been approved' }),
            },
        });

        sendSuccess(res, {
            status:         'ACTIVE',
            balance_before: balanceBefore,
            balance_after:  balanceAfter,
        }, 'Loan approved and funds credited to account');
    });
});

// ============================================================
// RECORD LOAN REPAYMENT (company pays back borrowed loan)
// POST /api/loans/received/:id/repayments
// ============================================================
const recordLoanReceivedRepayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { payment_date, schedule_id, notes, is_payoff } = req.body;
    let { amount } = req.body;

    await withTransaction(async (client) => {
        const loanResult = await client.query(`
            SELECT lr.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code
            FROM   loans_received lr
            JOIN   accounts a ON a.id = lr.account_id
            JOIN   references_registry r ON r.id = lr.reference_id
            WHERE  lr.id = $1
            FOR UPDATE
        `, [id]);

        if (loanResult.rows.length === 0) {
            throw createError.notFound('Loan not found');
        }

        const loan = loanResult.rows[0];

        if (loan.status === 'FULLY_REPAID') {
            throw createError.badRequest('This loan is already fully repaid');
        }
        if (loan.status === 'PENDING') {
            throw createError.badRequest('Loan has not been approved yet');
        }

        // "Pay off remaining balance" — compute the exact amount server-side
        // from the live outstanding figures (principal + interest), ignoring
        // whatever the client sent, so the loan clears to precisely zero on
        // both fields in one step. Paying an amount the client calculated
        // itself (e.g. matching just the principal shown on screen) is what
        // used to leave a small principal remainder once interest was
        // cleared first — that remainder then kept accruing more interest
        // indefinitely, which is why "paid off" loans appeared to keep
        // growing a balance.
        if (is_payoff) {
            amount = parseFloat((
                parseFloat(loan.outstanding_principal) + parseFloat(loan.outstanding_interest)
            ).toFixed(4));
        }

        // Split the repayment into portions
        const portions = splitRepayment(
            amount,
            0, // penalty outstanding — from accrual log
            parseFloat(loan.outstanding_interest),
            parseFloat(loan.outstanding_principal)
        );

        // Generate repayment reference
        const { referenceId: repRefId, referenceCode: repRefCode } =
            await generateReference(
                client,
                MODULE_CODES.LOAN_RECEIVED,
                'REPAY',
                'LOAN_REPAYMENT',
                req.user.id
            );

        // Generate transaction reference
        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(loan),
            'LOAN-OUT',
            'TRANSACTION',
            req.user.id
        );

        // Post debit transaction — money leaves the account
        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId:       loan.account_id,
            transactionType: 'DEBIT',
            inflowType:      'LOAN_REPAYMENT_OUT',
            amount,
            currencyId:      loan.currency_id,
            categoryId:      loan.category_id,
            description:     `Loan repayment to ${loan.lender_name} — ${loan.reference_code}`,
            valueDate:       payment_date,
            createdBy:       req.user.id,
            referenceId:     txRefId,
            loanReceivedId:  loan.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Record the repayment details
        const repayResult = await client.query(`
            INSERT INTO loan_received_repayments (
                reference_id, loan_received_id, schedule_id,
                transaction_id, amount_paid, principal_portion,
                interest_portion, penalty_portion, payment_date,
                notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
        `, [
            repRefId,
            id,
            schedule_id || null,
            transactionId,
            amount,
            portions.principal_portion,
            portions.interest_portion,
            portions.penalty_portion,
            payment_date,
            notes || null,
            req.user.id,
        ]);

        await linkReferenceToRecord(client, repRefId, repayResult.rows[0].id);

        // Update outstanding balances on loan. A payoff clamps both to
        // exactly zero rather than trusting subtraction to land there —
        // guarantees a clean FULLY_REPAID with no residue to re-accrue.
        const newPrincipal = is_payoff ? 0 : Math.max(
            0,
            parseFloat(loan.outstanding_principal) - portions.principal_portion
        );
        const newInterest = is_payoff ? 0 : Math.max(
            0,
            parseFloat(loan.outstanding_interest) - portions.interest_portion
        );

        const newStatus = determineLoanStatus({
            ...loan,
            outstanding_principal: newPrincipal,
            outstanding_interest:  newInterest,
        });

        await client.query(`
            UPDATE loans_received
            SET    outstanding_principal = $1,
                   outstanding_interest  = $2,
                   status               = $3,
                   is_overdue           = $4
            WHERE  id = $5
        `, [newPrincipal, newInterest, newStatus, newStatus === 'OVERDUE', id]);

        // Mark schedule instalment as paid if linked
        if (schedule_id) {
            await client.query(`
                UPDATE loan_received_schedule
                SET    status = 'PAID'
                WHERE  id = $1
            `, [schedule_id]);
        }

        await logAction(req.user.id, ACTIONS.LOAN_REPAYMENT_MADE, MODULES.LOANS, {
            ipAddress:   req.ip,
            recordType:  'loan_received_repayments',
            recordId:    repayResult.rows[0].id,
            newValues:   {
                repRefCode, amount, portions,
                balanceBefore, balanceAfter,
                new_outstanding: newPrincipal,
            },
            description: `Loan repayment recorded: ${repRefCode} — Amount: ${amount}`,
            client,
        });

        sendCreated(res, {
            repayment_reference:  repRefCode,
            amount_paid:          amount,
            principal_cleared:    portions.principal_portion,
            interest_cleared:     portions.interest_portion,
            penalty_cleared:      portions.penalty_portion,
            outstanding_principal: newPrincipal,
            outstanding_interest:  newInterest,
            loan_status:          newStatus,
            balance_before:       balanceBefore,
            balance_after:        balanceAfter,
        }, `Repayment recorded. Reference: ${repRefCode}`);
    });
});

// ============================================================
// AMEND PENALTY RATE (Treasurer only)
// POST /api/loans/received/:id/amend-rate
// Creates a new rate amendment record — never overwrites.
// ============================================================
const amendPenaltyRate = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { new_penalty_rate, reason, effective_from } = req.body;

    await withTransaction(async (client) => {
        const loan = await client.query(`
            SELECT id, penalty_interest_rate, status
            FROM   loans_received
            WHERE  id = $1
            FOR UPDATE
        `, [id]);

        if (loan.rows.length === 0) {
            throw createError.notFound('Loan not found');
        }
        if (loan.rows[0].status === 'FULLY_REPAID') {
            throw createError.badRequest('Cannot amend rate on a fully repaid loan');
        }

        const previousRate = loan.rows[0].penalty_interest_rate;

        // Record the amendment — never update the original
        await client.query(`
            INSERT INTO loan_received_rate_amendments (
                loan_received_id, previous_penalty_rate,
                new_penalty_rate, reason, effective_from, amended_by
            ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [id, previousRate, new_penalty_rate, reason, effective_from, req.user.id]);

        // Update the loan's current penalty rate
        await client.query(`
            UPDATE loans_received
            SET    penalty_interest_rate = $1
            WHERE  id = $2
        `, [new_penalty_rate, id]);

        await logAction(req.user.id, ACTIONS.LOAN_RATE_AMENDED, MODULES.LOANS, {
            ipAddress:   req.ip,
            recordType:  'loans_received',
            recordId:    parseInt(id),
            oldValues:   { penalty_rate: previousRate },
            newValues:   { penalty_rate: new_penalty_rate, reason, effective_from },
            description: `Penalty rate amended from ${previousRate}% to ${new_penalty_rate}%`,
            client,
        });

        sendSuccess(res, {
            previous_rate: previousRate,
            new_rate:      new_penalty_rate,
            effective_from,
        }, 'Penalty rate amended successfully');
    });
});

// ============================================================
// GET ALL LOANS RECEIVED
// GET /api/loans/received
// ============================================================
const getAllLoansReceived = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`lr.status = $${p}`);
        params.push(status.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM loans_received lr ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            lr.id,
            lr.lender_name,
            lr.lender_type,
            lr.principal_amount,
            lr.outstanding_principal,
            lr.outstanding_interest,
            lr.fixed_interest_rate,
            lr.penalty_interest_rate,
            lr.interest_period,
            lr.due_date,
            lr.is_overdue,
            lr.status,
            lr.created_at,
            lr.created_by,
            r.reference_code,
            r.public_id,
            a.name       AS account_name,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            cp.full_path AS category_trail
        FROM  loans_received lr
        JOIN  references_registry r ON r.id  = lr.reference_id
        JOIN  accounts a            ON a.id  = lr.account_id
        JOIN  currencies c          ON c.id  = lr.currency_id
        JOIN  categories cat        ON cat.id = lr.category_id
        JOIN  category_paths cp     ON cp.category_id = lr.category_id
        ${where}
        ORDER BY lr.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE LOAN RECEIVED WITH FULL DETAILS
// GET /api/loans/received/:id
// ============================================================
const getLoanReceivedById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            lr.*,
            r.reference_code,
            a.name       AS account_name,
            c.code       AS currency_code,
            c.symbol     AS currency_symbol,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name,
            -- Repayment schedule
            (
                SELECT json_agg(s ORDER BY s.instalment_number ASC)
                FROM (
                    SELECT instalment_number, due_date, principal_due,
                           interest_due, total_due, status
                    FROM loan_received_schedule
                    WHERE loan_received_id = lr.id
                ) s
            ) AS schedule,
            -- Repayments made
            (
                SELECT json_agg(rep ORDER BY rep.payment_date ASC)
                FROM (
                    SELECT lrr.id, lrr.amount_paid, lrr.principal_portion,
                           lrr.interest_portion, lrr.penalty_portion,
                           lrr.payment_date, lrr.notes,
                           rr.reference_code AS repayment_reference
                    FROM loan_received_repayments lrr
                    JOIN references_registry rr ON rr.id = lrr.reference_id
                    WHERE lrr.loan_received_id = lr.id
                ) rep
            ) AS repayments,
            -- Rate amendments
            (
                SELECT json_agg(ra ORDER BY ra.effective_from ASC)
                FROM (
                    SELECT previous_penalty_rate, new_penalty_rate,
                           reason, effective_from
                    FROM loan_received_rate_amendments
                    WHERE loan_received_id = lr.id
                ) ra
            ) AS rate_amendments
        FROM  loans_received lr
        JOIN  references_registry r ON r.id  = lr.reference_id
        JOIN  accounts a            ON a.id  = lr.account_id
        JOIN  currencies c          ON c.id  = lr.currency_id
        JOIN  categories cat        ON cat.id = lr.category_id
        JOIN  category_paths cp     ON cp.category_id = lr.category_id
        JOIN  users u               ON u.id  = lr.created_by
        LEFT JOIN users approver    ON approver.id = lr.approved_by
        WHERE lr.id = $1
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Loan not found');
    }

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// CREATE LOAN GIVEN
// POST /api/loans/given
// ============================================================
const createLoanGiven = asyncHandler(async (req, res) => {
    const {
        account_id, category_id, borrower_type, borrower_name,
        borrower_contact, is_member_borrower, member_borrower_id,
        principal_amount, fixed_interest_rate, penalty_interest_rate,
        interest_period, interest_calculation, disbursement_date,
        due_date, instalments,
    } = req.body;

    await withTransaction(async (client) => {
        const account = await client.query(
            'SELECT id, currency_id, name FROM accounts WHERE id = $1 AND is_active = TRUE',
            [account_id]
        );
        if (account.rows.length === 0) throw createError.notFound('Account not found');

        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.LOAN_GIVEN, 'LOAN', 'LOAN_GIVEN', req.user.id
        );

        const loanResult = await client.query(`
            INSERT INTO loans_given (
                reference_id, account_id, currency_id, category_id,
                borrower_type, borrower_name, borrower_contact,
                is_member_borrower, member_borrower_id,
                principal_amount, outstanding_principal, outstanding_interest,
                fixed_interest_rate, penalty_interest_rate,
                interest_period, interest_calculation,
                disbursement_date, due_date, repayment_account_id,
                status, created_by
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $10, 0, $11, $12, $13, $14, $15, $16, $2,
                'PENDING', $17
            ) RETURNING id
        `, [
            referenceId, account_id, account.rows[0].currency_id, category_id,
            borrower_type, borrower_name.trim(), borrower_contact || null,
            is_member_borrower || false, member_borrower_id || null,
            principal_amount, fixed_interest_rate, penalty_interest_rate,
            interest_period || 'MONTHLY', interest_calculation || 'SIMPLE',
            disbursement_date || null, due_date, req.user.id,
        ]);

        const loanId = loanResult.rows[0].id;
        await linkReferenceToRecord(client, referenceId, loanId);

        if (instalments && instalments > 0 && disbursement_date) {
            const scheduleData = generateRepaymentSchedule(
                principal_amount, fixed_interest_rate,
                interest_period || 'MONTHLY', interest_calculation || 'SIMPLE',
                disbursement_date, due_date, instalments
            );
            for (const instalment of scheduleData.schedule) {
                await client.query(`
                    INSERT INTO loan_given_schedule
                        (loan_given_id, instalment_number, due_date,
                         principal_due, interest_due)
                    VALUES ($1, $2, $3, $4, $5)
                `, [loanId, instalment.instalment_number, instalment.due_date,
                    instalment.principal_due, instalment.interest_due]);
            }
        }

        await client.query(`
            INSERT INTO approval_workflows
                (workflow_type, record_type, record_id, required_approvals, initiated_by)
            VALUES ('LOAN_GIVEN', 'loans_given', $1, 1, $2)
        `, [loanId, req.user.id]);

        await logAction(req.user.id, ACTIONS.LOAN_GIVEN_CREATED, MODULES.LOANS, {
            ipAddress: req.ip, recordType: 'loans_given', recordId: loanId,
            newValues: { referenceCode, principal_amount, borrower_name, due_date },
            description: `Loan given created: ${referenceCode} — ${borrower_name}`,
            client,
        });

        sendCreated(res, {
            loan_id: loanId, reference: referenceCode,
            borrower: borrower_name, principal: principal_amount,
            fixed_rate: fixed_interest_rate, penalty_rate: penalty_interest_rate,
            due_date, status: 'PENDING',
        }, `Loan given recorded. Reference: ${referenceCode}`);
    });
});

// ============================================================
// EDIT LOAN GIVEN (before approval)
// PATCH /api/loans/given/:id
// Mirrors editLoanReceived — only while still PENDING, editable
// by whoever created it or anyone who could approve it, schedule
// regenerated if a driving field changes.
// ============================================================
const editLoanGiven = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        category_id, borrower_type, borrower_name, borrower_contact,
        principal_amount, fixed_interest_rate, penalty_interest_rate,
        interest_period, interest_calculation, disbursement_date,
        due_date, instalments,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM loans_given WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Loan not found');
        }
        const loan = existing.rows[0];

        if (loan.status !== 'PENDING') {
            throw createError.badRequest('Only a pending loan can be edited');
        }

        const isCreator = loan.created_by === req.user.id;
        const canApprove = (req.user.permissions || []).includes('LOAN_APPROVE');
        if (!isCreator && !canApprove) {
            throw createError.forbidden(
                'Only the person who created this loan, or someone who can approve it, can edit it'
            );
        }

        const newPrincipal   = principal_amount     !== undefined ? parseFloat(principal_amount)   : parseFloat(loan.principal_amount);
        const newFixedRate   = fixed_interest_rate   !== undefined ? parseFloat(fixed_interest_rate) : parseFloat(loan.fixed_interest_rate);
        const newPenaltyRate = penalty_interest_rate !== undefined ? parseFloat(penalty_interest_rate) : parseFloat(loan.penalty_interest_rate);
        const newPeriod      = interest_period       || loan.interest_period;
        const newCalc        = interest_calculation  || loan.interest_calculation;
        const newDisbDate    = disbursement_date     !== undefined ? disbursement_date : loan.disbursement_date;
        const newDueDate     = due_date               || loan.due_date;

        const scheduleFieldsChanged = (
            principal_amount    !== undefined ||
            fixed_interest_rate !== undefined ||
            interest_period      !== undefined ||
            interest_calculation !== undefined ||
            disbursement_date    !== undefined ||
            due_date              !== undefined ||
            instalments           !== undefined
        );

        const updated = await client.query(`
            UPDATE loans_given
            SET    category_id           = COALESCE($1, category_id),
                   borrower_type         = COALESCE($2, borrower_type),
                   borrower_name         = COALESCE($3, borrower_name),
                   borrower_contact      = COALESCE($4, borrower_contact),
                   principal_amount      = $5,
                   outstanding_principal = $5,
                   fixed_interest_rate   = $6,
                   penalty_interest_rate = $7,
                   interest_period       = $8,
                   interest_calculation  = $9,
                   disbursement_date     = $10,
                   due_date              = $11
            WHERE  id = $12
            RETURNING *
        `, [
            category_id || null, borrower_type || null,
            borrower_name ? borrower_name.trim() : null, borrower_contact !== undefined ? borrower_contact : null,
            newPrincipal, newFixedRate, newPenaltyRate, newPeriod, newCalc,
            newDisbDate, newDueDate, id,
        ]);

        if (scheduleFieldsChanged) {
            let finalInstalments = instalments;
            if (finalInstalments === undefined) {
                const countResult = await client.query(
                    'SELECT COUNT(*) AS n FROM loan_given_schedule WHERE loan_given_id = $1', [id]
                );
                finalInstalments = parseInt(countResult.rows[0].n) || null;
            }
            await client.query('DELETE FROM loan_given_schedule WHERE loan_given_id = $1', [id]);
            if (finalInstalments && finalInstalments > 0 && newDisbDate) {
                const scheduleData = generateRepaymentSchedule(
                    newPrincipal, newFixedRate, newPeriod, newCalc, newDisbDate, newDueDate, finalInstalments
                );
                for (const instalment of scheduleData.schedule) {
                    await client.query(`
                        INSERT INTO loan_given_schedule
                            (loan_given_id, instalment_number, due_date, principal_due, interest_due)
                        VALUES ($1, $2, $3, $4, $5)
                    `, [id, instalment.instalment_number, instalment.due_date,
                        instalment.principal_due, instalment.interest_due]);
                }
            }
        }

        await logAction(req.user.id, ACTIONS.LOAN_GIVEN_UPDATED, MODULES.LOANS, {
            ipAddress:   req.ip,
            recordType:  'loans_given',
            recordId:    id,
            oldValues:   loan,
            newValues:   updated.rows[0],
            description: `Loan given edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Loan updated');
    });
});

// ============================================================
// APPROVE LOAN GIVEN
// POST /api/loans/given/:id/approve
// ============================================================
const approveLoanGiven = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const loanResult = await client.query(`
            SELECT lg.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code
            FROM loans_given lg
            JOIN accounts a ON a.id = lg.account_id
            JOIN references_registry r ON r.id = lg.reference_id
            WHERE lg.id = $1 FOR UPDATE
        `, [id]);

        if (loanResult.rows.length === 0) throw createError.notFound('Loan not found');
        const loan = loanResult.rows[0];
        if (loan.status !== 'PENDING') {
            throw createError.badRequest(`Loan cannot be approved. Status: ${loan.status}`);
        }

        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(loan),
            'LOAN-OUT', 'TRANSACTION', req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId: loan.account_id, transactionType: 'DEBIT',
            inflowType: 'LOAN_DISBURSED', amount: loan.principal_amount,
            currencyId: loan.currency_id, categoryId: loan.category_id,
            description: `Loan disbursed to ${loan.borrower_name} — ${loan.reference_code}`,
            valueDate: loan.disbursement_date || new Date().toISOString().split('T')[0],
            createdBy: req.user.id, referenceId: txRefId, loanGivenId: loan.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        await client.query(`
            UPDATE loans_given SET status = 'ACTIVE',
            approved_by = $1, approved_at = NOW() WHERE id = $2
        `, [req.user.id, id]);

        await client.query(`
            UPDATE approval_workflows SET status = 'APPROVED',
            current_approvals = 1, completed_at = NOW()
            WHERE record_type = 'loans_given' AND record_id = $1
        `, [id]);

        await logAction(req.user.id, ACTIONS.LOAN_GIVEN_APPROVED, MODULES.LOANS, {
            ipAddress: req.ip, recordType: 'loans_given', recordId: parseInt(id),
            newValues: { balanceBefore, balanceAfter },
            description: `Loan given approved and disbursed: ${loan.reference_code}`,
            client,
        });

        notify({
            userId:     loan.created_by,
            type:       'LOAN_GIVEN_APPROVED',
            title:      'Loan approved and disbursed',
            body:       `The loan to ${loan.borrower_name} (${loan.reference_code}) was approved and ${loan.principal_amount} disbursed.`,
            link:       `/loans/given/${id}`,
            module:     'LOANS',
            recordType: 'loans_given',
            recordId:   parseInt(id),
            email: {
                subject: `Loan disbursement approved — ${loan.reference_code}`,
                html:    await wrapEmail(`
                    <p>The loan you recorded has been approved and disbursed:</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Borrower</td><td style="padding:4px 0; text-align:right;">${loan.borrower_name}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Principal amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${loan.principal_amount}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${loan.reference_code}</td></tr>
                    </table>
                `, { preheader: 'A loan disbursement has been approved' }),
            },
        });

        // If the borrower is a member of the system, they get their own
        // notification too — this is their loan, not just the recorder's.
        if (loan.is_member_borrower && loan.member_borrower_id) {
            notify({
                userId:     loan.member_borrower_id,
                type:       'LOAN_DISBURSED_TO_YOU',
                title:      'Loan disbursed to you',
                body:       `A loan of ${loan.principal_amount} (${loan.reference_code}) has been disbursed in your name.`,
                link:       `/loans/given/${id}`,
                module:     'LOANS',
                recordType: 'loans_given',
                recordId:   parseInt(id),
                email: {
                    subject: `Loan disbursed — ${loan.reference_code}`,
                    html:    await wrapEmail(`
                        <p>A loan has been disbursed in your name:</p>
                        <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                            <tr><td style="padding:4px 0; color:#6b7280;">Amount</td><td style="padding:4px 0; text-align:right; font-weight:700;">${loan.principal_amount}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${loan.reference_code}</td></tr>
                            <tr><td style="padding:4px 0; color:#6b7280;">Due date</td><td style="padding:4px 0; text-align:right;">${loan.due_date}</td></tr>
                        </table>
                    `, { preheader: 'A loan has been disbursed to you' }),
                },
            });
        }

        sendSuccess(res, { status: 'ACTIVE', balance_before: balanceBefore,
            balance_after: balanceAfter },
            'Loan approved and funds disbursed from account');
    });
});

// ============================================================
// RECORD REPAYMENT ON LOAN GIVEN
// POST /api/loans/given/:id/repayments
// ============================================================
const recordLoanGivenRepayment = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { payment_date, schedule_id, notes, is_payoff } = req.body;
    let { amount } = req.body;

    await withTransaction(async (client) => {
        const loanResult = await client.query(`
            SELECT lg.*, a.currency_id, a.account_type, a.reference_prefix, r.reference_code
            FROM loans_given lg
            JOIN accounts a ON a.id = lg.account_id
            JOIN references_registry r ON r.id = lg.reference_id
            WHERE lg.id = $1 FOR UPDATE
        `, [id]);

        if (loanResult.rows.length === 0) throw createError.notFound('Loan not found');
        const loan = loanResult.rows[0];

        if (loan.status === 'FULLY_REPAID') {
            throw createError.badRequest('This loan is already fully repaid');
        }
        if (loan.status === 'PENDING') {
            throw createError.badRequest('Loan has not been approved yet');
        }

        // "Pay off remaining balance" — see recordLoanReceivedRepayment for
        // why this is computed server-side instead of trusting the client.
        if (is_payoff) {
            amount = parseFloat((
                parseFloat(loan.outstanding_principal) + parseFloat(loan.outstanding_interest)
            ).toFixed(4));
        }

        const portions = splitRepayment(
            amount, 0,
            parseFloat(loan.outstanding_interest),
            parseFloat(loan.outstanding_principal)
        );

        const { referenceId: repRefId, referenceCode: repRefCode } =
            await generateReference(client, MODULE_CODES.LOAN_GIVEN,
                'REPAY', 'LOAN_REPAYMENT', req.user.id);

        const { referenceId: txRefId } = await generateReference(
            client,
            resolveModuleCode(loan),
            'LOAN-IN', 'TRANSACTION', req.user.id
        );

        const { transactionId, balanceBefore, balanceAfter } = await postTransaction(client, {
            accountId: loan.repayment_account_id, transactionType: 'CREDIT',
            inflowType: 'LOAN_REPAYMENT_IN', amount,
            currencyId: loan.currency_id, categoryId: loan.category_id,
            description: `Loan repayment from ${loan.borrower_name} — ${loan.reference_code}`,
            valueDate: payment_date, createdBy: req.user.id,
            referenceId: txRefId, loanGivenId: loan.id,
        });

        await linkReferenceToRecord(client, txRefId, transactionId);

        const repayResult = await client.query(`
            INSERT INTO loan_given_repayments (
                reference_id, loan_given_id, schedule_id, transaction_id,
                amount_received, principal_portion, interest_portion,
                penalty_portion, payment_date, notes, created_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING id
        `, [repRefId, id, schedule_id || null, transactionId, amount,
            portions.principal_portion, portions.interest_portion,
            portions.penalty_portion, payment_date, notes || null, req.user.id]);

        await linkReferenceToRecord(client, repRefId, repayResult.rows[0].id);

        const newPrincipal = is_payoff ? 0 : Math.max(0,
            parseFloat(loan.outstanding_principal) - portions.principal_portion);
        const newInterest = is_payoff ? 0 : Math.max(0,
            parseFloat(loan.outstanding_interest) - portions.interest_portion);
        const newStatus = determineLoanStatus({
            ...loan, outstanding_principal: newPrincipal, outstanding_interest: newInterest });

        await client.query(`
            UPDATE loans_given SET outstanding_principal = $1,
            outstanding_interest = $2, status = $3, is_overdue = $4
            WHERE id = $5
        `, [newPrincipal, newInterest, newStatus, newStatus === 'OVERDUE', id]);

        if (schedule_id) {
            await client.query(
                `UPDATE loan_given_schedule SET status = 'PAID' WHERE id = $1`,
                [schedule_id]
            );
        }

        await logAction(req.user.id, ACTIONS.LOAN_REPAYMENT_RECEIVED, MODULES.LOANS, {
            ipAddress: req.ip, recordType: 'loan_given_repayments',
            recordId: repayResult.rows[0].id,
            newValues: { repRefCode, amount, portions, balanceBefore, balanceAfter,
                new_outstanding: newPrincipal },
            description: `Loan repayment received: ${repRefCode} — Amount: ${amount}`,
            client,
        });

        sendCreated(res, {
            repayment_reference: repRefCode, amount_received: amount,
            principal_cleared: portions.principal_portion,
            interest_cleared: portions.interest_portion,
            penalty_cleared: portions.penalty_portion,
            outstanding_principal: newPrincipal,
            outstanding_interest: newInterest,
            loan_status: newStatus,
            balance_before: balanceBefore, balance_after: balanceAfter,
        }, `Repayment received. Reference: ${repRefCode}`);
    });
});

// ============================================================
// AMEND PENALTY RATE ON LOAN GIVEN
// POST /api/loans/given/:id/amend-rate
// ============================================================
const amendLoanGivenRate = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { new_penalty_rate, reason, effective_from } = req.body;

    await withTransaction(async (client) => {
        const loan = await client.query(
            'SELECT id, penalty_interest_rate, status FROM loans_given WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (loan.rows.length === 0) throw createError.notFound('Loan not found');
        if (loan.rows[0].status === 'FULLY_REPAID') {
            throw createError.badRequest('Cannot amend rate on a fully repaid loan');
        }

        const previousRate = loan.rows[0].penalty_interest_rate;

        await client.query(`
            INSERT INTO loan_given_rate_amendments (
                loan_given_id, previous_penalty_rate, new_penalty_rate,
                reason, effective_from, amended_by
            ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [id, previousRate, new_penalty_rate, reason, effective_from, req.user.id]);

        await client.query(
            'UPDATE loans_given SET penalty_interest_rate = $1 WHERE id = $2',
            [new_penalty_rate, id]
        );

        await logAction(req.user.id, ACTIONS.LOAN_RATE_AMENDED, MODULES.LOANS, {
            ipAddress: req.ip, recordType: 'loans_given', recordId: parseInt(id),
            oldValues: { penalty_rate: previousRate },
            newValues: { penalty_rate: new_penalty_rate, reason, effective_from },
            description: `Loan given penalty rate amended: ${previousRate}% → ${new_penalty_rate}%`,
            client,
        });

        sendSuccess(res, { previous_rate: previousRate, new_rate: new_penalty_rate,
            effective_from }, 'Penalty rate amended successfully');
    });
});

// ============================================================
// GET ALL LOANS GIVEN
// GET /api/loans/given
// ============================================================
const getAllLoansGiven = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) { p++; conditions.push(`lg.status = $${p}`); params.push(status.toUpperCase()); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const countResult = await query(`SELECT COUNT(*) AS total FROM loans_given lg ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT lg.id, lg.borrower_name, lg.borrower_type, lg.principal_amount,
            lg.outstanding_principal, lg.outstanding_interest,
            lg.fixed_interest_rate, lg.penalty_interest_rate,
            lg.interest_period, lg.due_date, lg.is_overdue, lg.status,
            lg.created_at, lg.created_by, r.reference_code, r.public_id, a.name AS account_name,
            c.code AS currency_code, c.symbol AS currency_symbol,
            cat.name AS category_name, cp.full_path AS category_trail
        FROM loans_given lg
        JOIN references_registry r ON r.id = lg.reference_id
        JOIN accounts a ON a.id = lg.account_id
        JOIN currencies c ON c.id = lg.currency_id
        JOIN categories cat ON cat.id = lg.category_id
        JOIN category_paths cp ON cp.category_id = lg.category_id
        ${where}
        ORDER BY lg.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET SINGLE LOAN GIVEN
// GET /api/loans/given/:id
// ============================================================
const getLoanGivenById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT lg.*, r.reference_code, a.name AS account_name,
            c.code AS currency_code, c.symbol AS currency_symbol,
            cat.name AS category_name, cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS created_by_name,
            approver.first_name || ' ' || approver.last_name AS approved_by_name,
            (SELECT json_agg(s ORDER BY s.instalment_number ASC)
             FROM (SELECT instalment_number, due_date, principal_due,
                   interest_due, total_due, status
                   FROM loan_given_schedule WHERE loan_given_id = lg.id) s
            ) AS schedule,
            (SELECT json_agg(rep ORDER BY rep.payment_date ASC)
             FROM (SELECT lgr.id, lgr.amount_received, lgr.principal_portion,
                   lgr.interest_portion, lgr.penalty_portion,
                   lgr.payment_date, lgr.notes,
                   rr.reference_code AS repayment_reference
                   FROM loan_given_repayments lgr
                   JOIN references_registry rr ON rr.id = lgr.reference_id
                   WHERE lgr.loan_given_id = lg.id) rep
            ) AS repayments,
            -- Rate amendments (parity with getLoanReceivedById)
            (SELECT json_agg(ra ORDER BY ra.effective_from ASC)
             FROM (SELECT previous_penalty_rate, new_penalty_rate,
                   reason, effective_from
                   FROM loan_given_rate_amendments
                   WHERE loan_given_id = lg.id) ra
            ) AS rate_amendments
        FROM loans_given lg
        JOIN references_registry r ON r.id = lg.reference_id
        JOIN accounts a ON a.id = lg.account_id
        JOIN currencies c ON c.id = lg.currency_id
        JOIN categories cat ON cat.id = lg.category_id
        JOIN category_paths cp ON cp.category_id = lg.category_id
        JOIN users u ON u.id = lg.created_by
        LEFT JOIN users approver ON approver.id = lg.approved_by
        WHERE lg.id = $1
    `, [id]);

    if (result.rows.length === 0) throw createError.notFound('Loan not found');
    sendSuccess(res, result.rows[0]);
});

module.exports = {
    createLoanReceived,
    editLoanReceived,
    approveLoanReceived,
    recordLoanReceivedRepayment,
    amendPenaltyRate,
    getAllLoansReceived,
    getLoanReceivedById,
    createLoanGiven,
    editLoanGiven,
    approveLoanGiven,
    recordLoanGivenRepayment,
    amendLoanGivenRate,
    getAllLoansGiven,
    getLoanGivenById,
};