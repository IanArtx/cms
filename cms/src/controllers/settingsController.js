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
const { uploadBuffer, generateKey } = require('../services/storageService');
const { SIGNABLE_DOCUMENT_TYPES } = require('../services/signatureService');

// ============================================================
// GET COMPANY SETTINGS
// GET /api/settings/company
// Public — no authentication required (v1.32.3; see routes/settings.js's
// comment on this route for why). The frontend needs this on every page
// load, including the pre-login Login/Register/Forgot Password/Consent
// pages, to render the sidebar/topbar/logo/documents correctly for
// whichever company this deployment actually is.
// ============================================================
const getCompanySettings = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT company_name, company_address, logo_url,
               primary_color, accent_color,
               description, mission, vision, core_values, motto,
               stamps_enabled,
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
            stamps_enabled:  false,
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
        stamps_enabled,
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
               stamps_enabled  = COALESCE($10, stamps_enabled),
               updated_at      = NOW(),
               updated_by      = $11
        WHERE  id = 1
        RETURNING company_name, company_address, logo_url,
                  primary_color, accent_color,
                  description, mission, vision, core_values, motto,
                  stamps_enabled, updated_at
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
        typeof stamps_enabled === 'boolean' ? stamps_enabled : null,
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

    const logoKey = generateKey('branding', req.file.originalname);
    await uploadBuffer(req.file.buffer, logoKey, req.file.mimetype);
    const logoUrl = `/uploads/${logoKey}`;

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

// ============================================================
// UPDATE MEMBERSHIP AGREEMENT (v1.23.0, Section 4.29)
// PATCH /api/settings/membership-agreement
// Admin only. Bumps version — a record of when the wording changed,
// NOT a re-consent trigger: members who already consented are not
// asked again (Section 4.29's design note explains why).
// ============================================================
const updateMembershipAgreement = asyncHandler(async (req, res) => {
    const { content } = req.body;
    if (!content || !content.trim()) {
        throw createError.badRequest('Agreement content cannot be empty');
    }

    const result = await query(`
        UPDATE membership_agreement
        SET    content    = $1,
               version    = version + 1,
               updated_at = NOW(),
               updated_by = $2
        WHERE  id = 1
        RETURNING content, version, updated_at
    `, [content.trim(), req.user.id]);

    await logAction(req.user.id, ACTIONS.MEMBERSHIP_AGREEMENT_UPDATED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'membership_agreement',
        recordId:    1,
        description: `Membership Agreement updated to v${result.rows[0].version}`,
    });

    sendSuccess(res, result.rows[0], 'Membership Agreement updated');
});

