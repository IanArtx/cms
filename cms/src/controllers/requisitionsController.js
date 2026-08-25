// ============================================================
// REQUISITIONS CONTROLLER
// Any member can request money for a specific purpose.
// Treasurer or Director approves or rejects.
// On approval, a transaction is automatically posted.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES, resolveModuleCode } = require('../services/referenceService');
const { postTransaction, creditShareholderContribution, creditSideFundContribution } = require('./transactionsController');
const { createPendingFlexibleDeposit } = require('./savingsController');
const { clearFine } = require('../services/finesService');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');

MODULE_CODES.REQUISITION = 'REQ';

// ============================================================
// CREATE REQUISITION
// POST /api/requisitions
// Any authenticated member can create a requisition.
// ============================================================
const createRequisition = asyncHandler(async (req, res) => {
    const {
        category_id,
        title,
        description,
        amount_requested,
        purpose,
        required_by_date,
        priority,
        requisition_type,
        contribution_date,
        fine_id,
    } = req.body;

    const type = requisition_type || 'EXPENSE';
    const isAcknowledgementType = (t) =>
        t === 'CONTRIBUTION_ACKNOWLEDGEMENT' || t === 'SAVINGS_DEPOSIT' ||
        t === 'SIDE_FUND_CONTRIBUTION' || t === 'FINE_PAYMENT';

    if (isAcknowledgementType(type) && !contribution_date) {
        throw createError.badRequest(
            type === 'SAVINGS_DEPOSIT' ? 'Please provide the date you made the savings deposit' :
            type === 'SIDE_FUND_CONTRIBUTION' ? 'Please provide the date you made the side fund payment' :
            type === 'FINE_PAYMENT' ? 'Please provide the date you made the fine payment' :
            'Please provide the date you made the contribution'
        );
    }

    if (type === 'FINE_PAYMENT' && !fine_id) {
        throw createError.badRequest('Please select which fine this payment is for');
    }

    await withTransaction(async (client) => {
        // FINE_PAYMENT — validate the fine up front so we never let a
        // member request acknowledgement against someone else's fine, or
        // a fine that's already been cleared.
        let validatedFineId = null;
        if (type === 'FINE_PAYMENT') {
            const fineCheck = await client.query(
                'SELECT id, status, user_id FROM fines WHERE id = $1 FOR UPDATE', [fine_id]
            );
            if (fineCheck.rows.length === 0) {
                throw createError.notFound('Fine not found');
            }
            if (fineCheck.rows[0].user_id !== req.user.id) {
                throw createError.forbidden('This fine does not belong to you');
            }
            if (fineCheck.rows[0].status !== 'OUTSTANDING') {
                throw createError.badRequest('This fine has already been cleared');
            }
            validatedFineId = fineCheck.rows[0].id;
        }

        // Generate requisition reference
        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.REQUISITION, 'REQ',
            'REQUISITION', req.user.id
        );

        const result = await client.query(`
            INSERT INTO requisitions (
                reference_id, requested_by, category_id,
                title, description, amount_requested,
                purpose, required_by_date, priority, status,
                requisition_type, contribution_date, fine_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10, $11, $12)
            RETURNING id
        `, [
            referenceId, req.user.id, category_id,
            title.trim(), description || null, amount_requested,
            purpose.trim(), required_by_date || null,
            priority || 'NORMAL',
            type,
            isAcknowledgementType(type) ? contribution_date : null,
            validatedFineId,
        ]);

        const reqId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, reqId);

        await logAction(req.user.id, ACTIONS.REQUISITION_CREATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'requisitions',
            recordId:    reqId,
            newValues:   { referenceCode, title, amount_requested, requisition_type: type },
            description: `Requisition created: ${referenceCode} — ${title}`,
            client,
        });

        // --------------------------------------------------------
        // NOTIFY APPROVERS — Treasurer / Assistant Treasurer need
        // to know a new requisition is waiting on them.
        // --------------------------------------------------------
        const approversResult = await client.query(`
            SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
            FROM   users u
            JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            JOIN   roles r       ON r.id = ur.role_id
            WHERE  r.name IN ('Treasurer', 'Assistant Treasurer')
            AND    u.is_active = TRUE
        `);

        // wrapEmail is async and notifyMany's build() callback below must
        // stay synchronous, so render the branded shell once up-front with
        // a placeholder greeting, then personalise per-recipient with a
        // simple string replace.
        const approverEmailShell = await wrapEmail(`
            <p>Dear {{FIRST_NAME}},</p>
            <p><strong>${req.user.first_name} ${req.user.last_name}</strong> submitted a requisition that needs your approval:</p>
            <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                <tr><td style="padding:4px 0; color:#6b7280;">Title</td><td style="padding:4px 0; text-align:right;">${title}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Amount requested</td><td style="padding:4px 0; text-align:right; font-weight:700;">${amount_requested}</td></tr>
                <tr><td style="padding:4px 0; color:#6b7280;">Reference</td><td style="padding:4px 0; text-align:right;">${referenceCode}</td></tr>
            </table>
            <p>Please review and action this in the system.</p>
        `, { preheader: 'A requisition needs your approval' });

        notifyMany(approversResult.rows, 'REQUISITION_PENDING', (approver) => ({
            title:      'New requisition awaiting your approval',
            body:       `${req.user.first_name || 'A member'} submitted "${title}" for ${amount_requested}. Reference: ${referenceCode}.`,
            // v1.41.0 fix: there is no /requisitions/:id detail route —
            // RequisitionsPage.jsx is list-only — so this used to silently
            // bounce to the dashboard. Matches the other requisition
            // notifications elsewhere in this file.
            link:       `/requisitions`,
            module:     'FINANCE',
            recordType: 'requisitions',
            recordId:   reqId,
            email: {
                subject: `Requisition awaiting approval — ${referenceCode}`,
                html:    approverEmailShell.replace('{{FIRST_NAME}}', approver.first_name),
            },
        }));

        sendCreated(res, {
            requisition_id: reqId,
            reference:      referenceCode,
            title,
            amount_requested,
            status:         'PENDING',
        }, `Requisition submitted. Reference: ${referenceCode}`);
    });
});

