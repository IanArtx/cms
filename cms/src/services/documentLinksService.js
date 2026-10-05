// ============================================================
// TRANSACTION ↔ DOCUMENT LINKS (v1.78.0)
//
// Requested directly: "transactions can be connected to a specific
// document at the point of entry or later. a transaction can be
// connected to more than one document and vice versa but after one,
// the system shows alert that the transaction is already connected.
// documents should show connected transactions and the other way round
// including count. Connecting transactions shouldn't be mandatory. the
// transaction connected shows the reference of the connected
// document(s) on the printable version of the transaction".
//
// Table transaction_document_links (migration_v1.78.0.sql): one LIVE
// row per (transaction, document) pair; removing a link stamps
// removed_at/removed_by (history kept), and the pair can be linked again.
//
// THE "ALREADY CONNECTED" ALERT is enforced here, not only in the
// screen: linking LATER to a transaction (or document) that already has
// a live link answers 409 ALREADY_CONNECTED, listing what it is
// connected to, unless the request says confirm_additional: true (the
// screen asks the person first). Links made AT ENTRY (the form the
// transaction is recorded with) never trigger it — a new transaction
// has nothing connected yet.
//
// Every link and unlink is written to the audit log.
//
// Works before the migration has run (code deployed first): every
// read answers "no links" and every write explains the migration is
// missing — nothing else breaks.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const { logAction, ACTIONS, MODULES } = require('./auditService');
const postingTracker = require('./postingTracker');

// ---- is the table there? (cached once found) ------------------------
let ready = false;
let checkedAt = 0;
const linksReady = async (client = null) => {
    if (ready) return true;
    if (Date.now() - checkedAt < 30000) return false;
    checkedAt = Date.now();
    const run = client ? (t) => client.query(t) : (t) => query(t);
    const r = await run(`SELECT to_regclass('public.transaction_document_links') IS NOT NULL AS ok`);
    ready = !!r.rows[0].ok;
    return ready;
};
const assertReady = async (client) => {
    if (!(await linksReady(client))) {
        throw createError.badRequest('Connecting documents needs the v1.78.0 database update (migration_v1.78.0.sql) — ask the Admin to run it.');
    }
};

// SQL fragments for list queries — a live-link count, or 0 before the migration.
const transactionCountSql = async (alias = 't') => (await linksReady())
    ? `(SELECT COUNT(*)::int FROM transaction_document_links l WHERE l.transaction_id = ${alias}.id AND l.removed_at IS NULL)`
    : '0';
// The connected documents' references, joined with ", " (for print-outs).
const transactionRefsSql = async (alias = 't') => (await linksReady())
    ? `(SELECT string_agg(drr.reference_code, ', ' ORDER BY l.linked_at, l.id)
         FROM transaction_document_links l
         JOIN documents dd ON dd.id = l.document_id
         JOIN references_registry drr ON drr.id = dd.reference_id
        WHERE l.transaction_id = ${alias}.id AND l.removed_at IS NULL)`
    : 'NULL';
const documentCountSql = async (alias = 'd') => (await linksReady())
    ? `(SELECT COUNT(*)::int FROM transaction_document_links l WHERE l.document_id = ${alias}.id AND l.removed_at IS NULL)`
    : '0';

const TREASURY_ROLES = ['Treasurer', 'Assistant Treasurer', 'Admin'];
// Seeing transaction details = the same permission the Transactions
// page itself needs (a Shareholder holds a "financial" role but may not
// browse other members' transactions).
const hasFinancialAccess = (user) => (user.permissions || []).includes('FINANCE_VIEW_ALL');

// A document reached through /documents/:id/transactions must be one
// this person may see: a personal document only for its owner and
// Treasury; a deleted one for nobody.
const assertCanSeeDocument = async (user, documentId) => {
    const r = await query('SELECT id, owner_user_id, status FROM documents WHERE id = $1', [documentId]);
    if (!r.rows.length || r.rows[0].status === 'DELETED') throw createError.notFound('Document not found');
    if (!canOpen(user, r.rows[0])) throw createError.forbidden('This is a personal document. Only its owner and Treasury can open it.');
};

// Can this person open this document? (same rules as the Documents page:
// a personal document only for its owner and Treasury; a financial
// document not for finance-restricted staff without a grant — those
// staff can't reach transactions anyway, so that case is simply "no").
const canOpen = (user, doc) => {
    if (doc.status === 'DELETED') return false;
    if (doc.owner_user_id !== null && doc.owner_user_id !== undefined) {
        return doc.owner_user_id === user.id || (user.roles || []).some(r => TREASURY_ROLES.includes(r));
    }
    return true;
};

