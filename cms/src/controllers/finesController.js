// ============================================================
// FINES CONTROLLER (v1.37.0)
// Treasury assigns a fine to a shareholder — special income to the
// company, posted with its own traceable inflow_type once cleared.
// See finesService.js for the shared crediting core, and
// requisitionsController.js's FINE_PAYMENT branch for the
// "member paid externally, please record it" path.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const { notify } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const { clearFine } = require('../services/finesService');

MODULE_CODES.FINE = 'FINE';

const REASONS = ['CONTRIBUTION_FAILURE', 'MEETING_VIOLATION', 'GENERAL'];

// ============================================================
// CREATE (ASSIGN) A FINE — Treasurer/Assistant Treasurer/Admin (FINE_MANAGE)
// POST /api/fines
// For reason=CONTRIBUTION_FAILURE, `amount` is computed here from
// defaulted_amount x (fine_percentage / 100) rather than trusted from
// the client, so the stored amount can never drift from its own
// inputs. For MEETING_VIOLATION/GENERAL, `amount` is entered directly.
// ============================================================
const createFine = asyncHandler(async (req, res) => {
    const {
        user_id, reason, description, currency_id, amount,
        default_deadline, defaulted_amount, fine_percentage,
    } = req.body;

    if (!REASONS.includes(reason)) {
        throw createError.badRequest(`reason must be one of: ${REASONS.join(', ')}`);
    }
    if (!currency_id) {
        throw createError.badRequest('currency_id is required');
    }

    let finalAmount;
    if (reason === 'CONTRIBUTION_FAILURE') {
        if (!default_deadline || defaulted_amount === undefined || defaulted_amount === null ||
            fine_percentage === undefined || fine_percentage === null) {
            throw createError.badRequest(
                'The deadline of default, the amount defaulted on, and the fine percentage are all required for a contribution-failure fine'
            );
        }
        finalAmount = parseFloat(
            (parseFloat(defaulted_amount) * (parseFloat(fine_percentage) / 100)).toFixed(4)
        );
        if (finalAmount <= 0) {
            throw createError.badRequest('The computed fine amount must be greater than zero');
        }
    } else {
        if (!amount || parseFloat(amount) <= 0) {
            throw createError.badRequest('A fine amount greater than zero is required');
        }
        finalAmount = parseFloat(amount);
    }

    await withTransaction(async (client) => {
        const memberResult = await client.query(
            'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
            [user_id]
        );
        if (memberResult.rows.length === 0) {
            throw createError.notFound('Member not found');
        }
        const member = memberResult.rows[0];

        const { referenceId, referenceCode } = await generateReference(
            client, MODULE_CODES.FINE, 'FINE', 'FINE', req.user.id
        );

        const result = await client.query(`
            INSERT INTO fines (
                reference_id, user_id, reason, description, currency_id, amount,
                default_deadline, defaulted_amount, fine_percentage, assigned_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
        `, [
            referenceId, user_id, reason, description || null, currency_id, finalAmount,
            reason === 'CONTRIBUTION_FAILURE' ? default_deadline : null,
            reason === 'CONTRIBUTION_FAILURE' ? defaulted_amount : null,
            reason === 'CONTRIBUTION_FAILURE' ? fine_percentage : null,
            req.user.id,
        ]);
        const fineId = result.rows[0].id;
        await linkReferenceToRecord(client, referenceId, fineId);

        await logAction(req.user.id, ACTIONS.FINE_ASSIGNED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'fines',
            recordId:    fineId,
            newValues:   { referenceCode, reason, amount: finalAmount, memberId: user_id },
            description: `Fine assigned: ${referenceCode} — ${member.first_name} ${member.last_name}: ${finalAmount} (${reason})`,
            client,
        });

        notify({
            userId:     parseInt(user_id),
            type:       'FINE_ASSIGNED',
            title:      'A fine has been assigned to you',
            body:       `A fine of ${finalAmount} was assigned to you (${reason.replace('_', ' ').toLowerCase()}). Reference: ${referenceCode}.`,
            link:       '/fines',
            module:     'FINANCE',
            recordType: 'fines',
            recordId:   fineId,
            email: {
                to:      member.email,
                subject: `A fine has been assigned to you — ${referenceCode}`,
                html:    await wrapEmail(`
                    <p>Dear ${member.first_name},</p>
                    <p>A fine of <strong>${finalAmount}</strong> has been assigned to your account.</p>
                    ${description ? `<p style="color:#6b7280;">${description}</p>` : ''}
                    <p>Reference: ${referenceCode}. You can view and settle this from the Fines page.</p>
                `, { preheader: 'A fine has been assigned to you' }),
            },
        });

        sendCreated(res, {
            fine_id:   fineId,
            reference: referenceCode,
            amount:    finalAmount,
        }, `Fine assigned. Reference: ${referenceCode}`);
    });
});

