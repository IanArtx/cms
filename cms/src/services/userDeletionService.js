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
//
// v1.87.0 — "some profiles refused to be deleted where an error 'something
// went wrong' appears and that profile stays in the system." The check
// used to fire ~270 COUNT queries at once; on the hosted database the
// 20-connection pool (2-second wait) ran out and the request failed with
// a 500. It is now ONE query. Keys that Postgres cascades or nulls by
// itself no longer block; more of the account's own bookkeeping is
// cleaned; a refusal names the records in plain words; a foreign-key
// refusal from Postgres comes back as a clear message, never a 500.
// ============================================================

const { query, withTransaction } = require('../config/database');
const { createError } = require('../utils/errors');
const { deleteObject, toKey } = require('./storageService');

// (table, column) pairs that are safe to auto-clean rather than
// block on. Everything else discovered via pg_constraint blocks.
// v1.87.0 — more of the account's own bookkeeping is cleaned: unfinished
// forms, its own email-change requests and its event reminders; an
// invitation it used keeps its record (who it was sent to, by whom) but
// no longer points at the removed account.
const AUTO_CLEAN_DELETE = [
    { table: 'notifications',         column: 'user_id' },
    { table: 'role_requests',         column: 'user_id' },
    { table: 'user_roles',            column: 'user_id' },
    { table: 'member_consents',       column: 'user_id' },
    { table: 'form_drafts',           column: 'user_id' },
    { table: 'email_change_requests', column: 'user_id' },
    { table: 'event_notifications',   column: 'user_id' },
];
const AUTO_CLEAN_NULL = [
    { table: 'audit_log',           column: 'user_id' },
    { table: 'account_invitations', column: 'used_by_user_id' },
];
// Rows that disappear with the account's own email-change requests do
// not count against it (the person asked for their own change).
const EXTRA_CONDITION = {
    'email_change_requests.requested_by': 'AND user_id IS DISTINCT FROM $1',
    'email_change_requests.cancelled_by': 'AND user_id IS DISTINCT FROM $1',
};
const isAllowlisted = (table, column) =>
    AUTO_CLEAN_DELETE.some(a => a.table === table && a.column === column) ||
    AUTO_CLEAN_NULL.some(a => a.table === table && a.column === column);

const quoteIdent = (x) => `"${String(x).replace(/"/g, '""')}"`;

// ============================================================
// Every FK constraint in the live schema that points at users(id),
// as (table, column) pairs — read fresh from Postgres' own catalog
// every time, so this can never drift from what the schema actually
// looks like. on_delete: 'a' no action, 'r' restrict, 'c' cascade,
// 'n' set null, 'd' set default. Cascade / set-null keys never block —
// Postgres tidies those itself.
// ============================================================
const getForeignKeysToUsers = async (runQuery) => {
    const result = await runQuery(`
        SELECT DISTINCT
            c.conrelid::regclass::text AS table_name,
            a.attname                  AS column_name,
            c.confdeltype::text        AS on_delete
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
// THE CHECK — ONE statement (v1.87.0)
// Before v1.87.0 this fired one COUNT per foreign key (about 270) all at
// once. The connection pool holds 20 connections and waits at most 2
// seconds for one, so on the hosted database many of those queries timed
// out and the page showed "Something went wrong" — the account stayed.
// Now every check runs inside a single query on one connection.
// ============================================================
const footprintSql = (fks) => {
    const parts = fks
        .filter(fk => !isAllowlisted(fk.table_name, fk.column_name) && !['c', 'n'].includes(fk.on_delete))
        .map(fk => {
            const extra = EXTRA_CONDITION[`${fk.table_name}.${fk.column_name}`] || '';
            const lit = (x) => `'${String(x).replace(/'/g, "''")}'`;
            // table_name comes from regclass::text, so it is already quoted where needed
            return `SELECT ${lit(fk.table_name)} AS table_name, ${lit(fk.column_name)} AS column_name,
                       (SELECT COUNT(*) FROM ${fk.table_name} WHERE ${quoteIdent(fk.column_name)} = $1 ${extra})::int AS count`;
        });
    if (!parts.length) return null;
    return `SELECT * FROM (${parts.join('\n UNION ALL ')}) x WHERE x.count > 0 ORDER BY x.table_name, x.column_name`;
};

