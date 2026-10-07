// ============================================================
// SHARE CAPITAL CONTROLLER (v1.69.0)
// HTTP layer over shareCapitalService.js — see that file's header for
// the whole model (nominal value, issue price, whole shares, members'
// share credit, registered limit, returns of allotment, and the
// two-person approval of share value changes).
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { notify, notifyMany } = require('../services/notificationService');
const { wrapEmail } = require('../services/emailTemplates');
const svc = require('../services/shareCapitalService');
const { assertNotOwnRecord } = require('../services/approvalGuard'); // v1.72.0

// Roles that may see every member's shares and credit (the register).
const STAFF_VIEW_ROLES = ['Treasurer', 'Assistant Treasurer', 'Director', 'Admin', 'Secretary'];
const isStaffViewer = (req) => (req.user.roles || []).some(r => STAFF_VIEW_ROLES.includes(r));

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

const CHANGE_LABELS = {
    ISSUE_PRICE: 'issue price per share',
    NOMINAL_VALUE: 'nominal value per share',
    REGISTERED_SHARES: 'number of registered shares',
};

// ------------------------------------------------------------
// OVERVIEW / STATEMENTS
// ------------------------------------------------------------
const getOverview = asyncHandler(async (req, res) => {
    const overview = await svc.getOverview({ includeMembers: isStaffViewer(req) });
    sendSuccess(res, { ...overview, canSeeMembers: isStaffViewer(req) });
});

const getMyStatement = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.getMemberStatement(req.user.id));
});

const getMemberStatement = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.getMemberStatement(parseInt(req.params.userId, 10)));
});

// ------------------------------------------------------------
// REGISTERED VALUES (nominal value + registered shares, with history)
// Set in the system by a Director or the Treasurer; editable until the
// first shares are allotted, then changed only through Changes.
// ------------------------------------------------------------
const getRegisteredSetup = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.getRegisteredSetup());
});

const saveRegisteredSetup = asyncHandler(async (req, res) => {
    const { rows, currency_id, notes } = req.body;
    const result = await withTransaction(client => svc.saveRegisteredSetup(client, {
        rows, currencyId: currency_id, notes, userId: req.user.id,
    }));
    sendSuccess(res, result, 'Registered values saved');
});

// ------------------------------------------------------------
// OPENING CONVERSION
// ------------------------------------------------------------
const previewOpeningConversion = asyncHandler(async (req, res) => {
    const summary = await svc.previewOpeningConversion({ userId: req.user.id });
    sendSuccess(res, summary, 'Preview only — nothing has been saved');
});

const commitOpeningConversion = asyncHandler(async (req, res) => {
    const summary = await withTransaction(async (client) => {
        const s = await svc.runOpeningConversion(client, { userId: req.user.id });
        await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
            ipAddress: req.ip, recordType: 'share_allotments',
            newValues: { totalShares: s.totalShares, totalCredit: s.totalCredit, contributions: s.contributions },
            description: `Share capital opening conversion: ${s.contributions} contribution(s) → ${s.totalShares} whole shares, credit ${s.totalCredit}`,
            client,
        });
        return s;
    });
    sendSuccess(res, summary, `Converted to ${summary.totalShares} whole shares`);
});

// ------------------------------------------------------------
// ALLOTMENTS & RETURNS
// ------------------------------------------------------------
const getAllotments = asyncHandler(async (req, res) => {
    const { month, user_id, pending_returns } = req.query;
    sendSuccess(res, await svc.listAllotments({
        month: month || null,
        userId: user_id ? parseInt(user_id, 10) : null,
        pendingReturnsOnly: pending_returns === 'true',
    }));
});

const markReturnsFiled = asyncHandler(async (req, res) => {
    const { allotment_ids, filed_at, return_reference } = req.body;
    const result = await withTransaction(client => svc.markReturnsFiled(client, {
        allotmentIds: allotment_ids, filedAt: filed_at, returnReference: return_reference, userId: req.user.id,
    }));
    sendSuccess(res, result, `${result.updated} allotment(s) marked as filed`);
});

// ------------------------------------------------------------
// CHANGE REQUESTS
// ------------------------------------------------------------
const getChangeRequests = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.listChangeRequests());
});

const getEligibleResolutions = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.listEligibleResolutions());
});

const eligibleApprovers = async (excludeUserId) => {
    const r = await query(`
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
        FROM   users u
        JOIN   user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r ON r.id = ur.role_id AND r.is_active = TRUE
        WHERE  r.name IN ('Director', 'Treasurer') AND u.is_active = TRUE AND u.id <> $1
    `, [excludeUserId]);
    return r.rows;
};

