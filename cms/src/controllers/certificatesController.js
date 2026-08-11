// ============================================================
// CERTIFICATES CONTROLLER
// Certificate of Shares — on-demand issuance (self or, for
// Treasurer/Assistant Treasurer/Admin, any member) plus an
// Admin-only manual trigger that runs the same bulk issue+email
// pipeline the monthly/annual schedule runs automatically.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const {
    issueCertificate,
    issueCertificatesForAllShareholders,
    emailRoundCertificates,
} = require('../services/certificateService');
const { signSlot, getSignatureStatus } = require('../services/signatureService');
const { applyStamps, getAppliedStamps } = require('../services/stampService');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');

// ============================================================
// ISSUE A CERTIFICATE (on-demand)
// POST /api/certificates
// Any authenticated user may issue their OWN certificate.
// Treasurer / Assistant Treasurer / Admin may issue for anyone
// by passing user_id.
// ============================================================
const issueOne = asyncHandler(async (req, res) => {
    const { certificate_type, user_id } = req.body;

    if (!['MONTHLY', 'ANNUAL'].includes(certificate_type)) {
        throw createError.badRequest('certificate_type must be MONTHLY or ANNUAL');
    }

    let targetUserId = req.user.id;
    if (user_id && parseInt(user_id) !== req.user.id) {
        const allowedRoles = ['Treasurer', 'Assistant Treasurer', 'Admin'];
        const hasRole = (req.user.roles || []).some(r =>
            allowedRoles.includes(typeof r === 'object' ? r.name : r)
        );
        if (!hasRole) {
            throw createError.forbidden('You can only issue your own certificate');
        }
        targetUserId = parseInt(user_id);
    }

    const cert = await issueCertificate({
        userId:          targetUserId,
        certificateType: certificate_type,
        issuedBy:        req.user.id,
    });

    sendCreated(res, cert, `Certificate issued: ${cert.reference_code}`);
});

// ============================================================
// GET MY CERTIFICATE HISTORY
// GET /api/certificates/me
// ============================================================
const getMine = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);

    const countResult = await query(
        'SELECT COUNT(*) AS total FROM share_certificates WHERE user_id = $1',
        [req.user.id]
    );
    const total = parseInt(countResult.rows[0].total);

    const result = await query(`
        SELECT sc.id, r.reference_code, sc.certificate_type, sc.period_label,
               sc.shares_held, sc.percentage, sc.price_per_share,
               c.code AS currency_code, c.symbol AS currency_symbol,
               sc.share_value, sc.issued_at, sc.email_sent
        FROM   share_certificates sc
        JOIN   references_registry r ON r.id = sc.reference_id
        LEFT JOIN currencies c ON c.id = sc.currency_id
        WHERE  sc.user_id = $1
        ORDER  BY sc.issued_at DESC
        LIMIT  $2 OFFSET $3
    `, [req.user.id, limit, offset]);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET ALL CERTIFICATES (Treasurer / Assistant Treasurer / Admin)