// ---- reads -------------------------------------------------------------
const listDocumentsForTransaction = async (transactionId, user) => {
    if (!(await linksReady())) return [];
    const r = await query(`
        SELECT l.id AS link_id, l.linked_at, l.linked_via, l.note,
               lu.first_name || ' ' || lu.last_name AS linked_by_name,
               d.id AS document_id, d.title, d.document_type, d.status, d.source, d.file_name,
               d.owner_user_id, d.created_at AS document_created_at,
               rr.reference_code, rr.public_id,
               cp.full_path AS category_trail
        FROM   transaction_document_links l
        JOIN   documents d            ON d.id = l.document_id
        JOIN   references_registry rr ON rr.id = d.reference_id
        LEFT JOIN category_paths cp   ON cp.category_id = d.category_id
        JOIN   users lu               ON lu.id = l.linked_by
        WHERE  l.transaction_id = $1 AND l.removed_at IS NULL
        ORDER  BY l.linked_at, l.id
    `, [transactionId]);
    return r.rows.map(row => {
        const open = canOpen(user, row);
        return {
            ...row,
            can_open: open,
            // Someone who may not open a personal document still sees that a
            // document is connected, and its reference — not its title.
            title: open ? row.title : 'Personal document',
            owner_user_id: undefined,
        };
    });
};

const listTransactionsForDocument = async (documentId, user) => {
    if (!(await linksReady())) return { count: 0, transactions: [] };
    const r = await query(`
        SELECT l.id AS link_id, l.linked_at, l.linked_via, l.note,
               lu.first_name || ' ' || lu.last_name AS linked_by_name,
               t.id AS transaction_id, t.transaction_type, t.inflow_type, t.amount, t.value_date,
               t.description, t.status, t.is_reversal, t.is_reversed,
               rr.reference_code, rr.public_id,
               c.code AS currency_code, a.name AS account_name
        FROM   transaction_document_links l
        JOIN   transactions t         ON t.id = l.transaction_id
        JOIN   references_registry rr ON rr.id = t.reference_id
        JOIN   currencies c           ON c.id = t.currency_id
        JOIN   accounts a             ON a.id = t.account_id
        JOIN   users lu               ON lu.id = l.linked_by
        WHERE  l.document_id = $1 AND l.removed_at IS NULL
        ORDER  BY t.value_date, t.id
    `, [documentId]);
    // Financial detail only for people allowed to see company finances;
    // everyone else sees how many transactions are connected.
    if (!hasFinancialAccess(user)) return { count: r.rows.length, transactions: [], restricted: true };
    return { count: r.rows.length, transactions: r.rows };
};

// Reference codes of the documents connected to each of these
// transactions — for lists and the printable transaction.
const documentRefsForTransactions = async (transactionIds) => {
    const out = {};
    if (!transactionIds.length || !(await linksReady())) return out;
    const r = await query(`
        SELECT l.transaction_id, rr.reference_code, d.title, d.owner_user_id
        FROM   transaction_document_links l
        JOIN   documents d            ON d.id = l.document_id
        JOIN   references_registry rr ON rr.id = d.reference_id
        WHERE  l.transaction_id = ANY($1::int[]) AND l.removed_at IS NULL
        ORDER  BY l.linked_at, l.id
    `, [transactionIds]);
    for (const row of r.rows) {
        (out[row.transaction_id] = out[row.transaction_id] || []).push(row.reference_code);
    }
    return out;
};

// ---- writes ------------------------------------------------------------
const loadTransactions = async (client, ids) => {
    const r = await client.query(`
        SELECT t.id, rr.reference_code FROM transactions t
        JOIN references_registry rr ON rr.id = t.reference_id
        WHERE t.id = ANY($1::int[])`, [ids]);
    if (r.rows.length !== new Set(ids).size) throw createError.notFound('One of the transactions was not found.');
    return r.rows;
};
const loadDocuments = async (client, ids) => {
    const r = await client.query(`
        SELECT d.id, d.status, d.title, rr.reference_code FROM documents d
        JOIN references_registry rr ON rr.id = d.reference_id
        WHERE d.id = ANY($1::int[])`, [ids]);
    if (r.rows.length !== new Set(ids).size) throw createError.notFound('One of the documents was not found.');
    const deleted = r.rows.find(d => d.status === 'DELETED');
    if (deleted) throw createError.badRequest(`${deleted.reference_code} has been deleted and can't be connected.`);
    return r.rows;
};

const cleanIds = (v) => {
    const arr = Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]);
    const ids = arr.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0);
    return [...new Set(ids)];
};