// ============================================================
// GET SIGNATURE REQUIREMENTS (v1.23.0, Section 4.29)
// GET /api/settings/signature-requirements
// Admin only. Returns every document type alongside whichever roles
// are currently required to sign it (active rows only).
// ============================================================
// v1.44.0 — was a locally-duplicated copy of this same list (drifted
// from signatureService.js's own, which is the one actually enforced
// at sign time); now imported from there so there's exactly one
// source of truth.
const getSignatureRequirements = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT sr.id, sr.document_type, sr.role_id, r.name AS role_name
        FROM   signature_requirements sr
        JOIN   roles r ON r.id = sr.role_id
        WHERE  sr.is_active = TRUE
        ORDER  BY sr.document_type, r.name
    `);

    const byType = {};
    for (const t of SIGNABLE_DOCUMENT_TYPES) byType[t] = [];
    for (const row of result.rows) {
        byType[row.document_type].push({ role_id: row.role_id, role_name: row.role_name });
    }

    sendSuccess(res, byType);
});

// ============================================================
// SET SIGNATURE REQUIREMENTS FOR ONE DOCUMENT TYPE
// PUT /api/settings/signature-requirements/:documentType
// Body: { role_ids: [1, 2, ...] } — replaces the full set of
// required roles for that document type in one call (simplest UX:
// the frontend sends whatever's checked, not individual add/remove
// calls). An empty array turns the multi-signature requirement off
// entirely for that type, reverting it to the original single-
// approver flow.
// ============================================================
const setSignatureRequirements = asyncHandler(async (req, res) => {
    const { documentType } = req.params;
    const { role_ids } = req.body;

    if (!SIGNABLE_DOCUMENT_TYPES.includes(documentType)) {
        throw createError.badRequest(`documentType must be one of: ${SIGNABLE_DOCUMENT_TYPES.join(', ')}`);
    }
    if (!Array.isArray(role_ids)) {
        throw createError.badRequest('role_ids must be an array (can be empty)');
    }

    const { withTransaction } = require('../config/database');
    await withTransaction(async (client) => {
        await client.query(
            'UPDATE signature_requirements SET is_active = FALSE WHERE document_type = $1',
            [documentType]
        );
        for (const roleId of role_ids) {
            await client.query(`
                INSERT INTO signature_requirements (document_type, role_id, is_active, created_by)
                VALUES ($1, $2, TRUE, $3)
                ON CONFLICT (document_type, role_id) DO UPDATE SET is_active = TRUE
            `, [documentType, roleId, req.user.id]);
        }
    });

    await logAction(req.user.id, ACTIONS.SIGNATURE_REQUIREMENTS_UPDATED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'signature_requirements',
        description: `Signature requirements for ${documentType} set to role IDs [${role_ids.join(', ')}]`,
    });

    sendSuccess(res, { document_type: documentType, role_ids }, 'Signature requirements updated');
});

// ============================================================
// COMPANY STAMPS & SEALS (v1.24.0, Section 4.30)
// Admin-uploaded named stamp images, auto-applied to a document once
// it is fully approved/signed. Every document_type that can carry a
// stamp — the full documents.document_type list plus
// SHARE_CERTIFICATE — mirrors the CHECK constraint on
// document_stamp_requirements in schema.sql/migration_v1.24.0.sql.
// ============================================================
const STAMPABLE_DOCUMENT_TYPES = [
    'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
    'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
    'RECEIPT', 'RESOLUTION', 'CONTRACT', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT',
    'AUDITOR_FEEDBACK', 'AUDIT_REPORT', 'OTHER', 'SHARE_CERTIFICATE',
];

// ============================================================
// UPLOAD A STAMP
// POST /api/settings/stamps
// multipart/form-data, field name "stamp", plus a "name" body field
// (e.g. "Treasury", "Secretariat"). Stores the file under
// uploads/stamps/ the same way the logo is stored under
// uploads/branding/ — the DB gets a /uploads/... URL path, not the
// raw disk path.
// ============================================================
const uploadStamp = asyncHandler(async (req, res) => {
    if (!req.file) {
        throw createError.badRequest('No stamp image was uploaded');
    }
    const { name } = req.body;
    if (!name || !name.trim()) {
        throw createError.badRequest('A name is required (e.g. "Treasury", "Secretariat")');
    }

    const stampKey = generateKey('stamps', req.file.originalname);
    await uploadBuffer(req.file.buffer, stampKey, req.file.mimetype);
    const filePath = `/uploads/${stampKey}`;

    const result = await query(`
        INSERT INTO company_stamps (name, file_path, mime_type, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING id, name, file_path, mime_type, is_active, created_at
    `, [name.trim(), filePath, req.file.mimetype, req.user.id]);

    await logAction(req.user.id, ACTIONS.STAMP_UPLOADED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'company_stamps',
        recordId:    result.rows[0].id,
        description: `Stamp uploaded: "${name.trim()}"`,
    });

    sendSuccess(res, result.rows[0], 'Stamp uploaded', 201);
});

// ============================================================
// LIST STAMPS
// GET /api/settings/stamps
// Admin only. Returns every stamp, active and deactivated, newest
// first — the management screen needs to show deactivated ones too
// (greyed out) so an Admin can see what used to exist.
// ============================================================
const getStamps = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, name, file_path, mime_type, is_active, created_at
        FROM   company_stamps
        ORDER  BY is_active DESC, created_at DESC
    `);
    sendSuccess(res, result.rows);
});