const footprintWith = async (runQuery, userId) => {
    const sql = footprintSql(await getForeignKeysToUsers((s) => runQuery(s)));
    if (!sql) return { clean: true, blocking: [] };
    const r = await runQuery(sql, [userId]);
    const blocking = r.rows.map(x => ({ table: x.table_name, column: x.column_name, count: x.count }));
    return { clean: blocking.length === 0, blocking };
};

// Plain-words names for the places an account most often has records,
// so the message says "it approved payments" instead of a table name.
const FRIENDLY = {
    transactions: 'transactions', contributions: 'contributions', documents: 'documents',
    requisitions: 'requisitions', meeting_attendance: 'meeting registers', account_invitations: 'invitations it sent',
    users: 'other accounts (created, approved or declined by it)', share_allotments: 'shares',
};
const describeBlocking = (blocking) => {
    const names = [...new Set(blocking.map(b => FRIENDLY[b.table] || b.table.replace(/_/g, ' ')))];
    return names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
};

// ============================================================
// GET USER FOOTPRINT
// Returns { clean: boolean, blocking: [{ table, column, count }] } —
// blocking is empty when the account can be safely hard-deleted.
// ============================================================
const getUserFootprint = async (userId) => footprintWith((sql, params) => query(sql, params), userId);

// ============================================================
// HARD DELETE USER
// Re-checks the footprint inside the same transaction as the delete
// (a fresh contribution/role-assignment could theoretically land in
// the gap between an admin viewing the check and clicking confirm),
// then removes the account entirely.
// ============================================================
const hardDeleteUser = async (userId) => {
    try {
        return await withTransaction(async (client) => {
            const fp = await footprintWith((sql, params) => client.query(sql, params), userId);
            if (!fp.clean) {
                const e = createError.badRequest(
                    `Cannot delete — this account has records in: ${describeBlocking(fp.blocking)}. ` +
                    `Use Decline access or Deactivate instead — it keeps the history and the person can no longer sign in.`
                );
                e.blocking = fp.blocking;
                throw e;
            }

            const userResult = await client.query(
                `SELECT email, first_name, last_name, photo_path, signature_path FROM users WHERE id = $1 FOR UPDATE`,
                [userId]
            );
            if (userResult.rows.length === 0) {
                throw createError.notFound('User not found');
            }
            const user = userResult.rows[0];

            // Auto-clean the allowlisted bookkeeping (a table missing on an
            // older database is skipped)
            const present = async (table) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])).rows[0].ok;
            for (const a of AUTO_CLEAN_DELETE) {
                if (await present(a.table)) await client.query(`DELETE FROM ${a.table} WHERE ${quoteIdent(a.column)} = $1`, [userId]);
            }
            for (const a of AUTO_CLEAN_NULL) {
                if (await present(a.table)) await client.query(`UPDATE ${a.table} SET ${quoteIdent(a.column)} = NULL WHERE ${quoteIdent(a.column)} = $1`, [userId]);
            }

            await client.query('DELETE FROM users WHERE id = $1', [userId]);

            return {
                email: user.email,
                name:  `${user.first_name} ${user.last_name}`,
                files: [user.photo_path, user.signature_path].filter(Boolean),
            };
        }).then(async (out) => {
            // Best-effort, after the commit — an orphaned file in storage is
            // a much smaller problem than blocking the delete over it.
            for (const path of out.files) {
                try { await deleteObject(toKey(path)); } catch { /* ignore */ }
            }
            return { email: out.email, name: out.name };
        });
    } catch (err) {
        // A link the check did not know about (Postgres refused the delete):
        // say so plainly instead of "Something went wrong".
        if (err && err.code === '23503') {
            throw createError.badRequest(
                `Cannot delete — this account is still linked to ${String(err.table || 'another record').replace(/_/g, ' ')}. ` +
                `Use Decline access or Deactivate instead.`
            );
        }
        throw err;
    }
};

module.exports = {
    getUserFootprint,
    hardDeleteUser,
    describeBlocking,
};