// ============================================================
// APPROVE REQUISITION
// POST /api/requisitions/:id/approve
// Treasurer or Director approves and posts a transaction.
// ============================================================
const approveRequisition = asyncHandler(async (req, res) => {
    const { id }  = req.params;
    const {
        account_id,
        amount_approved,
        review_notes,
    } = req.body;

    await withTransaction(async (client) => {
        const reqResult = await client.query(`
            SELECT r.*, rr.reference_code,
                   u.first_name, u.last_name
            FROM   requisitions r
            JOIN   references_registry rr ON rr.id = r.reference_id
            JOIN   users u ON u.id = r.requested_by
            WHERE  r.id = $1 FOR UPDATE
        `, [id]);

        if (reqResult.rows.length === 0) {
            throw createError.notFound('Requisition not found');
        }

        const req_ = reqResult.rows[0];

        if (req_.status !== 'PENDING') {
            throw createError.badRequest(
                `Requisition cannot be approved. Status: ${req_.status}`
            );
        }

        const approvedAmount = parseFloat(amount_approved || req_.amount_requested);

        // ----------------------------------------------------------
        // CONTRIBUTION ACKNOWLEDGEMENT — member is asking us to record
        // capital they've already contributed. Runs the exact same
        // crediting logic as a Treasurer directly recording a
        // contribution (POST /transactions/contributions), just
        // triggered by this approval instead.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'CONTRIBUTION_ACKNOWLEDGEMENT') {
            const {
                transactionId, balanceBefore, balanceAfter,
                referenceCode: txRefCode, account,
            } = await creditShareholderContribution(client, {
                contributorId:     req_.requested_by,
                amount:            approvedAmount,
                contributionDate:  req_.contribution_date || new Date().toISOString().split('T')[0],
                categoryId:        req_.category_id,
                notes:             review_notes || req_.purpose,
                recordedByUserId:  req.user.id,
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       account_id      = $1,
                       currency_id     = $2,
                       amount_approved = $3,
                       transaction_id  = $4,
                       reviewed_by     = $5,
                       reviewed_at     = NOW(),
                       review_notes    = $6
                WHERE  id = $7
            `, [
                account.id,
                account.currency_id,
                approvedAmount,
                transactionId,
                req.user.id,
                review_notes || null,
                id,
            ]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { txRefCode, approvedAmount, balanceBefore, balanceAfter },
                description: `Contribution acknowledged: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Contribution acknowledgement approved',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and the contribution has been recorded.`,
                link:       `/requisitions`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
                email: {
                    subject: `Requisition approved — ${req_.reference_code}`,
                    html:    await wrapEmail(`
                        <p>Dear ${req_.first_name},</p>
                        <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved and the contribution recorded to your account.</p>
                        ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                    `, { preheader: 'Your requisition has been approved' }),
                },
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'CONTRIBUTION_ACKNOWLEDGEMENT',
                amount_approved:       approvedAmount,
                transaction_reference: txRefCode,
                balance_before:        balanceBefore,
                balance_after:         balanceAfter,
            }, 'Contribution acknowledged and recorded in the ledger');
        }

        // ----------------------------------------------------------
        // SAVINGS DEPOSIT — member is asking to add money to their own
        // savings. Approving here does NOT post any money movement —
        // it hands the request off to a Treasurer/Assistant Treasurer,
        // who gives the actual financial sign-off (see
        // savingsController.approveSavingsDeposit). This mirrors the
        // Treasurer-direct path exactly from that point on.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'SAVINGS_DEPOSIT') {
            const { savingsId, referenceCode: savRefCode } = await createPendingFlexibleDeposit(client, {
                userId:           req_.requested_by,
                categoryId:       req_.category_id,
                amount:           approvedAmount,
                depositDate:      req_.contribution_date || new Date().toISOString().split('T')[0],
                notes:            review_notes || req_.purpose,
                recordedByUserId: req.user.id,
                source:           'REQUISITION',
                requisitionId:    parseInt(id),
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       amount_approved = $1,
                       reviewed_by     = $2,
                       reviewed_at     = NOW(),
                       review_notes    = $3
                WHERE  id = $4
            `, [approvedAmount, req.user.id, review_notes || null, id]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { savRefCode, approvedAmount },
                description: `Savings deposit request forwarded to Treasurer/Assistant Treasurer for approval: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Savings deposit request forwarded for approval',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and forwarded to the Treasurer/Assistant Treasurer for final sign-off.`,
                link:       `/savings`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'SAVINGS_DEPOSIT',
                amount_approved:       approvedAmount,
                savings_reference:     savRefCode,
                savings_id:            savingsId,
            }, 'Savings deposit request forwarded to the Treasurer/Assistant Treasurer for approval');
        }

        // ----------------------------------------------------------
        // SIDE FUND CONTRIBUTION (v1.26.0) — member is asking us to
        // record a side fund payment they've already made. Just like
        // CONTRIBUTION_ACKNOWLEDGEMENT, this runs the exact same
        // crediting logic as every other side fund payment path
        // (applySideFundPayment, oldest-unpaid-period-first) — no
        // month picker on the request itself, the cascade sorts out
        // which period(s) it covers.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'SIDE_FUND_CONTRIBUTION') {
            const {
                transactionId, balanceBefore, balanceAfter,
                referenceCode: txRefCode, settled, creditBanked,
            } = await creditSideFundContribution(client, {
                userId:            req_.requested_by,
                amount:            approvedAmount,
                contributionDate:  req_.contribution_date || new Date().toISOString().split('T')[0],
                categoryId:        req_.category_id,
                recordedByUserId:  req.user.id,
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       amount_approved = $1,
                       transaction_id  = $2,
                       reviewed_by     = $3,
                       reviewed_at     = NOW(),
                       review_notes    = $4
                WHERE  id = $5
            `, [approvedAmount, transactionId, req.user.id, review_notes || null, id]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { txRefCode, approvedAmount, settled, creditBanked, balanceBefore, balanceAfter },
                description: `Side fund contribution acknowledged: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Side fund contribution approved',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and the side fund payment has been recorded.`,
                link:       `/side-fund`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
                email: {
                    subject: `Requisition approved — ${req_.reference_code}`,
                    html:    await wrapEmail(`
                        <p>Dear ${req_.first_name},</p>
                        <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved and the side fund payment recorded.</p>
                        ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                    `, { preheader: 'Your requisition has been approved' }),
                },
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'SIDE_FUND_CONTRIBUTION',
                amount_approved:       approvedAmount,
                transaction_reference: txRefCode,
                settled,
                credit_banked:         creditBanked,
                balance_before:        balanceBefore,
                balance_after:         balanceAfter,
            }, 'Side fund contribution acknowledged and recorded');
        }

        // ----------------------------------------------------------
        // FINE PAYMENT (v1.37.0) — member is asking us to record a fine
        // payment they've already made externally. Unlike the three
        // acknowledgement types above, this needs a Treasurer-chosen
        // account at approval time, because a fine must be paid into an
        // account in the SAME currency it was posted in — there's no
        // single "the" account to auto-resolve the way Savings/Side Fund
        // do. Runs the exact same crediting logic as the direct
        // Treasurer-clears-it path (finesController.clearFineDirect),
        // via the shared finesService.clearFine core.
        // ----------------------------------------------------------
        if (req_.requisition_type === 'FINE_PAYMENT') {
            if (!account_id) {
                throw createError.badRequest(
                    'A receiving account (in the same currency as the fine) is required to approve this requisition'
                );
            }

            const {
                transactionId, balanceBefore, balanceAfter,
                referenceCode: txRefCode,
            } = await clearFine(client, {
                fineId:             req_.fine_id,
                accountId:          parseInt(account_id),
                paidDate:           req_.contribution_date || new Date().toISOString().split('T')[0],
                paymentDescription: review_notes || req_.purpose,
                recordedByUserId:   req.user.id,
            });

            await client.query(`
                UPDATE requisitions
                SET    status          = 'APPROVED',
                       account_id      = $1,
                       amount_approved = $2,
                       transaction_id  = $3,
                       reviewed_by     = $4,
                       reviewed_at     = NOW(),
                       review_notes    = $5
                WHERE  id = $6
            `, [account_id, approvedAmount, transactionId, req.user.id, review_notes || null, id]);

            await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
                ipAddress:   req.ip,
                recordType:  'requisitions',
                recordId:    parseInt(id),
                newValues:   { txRefCode, approvedAmount, balanceBefore, balanceAfter, fineId: req_.fine_id },
                description: `Fine payment acknowledged: ${req_.reference_code} — ` +
                             `${req_.first_name} ${req_.last_name}: ${approvedAmount}`,
                client,
            });

            notify({
                userId:     req_.requested_by,
                type:       'REQUISITION_APPROVED',
                title:      'Fine payment approved',
                body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved and your fine payment has been recorded.`,
                link:       `/fines`,
                module:     'FINANCE',
                recordType: 'requisitions',
                recordId:   parseInt(id),
                email: {
                    subject: `Requisition approved — ${req_.reference_code}`,
                    html:    await wrapEmail(`
                        <p>Dear ${req_.first_name},</p>
                        <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved and your fine payment recorded.</p>
                        ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                    `, { preheader: 'Your requisition has been approved' }),
                },
            });

            return sendSuccess(res, {
                status:                'APPROVED',
                requisition_type:      'FINE_PAYMENT',
                amount_approved:       approvedAmount,
                transaction_reference: txRefCode,
                balance_before:        balanceBefore,
                balance_after:         balanceAfter,
            }, 'Fine payment acknowledged and recorded');
        }

        // ----------------------------------------------------------
        // EXPENSE (original behaviour) — money OUT of the selected
        // account to fulfil the request.
        // ----------------------------------------------------------
        if (!account_id) {
            throw createError.badRequest('A valid account is required to approve this requisition');
        }

        // Get the account
        const account = await client.query(
            'SELECT id, currency_id, account_type, reference_prefix FROM accounts WHERE id = $1',
            [account_id]
        );
        if (account.rows.length === 0) {
            throw createError.notFound('Account not found');
        }

        // Generate transaction reference
        const { referenceId: txRefId, referenceCode: txRefCode } =
            await generateReference(
                client, resolveModuleCode(account.rows[0]), 'REQ', 'TRANSACTION', req.user.id
            );

        // Post debit transaction
        const { transactionId, balanceBefore, balanceAfter } =
            await postTransaction(client, {
                accountId:       account_id,
                transactionType: 'DEBIT',
                inflowType:      'EXPENSE',
                amount:          approvedAmount,
                currencyId:      account.rows[0].currency_id,
                categoryId:      req_.category_id,
                description:     `Requisition: ${req_.title} — ` +
                                 `${req_.first_name} ${req_.last_name} ` +
                                 `(${req_.reference_code})`,
                valueDate:       new Date().toISOString().split('T')[0],
                createdBy:       req.user.id,
                referenceId:     txRefId,
            });

        await linkReferenceToRecord(client, txRefId, transactionId);

        // Update requisition
        await client.query(`
            UPDATE requisitions
            SET    status         = 'APPROVED',
                   account_id     = $1,
                   currency_id    = $2,
                   amount_approved = $3,
                   transaction_id  = $4,
                   reviewed_by     = $5,
                   reviewed_at     = NOW(),
                   review_notes    = $6
            WHERE  id = $7
        `, [
            account_id,
            account.rows[0].currency_id,
            approvedAmount,
            transactionId,
            req.user.id,
            review_notes || null,
            id,
        ]);

        await logAction(req.user.id, ACTIONS.REQUISITION_APPROVED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'requisitions',
            recordId:    parseInt(id),
            newValues:   { txRefCode, approvedAmount, balanceBefore, balanceAfter },
            description: `Requisition approved: ${req_.reference_code} — ${approvedAmount}`,
            client,
        });

        notify({
            userId:     req_.requested_by,
            type:       'REQUISITION_APPROVED',
            title:      'Requisition approved',
            body:       `Your requisition "${req_.title}" (${req_.reference_code}) was approved for ${approvedAmount}.`,
            link:       `/requisitions`,
            module:     'FINANCE',
            recordType: 'requisitions',
            recordId:   parseInt(id),
            email: {
                subject: `Requisition approved — ${req_.reference_code}`,
                html:    await wrapEmail(`
                    <p>Dear ${req_.first_name},</p>
                    <p>Your requisition <strong>${req_.title}</strong> (${req_.reference_code}) has been approved.</p>
                    <table style="width:100%; border-collapse:collapse; margin:12px 0;">
                        <tr><td style="padding:4px 0; color:#6b7280;">Amount approved</td><td style="padding:4px 0; text-align:right; font-weight:700;">${approvedAmount}</td></tr>
                        <tr><td style="padding:4px 0; color:#6b7280;">Transaction reference</td><td style="padding:4px 0; text-align:right;">${txRefCode}</td></tr>
                    </table>
                    ${review_notes ? `<p style="color:#6b7280;">Reviewer notes: ${review_notes}</p>` : ''}
                `, { preheader: 'Your requisition has been approved' }),
            },
        });

        sendSuccess(res, {
            status:                'APPROVED',
            amount_approved:       approvedAmount,
            transaction_reference: txRefCode,
            balance_before:        balanceBefore,
            balance_after:         balanceAfter,
        }, 'Requisition approved and payment processed');
    });
});

// ============================================================
// REJECT REQUISITION
// POST /api/requisitions/:id/reject
// ============================================================
const rejectRequisition = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { review_notes } = req.body;

    const result = await query(`
        UPDATE requisitions
        SET    status       = 'REJECTED',
               reviewed_by  = $1,
               reviewed_at  = NOW(),
               review_notes = $2
        WHERE  id = $3
        AND    status = 'PENDING'
        RETURNING id, title, requested_by
    `, [req.user.id, review_notes || null, id]);

    if (result.rows.length === 0) {
        throw createError.badRequest('Requisition not found or cannot be rejected');
    }

    const rejected = result.rows[0];

    await logAction(req.user.id, ACTIONS.REQUISITION_REJECTED, MODULES.FINANCE, {
        ipAddress:   req.ip,
        recordType:  'requisitions',
        recordId:    parseInt(id),
        description: `Requisition rejected: ID ${id}`,
    });

    notify({
        userId:     rejected.requested_by,
        type:       'REQUISITION_REJECTED',
        title:      'Requisition rejected',
        body:       `Your requisition "${rejected.title}" was not approved.${review_notes ? ` Reason: ${review_notes}` : ''}`,
        link:       `/requisitions`,
        module:     'FINANCE',
        recordType: 'requisitions',
        recordId:   parseInt(id),
        email: {
            subject: `Requisition not approved — ${rejected.title}`,
            html:    await wrapEmail(`
                <p>Your requisition <strong>${rejected.title}</strong> was not approved.</p>
                ${review_notes ? `<p style="color:#6b7280;">Reason: ${review_notes}</p>` : ''}
            `, { preheader: 'Your requisition was not approved' }),
        },
    });

    sendSuccess(res, null, 'Requisition rejected');
});

// ============================================================
// GET MY REQUISITIONS
// GET /api/requisitions/me
// ============================================================
const getMyRequisitions = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            r.id, r.title, r.description, r.amount_requested,
            r.amount_approved, r.purpose, r.required_by_date,
            r.priority, r.status, r.review_notes, r.created_at,
            r.reviewed_at, r.requisition_type, r.contribution_date,
            r.category_id, r.requested_by,
            rr.reference_code,
            rr.public_id,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            reviewer.first_name || ' ' || reviewer.last_name AS reviewed_by_name
        FROM  requisitions r
        JOIN  references_registry rr ON rr.id  = r.reference_id
        JOIN  categories cat         ON cat.id = r.category_id
        JOIN  category_paths cp      ON cp.category_id = r.category_id
        LEFT JOIN users reviewer     ON reviewer.id = r.reviewed_by
        WHERE r.requested_by = $1
        ORDER BY r.created_at DESC
    `, [req.user.id]);

    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL REQUISITIONS
// GET /api/requisitions
// Treasurer and Directors see all
// ============================================================
const getAllRequisitions = asyncHandler(async (req, res) => {
    const { status, priority } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status) {
        p++; conditions.push(`r.status = $${p}`);
        params.push(status.toUpperCase());
    }
    if (priority) {
        p++; conditions.push(`r.priority = $${p}`);
        params.push(priority.toUpperCase());
    }

    const where = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM requisitions r ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            r.id, r.title, r.description, r.amount_requested, r.amount_approved,
            r.priority, r.status, r.required_by_date, r.created_at,
            r.reviewed_at, r.review_notes, r.requisition_type, r.contribution_date,
            r.category_id, r.purpose, r.requested_by,
            rr.reference_code,
            rr.public_id,
            cat.name     AS category_name,
            cp.full_path AS category_trail,
            u.first_name || ' ' || u.last_name AS requested_by_name,
            u.email      AS requested_by_email,
            reviewer.first_name || ' ' || reviewer.last_name AS reviewed_by_name
        FROM  requisitions r
        JOIN  references_registry rr ON rr.id  = r.reference_id
        JOIN  categories cat         ON cat.id = r.category_id
        JOIN  category_paths cp      ON cp.category_id = r.category_id
        JOIN  users u                ON u.id  = r.requested_by
        LEFT JOIN users reviewer     ON reviewer.id = r.reviewed_by
        ${where}
        ORDER BY
            CASE r.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2
                WHEN 'NORMAL' THEN 3 WHEN 'LOW' THEN 4 END,
            r.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// EDIT A REQUISITION (before approval)
// PATCH /api/requisitions/:id
// Only while still PENDING. Editable by whoever requested it, or
// Treasurer/Assistant Treasurer.
// ============================================================
const editRequisition = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        category_id, title, description, amount_requested,
        purpose, required_by_date, priority,
        requisition_type, contribution_date, fine_id,
    } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query(
            'SELECT * FROM requisitions WHERE id = $1 FOR UPDATE', [id]
        );
        if (existing.rows.length === 0) {
            throw createError.notFound('Requisition not found');
        }
        const requisition = existing.rows[0];

        if (requisition.status !== 'PENDING') {
            throw createError.badRequest('Only a pending requisition can be edited');
        }

        const isRequester = requisition.requested_by === req.user.id;
        const userRoles = (req.user.roles || []);
        const canApprove = userRoles.includes('Treasurer') || userRoles.includes('Assistant Treasurer');
        if (!isRequester && !canApprove) {
            throw createError.forbidden(
                'Only the person who requested this, or the Treasurer/Assistant Treasurer, can edit it'
            );
        }

        const newType = requisition_type || requisition.requisition_type;
        const isAcknowledgementType = (t) =>
            t === 'CONTRIBUTION_ACKNOWLEDGEMENT' || t === 'SAVINGS_DEPOSIT' ||
            t === 'SIDE_FUND_CONTRIBUTION' || t === 'FINE_PAYMENT';
        if (isAcknowledgementType(newType) && !(contribution_date || requisition.contribution_date)) {
            throw createError.badRequest(
                newType === 'SAVINGS_DEPOSIT' ? 'Please provide the date the savings deposit was made' :
                newType === 'SIDE_FUND_CONTRIBUTION' ? 'Please provide the date the side fund payment was made' :
                newType === 'FINE_PAYMENT' ? 'Please provide the date the fine payment was made' :
                'Please provide the date the contribution was made'
            );
        }

        let newFineId = requisition.fine_id;
        if (newType === 'FINE_PAYMENT') {
            const targetFineId = fine_id || requisition.fine_id;
            if (!targetFineId) {
                throw createError.badRequest('Please select which fine this payment is for');
            }
            const fineCheck = await client.query(
                'SELECT id, status, user_id FROM fines WHERE id = $1 FOR UPDATE', [targetFineId]
            );
            if (fineCheck.rows.length === 0) {
                throw createError.notFound('Fine not found');
            }
            if (fineCheck.rows[0].user_id !== requisition.requested_by) {
                throw createError.forbidden('This fine does not belong to the requester');
            }
            if (fineCheck.rows[0].status !== 'OUTSTANDING') {
                throw createError.badRequest('This fine has already been cleared');
            }
            newFineId = fineCheck.rows[0].id;
        } else {
            newFineId = null;
        }

        const updated = await client.query(`
            UPDATE requisitions
            SET    category_id       = COALESCE($1, category_id),
                   title             = COALESCE($2, title),
                   description       = COALESCE($3, description),
                   amount_requested  = COALESCE($4, amount_requested),
                   purpose           = COALESCE($5, purpose),
                   required_by_date  = $6,
                   priority          = COALESCE($7, priority),
                   requisition_type  = $8,
                   contribution_date = $9,
                   fine_id           = $10
            WHERE  id = $11
            RETURNING *
        `, [
            category_id || null, title ? title.trim() : null,
            description !== undefined ? description : null,
            amount_requested || null, purpose ? purpose.trim() : null,
            required_by_date !== undefined ? required_by_date : requisition.required_by_date,
            priority || null, newType,
            isAcknowledgementType(newType)
                ? (contribution_date || requisition.contribution_date) : null,
            newFineId,
            id,
        ]);

        await logAction(req.user.id, ACTIONS.REQUISITION_UPDATED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'requisitions',
            recordId:    id,
            oldValues:   requisition,
            newValues:   updated.rows[0],
            description: `Requisition edited before approval: ID ${id}`,
            client,
        });

        sendSuccess(res, updated.rows[0], 'Requisition updated');
    });
});

module.exports = {
    createRequisition,
    editRequisition,
    approveRequisition,
    rejectRequisition,
    getMyRequisitions,
    getAllRequisitions,
};