const createChangeRequest = asyncHandler(async (req, res) => {
    const { change_type, proposed_value, effective_date, resolution_document_id, reason } = req.body;
    const created = await withTransaction(client => svc.createChangeRequest(client, {
        changeType: change_type,
        proposedValue: proposed_value,
        effectiveDate: effective_date,
        resolutionDocumentId: parseInt(resolution_document_id, 10),
        reason,
        userId: req.user.id,
    }));

    const approvers = await eligibleApprovers(req.user.id);
    notifyMany(approvers, 'SHARE_CAPITAL_CHANGE_PROPOSED', (u) => ({
        title: 'Share capital change awaiting your approval',
        body: `${req.user.first_name || 'A colleague'} proposed a change to the ${CHANGE_LABELS[change_type]} (${created.referenceCode}). ` +
              `It needs a second approver: a Director${created.capacity === 'Director' ? ' or the Treasurer' : ''}.`,
        link: '/share-capital?tab=changes',
        module: 'FINANCE',
        recordType: 'share_capital_change_requests',
        recordId: created.id,
    })).catch(() => {});

    sendCreated(res, created, `Change ${created.referenceCode} proposed — it now needs a second approver`);
});

const approveChangeRequest = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await withTransaction(client => svc.approveChangeRequest(client, {
        requestId: id, userId: req.user.id, note: req.body.note,
    }));

    // Notify every shareholder (best-effort, after commit).
    const holders = await query(`
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name, sr.shares_held
        FROM   shareholding_registry sr
        JOIN   users u ON u.id = sr.user_id AND u.is_active = TRUE
        WHERE  sr.effective_to IS NULL
    `);
    const r = result.request;
    const s = result.summary;
    const what = CHANGE_LABELS[r.change_type];
    const line = r.change_type === 'NOMINAL_VALUE'
        ? `The nominal value per share changed from ${r.currency_code} ${fmt(s.nominalBefore)} to ${r.currency_code} ${fmt(s.nominalAfter)} (${s.ratioText}). Every holding was converted by the same ratio.`
        : r.change_type === 'ISSUE_PRICE'
            ? `The issue price per share changes from ${r.currency_code} ${fmt(s.issuePriceBefore)} to ${r.currency_code} ${fmt(s.issuePriceAfter)} from ${s.effectiveDate}.`
            : `The number of registered shares changed from ${fmt(s.registeredBefore)} to ${fmt(s.registeredAfter)} (effective ${s.effectiveDate}).`;
    const shell = await wrapEmail(`
        <p>{{GREETING}}</p>
        <p>The following change to the company's share capital has been approved under board resolution
        <strong>${r.resolution_reference || ''} ${r.resolution_title ? `— ${r.resolution_title}` : ''}</strong>:</p>
        <p>${line}</p>
        {{HOLDING}}
        <p>The formal notice (${result.notice.referenceCode}), with the history of the share values, is in
        <strong>Documents &gt; My Documents</strong>.</p>
    `, { preheader: `Notice: change of the ${what}` });

    notifyMany(holders.rows, 'SHARE_CAPITAL_CHANGED', (h) => {
        const m = (s.members || []).find(x => x.userId === h.id);
        const holding = m
            ? `<p>Your holding: ${fmt(m.sharesBefore)} → <strong>${fmt(m.sharesAfter)}</strong> shares${m.creditAdded ? `; ${r.currency_code} ${fmt(m.creditAdded)} returned to your share credit` : ''}.</p>`
            : '';
        return {
            title: `Notice: change of the ${what}`,
            body: line,
            link: '/documents',
            module: 'FINANCE',
            recordType: 'documents',
            recordId: result.notice.documentId,
            email: {
                subject: `Notice to shareholders — change of the ${what}`,
                html: shell.replace('{{GREETING}}', `Dear ${h.first_name},`).replace('{{HOLDING}}', holding),
            },
        };
    }).catch(() => {});

    sendSuccess(res, result, `Change ${r.reference_code} approved and applied; notice ${result.notice.referenceCode} issued to all shareholders`);
});

const rejectChangeRequest = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await withTransaction(client => svc.rejectChangeRequest(client, {
        requestId: id, userId: req.user.id, note: req.body.note, cancel: false,
    }));
    sendSuccess(res, result, 'Change request rejected');
});

const cancelChangeRequest = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await withTransaction(client => svc.rejectChangeRequest(client, {
        requestId: id, userId: req.user.id, note: req.body.note, cancel: true,
    }));
    sendSuccess(res, result, 'Change request withdrawn');
});

