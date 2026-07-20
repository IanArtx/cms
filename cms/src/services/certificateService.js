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
// ============================================================
const renderCertificateHtml = async (cert) => {
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
        .signatures { display:flex; justify-content:space-between; margin-top:60px; }
        .sig-block { width:30%; text-align:center; }
        .sig-line { border-top:1px solid #1a1a1a; margin-bottom:6px; padding-top:36px; }
        .sig-title { font-size:11px; color:#6b7280; }
        .disclaimer { margin-top:50px; font-size:9.5px; color:#9ca3af; text-align:center; line-height:1.5; }
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

        <div class="signatures">
            <div class="sig-block"><div class="sig-line"></div><div class="sig-title">Company Secretary</div></div>
            <div class="sig-block"><div class="sig-line"></div><div class="sig-title">Treasurer</div></div>
            <div class="sig-block"><div class="sig-line"></div><div class="sig-title">Director</div></div>
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
// ============================================================
const renderCertificatePdfBuffer = async (html) => {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
        });
        return pdfBuffer;
    } finally {
        await browser.close();
    }
};

// ============================================================
// EMAIL A CERTIFICATE TO ITS HOLDER (PDF attachment)
// ============================================================
const emailCertificateToUser = async (cert) => {
    const html = await renderCertificateHtml(cert);
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
// ISSUE + EMAIL CERTIFICATES FOR EVERY ACTIVE SHAREHOLDER
// Used by both the scheduled cron jobs and the Admin "issue now"
// manual trigger — so testing it manually exercises exactly the
// same code path the schedule will run automatically.
// ============================================================
const issueCertificatesForAllShareholders = async (certificateType, issuedBy = null) => {
    const shareholders = await query(`
        SELECT DISTINCT sr.user_id
        FROM   shareholding_registry sr
        JOIN   users u ON u.id = sr.user_id AND u.is_active = TRUE
        WHERE  sr.effective_to IS NULL
        AND    sr.shares_held > 0
    `);

    let issued = 0, emailed = 0, failed = 0;
    const errors = [];

    for (const row of shareholders.rows) {
        try {
            const cert = await issueCertificate({
                userId: row.user_id,
                certificateType,
                issuedBy,
            });
            issued++;

            try {
                await emailCertificateToUser(cert);
                await query(`UPDATE share_certificates SET email_sent = TRUE WHERE id = $1`, [cert.id]);
                emailed++;
            } catch (emailErr) {
                logger.error('Certificate email failed', { userId: row.user_id, error: emailErr.message });
                await query(`UPDATE share_certificates SET email_error = $1 WHERE id = $2`,
                    [emailErr.message, cert.id]);
                failed++;
                errors.push({ userId: row.user_id, error: emailErr.message });
            }
        } catch (err) {
            logger.error('Certificate issuance failed', { userId: row.user_id, error: err.message });
            failed++;
            errors.push({ userId: row.user_id, error: err.message });
        }
    }

    return { total: shareholders.rows.length, issued, emailed, failed, errors };
};

module.exports = {
    getShareholderFigures,
    issueCertificate,
    renderCertificateHtml,
    renderCertificatePdfBuffer,
    emailCertificateToUser,
    issueCertificatesForAllShareholders,
};