// ============================================================
// DEACTIVATE A STAMP
// PATCH /api/settings/stamps/:id/deactivate
// Soft-deactivate only (same convention as roles.is_active /
// signature_requirements.is_active) — never hard-deleted, since
// document_stamps_applied rows may still reference it. Also turns
// off any document_stamp_requirements rows that were using it, so it
// stops being assigned to anything going forward.
// ============================================================
const deactivateStamp = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { withTransaction } = require('../config/database');
    const stamp = await withTransaction(async (client) => {
        const result = await client.query(
            'UPDATE company_stamps SET is_active = FALSE WHERE id = $1 RETURNING id, name',
            [id]
        );
        if (result.rows.length === 0) {
            throw createError.notFound('Stamp not found');
        }
        await client.query(
            'UPDATE document_stamp_requirements SET is_active = FALSE WHERE stamp_id = $1',
            [id]
        );
        return result.rows[0];
    });

    await logAction(req.user.id, ACTIONS.STAMP_DEACTIVATED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'company_stamps',
        recordId:    parseInt(id),
        description: `Stamp deactivated: "${stamp.name}"`,
    });

    sendSuccess(res, stamp, 'Stamp deactivated');
});

// ============================================================
// GET STAMP REQUIREMENTS
// GET /api/settings/stamp-requirements
// Admin only. Returns every stampable document type alongside
// whichever stamp(s) currently apply to it (active rows only).
// ============================================================
const getStampRequirements = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT dsr.id, dsr.document_type, dsr.stamp_id, cs.name AS stamp_name, cs.file_path
        FROM   document_stamp_requirements dsr
        JOIN   company_stamps cs ON cs.id = dsr.stamp_id
        WHERE  dsr.is_active = TRUE
        ORDER  BY dsr.document_type, cs.name
    `);

    const byType = {};
    for (const t of STAMPABLE_DOCUMENT_TYPES) byType[t] = [];
    for (const row of result.rows) {
        byType[row.document_type].push({
            stamp_id: row.stamp_id, stamp_name: row.stamp_name, file_path: row.file_path,
        });
    }

    sendSuccess(res, byType);
});

// ============================================================
// SET STAMP REQUIREMENTS FOR ONE DOCUMENT TYPE
// PUT /api/settings/stamp-requirements/:documentType
// Body: { stamp_ids: [1, 2, ...] } — replaces the full set for that
// type, same "replace, don't add/remove individually" UX as
// setSignatureRequirements. SHARE_CERTIFICATE is capped at exactly
// one stamp here (a friendly error before hitting the database) —
// the database's own partial unique index is the real backstop, this
// is just to fail with a clear message instead of a raw constraint
// error.
// ============================================================
const setStampRequirements = asyncHandler(async (req, res) => {
    const { documentType } = req.params;
    const { stamp_ids } = req.body;

    if (!STAMPABLE_DOCUMENT_TYPES.includes(documentType)) {
        throw createError.badRequest(`documentType must be one of: ${STAMPABLE_DOCUMENT_TYPES.join(', ')}`);
    }
    if (!Array.isArray(stamp_ids)) {
        throw createError.badRequest('stamp_ids must be an array (can be empty)');
    }
    if (documentType === 'SHARE_CERTIFICATE' && stamp_ids.length > 1) {
        throw createError.badRequest('Share Certificates can only have one stamp assigned (the Treasury stamp, or whichever stamp represents it) — not multiple');
    }

    const { withTransaction } = require('../config/database');
    await withTransaction(async (client) => {
        await client.query(
            'UPDATE document_stamp_requirements SET is_active = FALSE WHERE document_type = $1',
            [documentType]
        );
        for (const stampId of stamp_ids) {
            await client.query(`
                INSERT INTO document_stamp_requirements (document_type, stamp_id, is_active, created_by)
                VALUES ($1, $2, TRUE, $3)
                ON CONFLICT (document_type, stamp_id) DO UPDATE SET is_active = TRUE
            `, [documentType, stampId, req.user.id]);
        }
    });

    await logAction(req.user.id, ACTIONS.STAMP_REQUIREMENTS_UPDATED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'document_stamp_requirements',
        description: `Stamp requirements for ${documentType} set to stamp IDs [${stamp_ids.join(', ')}]`,
    });

    sendSuccess(res, { document_type: documentType, stamp_ids }, 'Stamp requirements updated');
});

// ============================================================
// CUSTOM FISCAL QUARTERS (v1.25.0, Section 4.10 addendum)
// Admin-defined financial-year quarters with fully custom date
// ranges — not necessarily equal 3-month blocks, not required to
// tile the calendar without gaps. Purely a labelling/lookup table;
// reports and documents look up which configured quarter a date
// falls into via fiscalService.getQuarterForDate.
// ============================================================

// ------------------------------------------------------------
// LIST FISCAL QUARTERS
// GET /api/settings/fiscal-quarters
// Any authenticated user — Reports/document generation needs this
// to show the right label, not just Admins.
// ------------------------------------------------------------
const getFiscalQuarters = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT id, label, start_date, end_date, created_at
        FROM   fiscal_quarters
        ORDER  BY start_date DESC
    `);
    sendSuccess(res, result.rows);
});

