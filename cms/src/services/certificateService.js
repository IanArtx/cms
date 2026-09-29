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
//      other on-demand document in the system. Always reflects
//      LIVE figures — never point-in-time, never signing-gated.
//   2. Automatic monthly/annual email (scheduler.js), and the
//      Admin "Issue Now" manual trigger, which runs the exact same
//      pipeline — issues a record for every active shareholder,
//      renders the same certificate to a PDF via headless Chrome
//      (puppeteer), and emails it as an attachment. Since v1.64.0
//      this path is always point-in-time (as_of_date) and always
//      signing-gated — see issueCertificatesForAllShareholders below.
// ============================================================

const shareCapitalService = require('./shareCapitalService');
const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const { generateReference, linkReferenceToRecord, MODULE_CODES } = require('./referenceService');
const { getBranding } = require('./emailTemplates');
const { sendEmail } = require('../config/email');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const { ensureSignatureSlots, getSignatureStatus, getRequiredRoles } = require('./signatureService');
const { getAppliedStamps } = require('./stampService');
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

const formatLongDate = (d) => new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
});

// ============================================================
// COMPUTE A SHAREHOLDER'S FIGURES
// shares held, percentage, price per share, share value.
//
// v1.64.0 — accepts an optional `asOfDate` ('YYYY-MM-DD'). When
// omitted, behaves exactly as before: the member's CURRENT
// (effective_to IS NULL) shareholding and the company's CURRENT
// share price — the same figures shown on My Profile
// (usersController.getMyProfile) and used by the on-demand
// single-certificate path. When given, looks up whichever
// shareholding_registry / share_price_history row was actually
// effective on that historical date (effective_from <= asOfDate <
// effective_to, or still open-ended) — used by the monthly/annual
// bulk pipeline so a certificate genuinely reflects "shareholding as
// of period-end", not whatever is live at send time.
// ============================================================
const getShareholderFigures = async (userId, asOfDate = null) => {
    // v1.69.0 — once converted to whole shares, a historical holding is
    // rebuilt exactly from the dated allotments (share_allotments) rather
    // than from whichever registry row happened to exist on that date.
    let allotmentHolding = null;
    if (asOfDate && await shareCapitalService.isOpeningConverted()) {
        const { byUser, total } = await shareCapitalService.getHoldingsAsOf(asOfDate);
        const shares = byUser.get(userId) || 0;
        allotmentHolding = {
            shares_held: shares,
            percentage: total > 0 ? ((shares / total) * 100).toFixed(4) : '0.0000',
        };
    }
    const holdingResult = allotmentHolding
        ? { rows: allotmentHolding.shares_held > 0 ? [allotmentHolding] : [] }
        : asOfDate
        ? await query(`
            SELECT shares_held, percentage
            FROM   shareholding_registry
            WHERE  user_id = $1
            AND    effective_from <= $2
            AND    (effective_to IS NULL OR effective_to > $2)
            ORDER  BY effective_from DESC
            LIMIT  1
        `, [userId, asOfDate])
        : await query(`
            SELECT shares_held, percentage
            FROM   shareholding_registry
            WHERE  user_id = $1 AND effective_to IS NULL
        `, [userId]);

    if (holdingResult.rows.length === 0) {
        throw createError.badRequest(
            asOfDate
                ? `This member had no active shareholding record as of ${asOfDate}`
                : 'This member has no active shareholding record'
        );
    }
    const holding = holdingResult.rows[0];

    const priceResult = asOfDate
        ? await query(`
            SELECT sph.price_per_share, c.id AS currency_id, c.code AS currency_code, c.symbol AS currency_symbol
            FROM   share_price_history sph
            JOIN   currencies c ON c.id = sph.currency_id
            WHERE  sph.effective_from <= $1
            AND    (sph.effective_to IS NULL OR sph.effective_to > $1)
            ORDER  BY sph.effective_from DESC
            LIMIT  1
        `, [asOfDate])
        : await query(`
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
// the shareholder's figures (live, or as of `asOfDate` when given),
// and stores the record. certificateType: 'MONTHLY' | 'ANNUAL'.
// periodLabel: optional override — 'YYYYMM' for MONTHLY,
// 'YYYY' for ANNUAL. Defaults to the current month/year — that
// default is only ever actually used by the on-demand single-
// certificate path; the bulk pipeline below always passes an
// explicit periodLabel/asOfDate of its own.
// ============================================================
const issueCertificate = async ({ userId, certificateType, issuedBy, periodLabel, asOfDate = null }) => {
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

    const figures = await getShareholderFigures(userId, asOfDate);

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
                 share_value, issued_by, as_of_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, issued_at
        `, [
            referenceId, userId, certificateType, ym,
            figures.shares_held, figures.percentage, figures.price_per_share,
            figures.currency_id, figures.share_value, issuedBy || null, asOfDate,
        ]);

        await linkReferenceToRecord(client, referenceId, result.rows[0].id);

        await logAction(issuedBy || userId, ACTIONS.CERTIFICATE_ISSUED, MODULES.SYSTEM, {
            recordType:  'share_certificates',
            recordId:    result.rows[0].id,
            newValues:   { referenceCode, certificateType, userId, asOfDate },
            description: `Certificate of Shares issued to ${user.first_name} ${user.last_name}: ${referenceCode}`,
            client,
        });

        return {
            id:               result.rows[0].id,
            reference_code:   referenceCode,
            issued_at:        result.rows[0].issued_at,
            certificate_type: certificateType,
            period_label:     ym,
            as_of_date:       asOfDate,
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
//
// v1.64.0: when `cert.as_of_date` is set, an extra "Shareholding As
// Of" row is shown alongside "Date Issued" so the two dates — when a
// certificate reports on vs. when it was actually sent — are never
// confused with each other.
// ============================================================
const renderCertificateHtml = async (cert, signatures = null, stamps = null) => {
    const branding = await getBranding();

    const issuedDate = formatLongDate(cert.issued_at);
    const asOfDisplay = cert.as_of_date ? formatLongDate(cert.as_of_date) : null;
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
            of the total issued shares, as recorded in the company's shareholding register${asOfDisplay ? ` as of ${asOfDisplay}` : ''}.
        </p>

        <table class="figures">
            <tr><td class="label">Shares Held</td><td class="value">${parseFloat(cert.shares_held).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td></tr>
            <tr><td class="label">Percentage of Issued Shares</td><td class="value">${cert.percentage != null ? parseFloat(cert.percentage).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}%</td></tr>
            <tr><td class="label">Price Per Share</td><td class="value">${cert.price_per_share != null ? `${cert.currency_symbol || cert.currency_code} ${parseFloat(cert.price_per_share).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}</td></tr>
            <tr><td class="label">Share Value</td><td class="value">${shareValueDisplay}</td></tr>
            <tr><td class="label">Certificate Type</td><td class="value">${cert.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly'}</td></tr>
            <tr><td class="label">Period</td><td class="value">${periodDisplay}</td></tr>
            ${asOfDisplay ? `<tr><td class="label">Shareholding As Of</td><td class="value">${asOfDisplay}</td></tr>` : ''}
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
//
// v1.64.0 — signing is mandatory, enforced HERE rather than only by
// caller discipline: this refuses to send unless `signatures` is a
// non-empty list where every required slot is actually SIGNED. The
// only caller left in this codebase (emailRoundCertificates, below)
// only ever invokes this after a round has been fully signed, so in
// normal operation this gate never trips — it exists so a future bug
// or a new call site can never slip an unsigned certificate out the
// door.
// ============================================================
const emailCertificateToUser = async (cert, signatures = null, stamps = null) => {
    if (!signatures || signatures.length === 0 || signatures.some(s => s.status !== 'SIGNED')) {
        throw new Error(`Refusing to email certificate ${cert.reference_code || cert.id} — required signatures are not all complete.`);
    }

    const html = await renderCertificateHtml(cert, signatures, stamps);
    const pdfBuffer = await renderCertificatePdfBuffer(html);

    const label = cert.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly';
    const asOfText = cert.as_of_date ? ` as of ${formatLongDate(cert.as_of_date)}` : '';

    await sendEmail({
        to:      cert.user.email,
        subject: `Your ${label} Certificate of Shares — ${cert.reference_code}`,
        html:    `<p>Dear ${cert.user.first_name},</p>
                  <p>Please find attached your ${label.toLowerCase()} Certificate of Shares
                  (${cert.reference_code}), confirming your shareholding${asOfText}.</p>`,
        attachments: [{
            filename: `${cert.reference_code}.pdf`,
            content:  pdfBuffer,
        }],
    });
};

// ============================================================
// GET THE LATEST SIGNED CERTIFICATE for a member (v1.65.0)
// Backs the on-demand download path — requested directly: "i would
// like that the shareholding certificates that are downloadable on
// demand at anytime be of the most recently signed batch such that
// the members always download a signed version. the certificate
// therefore should always show as of date... This therefore should
// not affect the current shareholding held by a shareholder." So this
// never mints a new certificate and never touches shareholding_registry
// — it only ever looks up the newest already-issued certificate that
// belongs to a FULLY_SIGNED round for this member/type, complete with
// that round's real signatures and any applied stamp, ready to render
// exactly the way emailRoundCertificates already does. Returns null
// when nothing signed exists yet (e.g. a brand-new shareholder before
// the first monthly/annual batch has run and been signed).
// ============================================================
const getLatestSignedCertificate = async (userId, certificateType) => {
    const result = await query(`
        SELECT sc.id, sc.certificate_type, sc.period_label, sc.shares_held, sc.percentage,
               sc.price_per_share, sc.currency_id, sc.share_value, sc.issued_at, sc.as_of_date,
               sc.signing_round_id,
               c.code AS currency_code, c.symbol AS currency_symbol,
               r.reference_code,
               u.id AS user_id, u.first_name, u.last_name, u.email
        FROM   share_certificates sc
        JOIN   certificate_signing_rounds csr ON csr.id = sc.signing_round_id AND csr.status = 'FULLY_SIGNED'
        JOIN   references_registry r ON r.id = sc.reference_id
        JOIN   users u ON u.id = sc.user_id
        LEFT JOIN currencies c ON c.id = sc.currency_id
        WHERE  sc.user_id = $1 AND sc.certificate_type = $2
        ORDER  BY sc.as_of_date DESC NULLS LAST, sc.issued_at DESC
        LIMIT  1
    `, [userId, certificateType]);

    if (result.rows.length === 0) return null;
    const row = result.rows[0];

    const [signatures, stamps] = await Promise.all([
        getSignatureStatus('CERTIFICATE_ROUND', row.signing_round_id),
        getAppliedStamps('CERTIFICATE_ROUND', row.signing_round_id),
    ]);

    return {
        cert: {
            id: row.id,
            reference_code: row.reference_code,
            issued_at: row.issued_at,
            as_of_date: row.as_of_date,
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
        },
        signatures,
        stamps,
    };
};

// ============================================================
// FIND-OR-CREATE THE SIGNING ROUND for a (certificateType,
// periodLabel) batch (v1.23.0, Section 4.29). Safe to call more than
// once for the same period — returns the existing round rather than
// erroring, since certificate_signing_rounds has a UNIQUE
// (certificate_type, period_label) constraint.
//
// v1.64.0 — accepts `asOfDate`, stored on the round so every
// certificate issued into it can be traced back to the period it
// reports on. If an existing round from before this column existed
// is found with no as_of_date yet, it's backfilled here.
// ============================================================
const openOrGetSigningRound = async (certificateType, periodLabel, openedBy = null, asOfDate = null) => {
    const existing = await query(
        `SELECT * FROM certificate_signing_rounds WHERE certificate_type = $1 AND period_label = $2`,
        [certificateType, periodLabel]
    );
    if (existing.rows.length > 0) {
        if (!existing.rows[0].as_of_date && asOfDate) {
            const backfilled = await query(
                `UPDATE certificate_signing_rounds SET as_of_date = $1 WHERE id = $2 RETURNING *`,
                [asOfDate, existing.rows[0].id]
            );
            return backfilled.rows[0];
        }
        return existing.rows[0];
    }

    const result = await query(`
        INSERT INTO certificate_signing_rounds (certificate_type, period_label, opened_by, as_of_date)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (certificate_type, period_label) DO UPDATE SET certificate_type = EXCLUDED.certificate_type
        RETURNING *
    `, [certificateType, periodLabel, openedBy, asOfDate]);
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
               sc.price_per_share, sc.currency_id, sc.share_value, sc.issued_at, sc.as_of_date,
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
            as_of_date: row.as_of_date,
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
// DEFAULT PERIOD/AS-OF-DATE for the bulk pipeline (v1.64.0).
//
// The monthly job fires on the 1st of the month and the annual job
// fires on 1 January — both AFTER the period they're actually
// reporting on has just ended, exactly the same "report covers the
// PREVIOUS period" convention scheduler.js's own monthly report jobs
// already use (see scheduleMonthlyGeneralReport). So:
//   - MONTHLY: periodLabel = the month that just ended ('YYYYMM'),
//     asOfDate = that month's last calendar day.
//   - ANNUAL: periodLabel = the year that just ended ('YYYY'),
//     asOfDate = 31 December of that year.
// This is also what the Admin "Issue Now" manual trigger runs by
// default when given no explicit override — matching this file's own
// header comment that it's "the same pipeline the monthly/annual
// cron jobs run automatically", useful for testing that exact
// pipeline rather than a different one.
// ============================================================
const computeDefaultPeriod = (certificateType) => {
    const now = new Date();
    if (certificateType === 'ANNUAL') {
        const year = now.getFullYear() - 1;
        return { periodLabel: String(year), asOfDate: `${year}-12-31` };
    }
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const year = prevMonthDate.getFullYear();
    const month = prevMonthDate.getMonth() + 1; // 1-12
    const periodLabel = String(year) + String(month).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    const asOfDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { periodLabel, asOfDate };
};

// ============================================================
// NOTIFY ADMINS — no signature requirement configured (v1.64.0)
// ============================================================
const notifyAdminsSigningNotConfigured = async (certificateType, periodLabel) => {
    const admins = await query(`
        SELECT DISTINCT u.id, u.first_name, u.email
        FROM   user_roles ur
        JOIN   roles r ON r.id = ur.role_id AND r.name = 'Admin'
        JOIN   users u ON u.id = ur.user_id AND u.is_active = TRUE
        WHERE  ur.revoked_at IS NULL
    `);
    const label = certificateType === 'ANNUAL' ? 'Annual' : 'Monthly';

    await notifyMany(admins.rows, 'CERTIFICATE_SIGNING_NOT_CONFIGURED', (recipient) => ({
        title: `${label} Certificate of Shares run blocked — no signatory configured`,
        body:  `The ${periodLabel} ${label.toLowerCase()} share certificate run did not issue anything because no signature requirement is configured for Share Certificates. Configure at least one required signatory role in Settings.`,
        link:  '/settings',
        module: 'SYSTEM',
        recordType: 'signature_requirements',
        recordId: null,
        email: {
            subject: `Action needed: configure Share Certificate signatories (${periodLabel})`,
            html: `<p>Dear ${recipient.first_name},</p>
                   <p>The ${periodLabel} ${label.toLowerCase()} Certificate of Shares run did not issue any
                   certificates because no signature requirement is configured for Share Certificates — since
                   certificates are now only ever sent once fully signed, there is no one who could sign this
                   batch to completion.</p>
                   <p>Please sign in and configure at least one required signatory role in Settings so this
                   and future runs can proceed.</p>`,
        },
    })).catch(() => {});
};

// ============================================================
// ISSUE CERTIFICATES FOR EVERY ACTIVE SHAREHOLDER
// Used by both the scheduled cron jobs and the Admin "issue now"
// manual trigger — so testing it manually exercises exactly the
// same code path the schedule will run automatically.
//
// v1.64.0 — two behavioural changes from v1.23.0:
//   1. POINT IN TIME: every certificate issued here now carries an
//      explicit `asOfDate` — by default the period that just ended
//      (see computeDefaultPeriod above), overridable via `overrides`
//      for tooling/tests. Figures are looked up AS OF that date
//      (getShareholderFigures), not live at issuance time.
//   2. SIGNING IS ALWAYS MANDATORY: the old "no signature requirement
//      configured -> issue and email immediately, unsigned" fallback
//      is gone. If nothing is configured for SHARE_CERTIFICATE, this
//      issues NOTHING — no certificates, no round left dangling —
//      and instead notifies every Admin to configure a signatory.
//      Once configured, certificates are issued into an OPEN round
//      and stay unemailed until every required role signs
//      (certificatesController.signRound calls emailRoundCertificates
//      only once allSigned === true).
// ============================================================
const issueCertificatesForAllShareholders = async (certificateType, issuedBy = null, overrides = {}) => {
    const defaults = computeDefaultPeriod(certificateType);
    const periodLabel = overrides.periodLabel || defaults.periodLabel;
    const asOfDate = overrides.asOfDate || defaults.asOfDate;

    // v1.64.0 — the candidate list is now POINT IN TIME (whoever held
    // shares as of asOfDate), not "whoever holds shares today". Using
    // today's live shareholders here would both miss a member who
    // exited between asOfDate and now (they still held shares during
    // the reported period and are owed a final certificate for it) and
    // wrongly include a member who joined after asOfDate (who
    // getShareholderFigures would then reject, since they had no
    // shareholding as of that date) — this matches the same
    // effective_from/effective_to range logic getShareholderFigures
    // itself uses.
    const shareholders = await query(`
        SELECT DISTINCT sr.user_id
        FROM   shareholding_registry sr
        JOIN   users u ON u.id = sr.user_id AND u.is_active = TRUE
        WHERE  sr.effective_from <= $1
        AND    (sr.effective_to IS NULL OR sr.effective_to > $1)
        AND    sr.shares_held > 0
    `, [asOfDate]);

    // Checked BEFORE opening a round — a round nothing could ever sign
    // (and so could never leave OPEN) shouldn't be created at all; this
    // way a blocked run leaves no dangling empty round behind.
    const requiredRoles = await getRequiredRoles('SHARE_CERTIFICATE');
    if (requiredRoles.length === 0) {
        await notifyAdminsSigningNotConfigured(certificateType, periodLabel);
        return {
            total: shareholders.rows.length, issued: 0, emailed: 0, failed: 0, errors: [],
            roundId: null, requiresSignatures: false, blocked: true,
            blockedReason: 'No signature requirement is configured for Share Certificates. An Admin must configure at least one required signatory role in Settings before certificates can be issued and sent.',
        };
    }

    const round = await openOrGetSigningRound(certificateType, periodLabel, issuedBy, asOfDate);

    // Idempotency guard (v1.64.0) — this round may already have
    // certificates issued into it, e.g. a retried "Issue Now" click, or
    // the cron somehow firing twice for the same period. Without this,
    // a second run would insert a duplicate batch: if the round is
    // still OPEN, every shareholder ends up with two certificates once
    // it's finally emailed; if it's already FULLY_SIGNED, the new
    // batch's certificates get attached to a round whose last-signature
    // trigger will never fire again — issued but permanently unemailed.
    const existingCertsResult = await query(
        `SELECT COUNT(*)::int AS count FROM share_certificates WHERE signing_round_id = $1`,
        [round.id]
    );
    if (existingCertsResult.rows[0].count > 0) {
        return {
            total: shareholders.rows.length, issued: 0, emailed: 0, failed: 0, errors: [],
            roundId: round.id, requiresSignatures: true, blocked: true, alreadyIssued: true,
            blockedReason: `${existingCertsResult.rows[0].count} certificate(s) for ${periodLabel} were already issued into this round (status ${round.status}) — not issuing a duplicate batch. See Certificate Signing Rounds.`,
            asOfDate, periodLabel,
        };
    }

    const { roles } = await withTransaction(async (client) =>
        ensureSignatureSlots(client, 'CERTIFICATE_ROUND', round.id, 'SHARE_CERTIFICATE')
    );

    // Defensive re-check — guards the narrow race where the requirement
    // was removed between the check above and here. Without this, the
    // round just opened would sit OPEN forever with no signature slots
    // for anyone to ever sign.
    if (roles.length === 0) {
        await notifyAdminsSigningNotConfigured(certificateType, periodLabel);
        return {
            total: shareholders.rows.length, issued: 0, emailed: 0, failed: 0, errors: [],
            roundId: round.id, requiresSignatures: false, blocked: true,
            blockedReason: 'No signature requirement is configured for Share Certificates. An Admin must configure at least one required signatory role in Settings before certificates can be issued and sent.',
        };
    }

    let issued = 0, failed = 0;
    const errors = [];

    for (const row of shareholders.rows) {
        try {
            const cert = await issueCertificate({
                userId: row.user_id,
                certificateType,
                issuedBy,
                periodLabel,
                asOfDate,
            });
            await query('UPDATE share_certificates SET signing_round_id = $1 WHERE id = $2', [round.id, cert.id]);
            issued++;
        } catch (err) {
            logger.error('Certificate issuance failed', { userId: row.user_id, error: err.message });
            failed++;
            errors.push({ userId: row.user_id, error: err.message });
        }
    }

    // Notify each configured signatory role's current holder(s) that
    // a new round needs their signature.
    if (roles.length > 0) {
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

    return {
        total: shareholders.rows.length, issued, emailed: 0, failed, errors,
        roundId: round.id, requiresSignatures: true, blocked: false, asOfDate, periodLabel,
    };
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
    computeDefaultPeriod,
    getLatestSignedCertificate,
};