// ------------------------------------------------------------
// SHARE CREDIT REFUNDS
// ------------------------------------------------------------
const getRefunds = asyncHandler(async (req, res) => {
    sendSuccess(res, await svc.listRefunds());
});

const createRefund = asyncHandler(async (req, res) => {
    const { user_id, credit_amount, account_id, reason } = req.body;
    const created = await withTransaction(client => svc.createRefund(client, {
        memberId: parseInt(user_id, 10), creditAmount: credit_amount, accountId: parseInt(account_id, 10),
        reason, requestedBy: req.user.id,
    }));
    const checkers = await query(`
        SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
        FROM   users u JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        JOIN   roles r ON r.id = ur.role_id
        WHERE  r.name IN ('Treasurer', 'Assistant Treasurer', 'Director') AND u.is_active = TRUE AND u.id <> $1
    `, [req.user.id]);
    notifyMany(checkers.rows, 'SHARE_CREDIT_REFUND_REQUESTED', () => ({
        title: 'Share credit refund awaiting approval',
        body: `Refund ${created.referenceCode} needs approval by someone other than the person who requested it.`,
        link: '/share-capital?tab=credits',
        module: 'FINANCE',
        recordType: 'capital_credit_refunds',
        recordId: created.id,
    })).catch(() => {});
    sendCreated(res, created, `Refund ${created.referenceCode} requested — awaiting a second person's approval`);
});

const decideRefund = (approve) => asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    // v1.72.0 — four-eyes rule (approving only; refusing is always allowed).
    if (approve) await assertNotOwnRecord(req, null, 'capital_credit_refunds', id, ['user_id', 'requested_by'], 'refund');
    const result = await withTransaction(client => svc.decideRefund(client, {
        refundId: id, userId: req.user.id, approve, note: req.body.note, payoutDate: req.body.payout_date,
    }));
    if (result.status === 'PAID') {
        notify({
            userId: result.memberId,
            type: 'SHARE_CREDIT_REFUNDED',
            title: 'Share credit refunded',
            body: `Your unused share credit was refunded (${result.transactionReference}).`,
            link: '/share-capital',
            module: 'FINANCE',
            recordType: 'capital_credit_refunds',
            recordId: id,
        }).catch(() => {});
    }
    sendSuccess(res, result, result.status === 'PAID' ? 'Refund approved and paid' : 'Refund rejected');
});

const cancelRefund = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await withTransaction(client => svc.decideRefund(client, {
        refundId: id, userId: req.user.id, cancel: true, note: req.body.note,
    }));
    sendSuccess(res, result, 'Refund request withdrawn');
});

// ------------------------------------------------------------
// EACH MEMBER'S SHARES REGISTERED WITH URSB (v1.81.0)
// See services/registeredSharesService.js.
// ------------------------------------------------------------
const registered = require('../services/registeredSharesService');

const getRegisteredByMember = asyncHandler(async (req, res) => {
    sendSuccess(res, await registered.getRegister());
});

// A member may see their own; the staff roles anyone's.
const getRegisteredForMember = asyncHandler(async (req, res) => {
    const memberId = parseInt(req.params.userId, 10);
    const roles = req.user.roles || [];
    if (memberId !== req.user.id && !roles.some(r => STAFF_VIEW_ROLES.includes(r))) {
        throw createError.forbidden('You can only see your own registered shares.');
    }
    sendSuccess(res, await registered.getMember(memberId));
});

const setRegisteredForMember = asyncHandler(async (req, res) => {
    const memberId = parseInt(req.params.userId, 10);
    const { shares, as_at, note, document_id, change_reason } = req.body;
    await withTransaction(client => registered.setOpening(client, {
        userId: memberId, shares: Number(shares), asAt: as_at, note, documentId: document_id ? parseInt(document_id, 10) : null,
        changeReason: change_reason, by: req.user.id, ipAddress: req.ip,
    }));
    sendSuccess(res, await registered.getMember(memberId), 'URSB-registered shares saved');
});

module.exports = {
    STAFF_VIEW_ROLES,
    getRegisteredByMember,   // v1.81.0
    getRegisteredForMember,  // v1.81.0
    setRegisteredForMember,  // v1.81.0
    getOverview,
    getMyStatement,
    getMemberStatement,
    getRegisteredSetup,
    saveRegisteredSetup,
    previewOpeningConversion,
    commitOpeningConversion,
    getAllotments,
    markReturnsFiled,
    getChangeRequests,
    getEligibleResolutions,
    createChangeRequest,
    approveChangeRequest,
    rejectChangeRequest,
    cancelChangeRequest,
    getRefunds,
    createRefund,
    approveRefund: decideRefund(true),
    rejectRefund: decideRefund(false),
    cancelRefund,
};
