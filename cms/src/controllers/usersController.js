// ============================================================
// USERS CONTROLLER
// Handles: profile view/update, role management, role requests
// ============================================================

const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated, sendPaginated, getPagination } = require('../utils/response');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');
const { sendRoleAssignedEmail } = require('../services/authService');
const { uploadBuffer, generateKey, deleteObject, toKey } = require('../services/storageService');
const { buildMemberPortfolio } = require('../services/portfolioService');
const { getUserFootprint, hardDeleteUser } = require('../services/userDeletionService');

// ============================================================
// GET OWN PROFILE
// GET /api/users/me
// ============================================================
const getMyProfile = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            u.id, u.uuid, u.email, u.first_name, u.last_name,
            u.date_of_birth, u.nationality, u.id_number, u.phone,
            u.address, u.photo_path, u.gender, u.avatar_choice,
            u.auditor_company_name, u.auditor_company_initials, u.auditor_contact_phone,
            u.emergency_contact_name,
            u.emergency_contact_phone, u.two_factor_enabled,
            u.is_email_verified, u.last_login_at, u.created_at,
            u.signature_path, u.signature_updated_at,
            bool_or(mc.id IS NOT NULL) AS has_consented,
            COALESCE(
                json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
                FILTER (WHERE r.id IS NOT NULL), '[]'
            ) AS roles,
            COALESCE(
                json_agg(DISTINCT p.code)
                FILTER (WHERE p.code IS NOT NULL), '[]'
            ) AS permissions,
            (SELECT jsonb_build_object(
                'shares_held', sr.shares_held,
                'percentage',  sr.percentage
             )
             FROM shareholding_registry sr
             WHERE sr.user_id = u.id AND sr.effective_to IS NULL
             LIMIT 1) AS shareholding
        FROM users u
        LEFT JOIN user_roles ur    ON ur.user_id  = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r          ON r.id        = ur.role_id AND r.is_active = TRUE
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p    ON p.id        = rp.permission_id
        LEFT JOIN member_consents mc ON mc.user_id = u.id
        WHERE u.id = $1
        GROUP BY u.id
    `, [req.user.id]);

    const profile = result.rows[0];

    if (profile) {
        // --------------------------------------------------------
        // Share value = shares_held × current price per share.
        // Also compute equivalent values in other currencies using
        // the latest monthly exchange rates set against the share
        // price's own currency (display only — see exchangeRatesController).
        // --------------------------------------------------------
        const priceResult = await query(`
            SELECT sph.price_per_share, c.id AS currency_id,
                   c.code AS currency_code, c.symbol AS currency_symbol
            FROM   share_price_history sph
            JOIN   currencies c ON c.id = sph.currency_id
            WHERE  sph.effective_to IS NULL
            ORDER  BY sph.effective_from DESC
            LIMIT  1
        `);
        const sharePrice = priceResult.rows[0] || null;

        if (profile.shareholding && sharePrice) {
            const shareValue = parseFloat(profile.shareholding.shares_held || 0) *
                parseFloat(sharePrice.price_per_share);

            profile.shareholding.share_value      = shareValue;
            profile.shareholding.currency_code    = sharePrice.currency_code;
            profile.shareholding.currency_symbol  = sharePrice.currency_symbol;

            const fxResult = await query(`
                SELECT tc.code AS currency_code, tc.symbol AS currency_symbol, cer.rate
                FROM   currency_exchange_rates cer
                JOIN   currencies tc ON tc.id = cer.target_currency_id
                WHERE  cer.base_currency_id = $1 AND cer.effective_to IS NULL
            `, [sharePrice.currency_id]);

            profile.shareholding.share_value_conversions = fxResult.rows.map(r => ({
                currency_code:   r.currency_code,
                currency_symbol: r.currency_symbol,
                amount:          shareValue * parseFloat(r.rate),
            }));
        }

        // --------------------------------------------------------
        // Total contributions — all-time, APPROVED only, grouped by
        // currency (in the normal case there's just one entry, since
        // contributions are recorded in the primary account's currency).
        // --------------------------------------------------------
        const contribResult = await query(`
            SELECT COALESCE(SUM(sc.amount), 0) AS total,
                   c.code AS currency_code, c.symbol AS currency_symbol
            FROM   shareholder_contributions sc
            JOIN   currencies c ON c.id = sc.currency_id
            WHERE  sc.user_id = $1 AND sc.status = 'APPROVED'
            GROUP  BY c.code, c.symbol
        `, [req.user.id]);

        profile.total_contributions = contribResult.rows.map(r => ({
            currency_code:   r.currency_code,
            currency_symbol: r.currency_symbol,
            amount:          parseFloat(r.total),
        }));
    }

    sendSuccess(res, profile);
});

// ============================================================
// UPDATE OWN PROFILE
// PATCH /api/users/me
// Users can only update personal information — not email, roles, or status
// ============================================================
const updateMyProfile = asyncHandler(async (req, res) => {
    const {
        first_name, last_name, date_of_birth, nationality,
        id_number, phone, address,
        emergency_contact_name, emergency_contact_phone,
        gender, avatar_choice,
        auditor_company_name, auditor_company_initials, auditor_contact_phone,
    } = req.body;

    const result = await query(`
        UPDATE users SET
            first_name              = COALESCE($1, first_name),
            last_name               = COALESCE($2, last_name),
            date_of_birth           = COALESCE($3, date_of_birth),
            nationality              = COALESCE($4, nationality),
            id_number               = COALESCE($5, id_number),
            phone                   = COALESCE($6, phone),
            address                 = COALESCE($7, address),
            emergency_contact_name  = COALESCE($8, emergency_contact_name),
            emergency_contact_phone = COALESCE($9, emergency_contact_phone),
            gender                  = COALESCE($10, gender),
            avatar_choice           = COALESCE($11, avatar_choice),
            auditor_company_name     = COALESCE($12, auditor_company_name),
            auditor_company_initials = COALESCE($13, auditor_company_initials),
            auditor_contact_phone    = COALESCE($14, auditor_contact_phone),
            updated_at              = NOW()
        WHERE id = $15
        RETURNING id, first_name, last_name, email, phone, address, gender, avatar_choice, photo_path,
                  auditor_company_name, auditor_company_initials, auditor_contact_phone
    `, [
        first_name, last_name, date_of_birth, nationality,
        id_number, phone, address,
        emergency_contact_name, emergency_contact_phone,
        gender, avatar_choice,
        auditor_company_name, auditor_company_initials, auditor_contact_phone,
        req.user.id,
    ]);

    await logAction(req.user.id, ACTIONS.USER_PROFILE_UPDATED, MODULES.USERS, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    req.user.id,
        description: 'User updated their own profile',
    });

    sendSuccess(res, result.rows[0], 'Profile updated successfully');
});

// ============================================================
// UPDATE PROFILE PHOTO
// PATCH /api/users/me/photo
// ============================================================
const updateProfilePhoto = asyncHandler(async (req, res) => {
    if (!req.file) throw createError.badRequest('No photo file uploaded');

    // v1.29.1 — file bytes now go to storageService (R2 in production,
    // local disk only as a dev fallback — see storageService.js) instead
    // of straight to Render's own ephemeral disk, which is what made
    // v1.28.3's fix incomplete: a correctly-formatted URL still pointed
    // at a file that vanished on the next redeploy. The stored value is
    // still a "/uploads/<key>" path either way, so nothing downstream
    // (getPhotoUrl(), Avatar.jsx) needed to change.
    const key = generateKey('profiles', req.file.originalname);
    await uploadBuffer(req.file.buffer, key, req.file.mimetype);
    const photoPath = `/uploads/${key}`;

    const existing = await query('SELECT photo_path FROM users WHERE id = $1', [req.user.id]);
    await query(
        'UPDATE users SET photo_path = $1, updated_at = NOW() WHERE id = $2',
        [photoPath, req.user.id]
    );

    // Best-effort cleanup of the photo being replaced — unlike free
    // ephemeral local disk, storage on R2 actually costs money, so an
    // orphaned old photo is worth tidying up (fire-and-forget; a failed
    // delete here should never block the response).
    const oldKey = toKey(existing.rows[0]?.photo_path);
    if (oldKey && oldKey !== key) deleteObject(oldKey);

    sendSuccess(res, { photo_path: photoPath }, 'Profile photo updated');
});

// ============================================================
// UPDATE MY SIGNATURE (v1.23.0, Section 4.29)
// PATCH /api/users/me/signature
// Body: { signature_data_url } — a "data:image/png;base64,...."
// string from the SignaturePad component (drawn, not uploaded — see
// Section 4.29 for why draw-only was chosen). Saved via storageService
// (R2 in production, v1.29.1) the same way photo_path is, not stored
// inline in the database, so it can be served as a normal image and
// stays consistent with every other file this system stores.
// Re-drawing later (e.g. after a mistake) simply overwrites
// signature_path with a new file — it does not retroactively change
// documents already signed, since those keep their own
// signature_snapshot_path copy taken at signing time (signatureService.js).
// ============================================================
const updateSignature = asyncHandler(async (req, res) => {
    const { signature_data_url } = req.body;

    if (!signature_data_url || !/^data:image\/png;base64,/.test(signature_data_url)) {
        throw createError.badRequest('signature_data_url must be a base64 PNG data URL');
    }

    const base64Data = signature_data_url.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > 2 * 1024 * 1024) {
        throw createError.badRequest('Signature image is too large (max 2MB)');
    }

    const key = generateKey('signatures', `${req.user.id}.png`);
    await uploadBuffer(buffer, key, 'image/png');

    // Stored as a "/uploads/..." URL path (same convention as
    // settingsController's logo_url), not a raw disk path — so it can
    // be served directly and resolved to an absolute URL the same way
    // certificateService.resolveAbsoluteAssetUrl already does for the
    // company logo.
    const signaturePath = `/uploads/${key}`;

    const existing = await query('SELECT signature_path FROM users WHERE id = $1', [req.user.id]);
    await query(
        'UPDATE users SET signature_path = $1, signature_updated_at = NOW() WHERE id = $2',
        [signaturePath, req.user.id]
    );

    // Best-effort cleanup of the old live signature file — the
    // per-signing snapshots (signatureService.js's signSlot) are
    // separate copies and are never touched by this.
    const oldKey = toKey(existing.rows[0]?.signature_path);
    if (oldKey && oldKey !== key) deleteObject(oldKey);

    await logAction(req.user.id, ACTIONS.SIGNATURE_UPDATED, MODULES.USERS, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    req.user.id,
        description: 'User set/updated their personal signature',
    }).catch(() => {});

    sendSuccess(res, { signature_path: signaturePath }, 'Signature saved');
});

// ============================================================
// GET ALL USERS (Admin/Director/Treasurer)
// GET /api/users
// ============================================================
const getAllUsers = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);
    const { search, role, is_active } = req.query;

    // Build dynamic WHERE clause
    const conditions = [];
    const params = [];
    let paramCount = 0;

    if (search) {
        paramCount++;
        conditions.push(`(
            u.first_name ILIKE $${paramCount} OR
            u.last_name  ILIKE $${paramCount} OR
            u.email      ILIKE $${paramCount}
        )`);
        params.push(`%${search}%`);
    }

    if (is_active !== undefined) {
        paramCount++;
        conditions.push(`u.is_active = $${paramCount}`);
        params.push(is_active === 'true');
    }

    if (role) {
        paramCount++;
        conditions.push(`r.name = $${paramCount}`);
        params.push(role);
    }

    const whereClause = conditions.length > 0
        ? 'WHERE ' + conditions.join(' AND ')
        : '';

    // Count total
    const countResult = await query(`
        SELECT COUNT(DISTINCT u.id) AS total
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r       ON r.id = ur.role_id
        ${whereClause}
    `, params);

    const total = parseInt(countResult.rows[0].total);

    // Fetch page
    params.push(limit, offset);
    const result = await query(`
        SELECT
            u.id, u.uuid, u.email, u.first_name, u.last_name,
            u.phone, u.is_active, u.is_email_verified,
            u.photo_path, u.gender, u.avatar_choice,
            u.last_login_at, u.created_at,
            COALESCE(
                json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
                FILTER (WHERE r.id IS NOT NULL), '[]'
            ) AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r       ON r.id = ur.role_id AND r.is_active = TRUE
        ${whereClause}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, params);

    sendPaginated(res, result.rows, total, page, limit);
});

