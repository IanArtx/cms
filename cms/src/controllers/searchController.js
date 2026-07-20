// ============================================================
// GLOBAL SEARCH CONTROLLER
// Powers the topbar search — one query fanned out across a few
// key modules, respecting the same view permissions those
// modules already enforce on their own list pages. Each category
// is skipped entirely (not just filtered) if the requester lacks
// the permission to view that module at all.
// ============================================================

const { query } = require('../config/database');
const { asyncHandler, createError } = require('../utils/errors');
const { sendSuccess } = require('../utils/response');

// ============================================================
// GLOBAL SEARCH
// GET /api/search?q=...
// Returns { members, transactions, documents, investments, events }
// — each an array (possibly empty), capped at 5 results per
// category so the dropdown stays compact.
// ============================================================
const globalSearch = asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
        throw createError.badRequest('Search term must be at least 2 characters');
    }
    const like = `%${q}%`;
    const perms = req.user.permissions || [];
    const has = (p) => perms.includes(p);

    const results = { members: [], transactions: [], documents: [], investments: [], events: [] };

    // Members — basic directory info, open to any authenticated user
    const membersResult = await query(`
        SELECT id, first_name, last_name, email
        FROM   users
        WHERE  is_active = TRUE
        AND    (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1
                OR (first_name || ' ' || last_name) ILIKE $1)
        ORDER  BY first_name
        LIMIT  5
    `, [like]);
    results.members = membersResult.rows.map(u => ({
        type:     'member',
        id:       u.id,
        label:    `${u.first_name} ${u.last_name}`,
        subtitle: u.email,
        link:     `/users`,
    }));

    // Transactions — by reference code or description
    if (has('FINANCE_VIEW_ALL')) {
        const txResult = await query(`
            SELECT t.id, r.reference_code, t.description, t.amount, t.transaction_date
            FROM   transactions t
            JOIN   references_registry r ON r.id = t.reference_id
            WHERE  r.reference_code ILIKE $1 OR r.public_id ILIKE $1 OR t.description ILIKE $1
            ORDER  BY t.transaction_date DESC
            LIMIT  5
        `, [like]);
        results.transactions = txResult.rows.map(t => ({
            type:     'transaction',
            id:       t.id,
            label:    t.reference_code,
            subtitle: t.description,
            link:     `/transactions`,
        }));
    }

    // Documents — by title, reference code, or public ID
    if (has('DOCUMENT_VIEW')) {
        const docResult = await query(`
            SELECT d.id, d.title, d.document_type
            FROM   documents d
            JOIN   references_registry r ON r.id = d.reference_id
            WHERE  (d.title ILIKE $1 OR r.reference_code ILIKE $1 OR r.public_id ILIKE $1)
            AND    d.status != 'SUPERSEDED'
            ORDER  BY d.created_at DESC
            LIMIT  5
        `, [like]);
        results.documents = docResult.rows.map(d => ({
            type:     'document',
            id:       d.id,
            label:    d.title,
            subtitle: d.document_type?.replace(/_/g, ' '),
            link:     `/documents`,
        }));
    }

    // Investments — by name
    if (has('INVESTMENT_VIEW')) {
        const invResult = await query(`
            SELECT i.id, i.name, r.reference_code
            FROM   investments i
            JOIN   references_registry r ON r.id = i.reference_id
            WHERE  i.name ILIKE $1 OR r.reference_code ILIKE $1 OR r.public_id ILIKE $1
            ORDER  BY i.created_at DESC
            LIMIT  5
        `, [like]);
        results.investments = invResult.rows.map(i => ({
            type:     'investment',
            id:       i.id,
            label:    i.name,
            subtitle: i.reference_code,
            link:     `/investments/${i.id}`,
        }));
    }

    // Events — by title
    const evResult = await query(`
        SELECT id, title, event_date
        FROM   events
        WHERE  title ILIKE $1
        ORDER  BY event_date DESC
        LIMIT  5
    `, [like]);
    results.events = evResult.rows.map(e => ({
        type:     'event',
        id:       e.id,
        label:    e.title,
        subtitle: e.event_date,
        link:     `/events`,
    }));

    sendSuccess(res, results);
});

module.exports = { globalSearch };