// Connect every document in documentIds to every transaction in
// transactionIds. `via` = 'AT_ENTRY' | 'LATER'. Returns { created, skipped }.
const link = async (client, { transactionIds, documentIds, userId, via = 'LATER', confirmAdditional = false, note = null, ipAddress = null }) => {
    const txIds = cleanIds(transactionIds);
    const docIds = cleanIds(documentIds);
    if (!txIds.length || !docIds.length) return { created: 0, skipped: 0 };
    await assertReady(client);
    const txs = await loadTransactions(client, txIds);
    const docs = await loadDocuments(client, docIds);

    // The alert: something being linked already has another live link.
    if (via !== 'AT_ENTRY' && !confirmAdditional) {
        const existing = await client.query(`
            SELECT l.transaction_id, l.document_id, trr.reference_code AS transaction_reference, drr.reference_code AS document_reference
            FROM   transaction_document_links l
            JOIN   transactions t ON t.id = l.transaction_id JOIN references_registry trr ON trr.id = t.reference_id
            JOIN   documents d    ON d.id = l.document_id    JOIN references_registry drr ON drr.id = d.reference_id
            WHERE  l.removed_at IS NULL
            AND    (l.transaction_id = ANY($1::int[]) OR l.document_id = ANY($2::int[]))
            AND    NOT (l.transaction_id = ANY($1::int[]) AND l.document_id = ANY($2::int[]))
        `, [txIds, docIds]);
        if (existing.rows.length) {
            const txAlready = {};
            const docAlready = {};
            for (const e of existing.rows) {
                if (txIds.includes(e.transaction_id)) (txAlready[e.transaction_reference] = txAlready[e.transaction_reference] || new Set()).add(e.document_reference);
                if (docIds.includes(e.document_id)) (docAlready[e.document_reference] = docAlready[e.document_reference] || new Set()).add(e.transaction_reference);
            }
            const parts = [
                ...Object.entries(txAlready).map(([t, ds]) => `Transaction ${t} is already connected to ${[...ds].join(', ')}.`),
                ...Object.entries(docAlready).map(([d, ts]) => `Document ${d} is already connected to ${[...ts].join(', ')}.`),
            ];
            const err = createError.conflict(`${parts.join(' ')} Connect anyway?`);
            err.error = 'ALREADY_CONNECTED';
            err.details = {
                transactions: Object.fromEntries(Object.entries(txAlready).map(([k, v]) => [k, [...v]])),
                documents: Object.fromEntries(Object.entries(docAlready).map(([k, v]) => [k, [...v]])),
            };
            throw err;
        }
    }

    let created = 0;
    let skipped = 0;
    for (const t of txs) {
        for (const d of docs) {
            const r = await client.query(`
                INSERT INTO transaction_document_links (transaction_id, document_id, note, linked_by, linked_via)
                SELECT $1, $2, $3, $4, $5
                WHERE NOT EXISTS (SELECT 1 FROM transaction_document_links
                                  WHERE transaction_id = $1 AND document_id = $2 AND removed_at IS NULL)
                RETURNING id
            `, [t.id, d.id, note || null, userId, via]);
            if (r.rows.length) {
                created++;
                await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
                    ipAddress, recordType: 'transaction_document_links', recordId: r.rows[0].id,
                    newValues: { transaction: t.reference_code, document: d.reference_code, via },
                    description: `Transaction ${t.reference_code} connected to document ${d.reference_code}${via === 'AT_ENTRY' ? ' (when it was recorded)' : ''}`,
                    client,
                }).catch(() => {});
            } else {
                skipped++;
            }
        }
    }
    return { created, skipped };
};

const unlink = async (client, { transactionId, documentId, userId, ipAddress = null }) => {
    await assertReady(client);
    const r = await client.query(`
        UPDATE transaction_document_links SET removed_at = NOW(), removed_by = $3
        WHERE  transaction_id = $1 AND document_id = $2 AND removed_at IS NULL
        RETURNING id
    `, [transactionId, documentId, userId]);
    if (!r.rows.length) throw createError.notFound('These two are not connected.');
    const refs = await client.query(`
        SELECT (SELECT rr.reference_code FROM transactions t JOIN references_registry rr ON rr.id = t.reference_id WHERE t.id = $1) AS tx,
               (SELECT rr.reference_code FROM documents d JOIN references_registry rr ON rr.id = d.reference_id WHERE d.id = $2) AS doc
    `, [transactionId, documentId]);
    await logAction(userId, ACTIONS.SYSTEM_CONFIG_CHANGED, MODULES.FINANCE, {
        ipAddress, recordType: 'transaction_document_links', recordId: r.rows[0].id,
        oldValues: { transaction: refs.rows[0].tx, document: refs.rows[0].doc },
        description: `Transaction ${refs.rows[0].tx} disconnected from document ${refs.rows[0].doc}`,
        client,
    }).catch(() => {});
    return { removed: true };
};

// Called at the end of a money form's controller (inside its database
// transaction): connects req.body.document_ids to every ledger row
// this request posted. Optional — does nothing when none were chosen.
const linkAtEntry = async (client, req) => {
    const docIds = cleanIds(req.body && req.body.document_ids);
    if (!docIds.length) return { created: 0 };
    const txIds = postingTracker.postedIds();
    if (!txIds.length) return { created: 0 };
    return link(client, {
        transactionIds: txIds, documentIds: docIds, userId: req.user.id,
        via: 'AT_ENTRY', confirmAdditional: true, ipAddress: req.ip,
    });
};

module.exports = {
    linksReady, transactionCountSql, transactionRefsSql, documentCountSql,
    listDocumentsForTransaction, listTransactionsForDocument, documentRefsForTransactions,
    link, unlink, linkAtEntry, cleanIds, hasFinancialAccess, assertCanSeeDocument,
};