// ============================================================
// GET USER BY ID (Admin only, or self)
// GET /api/users/:id
// ============================================================
const getUserById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const result = await query(`
        SELECT
            u.id, u.uuid, u.email, u.first_name, u.last_name,
            u.date_of_birth, u.nationality, u.id_number, u.phone,
            u.address, u.photo_path, u.gender, u.avatar_choice,
            u.auditor_company_name, u.auditor_company_initials, u.auditor_contact_phone,
            u.emergency_contact_name,
            u.emergency_contact_phone, u.two_factor_enabled,
            u.is_active, u.is_email_verified, u.last_login_at, u.created_at,
            COALESCE(
                json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name))
                FILTER (WHERE r.id IS NOT NULL), '[]'
            ) AS roles,
            (SELECT jsonb_build_object(
                'shares_held', sr.shares_held,
                'percentage',  sr.percentage
             )
             FROM shareholding_registry sr
             WHERE sr.user_id = u.id AND sr.effective_to IS NULL
             LIMIT 1) AS shareholding
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.revoked_at IS NULL
        LEFT JOIN roles r       ON r.id = ur.role_id AND r.is_active = TRUE
        WHERE u.id = $1
        GROUP BY u.id
    `, [id]);

    if (result.rows.length === 0) throw createError.notFound('User not found');

    sendSuccess(res, result.rows[0]);
});

