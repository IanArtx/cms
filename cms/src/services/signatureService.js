// ============================================================
// SIGNATURE SERVICE (v1.23.0, Section 4.29)
// Generic multi-signatory signing, shared by two callers:
//   - documentsController — target_type 'DOCUMENT', target_id =
//     documents.id (Resolutions, Loan/Grant Agreements)
//   - certificatesController — target_type 'CERTIFICATE_ROUND',
//     target_id = certificate_signing_rounds.id (one signature
//     covers every certificate issued in that round)
//
// The shape of the problem is identical either way: "N required
// ROLES must each have someone sign before this counts as approved,"
// so one table (document_signatures) and one set of functions serve
// both rather than duplicating the same logic twice.
// ============================================================

const { query } = require('../config/database');
const { createError } = require('../utils/errors');
const { notifyMany } = require('./notificationService');
const { copyObject, generateKey, toKey } = require('./storageService');

// v1.44.0 — widened from the original 4 (RESOLUTION/LOAN_AGREEMENT/
// GRANT_AGREEMENT/SHARE_CERTIFICATE) to every document type in the
// system, mirroring STAMPABLE_DOCUMENT_TYPES (settingsController.js)
// which already covers all of them. Being in this list only means a
// document type is ELIGIBLE to require signatures — an Admin still
// has to actually configure required roles for it in Settings ->
// Signatories (signature_requirements) before anything changes for
// that type in practice.
const SIGNABLE_DOCUMENT_TYPES = [
    'RESOLUTION', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'SHARE_CERTIFICATE',
    'CONTRACT', 'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
    'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
    'RECEIPT', 'AUDITOR_FEEDBACK', 'AUDIT_REPORT', 'OTHER',
];

// ============================================================
// GET ACTIVE REQUIRED ROLES for a document type
// ============================================================
const getRequiredRoles = async (documentType, client = null) => {
    const runner = client || { query };
    const result = await runner.query(`
        SELECT sr.role_id, r.name AS role_name
        FROM   signature_requirements sr
        JOIN   roles r ON r.id = sr.role_id
        WHERE  sr.document_type = $1 AND sr.is_active = TRUE
        ORDER  BY r.name
    `, [documentType]);
    return result.rows;
};

// ============================================================
// ENSURE SIGNATURE SLOTS EXIST for a target (idempotent — safe to
// call more than once, e.g. on every certificate-issuance run).
// Returns { hasRequirements, roles }. hasRequirements === false
// means "no signature_requirements configured for this document
// type" — the caller should fall back to its original, non-multi-
// signature behaviour.
// ============================================================
const ensureSignatureSlots = async (client, targetType, targetId, documentType) => {
    const roles = await getRequiredRoles(documentType, client);
    if (roles.length === 0) {
        return { hasRequirements: false, roles: [] };
    }

    for (const role of roles) {
        await client.query(`
            INSERT INTO document_signatures (target_type, target_id, required_role_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (target_type, target_id, required_role_id)
            WHERE required_role_id IS NOT NULL DO NOTHING
        `, [targetType, targetId, role.role_id]);
    }

    return { hasRequirements: true, roles };
};

// ============================================================
// ENSURE PERSON-SPECIFIC SIGNATURE SLOTS EXIST (v1.45.0) — the
// counterpart to ensureSignatureSlots above, but for a slot tied to
// one specific named USER rather than a role. Used when a document's
// own template_data names a specific person as e.g. Chairman or
// Secretary (Meeting Minutes/Agenda, Resolutions) — that person
// becomes a required signer for THIS document regardless of which
// role(s) they currently hold. Idempotent, same as ensureSignatureSlots.
// `people` is an array of { userId, positionTitle }; entries with no
// userId are silently skipped (a typed free-text name that doesn't
// resolve to a real system user never creates a signature slot).
// ============================================================
const ensurePersonSignatureSlots = async (client, targetType, targetId, people = []) => {
    const created = [];
    for (const person of people) {
        if (!person || !person.userId) continue;
        await client.query(`
            INSERT INTO document_signatures (target_type, target_id, required_user_id, position_title)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (target_type, target_id, required_user_id)
            WHERE required_user_id IS NOT NULL DO NOTHING
        `, [targetType, targetId, person.userId, person.positionTitle || null]);
        created.push(person);
    }
    return { hasRequirements: created.length > 0, people: created };
};

