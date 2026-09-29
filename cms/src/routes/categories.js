// ============================================================
// CATEGORIES CONTROLLER & ROUTES
// The universal hierarchical category system serving all modules.
// Categories can be nested to unlimited depth.
// ============================================================

const router = require('express').Router();
const { body, param, query: qp } = require('express-validator');
const { query, withTransaction } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess, sendCreated } = require('../utils/response');
const { validateRequest } = require('../middleware/validate');
const { authenticate, requireAssignedRole, requireConsent, requirePermissions } = require('../middleware/auth');
const { logAction, ACTIONS, MODULES } = require('../services/auditService');

// ============================================================
// REBUILD CATEGORY PATH (internal helper)
// Called whenever a category is created or its parent changes.
// Walks up the parent chain and stores the full path string.
// ============================================================
const rebuildCategoryPath = async (client, categoryId) => {
    // Recursive CTE to walk the parent chain from this category up to root
    const result = await client.query(`
        WITH RECURSIVE path_cte AS (
            SELECT id, parent_id, name, abbreviation, 0 AS depth
            FROM   categories
            WHERE  id = $1
            UNION ALL
            SELECT c.id, c.parent_id, c.name, c.abbreviation, p.depth + 1
            FROM   categories c
            JOIN   path_cte   p ON p.parent_id = c.id
        )
        SELECT
            string_agg(name,         ' > ' ORDER BY depth DESC) AS full_path,
            string_agg(abbreviation, '-'   ORDER BY depth DESC) AS full_abbreviation,
            MAX(depth) AS depth
        FROM path_cte
    `, [categoryId]);

    const { full_path, full_abbreviation, depth } = result.rows[0];

    await client.query(`
        INSERT INTO category_paths (category_id, full_path, full_abbreviation, depth)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (category_id) DO UPDATE
        SET full_path         = EXCLUDED.full_path,
            full_abbreviation = EXCLUDED.full_abbreviation,
            depth             = EXCLUDED.depth,
            updated_at        = NOW()
    `, [categoryId, full_path, full_abbreviation, depth]);
};

// ============================================================
// GET ALL CATEGORIES (with optional module filter)
// GET /api/categories?module=FINANCE
// Returns a structured tree
// ============================================================
let taxColumnKnown = null;
const hasTaxTreatmentColumn = async () => {
    if (taxColumnKnown) return true;
    const r = await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'categories' AND column_name = 'tax_treatment'`);
    taxColumnKnown = r.rows.length > 0 || null;
    return !!taxColumnKnown;
};
const TAX_TREATMENTS = ['DEDUCTIBLE', 'NOT_DEDUCTIBLE', 'CAPITAL'];

const getAllCategories = asyncHandler(async (req, res) => {
    const { module: mod, flat } = req.query;

    const params = [];
    let where = 'WHERE c.is_active = TRUE';
    if (mod) {
        params.push(mod.toUpperCase());
        where += ` AND c.module = $${params.length}`;
    }

    // v1.70.0 — tax_treatment (own setting, NULL = inherit) and the
    // effective one after inheriting from parents (default DEDUCTIBLE).
    const hasTax = await hasTaxTreatmentColumn();
    const result = await query(`
        SELECT
            c.id, c.parent_id, c.module, c.name, c.abbreviation,
            c.description, c.is_active, c.created_at,
            cp.full_path, cp.full_abbreviation, cp.depth
            ${hasTax ? ', c.tax_treatment' : ''}
        FROM categories c
        LEFT JOIN category_paths cp ON cp.category_id = c.id
        ${where}
        ORDER BY cp.depth ASC, c.name ASC
    `, params);
    if (hasTax) {
        const all = await query(`SELECT id, parent_id, tax_treatment FROM categories`);
        const byId = new Map(all.rows.map(c => [c.id, c]));
        const effective = (id) => {
            let cur = byId.get(id);
            const seen = new Set();
            while (cur && !seen.has(cur.id)) {
                seen.add(cur.id);
                if (cur.tax_treatment) return cur.tax_treatment;
                cur = cur.parent_id ? byId.get(cur.parent_id) : null;
            }
            return 'DEDUCTIBLE';
        };
        result.rows.forEach(r => { r.effective_tax_treatment = effective(r.id); });
    }

    // If flat=true, return array; otherwise build a tree
    if (flat === 'true') {
        return sendSuccess(res, result.rows);
    }

    // Build nested tree structure
    const map = {};
    const roots = [];
    result.rows.forEach(cat => {
        map[cat.id] = { ...cat, children: [] };
    });
    result.rows.forEach(cat => {
        if (cat.parent_id && map[cat.parent_id]) {
            map[cat.parent_id].children.push(map[cat.id]);
        } else {
            roots.push(map[cat.id]);
        }
    });

    sendSuccess(res, roots);
});

// ============================================================
// CREATE CATEGORY (Admin only)
// POST /api/categories
// ============================================================
const createCategory = asyncHandler(async (req, res) => {
    const { parent_id, module, name, abbreviation, description, tax_treatment } = req.body;

    await withTransaction(async (client) => {
        // Validate parent exists if provided
        if (parent_id) {
            const parent = await client.query(
                'SELECT id, module FROM categories WHERE id = $1 AND is_active = TRUE',
                [parent_id]
            );
            if (parent.rows.length === 0) throw createError.notFound('Parent category not found');
            // Module must match parent
            if (parent.rows[0].module !== module.toUpperCase()) {
                throw createError.badRequest('Child category must belong to the same module as its parent');
            }
        }

        const result = await client.query(`
            INSERT INTO categories (parent_id, module, name, abbreviation, description, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [
            parent_id || null,
            module.toUpperCase(),
            name.trim(),
            abbreviation.toUpperCase().trim(),
            description || null,
            req.user.id,
        ]);

        const newCat = result.rows[0];
        // v1.70.0 — optional tax treatment (NULL = inherit from the parent)
        if (tax_treatment && TAX_TREATMENTS.includes(tax_treatment) && await hasTaxTreatmentColumn()) {
            await client.query(`UPDATE categories SET tax_treatment = $1 WHERE id = $2`, [tax_treatment, newCat.id]);
        }

        // Build and store the path
        await rebuildCategoryPath(client, newCat.id);

        await logAction(req.user.id, ACTIONS.CATEGORY_CREATED, MODULES.SYSTEM, {
            ipAddress:   req.ip,
            recordType:  'categories',
            recordId:    newCat.id,
            newValues:   { name, module, abbreviation, parent_id },
            description: `Category created: ${name}`,
            client,
        });

        // Return with path
        const withPath = await client.query(`
            SELECT c.*, cp.full_path, cp.full_abbreviation, cp.depth
            FROM categories c
            JOIN category_paths cp ON cp.category_id = c.id
            WHERE c.id = $1
        `, [newCat.id]);

        sendCreated(res, withPath.rows[0], 'Category created successfully');
    });
});

