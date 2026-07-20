// ============================================================
// SYSTEM ROUTES
// Prefix: /api/system
// Admin-only system configuration endpoints
// ============================================================

const router = require('express').Router();
const { body, param } = require('express-validator');
const { validateRequest, validators } = require('../middleware/validate');
const { authenticate, blockAuditor, requirePermissions } = require('../middleware/auth');
const { query } = require('../config/database');
const { sendSuccess, sendCreated } = require('../utils/response');
const { asyncHandler, createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');

router.use(authenticate);
router.use(blockAuditor);
router.use(requirePermissions(['SYSTEM_CONFIG']));

// Create a new role
router.post('/roles',
    [
        body('name').trim().notEmpty().withMessage('Role name is required'),
        body('description').optional().trim(),
    ],
    validateRequest,
    asyncHandler(async (req, res) => {
        const { name, description } = req.body;

        const existing = await query(
            'SELECT id FROM roles WHERE name = $1', [name]
        );
        if (existing.rows.length > 0) {
            throw createError.conflict('A role with this name already exists');
        }

        const result = await query(`
            INSERT INTO roles (name, description, is_system_role, created_by)
            VALUES ($1, $2, FALSE, $3)
            RETURNING id, name, description, is_system_role
        `, [name.trim(), description || null, req.user.id]);

        await logAction(req.user.id, ACTIONS.ROLE_CREATED, MODULES.SYSTEM, {
            ipAddress: req.ip,
            recordType: 'roles',
            recordId: result.rows[0].id,
            description: `New role created: ${name}`,
        });

        sendCreated(res, result.rows[0], `Role "${name}" created successfully`);
    })
);

// Update a role (non-system roles only)
router.patch('/roles/:id',
    validators.idParam('id'),
    [
        body('name').optional().trim().notEmpty(),
        body('description').optional().trim(),
    ],
    validateRequest,
    asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { name, description } = req.body;

        const role = await query(
            'SELECT id, is_system_role FROM roles WHERE id = $1', [id]
        );
        if (role.rows.length === 0) throw createError.notFound('Role not found');
        if (role.rows[0].is_system_role) {
            throw createError.badRequest('System roles cannot be modified');
        }

        const result = await query(`
            UPDATE roles SET
                name        = COALESCE($1, name),
                description = COALESCE($2, description)
            WHERE id = $3
            RETURNING id, name, description, is_system_role
        `, [name || null, description !== undefined ? description : null, id]);

        sendSuccess(res, result.rows[0], 'Role updated successfully');
    })
);

// ============================================================
// PERMISSIONS MANAGEMENT
// The `permissions` table is seeded by migrations (new features add
// their own permission codes there), but nothing has ever let an
// Admin actually GRANT those codes to a role through the app —
// role_permissions has always required a direct database edit. These
// three routes are that missing piece: list every permission, see
// what a role currently has, and set a role's permissions in one go.
// ============================================================

// List every permission in the system, grouped by module — used to
// render the grant/revoke checkbox matrix per role.
router.get('/permissions',
    asyncHandler(async (req, res) => {
        const result = await query(`
            SELECT id, code, module, description
            FROM   permissions
            ORDER  BY module, code
        `);
        sendSuccess(res, result.rows);
    })
);

// List the permission codes currently granted to one role.
router.get('/roles/:id/permissions',
    validators.idParam('id'),
    validateRequest,
    asyncHandler(async (req, res) => {
        const { id } = req.params;

        const role = await query('SELECT id FROM roles WHERE id = $1', [id]);
        if (role.rows.length === 0) throw createError.notFound('Role not found');

        const result = await query(`
            SELECT p.code
            FROM   role_permissions rp
            JOIN   permissions p ON p.id = rp.permission_id
            WHERE  rp.role_id = $1
            ORDER  BY p.code
        `, [id]);

        sendSuccess(res, result.rows.map(r => r.code));
    })
);

// Replace a role's entire permission set with the given list of
// codes — whatever isn't in the list gets revoked, whatever's new
// gets granted. Simpler and less error-prone for a checkbox-matrix
// UI than granting/revoking one at a time.
router.put('/roles/:id/permissions',
    validators.idParam('id'),
    [
        body('permission_codes').isArray().withMessage('permission_codes must be an array'),
        body('permission_codes.*').isString(),
    ],
    validateRequest,
    asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { permission_codes } = req.body;

        const role = await query('SELECT id, name, is_system_role FROM roles WHERE id = $1', [id]);
        if (role.rows.length === 0) throw createError.notFound('Role not found');

        const permsResult = await query(
            'SELECT id, code FROM permissions WHERE code = ANY($1::text[])',
            [permission_codes]
        );
        const foundCodes = permsResult.rows.map(p => p.code);
        const unknown = permission_codes.filter(c => !foundCodes.includes(c));
        if (unknown.length > 0) {
            throw createError.badRequest(`Unknown permission code(s): ${unknown.join(', ')}`);
        }

        await query('DELETE FROM role_permissions WHERE role_id = $1', [id]);

        for (const perm of permsResult.rows) {
            await query(`
                INSERT INTO role_permissions (role_id, permission_id, granted_by)
                VALUES ($1, $2, $3)
                ON CONFLICT (role_id, permission_id) DO NOTHING
            `, [id, perm.id, req.user.id]);
        }

        await logAction(req.user.id, ACTIONS.PERMISSION_GRANTED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'roles',
            recordId:    parseInt(id),
            newValues:   { permission_codes },
            description: `Permissions updated for role "${role.rows[0].name}": ${permission_codes.length} permission(s) granted`,
        });

        sendSuccess(res, { role_id: parseInt(id), permission_codes }, `Permissions updated for role "${role.rows[0].name}"`);
    })
);

module.exports = router;