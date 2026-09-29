// ============================================================
// SAVINGS FINE SETTLEMENT CONTROLLER (v1.59.0)
// Pay one or more of a member's own OUTSTANDING fines straight out of
// their savings principal. See savingsFineSettlementService.js for
// the shared settle()/decline() core and the full design writeup.
//
// Two creation entry points funnel into the same shared review/settle
// logic below:
//   createSettlement          — Treasurer/Assistant Treasurer, on a
//                                member's behalf (FINE_MANAGE)
//   requestSettlement         — a member, for themselves (self-service)
// Four review endpoints, gated by WHO may act on which source:
//   confirmSettlement/rejectSettlement — the member only, and only on
//                                         a TREASURY_DIRECT entry
//   approveSettlement/denySettlement   — FINE_MANAGE only, and only on
//                                         a MEMBER_REQUEST entry
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('../services/referenceService');
const { notify, notifyMany } = require('../services/notificationService');
const { getSavingsAccount, getOrCreateSavingsBalance } = require('../services/savingsService');
const { settleFineSettlement, declineFineSettlement } = require('../services/savingsFineSettlementService');
const { assertNotOwnRecord } = require('../services/approvalGuard'); // v1.72.0

MODULE_CODES.SAVINGS_FINE_SETTLEMENT = 'SAV';

// ============================================================
// INTERNAL HELPER — validates the member, the savings account/balance,
// the selected fines (ownership, OUTSTANDING, same currency as
// Savings), the destination account, and the running total — shared
// by both creation entry points. Must be called from inside an
// existing withTransaction block.
// ============================================================
const prepareSettlement = async (client, { userId, fineIds, destinationAccountId }) => {
    const memberResult = await client.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (memberResult.rows.length === 0) {
        throw createError.notFound('Member not found');
    }
    const member = memberResult.rows[0];

    if (!Array.isArray(fineIds) || fineIds.length === 0) {
        throw createError.badRequest('Select at least one outstanding fine to settle');
    }

    const finesResult = await client.query(`
        SELECT id, amount, currency_id, status
        FROM   fines
        WHERE  id = ANY($1::int[]) AND user_id = $2
    `, [fineIds, userId]);

    if (finesResult.rows.length !== fineIds.length) {
        throw createError.badRequest('One or more selected fines do not belong to this member or do not exist');
    }

    // v1.61.0 — a company can now have more than one Savings account
    // (one per currency), so the fines' own currency decides WHICH one
    // this settlement draws from, rather than assuming a singleton.
    const fineCurrencyId = finesResult.rows[0].currency_id;
    for (const fine of finesResult.rows) {
        if (fine.status !== 'OUTSTANDING') {
            throw createError.badRequest('One or more selected fines is no longer outstanding');
        }
        if (fine.currency_id !== fineCurrencyId) {
            throw createError.badRequest(
                'Every selected fine must be in the same currency — ' +
                'this system does not automatically convert currencies when moving real money between accounts.'
            );
        }
    }

    const savingsAccount = await getSavingsAccount(client, fineCurrencyId);

    const totalAmount = finesResult.rows.reduce((sum, f) => sum + parseFloat(f.amount), 0);

    const balance = await getOrCreateSavingsBalance(client, userId, fineCurrencyId);
    if (totalAmount > parseFloat(balance.principal_balance)) {
        throw createError.badRequest(
            `Cannot settle more than the member has saved. Selected total: ${totalAmount}. Available: ${balance.principal_balance}.`
        );
    }

    // Destination defaults to Primary (same default creditShareholderContribution/
    // v1.58.0's Savings-to-Capital Conversion use) — validated to share the
    // Savings account's own currency, same as every selected fine.
    const destAccountResult = destinationAccountId
        ? await client.query(`
            SELECT id, currency_id
            FROM   accounts
            WHERE  id = $1 AND is_active = TRUE AND account_type != 'SAVINGS'
        `, [destinationAccountId])
        : await client.query(`
            SELECT id, currency_id
            FROM   accounts
            WHERE  account_type = 'PRIMARY' AND is_active = TRUE
        `);
    if (destAccountResult.rows.length === 0) {
        throw createError.badRequest(
            destinationAccountId
                ? 'The selected destination account was not found, is inactive, or is a Savings account'
                : 'Primary account has not been set up yet'
        );
    }
    const destAccount = destAccountResult.rows[0];
    if (destAccount.currency_id !== savingsAccount.currency_id) {
        throw createError.badRequest(
            'The destination account must be in the same currency as the Savings account.'
        );
    }

    return { member, savingsAccount, destAccount, fines: finesResult.rows, totalAmount };
};

