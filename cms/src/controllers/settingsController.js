// ============================================================
// SETTINGS CONTROLLER
// Company branding settings — name, address, logo, brand colors.
// This is what makes the system reusable by any company: instead
// of these values being hardcoded or baked into the frontend build
// via env vars, they live in the database and can be edited by a
// System Admin through Settings > Company, taking effect for every
// user (sidebar, topbar, and every generated document) without a
// code change or redeploy.
// ============================================================

const { query } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { invalidateBrandingCache } = require('../services/emailTemplates');

// ============================================================
// GET COMPANY SETTINGS
// GET /api/settings/company
// Available to any authenticated user — the frontend needs this
// on every page load to render the sidebar/topbar/logo correctly,
// not just for admins.
// ============================================================
const getCompanySettings = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT company_name, company_address, logo_url,
               primary_color, accent_color,
               description, mission, vision, core_values, motto,
               updated_at
        FROM   company_settings
        WHERE  id = 1
    `);

    // Should always exist (seeded by the schema/migration), but fall
    // back gracefully rather than 500ing the whole app if it's ever
    // missing on a database that was set up before v1.5.0.
    if (result.rows.length === 0) {
        return sendSuccess(res, {
            company_name:    'Company Management System',
            company_address: '',
            logo_url:        null,
            primary_color:   '#1e3a5f',
            accent_color:    '#c9a227',
            description:     '',
            mission:         '',
            vision:          '',
            core_values:     '',
            motto:           '',
        });
    }

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// UPDATE COMPANY SETTINGS
// PATCH /api/settings/company
// Restricted to the "Admin" role directly (checked in the route,
// not through the configurable permission system) — this is
// foundational, company-identity-level configuration, the same
// treatment given to contribution recording in v1.4.0.
// ============================================================
const updateCompanySettings = asyncHandler(async (req, res) => {
    const {
        company_name, company_address, primary_color, accent_color,
        description, mission, vision, core_values, motto,
    } = req.body;

    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    if (primary_color && !hexPattern.test(primary_color)) {
        throw createError.badRequest('Primary color must be a hex code like #1e3a5f');
    }
    if (accent_color && !hexPattern.test(accent_color)) {
        throw createError.badRequest('Accent color must be a hex code like #c9a227');
    }

    const result = await query(`
        UPDATE company_settings
        SET    company_name    = COALESCE($1, company_name),
               company_address = COALESCE($2, company_address),
               primary_color   = COALESCE($3, primary_color),
               accent_color    = COALESCE($4, accent_color),
               description     = COALESCE($5, description),
               mission         = COALESCE($6, mission),
               vision          = COALESCE($7, vision),
               core_values     = COALESCE($8, core_values),
               motto           = COALESCE($9, motto),
               updated_at      = NOW(),
               updated_by      = $10
        WHERE  id = 1
        RETURNING company_name, company_address, logo_url,
                  primary_color, accent_color,
                  description, mission, vision, core_values, motto, updated_at
    `, [
        company_name?.trim() || null,
        company_address !== undefined ? company_address : null,
        primary_color || null,
        accent_color || null,
        description !== undefined ? description : null,
        mission !== undefined ? mission : null,
        vision !== undefined ? vision : null,
        core_values !== undefined ? core_values : null,
        motto !== undefined ? motto : null,
        req.user.id,
    ]);

    if (result.rows.length === 0) {
        throw createError.notFound('Company settings not found');
    }

    await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'company_settings',
        recordId:    1,
        newValues:   result.rows[0],
        description: 'Company branding settings updated',
    });

    invalidateBrandingCache();
    sendSuccess(res, result.rows[0], 'Company settings updated');
});

// ============================================================
// UPLOAD COMPANY LOGO
// POST /api/settings/company/logo
// multipart/form-data, field name "logo". Stores the file under
// uploads/branding/ (served publicly at /uploads/branding/...) and
// saves the resulting URL onto company_settings.logo_url.
// ============================================================
const uploadCompanyLogo = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw createError.badRequest('No logo file was uploaded');
    }

    const logoUrl = `/uploads/branding/${req.file.filename}`;

    const result = await query(`
        UPDATE company_settings
        SET    logo_url   = $1,
               updated_at = NOW(),
               updated_by = $2
        WHERE  id = 1
        RETURNING logo_url
    `, [logoUrl, req.user.id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Company settings not found');
    }

    await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'company_settings',
        recordId:    1,
        newValues:   { logo_url: logoUrl },
        description: 'Company logo updated',
    });

    invalidateBrandingCache();
    sendSuccess(res, { logo_url: logoUrl }, 'Logo updated');
});

module.exports = {
    getCompanySettings,
    updateCompanySettings,
    uploadCompanyLogo,
};