// ============================================================
// SIGN A SLOT
// The caller (userId) must currently hold the role attached to some
// still-PENDING slot for this target, and must already have a saved
// signature_path. Copies that signature image to a snapshot file so
// a later change to the user's stored signature never alters
// something already signed. Returns { allSigned, remainingRoles }.
// ============================================================
const signSlot = async (client, { targetType, targetId, userId }) => {
    const userResult = await client.query(
        'SELECT signature_path, first_name, last_name FROM users WHERE id = $1',
        [userId]
    );
    const user = userResult.rows[0];
    if (!user) throw createError.notFound('User not found');
    if (!user.signature_path) {
        throw createError.badRequest('You need to set up your signature before you can sign this (Settings / My Profile).');
    }

    const userRolesResult = await client.query(`
        SELECT ur.role_id
        FROM   user_roles ur
        WHERE  ur.user_id = $1 AND ur.revoked_at IS NULL
    `, [userId]);
    const userRoleIds = userRolesResult.rows.map(r => r.role_id);

    // Find a PENDING slot this user can fill — either a role-based
    // slot whose role they currently hold, or (v1.45.0) a slot naming
    // them specifically as a required signer (e.g. Chairman/Secretary
    // on a Meeting Minutes/Agenda/Resolution) regardless of role.
    const slotResult = await client.query(`
        SELECT id, required_role_id, required_user_id
        FROM   document_signatures
        WHERE  target_type = $1 AND target_id = $2
        AND    status = 'PENDING'
        AND    (required_user_id = $3 OR required_role_id = ANY($4::int[]))
        LIMIT  1
        FOR UPDATE
    `, [targetType, targetId, userId, userRoleIds]);

    if (slotResult.rows.length === 0) {
        throw createError.forbidden('There is no pending signature slot here that you can sign (either you already signed, someone else already covered it, or you are not a required signatory for this).');
    }
    const slot = slotResult.rows[0];

    // Snapshot the signature file at this moment — a real copy (not
    // just re-pointing at the live signature_path), via storageService
    // so it works the same way whether files live on R2 or (dev
    // fallback) local disk.
    const sourceKey = toKey(user.signature_path);
    const snapshotKey = generateKey(
        'signature-snapshots',
        `${targetType.toLowerCase()}-${targetId}-${slot.id}.png`
    );
    let snapshotUrlPath = user.signature_path; // fallback if the source file is somehow missing
    try {
        await copyObject(sourceKey, snapshotKey);
        snapshotUrlPath = `/uploads/${snapshotKey}`;
    } catch (err) {
        // Source file missing (e.g. moved/deleted outside the app) —
        // fall back to referencing the live signature_path rather than
        // failing the whole signing action outright.
    }

    await client.query(`
        UPDATE document_signatures
        SET    status = 'SIGNED', signed_by = $1, signature_snapshot_path = $2, signed_at = NOW()
        WHERE  id = $3
    `, [userId, snapshotUrlPath, slot.id]);

    const remainingResult = await client.query(`
        SELECT COUNT(*)::int AS remaining
        FROM   document_signatures
        WHERE  target_type = $1 AND target_id = $2 AND status = 'PENDING'
    `, [targetType, targetId]);

    return { allSigned: remainingResult.rows[0].remaining === 0, signerName: `${user.first_name} ${user.last_name}` };
};

// ============================================================
// GET SIGNATURE STATUS for a target — every required role's slot,
// who (if anyone) has signed it, and their snapshot image URL.
// ============================================================
const getSignatureStatus = async (targetType, targetId) => {
    const result = await query(`
        SELECT ds.id, ds.required_role_id, r.name AS role_name,
               ds.required_user_id, ds.position_title,
               ru.first_name AS required_first_name, ru.last_name AS required_last_name,
               ds.status, ds.signed_by,
               u.first_name AS signer_first_name, u.last_name AS signer_last_name,
               ds.signature_snapshot_path, ds.signed_at
        FROM   document_signatures ds
        LEFT JOIN roles r  ON r.id = ds.required_role_id
        LEFT JOIN users ru ON ru.id = ds.required_user_id
        LEFT JOIN users u  ON u.id = ds.signed_by
        WHERE  ds.target_type = $1 AND ds.target_id = $2
        ORDER  BY COALESCE(r.name, ds.position_title, '')
    `, [targetType, targetId]);

    // v1.45.0 — a slot is either role-based (required_role_id) or
    // person-based (required_user_id, e.g. a named Chairman/Secretary
    // who must sign regardless of role). role_name is kept as the
    // display label either way — for a person-based slot it falls
    // back to position_title ('Chairman'/'Secretary') or the person's
    // own name, so existing frontend code that just shows role_name
    // keeps working unchanged; required_user_name is additionally
    // exposed for callers that want to show the named person too.
    return result.rows.map(row => ({
        role_id:            row.required_role_id,
        role_name:          row.required_role_id
                                 ? row.role_name
                                 : (row.position_title || `${row.required_first_name} ${row.required_last_name}`),
        required_user_id:   row.required_user_id,
        required_user_name: row.required_user_id ? `${row.required_first_name} ${row.required_last_name}` : null,
        status:              row.status,
        signed_by:           row.signed_by,
        signer_name:         row.signed_by ? `${row.signer_first_name} ${row.signer_last_name}` : null,
        signature_url:       row.signature_snapshot_path,
        signed_at:           row.signed_at,
    }));
};

