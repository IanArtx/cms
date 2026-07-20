// ============================================================
// EMAIL TEMPLATES
// One consistent, branded HTML shell for every email the system
// sends — the "central email" the company communicates through.
// Pulls the company name/logo/color from company_settings (the
// same source Settings > Company edits), with a short in-memory
// cache so we're not hitting the DB on every single email send.
// ============================================================

const { query } = require('../config/database');

let cachedBranding = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const getBranding = async () => {
    const now = Date.now();
    if (cachedBranding && (now - cachedAt) < CACHE_TTL_MS) {
        return cachedBranding;
    }

    try {
        const result = await query(`
            SELECT company_name, company_address, primary_color, accent_color, logo_url
            FROM   company_settings
            WHERE  id = 1
        `);
        cachedBranding = result.rows[0] || {
            company_name: process.env.COMPANY_NAME || 'Company Management System',
            company_address: process.env.COMPANY_ADDRESS || '',
            primary_color: '#1e3a5f',
            accent_color: '#c9a227',
            logo_url: null,
        };
    } catch {
        cachedBranding = {
            company_name: process.env.COMPANY_NAME || 'Company Management System',
            company_address: process.env.COMPANY_ADDRESS || '',
            primary_color: '#1e3a5f',
            accent_color: '#c9a227',
            logo_url: null,
        };
    }
    cachedAt = now;
    return cachedBranding;
};

// ============================================================
// WRAP EMAIL
// Wraps a simple content HTML fragment in a branded shell —
// header with company name, a body area, and a footer.
// ============================================================
const wrapEmail = async (contentHtml, { preheader = '' } = {}) => {
    const branding = await getBranding();

    return `
    <div style="font-family: Arial, Helvetica, sans-serif; background:#f3f4f6; padding:24px 0;">
        <div style="display:none; max-height:0; overflow:hidden;">${preheader}</div>
        <div style="max-width:560px; margin:0 auto; background:white; border-radius:10px;
            overflow:hidden; border:1px solid #e5e7eb;">
            <div style="background:${branding.primary_color}; padding:20px 28px;">
                <p style="margin:0; color:white; font-size:16px; font-weight:700; letter-spacing:0.3px;">
                    ${branding.company_name}
                </p>
            </div>
            <div style="padding:28px; color:#1f2937; font-size:14px; line-height:1.6;">
                ${contentHtml}
            </div>
            <div style="padding:16px 28px; background:#f9fafb; border-top:1px solid #e5e7eb;
                font-size:11px; color:#9ca3af;">
                <p style="margin:0 0 4px 0;">${branding.company_name}${branding.company_address ? ` — ${branding.company_address}` : ''}</p>
                <p style="margin:0;">This is an automated message from the company management system. Please do not reply directly to this email.</p>
            </div>
        </div>
    </div>`;
};

// Call after Settings > Company is updated so the very next email
// reflects the change instead of waiting out the cache TTL.
const invalidateBrandingCache = () => { cachedBranding = null; };

module.exports = { wrapEmail, invalidateBrandingCache, getBranding };
