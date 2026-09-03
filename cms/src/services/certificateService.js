// ============================================================
// CERTIFICATE OF SHARES SERVICE
// Issues a numbered, branded Certificate of Shares for a
// shareholder — the same format is used for both the "MONTHLY"
// and "ANNUAL" certificate types, they only differ in how often
// they're issued and which reference series/period they carry.
//
// Two delivery paths use this service:
//   1. On-demand (certificatesController) — issues a record and
//      returns the figures; the FRONTEND renders and prints it
//      (exportUtils.shareCertificateTemplate), same as every
//      other on-demand document in the system.
//   2. Automatic monthly/annual email (scheduler.js) — issues a
//      record for every active shareholder, renders the same
//      certificate to a PDF via headless Chrome (puppeteer), and
//      emails it as an attachment.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('./referenceService');
const { getBranding } = require('./emailTemplates');
const { sendEmail } = require('../config/email');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { ensureSignatureSlots, getSignatureStatus } = require('./signatureService');
const { applyStamps, getAppliedStamps } = require('./stampService');
const { notifyMany } = require('./notificationService');
const { renderHtmlToPdfBuffer } = require('./pdfService');
const logger = require('../config/logger');

// ============================================================
// RESOLVE ABSOLUTE ASSET URL
// company_settings.logo_url is stored as a relative path
// (e.g. "/uploads/branding/xxx.png") so the frontend can prefix it
// with whatever origin it's running on. Headless Chrome rendering
// this HTML server-side (puppeteer, via page.setContent) has no
// browser origin to resolve a relative path against, so it must be
// turned into a full URL here using this server's own address.
// ============================================================
const resolveAbsoluteAssetUrl = (path) => {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path; // already absolute
    const base = (process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`)
        .replace(/\/$/, '');
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
};

// ============================================================
// COMPUTE A SHAREHOLDER'S CURRENT FIGURES
// shares held, percentage, current price per share, share value —
// the same figures shown on My Profile (usersController.getMyProfile).
// ============================================================
const getShareholderFigures = async (userId) => {
    const holdingResult = await query(`
        SELECT shares_held, percentage
        FROM   shareholding_registry
        WHERE  user_id = $1 AND effective_to IS NULL
    `, [userId]);

    if (holdingResult.rows.length === 0) {
        throw createError.badRequest('This member has no active shareholding record');
    }
    const holding = holdingResult.rows[0];

    const priceResult = await query(`
        SELECT sph.price_per_share, c.id AS currency_id, c.code AS currency_code, c.symbol AS currency_symbol
        FROM   share_price_history sph
        JOIN   currencies c ON c.id = sph.currency_id
        WHERE  sph.effective_to IS NULL
        ORDER  BY sph.effective_from DESC
        LIMIT  1
    `);
    const sharePrice = priceResult.rows[0] || null;

    const shareValue = sharePrice
        ? parseFloat(holding.shares_held || 0) * parseFloat(sharePrice.price_per_share)
        : null;

    return {
        shares_held:      parseFloat(holding.shares_held || 0),
        percentage:       holding.percentage,
        price_per_share:  sharePrice?.price_per_share || null,
        currency_id:      sharePrice?.currency_id || null,
        currency_code:    sharePrice?.currency_code || null,
        currency_symbol:  sharePrice?.currency_symbol || null,
        share_value:      shareValue,
    };
};

// ============================================================
// ISSUE A CERTIFICATE
// Generates a unique certificate number (via the same
// reference-registry mechanism used everywhere else), captures
// the shareholder's figures at this moment, and stores the
// record. certificateType: 'MONTHLY' | 'ANNUAL'.
// periodLabel: optional override — 'YYYYMM' for MONTHLY,
// 'YYYY' for ANNUAL. Defaults to the current month/year.
// ============================================================
const issueCertificate = async ({ userId, certificateType, issuedBy, periodLabel }) => {
    if (!['MONTHLY', 'ANNUAL'].includes(certificateType)) {
        throw createError.badRequest('certificateType must be MONTHLY or ANNUAL');
    }

    const userResult = await query(
        'SELECT id, first_name, last_name, email FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
    );
    if (userResult.rows.length === 0) {
        throw createError.notFound('Member not found');
    }
    const user = userResult.rows[0];

    const figures = await getShareholderFigures(userId);

    const now = new Date();
    const ym = periodLabel || (certificateType === 'ANNUAL'
        ? String(now.getFullYear())
        : String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0'));

    const certificate = await withTransaction(async (client) => {
        const { referenceId, referenceCode } = await generateReference(
            client,
            MODULE_CODES.SHARE_CERTIFICATE,
            certificateType,
            'SHARE_CERTIFICATE',
            issuedBy || userId,
            ym
        );

        const result = await client.query(`
            INSERT INTO share_certificates
                (reference_id, user_id, certificate_type, period_label,
                 shares_held, percentage, price_per_share, currency_id,
                 share_value, issued_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id, issued_at
        `, [
            referenceId, userId, certificateType, ym,
            figures.shares_held, figures.percentage, figures.price_per_share,
            figures.currency_id, figures.share_value, issuedBy || null,
        ]);

        await linkReferenceToRecord(client, referenceId, result.rows[0].id);

        await logAction(issuedBy || userId, ACTIONS.CERTIFICATE_ISSUED, MODULES.SYSTEM, {
            recordType:  'share_certificates',
            recordId:    result.rows[0].id,
            newValues:   { referenceCode, certificateType, userId },
            description: `Certificate of Shares issued to ${user.first_name} ${user.last_name}: ${referenceCode}`,
            client,
        });

        return {
            id:               result.rows[0].id,
            reference_code:   referenceCode,
            issued_at:        result.rows[0].issued_at,
            certificate_type: certificateType,
            period_label:     ym,
        };
    });

    return {
        ...certificate,
        user: { id: user.id, first_name: user.first_name, last_name: user.last_name, email: user.email },
        ...figures,
    };
};

// ============================================================
// RENDER CERTIFICATE HTML (server-side — used for the PDF
// attachment only; the on-demand/interactive path renders its
// own copy client-side via exportUtils.shareCertificateTemplate).
//
// v1.23.0 (Section 4.29): `signatures`, if supplied, is the
// getSignatureStatus('CERTIFICATE_ROUND', roundId) result — one
// block per required role, showing that person's actual signature
// image once SIGNED. When omitted (on-demand single-certificate
// issuance, which isn't part of the signing-round gate — Section
// 4.29's known-issues note), falls back to the original three blank
// signature lines so that path's output is unchanged.
// ============================================================
const renderCertificateHtml = async (cert, signatures = null, stamps = null) => {
    const branding = await getBranding();

    const issuedDate = new Date(cert.issued_at).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
    });
    const periodDisplay = cert.certificate_type === 'ANNUAL'
        ? cert.period_label
        : `${cert.period_label.slice(0, 4)}-${cert.period_label.slice(4, 6)}`;

    const shareValueDisplay = cert.share_value != null
        ? `${cert.currency_symbol || cert.currency_code || ''} ${parseFloat(cert.share_value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
        : '—';

    return `<!DOCTYPE html>
    <html>
    <head><meta charset="utf-8">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: Arial, Helvetica, sans-serif; color:#1a1a1a; padding:40px; }
        .letterhead { display:flex; align-items:center; justify-content:space-between;
            border-bottom:3px solid ${branding.primary_color}; padding-bottom:16px; margin-bottom:28px; }
        .letterhead img { max-height:56px; }
        .company-name { font-size:18px; font-weight:700; color:${branding.primary_color}; }
        .company-address { font-size:11px; color:#6b7280; margin-top:2px; }
        h1 { text-align:center; font-size:22px; letter-spacing:1.5px;
            color:${branding.primary_color}; margin:20px 0 4px; }
        .cert-number { text-align:center; font-size:12px; color:#6b7280; margin-bottom:28px; }
        p.body-text { font-size:13px; line-height:1.9; margin-bottom:20px; }
        table.figures { width:100%; border-collapse:collapse; margin:20px 0; }
        table.figures td { padding:8px 10px; border:1px solid #e5e7eb; font-size:12px; }
        table.figures td.label { color:#6b7280; width:45%; }
        table.figures td.value { font-weight:700; }
        .signatures { display:flex; justify-content:space-between; margin-top:60px; flex-wrap:wrap; }
        .sig-block { width:30%; text-align:center; }
        .sig-line { border-top:1px solid #1a1a1a; margin-bottom:6px; padding-top:36px; position:relative; }
        .sig-line img { position:absolute; bottom:2px; left:50%; transform:translateX(-50%); max-height:34px; max-width:90%; }
        .sig-title { font-size:11px; color:#6b7280; }
        .sig-name { font-size:10px; color:#1a1a1a; font-weight:700; margin-top:2px; }
        .disclaimer { margin-top:50px; font-size:9.5px; color:#9ca3af; text-align:center; line-height:1.5; }
        .stamp-wrap { position:relative; }
        .stamp { position:absolute; right:6%; bottom:-10px; max-height:110px; max-width:150px;
            opacity:0.92; pointer-events:none; }
    </style>
    </head>
    <body>
        <div class="letterhead">
            <div>
                <div class="company-name">${branding.company_name}</div>
                ${branding.company_address ? `<div class="company-address">${branding.company_address}</div>` : ''}
            </div>
            ${branding.logo_url ? `<img src="${resolveAbsoluteAssetUrl(branding.logo_url)}" />` : ''}
        </div>

        <h1>CERTIFICATE OF SHARES</h1>
        <p class="cert-number">Certificate No. ${cert.reference_code}</p>

        <p class="body-text">
            This is to certify that <strong>${cert.user.first_name} ${cert.user.last_name}</strong>
            is the registered holder of <strong>${parseFloat(cert.shares_held).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
            shares of <strong>${branding.company_name}</strong>, representing
            <strong>${cert.percentage != null ? parseFloat(cert.percentage).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}%</strong>
            of the total issued shares, as recorded in the company's shareholding register.
        </p>

        <table class="figures">
            <tr><td class="label">Shares Held</td><td class="value">${parseFloat(cert.shares_held).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>
            <tr><td class="label">Percentage of Issued Shares</td><td class="value">${cert.percentage != null ? parseFloat(cert.percentage).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}%</td></tr>
            <tr><td class="label">Price Per Share</td><td class="value">${cert.price_per_share != null ? `${cert.currency_symbol || cert.currency_code} ${parseFloat(cert.price_per_share).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}</td></tr>
            <tr><td class="label">Share Value</td><td class="value">${shareValueDisplay}</td></tr>
            <tr><td class="label">Certificate Type</td><td class="value">${cert.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly'}</td></tr>
            <tr><td class="label">Period</td><td class="value">${periodDisplay}</td></tr>
            <tr><td class="label">Date Issued</td><td class="value">${issuedDate}</td></tr>
        </table>

        <div class="stamp-wrap">
            <div class="signatures">
                ${(signatures && signatures.length > 0
                    ? signatures.map(sig => `
                        <div class="sig-block">
                            <div class="sig-line">${sig.signature_url ? `<img src="${resolveAbsoluteAssetUrl(sig.signature_url)}" />` : ''}</div>
                            <div class="sig-title">${sig.role_name}</div>
                            ${sig.signer_name ? `<div class="sig-name">${sig.signer_name}</div>` : ''}
                        </div>`).join('')
                    : `
                        <div class="sig-block"><div class="sig-line"></div><div class="sig-title">Company Secretary</div></div>
                        <div class="sig-block"><div class="sig-line"></div><div class="sig-title">Treasurer</div></div>
                        <div class="sig-block"><div class="sig-line"></div><div class="sig-title">Director</div></div>`
                )}
            </div>
            ${(stamps && stamps.length > 0)
                ? stamps.map(stamp => `<img class="stamp" src="${resolveAbsoluteAssetUrl(stamp.file_path)}" alt="${stamp.name}" />`).join('')
                : ''}
        </div>

        <p class="disclaimer">
            This certificate is issued for record-keeping and transparency purposes based on the
            company's internal shareholding register as of the date above. It does not, of itself,
            constitute a negotiable or transferable instrument.
        </p>
    </body>
    </html>`;
};

// ============================================================
// RENDER CERTIFICATE TO A PDF BUFFER (headless Chrome)
// v1.46.0 — the actual headless-Chrome rendering was factored out
// into the shared pdfService.js (reused by reportService.js's
// monthly report emails); this stays as a thin, backward-compatible
// wrapper so every existing call site here is unaffected.
// ============================================================
const renderCertificatePdfBuffer = async (html) => renderHtmlToPdfBuffer(html);

// ============================================================
// EMAIL A CERTIFICATE TO ITS HOLDER (PDF attachment)
// `signatures`, if supplied, is baked into the PDF (Section 4.29) —
// see renderCertificateHtml above. `stamps`, if supplied, is baked in
// the same way (Section 4.30).
// ============================================================
const emailCertificateToUser = async (cert, signatures = null, stamps = null) => {
    const html = await renderCertificateHtml(cert, signatures, stamps);
    const pdfBuffer = await renderCertificatePdfBuffer(html);

    const label = cert.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly';

    await sendEmail({
        to:      cert.user.email,
        subject: `Your ${label} Certificate of Shares — ${cert.reference_code}`,
        html:    `<p>Dear ${cert.user.first_name},</p>
                  <p>Please find attached your ${label.toLowerCase()} Certificate of Shares
                  (${cert.reference_code}), confirming your current shareholding.</p>`,
        attachments: [{
            filename: `${cert.reference_code}.pdf`,
            content:  pdfBuffer,
        }],
    });
};

// ============================================================
// FIND-OR-CREATE THE SIGNING ROUND for a (certificateType,
// periodLabel) batch (v1.23.0, Section 4.29). Safe to call more than
// once for the same period — returns the existing round rather than
// erroring, since certificate_signing_rounds has a UNIQUE
// (certificate_type, period_label) constraint.
// ============================================================
const openOrGetSigningRound = async (certificateType, periodLabel, openedBy = null) => {
    const existing = await query(
        `SELECT * FROM certificate_signing_rounds WHERE certificate_type = $1 AND period_label = $2`,
        [certificateType, periodLabel]
    );
    if (existing.rows.length > 0) return existing.rows[0];

    const result = await query(`
        INSERT INTO certificate_signing_rounds (certificate_type, period_label, opened_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (certificate_type, period_label) DO UPDATE SET certificate_type = EXCLUDED.certificate_type
        RETURNING *
    `, [certificateType, periodLabel, openedBy]);
    return result.rows[0];
};

// ============================================================
// RENDER + EMAIL EVERY CERTIFICATE IN A FULLY-SIGNED ROUND
// Called once, right after the last required signature lands
// (certificatesController.signRound). Baking the same signature set
// into every certificate in the round, rather than re-checking
// per-certificate, is correct because one round covers exactly one
// batch — every certificate in it shares the same signatories.
// ============================================================
const emailRoundCertificates = async (roundId) => {
    const signatures = await getSignatureStatus('CERTIFICATE_ROUND', roundId);
    const stamps = await getAppliedStamps('CERTIFICATE_ROUND', roundId);

    const certsResult = await query(`
        SELECT sc.id, sc.certificate_type, sc.period_label, sc.shares_held, sc.percentage,
               sc.price_per_share, sc.currency_id, sc.share_value, sc.issued_at,
               c.code AS currency_code, c.symbol AS currency_symbol,
               r.reference_code,
               u.id AS user_id, u.first_name, u.last_name, u.email
        FROM   share_certificates sc
        JOIN   references_registry r ON r.id = sc.reference_id
        JOIN   users u ON u.id = sc.user_id
        LEFT JOIN currencies c ON c.id = sc.currency_id
        WHERE  sc.signing_round_id = $1
    `, [roundId]);

    let emailed = 0, failed = 0;
    const errors = [];

    for (const row of certsResult.rows) {
        const cert = {
            id: row.id,
            reference_code: row.reference_code,
            issued_at: row.issued_at,
            certificate_type: row.certificate_type,
            period_label: row.period_label,
            shares_held: row.shares_held,
            percentage: row.percentage,
            price_per_share: row.price_per_share,
            currency_id: row.currency_id,
            currency_code: row.currency_code,
            currency_symbol: row.currency_symbol,
            share_value: row.share_value,
            user: { id: row.user_id, first_name: row.first_name, last_name: row.last_name, email: row.email },
        };

        try {
            await emailCertificateToUser(cert, signatures, stamps);
            await query(`UPDATE share_certificates SET email_sent = TRUE, email_error = NULL WHERE id = $1`, [cert.id]);
            emailed++;
        } catch (emailErr) {
            logger.error('Signed certificate email failed', { userId: row.user_id, error: emailErr.message });
            await query(`UPDATE share_certificates SET email_error = $1 WHERE id = $2`, [emailErr.message, cert.id]);
            failed++;
            errors.push({ userId: row.user_id, error: emailErr.message });
        }
    }

    return { total: certsResult.rows.length, emailed, failed, errors };
};

// ============================================================
// ISSUE CERTIFICATES FOR EVERY ACTIVE SHAREHOLDER
// Used by both the scheduled cron jobs and the Admin "issue now"
// manual trigger — so testing it manually exercises exactly the
// same code path the schedule will run automatically.
//
// v1.23.0 (Section 4.29): every certificate issued here is grouped
// into one certificate_signing_rounds row for this (type, period).
//   - If an Admin has configured signature_requirements for
//     SHARE_CERTIFICATE, certificates are issued but NOT emailed yet
//     — the round stays OPEN, signatories are notified, and emailing
//     happens later via emailRoundCertificates once fully signed
//     (certificatesController.signRound).
//   - If nothing is configured, behaviour is unchanged from before
//     this feature existed: issue and email immediately, and the
//     round is marked FULLY_SIGNED right away (kept only so the
//     Signing Rounds screen still shows a consistent history).
// ============================================================
const issueCertificatesForAllShareholders = async (certificateType, issuedBy = null) => {
    const shareholders = await query(`
        SELECT DISTINCT sr.user_id
        FROM   shareholding_registry sr
        JOIN   users u ON u.id = sr.user_id AND u.is_active = TRUE
        WHERE  sr.effective_to IS NULL
        AND    sr.shares_held > 0
    `);

    const now = new Date();
    const periodLabel = certificateType === 'ANNUAL'
        ? String(now.getFullYear())
        : String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0');

    const round = await openOrGetSigningRound(certificateType, periodLabel, issuedBy);

    const { hasRequirements, roles } = await withTransaction(async (client) =>
        ensureSignatureSlots(client, 'CERTIFICATE_ROUND', round.id, 'SHARE_CERTIFICATE')
    );

    let issued = 0, emailed = 0, failed = 0;
    const errors = [];

    // v1.24.0 — if there's no signature requirement, this round is
    // effectively "approved" the instant it's created (no one needs
    // to sign it), so whichever stamp is configured for
    // SHARE_CERTIFICATE (Section 4.30) applies right away, before the
    // per-shareholder emailing loop below. If a signature requirement
    // IS configured, stamping instead happens once the round is fully
    // signed (certificatesController.signRound).
    let immediateStamps = [];
    if (!hasRequirements) {
        immediateStamps = await applyStamps('CERTIFICATE_ROUND', round.id, 'SHARE_CERTIFICATE').catch(() => []);
    }

    for (const row of shareholders.rows) {
        try {
            const cert = await issueCertificate({
                userId: row.user_id,
                certificateType,
                issuedBy,
                periodLabel,
            });
            await query('UPDATE share_certificates SET signing_round_id = $1 WHERE id = $2', [round.id, cert.id]);
            issued++;

            if (!hasRequirements) {
                // No signature requirement configured — original
                // behaviour, email immediately.
                try {
                    await emailCertificateToUser(cert, null, immediateStamps);
                    await query(`UPDATE share_certificates SET email_sent = TRUE WHERE id = $1`, [cert.id]);
                    emailed++;
                } catch (emailErr) {
                    logger.error('Certificate email failed', { userId: row.user_id, error: emailErr.message });
                    await query(`UPDATE share_certificates SET email_error = $1 WHERE id = $2`,
                        [emailErr.message, cert.id]);
                    failed++;
                    errors.push({ userId: row.user_id, error: emailErr.message });
                }
            }
        } catch (err) {
            logger.error('Certificate issuance failed', { userId: row.user_id, error: err.message });
            failed++;
            errors.push({ userId: row.user_id, error: err.message });
        }
    }

    if (!hasRequirements) {
        // Nothing to sign — close the round immediately so it doesn't
        // sit "OPEN" forever on the Signing Rounds screen.
        await query(
            `UPDATE certificate_signing_rounds SET status = 'FULLY_SIGNED', fully_signed_at = NOW() WHERE id = $1 AND status = 'OPEN'`,
            [round.id]
        );
    } else if (roles.length > 0) {
        // Notify each configured signatory role's current holder(s)
        // that a new round needs their signature.
        const roleIds = roles.map(r => r.role_id);
        const signatoriesResult = await query(`
            SELECT DISTINCT u.id, u.first_name, u.email
            FROM   user_roles ur
            JOIN   users u ON u.id = ur.user_id AND u.is_active = TRUE
            WHERE  ur.role_id = ANY($1::int[]) AND ur.revoked_at IS NULL
        `, [roleIds]);

        await notifyMany(signatoriesResult.rows, 'CERTIFICATE_ROUND_OPENED', (recipient) => ({
            title: `${certificateType === 'ANNUAL' ? 'Annual' : 'Monthly'} Certificate of Shares round needs your signature`,
            body:  `${issued} certificate(s) for ${periodLabel} are ready and waiting on your signature.`,
            // v1.41.0 fix: '/certificates' isn't a real route — certificate
            // download/signing actually lives on the Profile page.
            link:  '/profile',
            module: 'SYSTEM',
            recordType: 'certificate_signing_rounds',
            recordId: round.id,
            email: {
                subject: `Certificates awaiting your signature — ${periodLabel}`,
                html: `<p>Dear ${recipient.first_name},</p>
                       <p>${issued} Certificate(s) of Shares for ${periodLabel} are ready and waiting on your signature.
                       Please sign in to the system to review and sign.</p>`,
            },
        })).catch(() => {});
    }

    return { total: shareholders.rows.length, issued, emailed, failed, errors, roundId: round.id, requiresSignatures: hasRequirements };
};

module.exports = {
    getShareholderFigures,
    issueCertificate,
    renderCertificateHtml,
    renderCertificatePdfBuffer,
    emailCertificateToUser,
    issueCertificatesForAllShareholders,
    openOrGetSigningRound,
    emailRoundCertificates,
};