// ============================================================
// GET MEMBER PORTFOLIO (v1.34.0)
// GET /api/users/:id/portfolio
// The full "everything about this member" snapshot — profile,
// roles held, shareholding + contribution history, savings,
// dividends received, side fund standing, every payment ever paid
// out to them, and every transaction they've been involved in
// (see portfolioService.js for the full breakdown). Gated the same
// way as GET /:id above (isSelfOrHasPermission('USER_VIEW_ALL')) —
// everyone can see their own, Admins/permitted roles can see anyone's.
// ============================================================
const getMemberPortfolio = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const portfolio = await buildMemberPortfolio(parseInt(id, 10));

    if (!portfolio) {
        throw createError.notFound('User not found');
    }

    sendSuccess(res, portfolio);
});

// ============================================================
// DEACTIVATE USER (Admin only — soft delete)
// PATCH /api/users/:id/deactivate
// ============================================================
const deactivateUser = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
        throw createError.badRequest('You cannot deactivate your own account');
    }

    const result = await query(`
        UPDATE users SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1 AND is_active = TRUE
        RETURNING id, email
    `, [id]);

    if (result.rows.length === 0) {
        throw createError.notFound('User not found or already deactivated');
    }

    await logAction(req.user.id, ACTIONS.USER_DEACTIVATED, MODULES.USERS, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    parseInt(id),
        description: `User deactivated: ${result.rows[0].email}`,
    });

    sendSuccess(res, null, 'User account deactivated');
});