// ============================================================
// GET MY FINES — self-scoped, open to any authenticated member
// GET /api/fines/me
// ============================================================
const getMyFines = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT f.*, rr.reference_code,
               cur.code AS currency_code, cur.symbol AS currency_symbol,
               assigner.first_name || ' ' || assigner.last_name AS assigned_by_name,
               clearer.first_name  || ' ' || clearer.last_name  AS cleared_by_name,
               acc.name AS account_name
        FROM   fines f
        JOIN   references_registry rr ON rr.id = f.reference_id
        JOIN   currencies cur         ON cur.id = f.currency_id
        LEFT JOIN users assigner ON assigner.id = f.assigned_by
        LEFT JOIN users clearer  ON clearer.id  = f.cleared_by
        LEFT JOIN accounts acc   ON acc.id      = f.account_id
        WHERE  f.user_id = $1
        ORDER  BY f.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL FINES — Treasurer/Assistant Treasurer/Admin (FINE_VIEW)
// GET /api/fines
// ============================================================
const getAllFines = asyncHandler(async (req, res) => {
    const { status, user_id } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (status)  { p++; conditions.push(`f.status = $${p}`);  params.push(status.toUpperCase()); }
    if (user_id) { p++; conditions.push(`f.user_id = $${p}`); params.push(user_id); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM fines f ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT f.*, rr.reference_code,
               cur.code AS currency_code, cur.symbol AS currency_symbol,
               u.first_name || ' ' || u.last_name AS member_name,
               u.email AS member_email,
               assigner.first_name || ' ' || assigner.last_name AS assigned_by_name
        FROM   fines f
        JOIN   references_registry rr ON rr.id = f.reference_id
        JOIN   currencies cur         ON cur.id = f.currency_id
        JOIN   users u                ON u.id   = f.user_id
        LEFT JOIN users assigner ON assigner.id = f.assigned_by
        ${where}
        ORDER  BY f.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// CLEAR A FINE DIRECTLY — Treasurer/Assistant Treasurer/Admin (FINE_MANAGE)
// PATCH /api/fines/:id/clear
// Only a paid date and description are required — everything else
// (account/currency validation, category, the actual transaction) is
// handled by finesService.clearFine.
// ============================================================
const clearFineDirect = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { account_id, paid_date, description } = req.body;

    if (!account_id) {
        throw createError.badRequest('An account to receive the payment is required');
    }

    await withTransaction(async (client) => {
        const { transactionId, balanceBefore, balanceAfter, referenceCode, member, fine } =
            await clearFine(client, {
                fineId:              parseInt(id),
                accountId:           parseInt(account_id),
                paidDate:            paid_date || new Date().toISOString().split('T')[0],
                paymentDescription:  description,
                recordedByUserId:    req.user.id,
            });

        sendSuccess(res, {
            fine_id:               fine.id,
            transaction_reference: referenceCode,
            transaction_id:        transactionId,
            balance_before:        balanceBefore,
            balance_after:         balanceAfter,
        }, `Fine cleared for ${member.first_name} ${member.last_name}. Reference: ${referenceCode}`);
    });
});

module.exports = {
    createFine,
    getMyFines,
    getAllFines,
    clearFineDirect,
};