// ============================================================
// INTERNAL HELPER — inserts the parent + item rows once
// prepareSettlement has validated everything. Shared by both creation
// entry points; only `source`/`initiatedBy`/notification wording
// differs between them.
// ============================================================
const insertSettlement = async (client, {
    member, savingsAccount, destAccount, fines, totalAmount,
    settlementDate, notes, source, initiatedBy,
}) => {
    const { referenceId, referenceCode } = await generateReference(
        client, MODULE_CODES.SAVINGS_FINE_SETTLEMENT, 'SAVFINE', 'SAVINGS_FINE_SETTLEMENT', initiatedBy
    );

    const status = source === 'TREASURY_DIRECT' ? 'PENDING_CONFIRMATION' : 'PENDING_APPROVAL';

    const result = await client.query(`
        INSERT INTO savings_fine_settlements (
            reference_id, user_id, account_id, destination_account_id, total_amount,
            currency_id, settlement_date, notes, source, status, initiated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
    `, [
        referenceId, member.id, savingsAccount.id, destAccount.id, totalAmount,
        savingsAccount.currency_id, settlementDate, notes || null, source, status, initiatedBy,
    ]);
    const settlementId = result.rows[0].id;
    await linkReferenceToRecord(client, referenceId, settlementId);

    for (const fine of fines) {
        await client.query(`
            INSERT INTO savings_fine_settlement_items (settlement_id, fine_id, amount)
            VALUES ($1, $2, $3)
        `, [settlementId, fine.id, fine.amount]);
    }

    return { settlementId, referenceCode, status };
};

// ============================================================
// CREATE (TREASURY-DIRECT) — Treasurer/Assistant Treasurer, on a
// member's behalf. Sits PENDING_CONFIRMATION until the member confirms.
// POST /api/fines/settlements
// ============================================================
const createSettlement = asyncHandler(async (req, res) => {
    const { user_id, fine_ids, settlement_date, notes, destination_account_id } = req.body;

    await withTransaction(async (client) => {
        const { member, savingsAccount, destAccount, fines, totalAmount } = await prepareSettlement(client, {
            userId: user_id, fineIds: fine_ids, destinationAccountId: destination_account_id,
        });

        const { settlementId, referenceCode, status } = await insertSettlement(client, {
            member, savingsAccount, destAccount, fines, totalAmount,
            settlementDate: settlement_date, notes, source: 'TREASURY_DIRECT', initiatedBy: req.user.id,
        });

        await logAction(req.user.id, ACTIONS.SAVINGS_FINE_SETTLEMENT_ENTERED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_fine_settlements',
            recordId:    settlementId,
            newValues:   { referenceCode, user_id, totalAmount, fineCount: fines.length },
            description: `Savings fine settlement entered (awaiting member confirmation): ${referenceCode} — ${member.first_name} ${member.last_name}: ${totalAmount} across ${fines.length} fine(s)`,
            client,
        });

        notify({
            userId:     member.id,
            type:       'SAVINGS_FINE_SETTLEMENT_PENDING',
            title:      'Confirm settling fines from your savings',
            body:       `The Treasurer wants to settle ${fines.length} fine(s) totalling ${totalAmount} out of your savings (${referenceCode}). Nothing has moved yet — please confirm or reject.`,
            link:       '/fines',
            module:     'FINANCE',
            recordType: 'savings_fine_settlements',
            recordId:   settlementId,
        });

        sendCreated(res, {
            settlement_id: settlementId,
            reference:     referenceCode,
            status,
        }, `Savings fine settlement recorded. Reference: ${referenceCode}. Awaiting the member's confirmation.`);
    });
});

