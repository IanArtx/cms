// ============================================================
// SIGNATORIES ON SYSTEM-ISSUED DOCUMENTS (v1.85.1)
// Requested: "the share purchase receipts and some documents that
// involve an approval step shows the last person or the final approver
// on the Treasurer signatory. This also applies to investments that
// have separate recording person and approving person. (i would like
// that all parties involved get signatories positions and reflect their
// respective positions)".
//
// A "party" is one person and what they did on the record:
//     { action: 'Recorded by' | 'Approved by' | 'Requested by' | …,
//       userId, at }
// buildParties() turns them into what a document prints:
//     { action, user_id, name, position, signature_url, at }
//   • position = the person's role in the company (the most senior one
//     they hold: Treasurer, Assistant Treasurer, Director, Secretary,
//     Assistant Secretary, Admin, Administrative Officer, Shareholder)
//     as at the moment the document is issued;
//   • signature_url = a SNAPSHOT copy of their saved signature, so a
//     later change of signature never alters an issued document;
//   • the same person doing two things is shown once ("Recorded and
//     approved by").
// positionSql(col) gives the same position inside a SQL query (for
// documents printed straight from the records, e.g. investment entries).
// ============================================================

const { copyObject, generateKey, toKey } = require('./storageService');

const POSITION_ORDER = [
    'Treasurer', 'Assistant Treasurer', 'Director', 'Secretary', 'Assistant Secretary',
    'Admin', 'Administrative Officer', 'Shareholder',
];

const positionSql = (userIdExpr) => `(
    SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE  ur.user_id = ${userIdExpr} AND ur.revoked_at IS NULL AND r.is_active = TRUE
    ORDER  BY COALESCE(array_position(ARRAY[${POSITION_ORDER.map(p => `'${p}'`).join(', ')}]::text[], r.name::text), 99), r.name
    LIMIT  1)`;

const joinActions = (actions) => {
    const lower = actions.map((a, i) => (i === 0 ? a : a.replace(/^(\w)/, (m) => m.toLowerCase())));
    if (lower.length === 1) return lower[0];
    // "Recorded by" + "approved by" → "Recorded and approved by"
    const stems = lower.map(a => a.replace(/\s+by$/i, ''));
    return `${stems.slice(0, -1).join(', ')} and ${stems[stems.length - 1]} by`;
};

const buildParties = async (client, parties, { snapshotPrefix = 'doc', snapshot = true } = {}) => {
    const wanted = (parties || []).filter(p => p && p.userId);
    const order = [];
    const byUser = new Map();
    for (const p of wanted) {
        const id = Number(p.userId);
        if (!byUser.has(id)) { byUser.set(id, { actions: [], at: p.at || null }); order.push(id); }
        const e = byUser.get(id);
        if (!e.actions.includes(p.action)) e.actions.push(p.action);
        if (p.at && (!e.at || new Date(p.at) > new Date(e.at))) e.at = p.at;
    }
    if (!order.length) return [];
    const rows = await client.query(`
        SELECT u.id, u.first_name, u.last_name, u.signature_path, ${positionSql('u.id')} AS position
        FROM   users u WHERE u.id = ANY($1::int[])`, [order]);
    const users = new Map(rows.rows.map(r => [Number(r.id), r]));
    const out = [];
    for (const id of order) {
        const u = users.get(id);
        if (!u) continue;
        const e = byUser.get(id);
        let signatureUrl = null;
        if (u.signature_path) {
            signatureUrl = u.signature_path;
            if (snapshot) {
                try {
                    const key = generateKey('signature-snapshots', `${snapshotPrefix}-${id}.png`);
                    await copyObject(toKey(u.signature_path), key);
                    signatureUrl = `/uploads/${key}`;
                } catch (_) { /* source file missing — keep the saved path */ }
            }
        }
        out.push({
            action: joinActions(e.actions),
            user_id: id,
            name: `${u.first_name} ${u.last_name}`,
            position: u.position || null,
            signature_url: signatureUrl,
            at: e.at ? new Date(e.at).toISOString() : new Date().toISOString(),
        });
    }
    return out;
};

module.exports = { POSITION_ORDER, positionSql, buildParties, joinActions };
