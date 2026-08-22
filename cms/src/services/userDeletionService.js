// ============================================================
// USER DELETION SERVICE (v1.35.0)
// Permanently removes a user record — for exactly one situation:
// someone registered more than once (usually with a different email
// each time out of confusion) and the extra account was never
// actually used for anything. This is NOT a replacement for
// deactivateUser() (usersController.js) — that stays the correct,
// safe, reversible tool for every other "this member shouldn't have
// access anymore" situation. This module only ever removes an
// account that has done, and been part of, absolutely nothing.
//
// WHY THIS CAN'T JUST BE "DELETE FROM users WHERE id = $1":
// Virtually every table in this schema has a foreign key back to
// users(id) — contributions, transactions, dividends, savings, side
// fund activity, documents, audit_log, and dozens more. A user who
// has ever contributed, been assigned a role and logged in, approved
// something, or even just shown up as the "recorded by"/"approved
// by" on someone else's record cannot be safely deleted — Postgres
// would reject it outright once contype='f' constraints are hit, and
// forcing it through by cascading would mean erasing real financial
// or governance history, which this system never does anywhere else
// (see audit_log's own "append-only, never deleted" design, Section
// 25.2 CMS_BIBLE.md).
//
// HOW THE SAFETY CHECK WORKS: rather than hand-maintain a list of
// "every table that might reference a user" (this schema has ~90
// such FK columns across ~60 tables, and that list would silently
// go stale the next time a table is added), getUserFootprint()
// reads Postgres' own catalog (pg_constraint) for every foreign key
// that points at users(id), then checks each one for rows matching
// this user. This stays correct automatically as the schema grows —
// nothing here needs updating when a new table with a users(id) FK
// is added later.
//
// THE ONE EXCEPTION — a small, explicit allowlist of purely
// self-contained bookkeeping that a genuinely unused account can
// still have picked up along the way (a role request, a role
// assignment that was never really exercised, their own bell
// notifications, agreeing to the membership agreement) — none of
// these have any effect on anyone else or on company finances, so
// they're cleaned up automatically as part of the delete rather than
// blocking it. audit_log is the one table in the allowlist that is
// NOT deleted — its rows are preserved and just have user_id set to
// NULL, honouring the "never deleted" rule while still letting the
// FK go away.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const { deleteObject, toKey } = require('./storageService');

// (table, column) pairs that are safe to auto-clean rather than
// block on. Everything else discovered via pg_constraint blocks.
const AUTO_CLEAN_DELETE = [
    { table: 'notifications',   column: 'user_id' },
    { table: 'role_requests',   column: 'user_id' },
    { table: 'user_roles',      column: 'user_id' },
    { table: 'member_consents', column: 'user_id' },
];
const AUTO_CLEAN_NULL = [
    { table: 'audit_log', column: 'user_id' },
];
const isAllowlisted = (table, column) =>
    AUTO_CLEAN_DELETE.some(a => a.table === table && a.column === column) ||
    AUTO_CLEAN_NULL.some(a => a.table === table && a.column === column);

// ============================================================
// Every FK constraint in the live schema that points at users(id),
// as (table, column) pairs — read fresh from Postgres' own catalog
// every time, so this can never drift from what the schema actually
// looks like.
// ============================================================
const getForeignKeysToUsers = async (runQuery) => {
    const result = await runQuery(`
        SELECT
            c.conrelid::regclass::text AS table_name,
            a.attname                  AS column_name
        FROM   pg_constraint c
        JOIN   LATERAL unnest(c.conkey) WITH ORDINALITY AS ck(attnum, ord) ON TRUE
        JOIN   pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck.attnum
        WHERE  c.confrelid = 'users'::regclass
        AND    c.contype   = 'f'
        -- the FK column set on the users table pointing at itself
        -- (users.created_by) is included deliberately — someone else's
        -- account having been created BY the user we're checking is
        -- exactly the kind of real activity that should block deletion.
        ORDER  BY table_name, column_name
    `);
    return result.rows;
};

// ============================================================
// GET USER FOOTPRINT
// Returns { clean: boolean, blocking: [{ table, column, count }] } —
// blocking is empty when the account can be safely hard-deleted.
// ============================================================
const getUserFootprint = async (userId) => {
    const fks = await getForeignKeysToUsers((sql) => query(sql));

    const checks = fks
        .filter(fk => !isAllowlisted(fk.table_name, fk.column_name))
        .map(async (fk) => {
            const result = await query(
                `SELECT COUNT(*) AS count FROM ${fk.table_name} WHERE ${fk.column_name} = $1`,
                [userId]
            );
            return {
                table:  fk.table_name,
                column: fk.column_name,
                count:  parseInt(result.rows[0].count, 10),
            };
        });

    const results = await Promise.all(checks);
    const blocking = results.filter(r => r.count > 0);

    return { clean: blocking.length === 0, blocking };
};

// ============================================================
// HARD DELETE USER
// Re-checks the footprint inside the same transaction as the delete
// (a fresh contribution/role-assignment could theoretically land in
// the gap between an admin viewing the check and clicking confirm),
// then removes the account entirely.
// ============================================================
const hardDeleteUser = async (userId) => {
    return withTransaction(async (client) => {
        const fks = await getForeignKeysToUsers((sql) => client.query(sql));
        const blockingChecks = fks.filter(fk => !isAllowlisted(fk.table_name, fk.column_name));

        for (const fk of blockingChecks) {
            const result = await client.query(
                `SELECT COUNT(*) AS count FROM ${fk.table_name} WHERE ${fk.column_name} = $1`,
                [userId]
            );
            if (parseInt(result.rows[0].count, 10) > 0) {
                throw createError.badRequest(
                    `Cannot delete — this account has activity in ${fk.table_name}.${fk.column_name}. ` +
                    `Use Deactivate instead.`
                );
            }
        }

        const userResult = await client.query(
            `SELECT email, first_name, last_name, photo_path, signature_path FROM users WHERE id = $1`,
            [userId]
        );
        if (userResult.rows.length === 0) {
            throw createError.notFound('User not found');
        }
        const user = userResult.rows[0];

        // Auto-clean the allowlisted bookkeeping
        for (const a of AUTO_CLEAN_DELETE) {
            await client.query(`DELETE FROM ${a.table} WHERE ${a.column} = $1`, [userId]);
        }
        for (const a of AUTO_CLEAN_NULL) {
            await client.query(`UPDATE ${a.table} SET ${a.column} = NULL WHERE ${a.column} = $1`, [userId]);
        }

        await client.query('DELETE FROM users WHERE id = $1', [userId]);

        // Best-effort — an orphaned file in storage is a much smaller
        // problem than blocking the delete over it.
        for (const path of [user.photo_path, user.signature_path]) {
            if (!path) continue;
            try {
                await deleteObject(toKey(path));
            } catch {
                // ignore — cleanup is best-effort
            }
        }

        return {
            email: user.email,
            name:  `${user.first_name} ${user.last_name}`,
        };
    });
};

module.exports = {
    getUserFootprint,
    hardDeleteUser,
};