// ============================================================
// REQUEST (MEMBER-SIDE) — a member selects their own outstanding
// fines to settle from their own savings. Sits PENDING_APPROVAL until
// a Treasurer/Assistant Treasurer approves it.
// POST /api/fines/settlements/request
// ============================================================
const requestSettlement = asyncHandler(async (req, res) => {
    const { fine_ids, settlement_date, notes, destination_account_id } = req.body;

    await withTransaction(async (client) => {
        const { member, savingsAccount, destAccount, fines, totalAmount } = await prepareSettlement(client, {
            userId: req.user.id, fineIds: fine_ids, destinationAccountId: destination_account_id,
        });

        const { settlementId, referenceCode, status } = await insertSettlement(client, {
            member, savingsAccount, destAccount, fines, totalAmount,
            settlementDate: settlement_date, notes, source: 'MEMBER_REQUEST', initiatedBy: req.user.id,
        });

        await logAction(req.user.id, ACTIONS.SAVINGS_FINE_SETTLEMENT_REQUESTED, MODULES.FINANCE, {
            ipAddress:   req.ip,
            recordType:  'savings_fine_settlements',
            recordId:    settlementId,
            newValues:   { referenceCode, totalAmount, fineCount: fines.length },
            description: `Savings fine settlement requested (awaiting Treasurer approval): ${referenceCode} — ${member.first_name} ${member.last_name}: ${totalAmount} across ${fines.length} fine(s)`,
            client,
        });

        // Notify Treasurer / Assistant Treasurer — same lookup pattern
        // as createPendingFlexibleDeposit's own approver notification.
        const approvers = await client.query(`
            SELECT DISTINCT u.id, u.first_name, u.last_name, u.email
            FROM   users u
            JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
            JOIN   roles r       ON r.id = ur.role_id
            WHERE  r.name IN ('Treasurer', 'Assistant Treasurer')
            AND    u.is_active = TRUE
        `);
        notifyMany(approvers.rows, 'SAVINGS_FINE_SETTLEMENT_PENDING', () => ({
            title:      'Savings fine settlement request awaiting your approval',
            body:       `${member.first_name} ${member.last_name} wants to settle ${fines.length} fine(s) totalling ${totalAmount} out of their savings (${referenceCode}).`,
            link:       '/fines',
            module:     'FINANCE',
            recordType: 'savings_fine_settlements',
            recordId:   settlementId,
        }));

        sendCreated(res, {
            settlement_id: settlementId,
            reference:     referenceCode,
            status,
        }, `Request submitted. Reference: ${referenceCode}. Awaiting Treasurer/Assistant Treasurer approval.`);
    });
});