// ============================================================
// UPDATE CATEGORY (Admin only)
// PATCH /api/categories/:id
// ============================================================
const updateCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, abbreviation, description, is_active, tax_treatment } = req.body;

    await withTransaction(async (client) => {
        // v1.70.0 — '' or 'INHERIT' clears the category's own setting.
        if (tax_treatment !== undefined && await hasTaxTreatmentColumn()) {
            const value = TAX_TREATMENTS.includes(tax_treatment) ? tax_treatment : null;
            const before = await client.query(`SELECT tax_treatment, name FROM categories WHERE id = $1`, [id]);
            await client.query(`UPDATE categories SET tax_treatment = $1 WHERE id = $2`, [value, id]);
            if (before.rows.length && (before.rows[0].tax_treatment || null) !== value) {
                await logAction(req.user.id, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.SYSTEM, {
                    ipAddress: req.ip, recordType: 'categories', recordId: parseInt(id),
                    oldValues: { tax_treatment: before.rows[0].tax_treatment }, newValues: { tax_treatment: value },
                    description: `Category "${before.rows[0].name}" tax treatment: ${before.rows[0].tax_treatment || 'inherit'} -> ${value || 'inherit'}`,
                    client,
                });
            }
        }
        const result = await client.query(`
            UPDATE categories SET
                name         = COALESCE($1, name),
                abbreviation = COALESCE($2, abbreviation),
                description  = COALESCE($3, description),
                is_active    = COALESCE($4, is_active)
            WHERE id = $5
            RETURNING *
        `, [
            name?.trim() || null,
            abbreviation?.toUpperCase().trim() || null,
            description,
            is_active,
            id,
        ]);

        if (result.rows.length === 0) throw createError.notFound('Category not found');

        // Rebuild path if name or abbreviation changed
        await rebuildCategoryPath(client, parseInt(id));

        sendSuccess(res, result.rows[0], 'Category updated');
    });
});

// ============================================================
// ROUTES
// ============================================================
router.use(authenticate);
router.use(requireAssignedRole);
router.use(requireConsent);

router.get('/',    getAllCategories);

router.post('/',
    requirePermissions(['CATEGORY_MANAGE']),
    [
        body('module').isIn(['FINANCE','DOCUMENT','EVENT','INVESTMENT','GENERAL'])
            .withMessage('Module must be one of: FINANCE, DOCUMENT, EVENT, INVESTMENT, GENERAL'),
        body('name').trim().notEmpty().withMessage('Name is required'),
        body('abbreviation').trim().notEmpty().withMessage('Abbreviation is required')
            .isLength({ max: 20 }).withMessage('Abbreviation max 20 characters'),
        body('parent_id').optional().isInt({ min: 1 }),
        body('tax_treatment').optional({ values: 'falsy' }).isIn(TAX_TREATMENTS).withMessage('Invalid tax treatment'),
    ],
    validateRequest,
    createCategory
);

router.patch('/:id',
    requirePermissions(['CATEGORY_MANAGE']),
    [
        param('id').isInt({ min: 1 }),
        body('tax_treatment').optional({ values: 'null' }).isIn(['', 'INHERIT', ...TAX_TREATMENTS]).withMessage('Invalid tax treatment'),
    ],
    validateRequest,
    updateCategory
);

module.exports = router;
