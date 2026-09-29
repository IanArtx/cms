// ============================================================
// APPROVAL GUARD (v1.72.0) — "four eyes" rule
//
// Requested directly: "activities can't be both created and at the
// same time approved by the same person (exception to the admin)".
//
// Every approval step calls one of these before doing anything:
//   • assertNotOwnApproval(req, [userIds…], label)
//       — refuses when the approver is one of the listed people
//   • assertNotOwnRecord(req, client, table, id, columns, label)
//       — looks those people up on the record first
//
// Who counts as "the same person": whoever CREATED / REQUESTED /
// RECORDED the item and, for money paid to or for a member, the
// member it BENEFITS (e.g. a Treasurer's own savings deposit, pledge
// payment, service-fee request or share-credit refund). Nobody approves
// money going to themselves.
//
// The one exception is the Admin role — an Admin may approve their own
// item (e.g. when they are the only person who could). Every approval
// is still written to the audit log with who created and who approved.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');

const isAdmin = (req) => (req.user?.roles || []).includes('Admin');

const assertNotOwnApproval = (req, userIds, label = 'item') => {
    if (isAdmin(req)) return;
    const me = req.user?.id;
    const ids = (userIds || []).filter(x => x !== null && x !== undefined).map(Number);
    if (ids.includes(Number(me))) {
        throw createError.forbidden(
            `You created or benefit from this ${label}, so someone else must approve it. ` +
            '(Only an Admin can approve their own items.)');
    }
};

// Tables and columns are fixed strings chosen in code (never from the
// request), so building them into the SQL is safe.
const assertNotOwnRecord = async (req, client, table, id, columns, label = 'item') => {
    if (isAdmin(req)) return;
    const runner = client || { query };
    const cols = columns.join(', ');
    const r = await runner.query(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id]);
    if (!r.rows.length) return; // the handler reports "not found" itself
    assertNotOwnApproval(req, columns.map(c => r.rows[0][c]), label);
};

module.exports = { assertNotOwnApproval, assertNotOwnRecord, isAdmin };