// GET /api/certificates
// ============================================================
const getAll = asyncHandler(async (req, res) => {
    const { certificate_type, user_id } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const conditions = [];
    const params = [];
    let p = 0;

    if (certificate_type) {
        p++; conditions.push(`sc.certificate_type = $${p}`);
        params.push(certificate_type.toUpperCase());
    }
    if (user_id) {
        p++; conditions.push(`sc.user_id = $${p}`);
        params.push(user_id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
        `SELECT COUNT(*) AS total FROM share_certificates sc ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await query(`
        SELECT sc.id, r.reference_code, sc.certificate_type, sc.period_label,
               sc.shares_held, sc.percentage, sc.price_per_share,
               c.code AS currency_code, c.symbol AS currency_symbol,
               sc.share_value, sc.issued_at, sc.email_sent, sc.email_error,
               u.first_name || ' ' || u.last_name AS holder_name
        FROM   share_certificates sc
        JOIN   references_registry r ON r.id = sc.reference_id
        JOIN   users u ON u.id = sc.user_id
        LEFT JOIN currencies c ON c.id = sc.currency_id
        ${where}
        ORDER  BY sc.issued_at DESC
        LIMIT  $${p + 1} OFFSET $${p + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// ISSUE NOW FOR ALL SHAREHOLDERS (Admin only)
// POST /api/certificates/issue-now
// Runs the exact same pipeline the monthly/annual cron jobs run —
// useful both for testing and for an ad-hoc reissue.
// ============================================================
const issueNow = asyncHandler(async (req, res) => {
    const { certificate_type } = req.body;

    if (!['MONTHLY', 'ANNUAL'].includes(certificate_type)) {
        throw createError.badRequest('certificate_type must be MONTHLY or ANNUAL');
    }

    const result = await issueCertificatesForAllShareholders(certificate_type, req.user.id);

    sendSuccess(res, result,
        `Issued ${result.issued}/${result.total} certificates, emailed ${result.emailed}`);
});

// ============================================================
// LIST CERTIFICATE SIGNING ROUNDS (v1.23.0, Section 4.29)
// GET /api/certificates/rounds
// Treasurer / Assistant Treasurer / Admin — same audience as
// GET /api/certificates.
// ============================================================
const getRounds = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT csr.id, csr.certificate_type, csr.period_label, csr.status,
               csr.opened_at, csr.fully_signed_at,
               COUNT(sc.id)::int AS certificate_count
        FROM   certificate_signing_rounds csr
        LEFT JOIN share_certificates sc ON sc.signing_round_id = csr.id
        GROUP  BY csr.id
        ORDER  BY csr.opened_at DESC
    `);
    sendSuccess(res, result.rows);
});

// ============================================================
// GET ONE SIGNING ROUND, WITH SIGNATURE STATUS
// GET /api/certificates/rounds/:id
// ============================================================
const getRoundById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const roundResult = await query(`
        SELECT csr.*, COUNT(sc.id)::int AS certificate_count
        FROM   certificate_signing_rounds csr
        LEFT JOIN share_certificates sc ON sc.signing_round_id = csr.id
        WHERE  csr.id = $1
        GROUP  BY csr.id
    `, [id]);
    if (roundResult.rows.length === 0) throw createError.notFound('Signing round not found');

    const signatures = await getSignatureStatus('CERTIFICATE_ROUND', id);
    const stamps = await getAppliedStamps('CERTIFICATE_ROUND', id);

    sendSuccess(res, { ...roundResult.rows[0], signatures, stamps });
});

// ============================================================
// SIGN A CERTIFICATE ROUND (v1.23.0, Section 4.29)
// POST /api/certificates/rounds/:id/sign
// One signature covers every certificate in the round. Once every
// required role has signed, every certificate in the round is
// rendered with the completed signatures baked in and emailed.
// ============================================================
const signRound = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const roundResult = await query('SELECT * FROM certificate_signing_rounds WHERE id = $1', [id]);
    if (roundResult.rows.length === 0) throw createError.notFound('Signing round not found');
    const round = roundResult.rows[0];

    if (round.status === 'FULLY_SIGNED') {
        throw createError.badRequest('This round is already fully signed');
    }

    const { allSigned, signerName } = await withTransaction(async (client) =>
        signSlot(client, { targetType: 'CERTIFICATE_ROUND', targetId: round.id, userId: req.user.id })
    );

    await logAction(req.user.id, ACTIONS.CERTIFICATE_ROUND_SIGNED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'certificate_signing_rounds',
        recordId:    round.id,
        description: `${signerName} signed the ${round.period_label} certificate round`,
    }).catch(() => {});

    let emailResult = null;
    if (allSigned) {
        await query(
            `UPDATE certificate_signing_rounds SET status = 'FULLY_SIGNED', fully_signed_at = NOW() WHERE id = $1`,
            [round.id]
        );

        await logAction(req.user.id, ACTIONS.CERTIFICATE_ROUND_FULLY_SIGNED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'certificate_signing_rounds',
            recordId:    round.id,
            description: `Certificate round ${round.period_label} fully signed — emailing certificates`,
        }).catch(() => {});

        // v1.24.0 — apply whichever stamp is configured for
        // SHARE_CERTIFICATE (at most one, e.g. Treasury — see
        // migration_v1.24.0.sql) before rendering, so it's baked
        // into every certificate emailed below.
        await applyStamps('CERTIFICATE_ROUND', round.id, 'SHARE_CERTIFICATE').catch(() => {});

        emailResult = await emailRoundCertificates(round.id);
    }

    const signatures = await getSignatureStatus('CERTIFICATE_ROUND', round.id);
    const stamps = await getAppliedStamps('CERTIFICATE_ROUND', round.id);
    sendSuccess(res, { fully_signed: allSigned, signatures, stamps, email_result: emailResult },
        allSigned
            ? `Round fully signed — ${emailResult.emailed}/${emailResult.total} certificates emailed`
            : 'Signature recorded');
});

module.exports = { issueOne, getMine, getAll, issueNow, getRounds, getRoundById, signRound };