// ============================================================
// DELETION CHECK — PREVIEW ONLY (v1.35.0)
// GET /api/users/:id/deletion-check
// Read-only — reports whether this account can be safely, permanently
// deleted, and if not, exactly which tables have activity on record.
// See userDeletionService.js for the full explanation of why this
// check exists and how it works. Meant for exactly one situation:
// a duplicate registration (someone signed up more than once, usually
// under a different email each time) that was never actually used.
// ============================================================
const getDeletionCheck = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const footprint = await getUserFootprint(parseInt(id, 10));
    sendSuccess(res, footprint);
});

// ============================================================
// DELETE USER PERMANENTLY (v1.35.0)
// DELETE /api/users/:id
// Irreversible. Only succeeds if the account has no real activity
// anywhere in the system (re-checked at commit time, not just relying
// on whatever the preview showed a moment earlier) — otherwise use
// Deactivate, which is safe, reversible, and appropriate for every
// other "this member shouldn't have access" situation.
// ============================================================
const deleteUserPermanently = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
        throw createError.badRequest('You cannot delete your own account');
    }

    const deleted = await hardDeleteUser(parseInt(id, 10));

    await logAction(req.user.id, ACTIONS.USER_PERMANENTLY_DELETED, MODULES.USERS, {
        ipAddress:   req.ip,
        recordType:  'users',
        recordId:    parseInt(id),
        newValues:   deleted,
        description: `User permanently deleted: ${deleted.name} (${deleted.email})`,
    });

    sendSuccess(res, null, `${deleted.name} (${deleted.email}) permanently deleted`);
});

