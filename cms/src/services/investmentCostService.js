// ============================================================
// INVESTMENT COST SERVICE (v1.80.0) — what money spent on an
// investment was FOR.
//
// Requested: "money used to buy or sustain or operate an investment is
// well categorised". Confirmed: buying / expanding = asset (adds to the
// investment's cost); running and maintenance = expenses of that
// investment. New entries only — older ones are listed on the
// investment page to be classified one by one.
//
//   CAPITAL      buying the investment or adding to it (land, building,
//                equipment, stock of birds …) → ledger 1400 (asset)
//   OPERATING    running it (feed, wages, fuel, utilities, transport …)
//                → ledger 5150 Investment Operating Costs (expense)
//   MAINTENANCE  repairs and upkeep that keep it running without adding
//                to it → ledger 5160 Investment Maintenance Costs (expense)
//
// Stored on transactions.investment_cost_type. NULL = recorded before
// v1.80.0 → still treated as capital (1400), exactly as before, until
// someone classifies it. A reversal follows the entry it reverses.
//
// Each type also has its own category trail, created the first time it
// is needed:
//   Expense › Investments › Purchase & expansion | Operating costs |
//                           Maintenance & repairs
// ============================================================

const { createError } = require('../utils/errors');
const { rebuildCategoryPath } = require('./categoryService');

const COST_TYPES = ['CAPITAL', 'OPERATING', 'MAINTENANCE'];
const COST_TYPE_LABEL = {
    CAPITAL: 'Buying / expanding (asset)',
    OPERATING: 'Running costs (expense)',
    MAINTENANCE: 'Maintenance & repairs (expense)',
};
const COST_TYPE_GL = { CAPITAL: '1400', OPERATING: '5150', MAINTENANCE: '5160' };
const CATEGORY = {
    CAPITAL: { name: 'Purchase & expansion', abbreviation: 'INV-CAP', description: 'Buying an investment or adding to it — capital, kept as part of the investment\'s cost (v1.80.0).' },
    OPERATING: { name: 'Operating costs', abbreviation: 'INV-OPR', description: 'Running an investment — feed, wages, fuel, utilities, transport … (v1.80.0).' },
    MAINTENANCE: { name: 'Maintenance & repairs', abbreviation: 'INV-MNT', description: 'Repairs and upkeep that keep an investment running (v1.80.0).' },
};

// ---- is the v1.80.0 column there? (cached once true) ------------------
let ready = false;
const costTypeReady = async (db) => {
    if (ready) return true;
    const r = await db.query(`SELECT 1 FROM information_schema.columns
                              WHERE table_name = 'transactions' AND column_name = 'investment_cost_type'`);
    ready = r.rows.length > 0;
    return ready;
};

const assertCostType = (t, { required = false } = {}) => {
    if (t === undefined || t === null || t === '') {
        if (required) throw createError.badRequest('Choose what the money is for: buying / expanding the investment, running it, or maintenance and repairs.');
        return null;
    }
    if (!COST_TYPES.includes(t)) throw createError.badRequest('The purpose must be CAPITAL (buying / expanding), OPERATING (running) or MAINTENANCE (repairs).');
    return t;
};

const setCostType = async (client, transactionId, costType) => {
    if (!costType || !(await costTypeReady(client))) return;
    await client.query('UPDATE transactions SET investment_cost_type = $1 WHERE id = $2', [costType, transactionId]);
};

// Find a category by name (case-insensitive) under a parent, or create it.
const findOrCreate = async (client, { parentId, name, abbreviation, description, userId }) => {
    const r = await client.query(`
        SELECT id FROM categories
        WHERE  module = 'FINANCE' AND lower(name) = lower($1)
        AND    ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}
        ORDER  BY id LIMIT 1`, parentId ? [name, parentId] : [name]);
    if (r.rows.length) return r.rows[0].id;
    const ins = await client.query(`
        INSERT INTO categories (parent_id, module, name, abbreviation, description, is_active, created_by)
        VALUES ($1, 'FINANCE', $2, $3, $4, TRUE, $5) RETURNING id`,
    [parentId || null, name, abbreviation, description || null, userId || null]);
    await rebuildCategoryPath(client, ins.rows[0].id);
    return ins.rows[0].id;
};

// Expense › Investments › <purpose>
const purposeCategory = async (client, costType, userId) => {
    if (!CATEGORY[costType]) return null;
    // The company's own "Expense" root, whatever its exact spelling.
    const root = await client.query(`
        SELECT id FROM categories
        WHERE  module = 'FINANCE' AND parent_id IS NULL AND lower(name) IN ('expense', 'expenses')
        ORDER  BY id LIMIT 1`);
    const rootId = root.rows.length ? root.rows[0].id
        : await findOrCreate(client, { name: 'Expense', abbreviation: 'EXP', description: 'Money spent', userId });
    const invId = await findOrCreate(client, {
        parentId: rootId, name: 'Investments', abbreviation: 'INVX',
        description: 'Money spent on the company\'s investments, by purpose (v1.80.0).', userId,
    });
    return findOrCreate(client, { parentId: invId, ...CATEGORY[costType], userId });
};

module.exports = {
    COST_TYPES, COST_TYPE_LABEL, COST_TYPE_GL,
    costTypeReady, assertCostType, setCostType, purposeCategory,
};
