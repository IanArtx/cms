// ============================================================
// CATEGORY SERVICE (v1.37.0)
// One small shared helper — get-or-create a top-level category by
// (module, name) — used by finesService.js and depositService.js so
// their crediting flows only ever need a date and description, without
// forcing an Admin to pre-configure a category in Settings > Categories
// before either feature can be used for the first time. Every OTHER
// category-driven flow in this system still requires the caller to
// pick an existing category explicitly — this is deliberately narrow,
// just for these two system-managed categories.
//
// rebuildCategoryPath is duplicated from categories.js rather than
// imported — that file doesn't export it, and this is a small, stable
// recursive-CTE query unlikely to drift from the original.
// ============================================================
const rebuildCategoryPath = async (client, categoryId) => {
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
// GET (OR CREATE) A TOP-LEVEL CATEGORY BY (module, name)
// Must be called from inside an existing withTransaction block —
// creation locks nothing itself, but the row it inserts should live
// or die with whatever caller transaction is crediting money against
// it (consistent with every other get-or-create helper in this system,
// e.g. savingsService.getOrCreateSavingsBalance).
// ============================================================
const getOrCreateCategory = async (client, { module, name, abbreviation, description, createdBy }) => {
    const existing = await client.query(
        `SELECT id FROM categories WHERE module = $1 AND name = $2 AND parent_id IS NULL LIMIT 1`,
        [module, name]
    );
    if (existing.rows.length > 0) return existing.rows[0].id;

    const created = await client.query(`
        INSERT INTO categories (module, name, abbreviation, description, is_active, created_by)
        VALUES ($1, $2, $3, $4, TRUE, $5)
        RETURNING id
    `, [module, name, abbreviation, description || null, createdBy || null]);

    const categoryId = created.rows[0].id;
    await rebuildCategoryPath(client, categoryId);
    return categoryId;
};

module.exports = { getOrCreateCategory };