// ============================================================
// ASSIGN ROLE (Admin only)
// POST /api/users/:id/roles
// ============================================================
const assignRole = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role_id, notes } = req.body;

    await withTransaction(async (client) => {
        // Check user exists
        const userResult = await client.query(
            'SELECT id, email, first_name, last_name FROM users WHERE id = $1 AND is_active = TRUE',
            [id]
        );
        if (userResult.rows.length === 0) throw createError.notFound('User not found');
        const targetUser = userResult.rows[0];

        // Check role exists
        const roleResult = await client.query(
            'SELECT id, name FROM roles WHERE id = $1 AND is_active = TRUE',
            [role_id]
        );
        if (roleResult.rows.length === 0) throw createError.notFound('Role not found');
        const role = roleResult.rows[0];

        // Check not already assigned
        const existing = await client.query(
            'SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2 AND revoked_at IS NULL',
            [id, role_id]
        );
        if (existing.rows.length > 0) {
            throw createError.conflict('User already holds this role');
        }

        await client.query(`
            INSERT INTO user_roles (user_id, role_id, assigned_by, notes)
            VALUES ($1, $2, $3, $4)
        `, [id, role_id, req.user.id, notes || null]);

        // If there was a pending role request for this role, mark it approved
        await client.query(`
            UPDATE role_requests
            SET    status = 'APPROVED', reviewed_by = $1, reviewed_at = NOW()
            WHERE  user_id = $2 AND role_id = $3 AND status = 'PENDING'
        `, [req.user.id, id, role_id]);

        await logAction(req.user.id, ACTIONS.ROLE_ASSIGNED, MODULES.USERS, {
            ipAddress:   req.ip,
            recordType:  'user_roles',
            recordId:    parseInt(id),
            description: `Role '${role.name}' assigned to ${targetUser.email}`,
            client,
        });

        // Notify the user by email
        const assignerName = `${req.user.first_name} ${req.user.last_name}`;
        await sendRoleAssignedEmail(targetUser, role.name, assignerName);

        sendCreated(res, null, `Role '${role.name}' assigned successfully`);
    });
});

// ============================================================
// REVOKE ROLE (Admin only)
// DELETE /api/users/:id/roles/:roleId
// ============================================================
const revokeRole = asyncHandler(async (req, res) => {
    const { id, roleId } = req.params;

    const result = await query(`
        UPDATE user_roles
        SET    revoked_at = NOW(), revoked_by = $1
        WHERE  user_id = $2 AND role_id = $3 AND revoked_at IS NULL
        RETURNING id
    `, [req.user.id, id, roleId]);

    if (result.rows.length === 0) {
        throw createError.notFound('Role assignment not found');
    }

    await logAction(req.user.id, ACTIONS.ROLE_REVOKED, MODULES.USERS, {
        ipAddress:   req.ip,
        recordType:  'user_roles',
        recordId:    parseInt(id),
        description: `Role ID ${roleId} revoked from user ID ${id}`,
    });

    sendSuccess(res, null, 'Role revoked successfully');
});