// ------------------------------------------------------------
// CREATE A FISCAL QUARTER — Admin
// POST /api/settings/fiscal-quarters
// ------------------------------------------------------------
const createFiscalQuarter = asyncHandler(async (req, res) => {
    const { label, start_date, end_date } = req.body;

    if (new Date(end_date) < new Date(start_date)) {
        throw createError.badRequest('end_date cannot be before start_date');
    }

    const result = await query(`
        INSERT INTO fiscal_quarters (label, start_date, end_date, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `, [label.trim(), start_date, end_date, req.user.id]);

    await logAction(req.user.id, ACTIONS.FISCAL_QUARTER_CREATED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'fiscal_quarters',
        recordId:    result.rows[0].id,
        newValues:   result.rows[0],
        description: `Fiscal quarter created: "${label.trim()}" (${start_date} to ${end_date})`,
    });

    sendSuccess(res, result.rows[0], 'Fiscal quarter created', 201);
});

// ------------------------------------------------------------
// UPDATE A FISCAL QUARTER — Admin
// PUT /api/settings/fiscal-quarters/:id
// ------------------------------------------------------------
const updateFiscalQuarter = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { label, start_date, end_date } = req.body;

    if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
        throw createError.badRequest('end_date cannot be before start_date');
    }

    const result = await query(`
        UPDATE fiscal_quarters
        SET    label      = COALESCE($1, label),
               start_date = COALESCE($2, start_date),
               end_date   = COALESCE($3, end_date)
        WHERE  id = $4
        RETURNING *
    `, [label?.trim() || null, start_date || null, end_date || null, id]);

    if (result.rows.length === 0) {
        throw createError.notFound('Fiscal quarter not found');
    }

    await logAction(req.user.id, ACTIONS.FISCAL_QUARTER_UPDATED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'fiscal_quarters',
        recordId:    parseInt(id),
        newValues:   result.rows[0],
        description: `Fiscal quarter updated: "${result.rows[0].label}"`,
    });

    sendSuccess(res, result.rows[0], 'Fiscal quarter updated');
});

// ------------------------------------------------------------
// DELETE A FISCAL QUARTER — Admin
// DELETE /api/settings/fiscal-quarters/:id
// Hard delete — this is a labelling table only, nothing else
// references a fiscal_quarters row by foreign key, so there's
// nothing left dangling.
// ------------------------------------------------------------
const deleteFiscalQuarter = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query('DELETE FROM fiscal_quarters WHERE id = $1 RETURNING id, label', [id]);
    if (result.rows.length === 0) {
        throw createError.notFound('Fiscal quarter not found');
    }

    await logAction(req.user.id, ACTIONS.FISCAL_QUARTER_DELETED, MODULES.SYSTEM, {
        ipAddress:   req.ip,
        recordType:  'fiscal_quarters',
        recordId:    parseInt(id),
        description: `Fiscal quarter deleted: "${result.rows[0].label}"`,
    });

    sendSuccess(res, { id: parseInt(id) }, 'Fiscal quarter deleted');
});

module.exports = {
    getCompanySettings,
    updateCompanySettings,
    uploadCompanyLogo,
    updateMembershipAgreement,
    getSignatureRequirements,
    setSignatureRequirements,
    STAMPABLE_DOCUMENT_TYPES,
    uploadStamp,
    getStamps,
    deactivateStamp,
    getStampRequirements,
    setStampRequirements,
    getFiscalQuarters,
    createFiscalQuarter,
    updateFiscalQuarter,
    deleteFiscalQuarter,
};