// ============================================================
// NOTIFY WHOEVER STILL HAS A PENDING SLOT for a target — bell
// notification + email, same as every other notifyMany() use in
// this codebase (v1.23.1). Used both the moment slots open (so a
// signatory doesn't have to stumble onto the Signatures modal by
// chance) and by the daily reminder job for anything still pending.
// `subject`/`buildEmailHtml(recipient, roleName)` let the caller
// phrase "signature is open" vs. "signature is still pending" text
// differently while sharing the actual lookup-and-send logic.
// ============================================================
const notifyPendingSignatories = async (targetType, targetId, notificationType, { title, link, recordType, emailSubject, buildEmailHtml }) => {
    const pendingRoles = await query(`
        SELECT DISTINCT ds.required_role_id, r.name AS role_name
        FROM   document_signatures ds
        JOIN   roles r ON r.id = ds.required_role_id
        WHERE  ds.target_type = $1 AND ds.target_id = $2 AND ds.status = 'PENDING'
        AND    ds.required_role_id IS NOT NULL
    `, [targetType, targetId]);

    // v1.45.0 — a target can also have person-based pending slots
    // (a specific named Chairman/Secretary), which have no role at
    // all — these are gathered separately and merged into the same
    // recipient list below.
    const pendingPeople = await query(`
        SELECT DISTINCT ds.required_user_id, ds.position_title
        FROM   document_signatures ds
        WHERE  ds.target_type = $1 AND ds.target_id = $2 AND ds.status = 'PENDING'
        AND    ds.required_user_id IS NOT NULL
    `, [targetType, targetId]);

    if (pendingRoles.rows.length === 0 && pendingPeople.rows.length === 0) return { notified: 0 };

    const labelsByHolder = new Map(); // userId -> { first_name, email, labels: [] }

    if (pendingRoles.rows.length > 0) {
        const roleIds = pendingRoles.rows.map(r => r.required_role_id);
        const holders = await query(`
            SELECT DISTINCT u.id, u.first_name, u.email, ur.role_id
            FROM   user_roles ur
            JOIN   users u ON u.id = ur.user_id AND u.is_active = TRUE
            WHERE  ur.role_id = ANY($1::int[]) AND ur.revoked_at IS NULL
        `, [roleIds]);

        const roleNameById = new Map(pendingRoles.rows.map(r => [r.required_role_id, r.role_name]));
        for (const h of holders.rows) {
            if (!labelsByHolder.has(h.id)) {
                labelsByHolder.set(h.id, { first_name: h.first_name, email: h.email, labels: [] });
            }
            labelsByHolder.get(h.id).labels.push(roleNameById.get(h.role_id));
        }
    }

    if (pendingPeople.rows.length > 0) {
        const userIds = pendingPeople.rows.map(r => r.required_user_id);
        const people = await query(`
            SELECT id, first_name, email FROM users WHERE id = ANY($1::int[]) AND is_active = TRUE
        `, [userIds]);

        const titleByUser = new Map(pendingPeople.rows.map(r => [r.required_user_id, r.position_title]));
        for (const p of people.rows) {
            if (!labelsByHolder.has(p.id)) {
                labelsByHolder.set(p.id, { first_name: p.first_name, email: p.email, labels: [] });
            }
            labelsByHolder.get(p.id).labels.push(titleByUser.get(p.id) || 'Signatory');
        }
    }

    const recipients = Array.from(labelsByHolder.entries()).map(([id, v]) => ({
        id, first_name: v.first_name, email: v.email, roleNames: v.labels,
    }));

    await notifyMany(recipients, notificationType, (recipient) => ({
        title,
        body: `Your signature (${recipient.roleNames.join(', ')}) is needed.`,
        link,
        module: 'SYSTEM',
        recordType,
        recordId: targetId,
        email: {
            subject: emailSubject,
            html: buildEmailHtml(recipient),
        },
    })).catch(() => {});

    return { notified: recipients.length };
};