// ============================================================
// GET ALL ROLE REQUESTS (Admin only)
// GET /api/users/role-requests
// ============================================================
const getRoleRequests = asyncHandler(async (req, res) => {
    const { status } = req.query;
    const { page, limit, offset } = getPagination(req.query);

    const params = [];
    let where = '';
    if (status) {
        params.push(status.toUpperCase());
        where = `WHERE rr.status = $1`;
    }

    const result = await query(`
        SELECT
            rr.id, rr.reason, rr.status, rr.created_at,
            rr.review_notes, rr.reviewed_at,
            jsonb_build_object('id', u.id, 'email', u.email,
                'first_name', u.first_name, 'last_name', u.last_name) AS user,
            jsonb_build_object('id', r.id, 'name', r.name) AS role,
            jsonb_build_object('id', rv.id, 'first_name', rv.first_name,
                'last_name', rv.last_name) AS reviewed_by
        FROM role_requests rr
        JOIN users u  ON u.id  = rr.user_id
        JOIN roles r  ON r.id  = rr.role_id
        LEFT JOIN users rv ON rv.id = rr.reviewed_by
        ${where}
        ORDER BY rr.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    sendSuccess(res, result.rows);
});

// ============================================================
// GET ALL ROLES (any authenticated user — needed for registration form)
// GET /api/users/roles
// ============================================================
const getAllRoles = asyncHandler(async (req, res) => {
    const result = await query(
        `SELECT id, name, description, is_system_role, is_active 
         FROM roles WHERE is_active = TRUE ORDER BY name`
    );
    sendSuccess(res, result.rows);
});

// ============================================================
// GET MY ROLE REQUEST (any authenticated user, including zero-role
// accounts — this is the one thing a pending account most needs to
// see: what they requested at registration and whether an Admin has
// reviewed it yet. Feeds the pending-approval page, Section 4.29.)
// GET /api/users/me/role-request
// ============================================================
const getMyRoleRequest = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT rr.id, rr.reason, rr.status, rr.created_at,
               rr.review_notes, rr.reviewed_at,
               r.name AS role_name
        FROM   role_requests rr
        JOIN   roles r ON r.id = rr.role_id
        WHERE  rr.user_id = $1
        ORDER BY rr.created_at DESC
        LIMIT 1
    `, [req.user.id]);

    sendSuccess(res, result.rows[0] || null);
});

// ============================================================
// GET MEMBERSHIP AGREEMENT + MY CONSENT STATUS (v1.23.0, Section
// 4.29). Any authenticated user, including zero-role/not-yet-
// consented accounts — this is what the Consent page itself reads.
// GET /api/users/me/membership-agreement
// ============================================================
const getMembershipAgreement = asyncHandler(async (req, res) => {
    const agreementResult = await query('SELECT content, version, updated_at FROM membership_agreement WHERE id = 1');
    const consentResult = await query(
        'SELECT agreement_version, consented_at FROM member_consents WHERE user_id = $1',
        [req.user.id]
    );

    sendSuccess(res, {
        agreement: agreementResult.rows[0] || null,
        my_consent: consentResult.rows[0] || null,
    });
});

// ============================================================
// GIVE MEMBERSHIP CONSENT (v1.23.0, Section 4.29)
// POST /api/users/me/consent
// One-time — requires a signature already saved (draw it first via
// PATCH /users/me/signature, same screen, before this call). Upserts
// so a duplicate submit (e.g. a double-click) doesn't error.
// ============================================================
const giveConsent = asyncHandler(async (req, res) => {
    if (!req.user.signature_path) {
        throw createError.badRequest('Please draw your signature before consenting');
    }

    const agreementResult = await query('SELECT version FROM membership_agreement WHERE id = 1');
    const version = agreementResult.rows[0]?.version || 1;

    await query(`
        INSERT INTO member_consents (user_id, agreement_version, ip_address, user_agent)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO NOTHING
    `, [req.user.id, version, req.ip, req.headers['user-agent'] || null]);

    await logAction(req.user.id, ACTIONS.MEMBERSHIP_CONSENT_GIVEN, MODULES.USERS, {
        ipAddress:   req.ip,
        recordType:  'member_consents',
        recordId:    req.user.id,
        description: `Member consented to Membership Agreement v${version}`,
    }).catch(() => {});

    sendSuccess(res, { consented: true }, 'Consent recorded');
});

// ============================================================
// GET ALL SHAREHOLDING (visible to all members — aggregate view)
// GET /api/users/shareholding
// ============================================================
const getShareholding = asyncHandler(async (req, res) => {
    const result = await query(`
        SELECT
            u.first_name, u.last_name,
            sr.shares_held, sr.percentage, sr.effective_from
        FROM shareholding_registry sr
        JOIN users u ON u.id = sr.user_id
        WHERE sr.effective_to IS NULL
        ORDER BY sr.percentage DESC
    `);
    sendSuccess(res, result.rows);
});

module.exports = {
    getMyProfile, updateMyProfile, updateProfilePhoto,
    getAllUsers, getUserById, getMemberPortfolio, deactivateUser,
    getDeletionCheck, deleteUserPermanently,
    assignRole, revokeRole, getRoleRequests, getMyRoleRequest,
    getAllRoles, getShareholding,
    updateSignature, getMembershipAgreement, giveConsent,
};