// ============================================================
// CONFIRM — the member only, and only on a TREASURY_DIRECT entry.
// PATCH /api/fines/settlements/:id/confirm
// ============================================================
const confirmSettlement = asyncHandler(async (req, res) => {
    const { id } = req.params;

    await withTransaction(async (client) => {
        const existing = await client.query('SELECT * FROM savings_fine_settlements WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            throw createError.notFound('Savings fine settlement not found');
        }
        const settlement = existing.rows[0];

        if (settlement.user_id !== req.user.id) {
            throw createError.forbidden('Only the member whose savings this is can confirm this settlement');
        }
        if (settlement.source !== 'TREASURY_DIRECT' || settlement.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This settlement cannot be confirmed. Status: ${settlement.status}`);
        }

        const result = await settleFineSettlement(client, { settlementId: parseInt(id), recordedByUserId: req.user.id });

        sendSuccess(res, {
            status: 'SETTLED',
            savings_transaction_reference: result.txRefCode,
        }, 'Confirmed — the selected fines have been settled from your savings');
    });
});

// ============================================================
// REJECT — the member only, and only on a TREASURY_DIRECT entry.
// PATCH /api/fines/settlements/:id/reject
// ============================================================
const rejectSettlement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query('SELECT * FROM savings_fine_settlements WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            throw createError.notFound('Savings fine settlement not found');
        }
        const settlement = existing.rows[0];

        if (settlement.user_id !== req.user.id) {
            throw createError.forbidden('Only the member whose savings this is can reject this settlement');
        }
        if (settlement.source !== 'TREASURY_DIRECT' || settlement.status !== 'PENDING_CONFIRMATION') {
            throw createError.badRequest(`This settlement cannot be rejected. Status: ${settlement.status}`);
        }

        await declineFineSettlement(client, { settlementId: parseInt(id), recordedByUserId: req.user.id, reason });
        sendSuccess(res, { status: 'REJECTED' }, 'Settlement rejected');
    });
});

// ============================================================
// APPROVE — FINE_MANAGE only, and only on a MEMBER_REQUEST entry.
// PATCH /api/fines/settlements/:id/approve
// ============================================================
const approveSettlement = asyncHandler(async (req, res) => {
    // v1.72.0 — four-eyes rule: the creator (or the member it benefits) can't approve it; an Admin can.
    await assertNotOwnRecord(req, null, 'savings_fine_settlements', req.params.id, ['user_id', 'initiated_by'], 'fine settlement');
    const { id } = req.params;

    await withTransaction(async (client) => {
        const existing = await client.query('SELECT * FROM savings_fine_settlements WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            throw createError.notFound('Savings fine settlement not found');
        }
        const settlement = existing.rows[0];

        if (settlement.source !== 'MEMBER_REQUEST' || settlement.status !== 'PENDING_APPROVAL') {
            throw createError.badRequest(`This settlement cannot be approved. Status: ${settlement.status}`);
        }

        const result = await settleFineSettlement(client, { settlementId: parseInt(id), recordedByUserId: req.user.id });

        sendSuccess(res, {
            status: 'SETTLED',
            savings_transaction_reference: result.txRefCode,
        }, 'Approved — the selected fines have been settled from the member\'s savings');
    });
});

// ============================================================
// DENY — FINE_MANAGE only, and only on a MEMBER_REQUEST entry.
// PATCH /api/fines/settlements/:id/deny
// ============================================================
const denySettlement = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    await withTransaction(async (client) => {
        const existing = await client.query('SELECT * FROM savings_fine_settlements WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            throw createError.notFound('Savings fine settlement not found');
        }
        const settlement = existing.rows[0];

        if (settlement.source !== 'MEMBER_REQUEST' || settlement.status !== 'PENDING_APPROVAL') {
            throw createError.badRequest(`This settlement cannot be denied. Status: ${settlement.status}`);
        }

        await declineFineSettlement(client, { settlementId: parseInt(id), recordedByUserId: req.user.id, reason });
        sendSuccess(res, { status: 'REJECTED' }, 'Request denied');
    });
});

// ============================================================
// GET MY SETTLEMENTS — every settlement concerning this member,
// whichever direction it came from.
// GET /api/fines/settlements/me
// ============================================================
const getMySettlements = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT sfs.*, r.reference_code,
               c.code AS currency_code,
               ini.first_name || ' ' || ini.last_name AS initiated_by_name,
               rev.first_name || ' ' || rev.last_name AS reviewed_by_name,
               (SELECT COUNT(*) FROM savings_fine_settlement_items i WHERE i.settlement_id = sfs.id) AS fine_count
        FROM   savings_fine_settlements sfs
        JOIN   references_registry r ON r.id = sfs.reference_id
        JOIN   currencies c ON c.id = sfs.currency_id
        JOIN   users ini ON ini.id = sfs.initiated_by
        LEFT JOIN users rev ON rev.id = sfs.reviewed_by
        WHERE  sfs.user_id = $1
        ORDER BY sfs.created_at DESC
    `, [req.user.id]);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL SETTLEMENTS — Treasurer/Admin (FINE_VIEW)
// GET /api/fines/settlements
// ============================================================
const getAllSettlements = asyncHandler(async (req, res) => {
    const { status, source } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;
    if (status) { p++; conditions.push(`sfs.status = $${p}`); params.push(status.toUpperCase()); }
    if (source) { p++; conditions.push(`sfs.source = $${p}`); params.push(source.toUpperCase()); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM savings_fine_settlements sfs ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT
            sfs.*, r.reference_code, c.code AS currency_code,
            u.first_name || ' ' || u.last_name AS member_name,
            ini.first_name || ' ' || ini.last_name AS initiated_by_name,
            rev.first_name || ' ' || rev.last_name AS reviewed_by_name,
            (SELECT COUNT(*) FROM savings_fine_settlement_items i WHERE i.settlement_id = sfs.id) AS fine_count
        FROM  savings_fine_settlements sfs
        JOIN  references_registry r ON r.id = sfs.reference_id
        JOIN  currencies c ON c.id = sfs.currency_id
        JOIN  users u ON u.id = sfs.user_id
        JOIN  users ini ON ini.id = sfs.initiated_by
        LEFT JOIN users rev ON rev.id = sfs.reviewed_by
        ${where}
        ORDER BY sfs.created_at DESC
        LIMIT $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET ONE SETTLEMENT'S FINE ITEMS — used by both "mine" and "all"
// detail views to show exactly which fines a settlement covers.
// GET /api/fines/settlements/:id/items
// ============================================================
const getSettlementItems = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const settlementResult = await query('SELECT user_id FROM savings_fine_settlements WHERE id = $1', [id]);
    if (settlementResult.rows.length === 0) {
        throw createError.notFound('Savings fine settlement not found');
    }
    const isOwner = settlementResult.rows[0].user_id === req.user.id;
    const canViewAll = (req.user.permissions || []).includes('FINE_VIEW');
    if (!isOwner && !canViewAll) {
        throw createError.forbidden('You do not have access to this settlement');
    }

    const result = await query(`
        SELECT sfsi.*, f.reason, f.description AS fine_description
        FROM   savings_fine_settlement_items sfsi
        JOIN   fines f ON f.id = sfsi.fine_id
        WHERE  sfsi.settlement_id = $1
    `, [id]);
    sendSuccess(res, result.rows);
});

module.exports = {
    createSettlement,
    requestSettlement,
    confirmSettlement,
    rejectSettlement,
    approveSettlement,
    denySettlement,
    getMySettlements,
    getAllSettlements,
    getSettlementItems,
};