// ============================================================
// GET MY PENDING SIGNATURES (v1.44.0) — every DOCUMENT and
// CERTIFICATE_ROUND target where the caller currently holds at least
// one still-PENDING required-signatory slot, across both the
// `documents` table (Resolutions, Loan/Grant Agreements, etc.) and
// `certificate_signing_rounds` (Share Certificates) — the two never
// otherwise show up in the same list anywhere in the app. Powers the
// "Pending My Signature" tab. One row per target (not per role slot)
// — role_names collects every one of the caller's currently-pending
// roles on that same target, since a person can hold more than one
// required role.
// ============================================================
const getMyPendingSignatures = async (userId) => {
    const userRolesResult = await query(
        'SELECT role_id FROM user_roles WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
    );
    const roleIds = userRolesResult.rows.map(r => r.role_id);

    const dedupeByTarget = (rows, mapFn) => {
        const byId = new Map();
        for (const row of rows) {
            if (!byId.has(row.target_id)) {
                byId.set(row.target_id, { ...mapFn(row), role_names: [row.role_name] });
            } else {
                byId.get(row.target_id).role_names.push(row.role_name);
            }
        }
        return Array.from(byId.values());
    };

    // v1.45.0 — roleIds may legitimately be empty (a person can be
    // named a specific-person signatory, e.g. Chairman, without
    // holding any role at all), so role-based lookups below use a
    // guaranteed-empty-safe array rather than short-circuiting.
    const docRoleRows = roleIds.length > 0 ? (await query(`
        SELECT d.id AS target_id, d.title, d.document_type, rr.reference_code, r.name AS role_name
        FROM   document_signatures ds
        JOIN   documents d             ON d.id = ds.target_id AND ds.target_type = 'DOCUMENT'
        JOIN   roles r                 ON r.id = ds.required_role_id
        JOIN   references_registry rr  ON rr.id = d.reference_id
        WHERE  ds.status = 'PENDING' AND ds.required_role_id = ANY($1::int[])
        ORDER  BY d.title
    `, [roleIds])).rows : [];

    const docPersonRows = (await query(`
        SELECT d.id AS target_id, d.title, d.document_type, rr.reference_code,
               COALESCE(ds.position_title, 'Signatory') AS role_name
        FROM   document_signatures ds
        JOIN   documents d             ON d.id = ds.target_id AND ds.target_type = 'DOCUMENT'
        JOIN   references_registry rr  ON rr.id = d.reference_id
        WHERE  ds.status = 'PENDING' AND ds.required_user_id = $1
        ORDER  BY d.title
    `, [userId])).rows;

    const docRows = { rows: [...docRoleRows, ...docPersonRows] };

    const certRows = roleIds.length > 0 ? await query(`
        SELECT csr.id AS target_id, csr.certificate_type, csr.period_label, r.name AS role_name
        FROM   document_signatures ds
        JOIN   certificate_signing_rounds csr ON csr.id = ds.target_id AND ds.target_type = 'CERTIFICATE_ROUND'
        JOIN   roles r                        ON r.id = ds.required_role_id
        WHERE  ds.status = 'PENDING' AND ds.required_role_id = ANY($1::int[])
        ORDER  BY csr.period_label DESC
    `, [roleIds]) : { rows: [] };

    const documents = dedupeByTarget(docRows.rows, row => ({
        target_type:     'DOCUMENT',
        target_id:       row.target_id,
        title:           row.title,
        subtitle:        row.document_type.replace(/_/g, ' '),
        reference_code:  row.reference_code,
    }));

    const rounds = dedupeByTarget(certRows.rows, row => ({
        target_type: 'CERTIFICATE_ROUND',
        target_id:   row.target_id,
        title:       `${row.certificate_type === 'ANNUAL' ? 'Annual' : 'Monthly'} Share Certificates`,
        subtitle:    row.period_label,
    }));

    return [...documents, ...rounds];
};

module.exports = {
    SIGNABLE_DOCUMENT_TYPES,
    getRequiredRoles,
    ensureSignatureSlots,
    ensurePersonSignatureSlots,
    signSlot,
    getSignatureStatus,
    notifyPendingSignatories,
    getMyPendingSignatures,
};
