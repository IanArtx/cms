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

const SIGNABLE_DOCUMENT_TYPES = ['RESOLUTION', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'SHARE_CERTIFICATE'];

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
            ON CONFLICT (target_type, target_id, required_role_id) DO NOTHING
        `, [targetType, targetId, role.role_id]);
    }

    return { hasRequirements: true, roles };
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

    if (userRoleIds.length === 0) {
        throw createError.forbidden('Your role does not have a pending signature slot on this item');
    }

    // Find a PENDING slot whose required role this user actually holds
    const slotResult = await client.query(`
        SELECT id, required_role_id
        FROM   document_signatures
        WHERE  target_type = $1 AND target_id = $2
        AND    status = 'PENDING'
        AND    required_role_id = ANY($3::int[])
        LIMIT  1
        FOR UPDATE
    `, [targetType, targetId, userRoleIds]);

    if (slotResult.rows.length === 0) {
        throw createError.forbidden('There is no pending signature slot here that your role covers (either you already signed, someone else already covered your role, or your role is not a required signatory for this).');
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
        SELECT ds.id, ds.required_role_id, r.name AS role_name, ds.status,
               ds.signed_by, u.first_name AS signer_first_name, u.last_name AS signer_last_name,
               ds.signature_snapshot_path, ds.signed_at
        FROM   document_signatures ds
        JOIN   roles r ON r.id = ds.required_role_id
        LEFT JOIN users u ON u.id = ds.signed_by
        WHERE  ds.target_type = $1 AND ds.target_id = $2
        ORDER  BY r.name
    `, [targetType, targetId]);

    return result.rows.map(row => ({
        role_id:           row.required_role_id,
        role_name:         row.role_name,
        status:            row.status,
        signed_by:         row.signed_by,
        signer_name:       row.signed_by ? `${row.signer_first_name} ${row.signer_last_name}` : null,
        signature_url:     row.signature_snapshot_path,
        signed_at:         row.signed_at,
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
    const pending = await query(`
        SELECT DISTINCT ds.required_role_id, r.name AS role_name
        FROM   document_signatures ds
        JOIN   roles r ON r.id = ds.required_role_id
        WHERE  ds.target_type = $1 AND ds.target_id = $2 AND ds.status = 'PENDING'
    `, [targetType, targetId]);

    if (pending.rows.length === 0) return { notified: 0 };

    const roleIds = pending.rows.map(r => r.required_role_id);
    const roleNameByHolder = new Map(); // userId -> [roleNames]

    const holders = await query(`
        SELECT DISTINCT u.id, u.first_name, u.email, ur.role_id
        FROM   user_roles ur
        JOIN   users u ON u.id = ur.user_id AND u.is_active = TRUE
        WHERE  ur.role_id = ANY($1::int[]) AND ur.revoked_at IS NULL
    `, [roleIds]);

    const roleNameById = new Map(pending.rows.map(r => [r.required_role_id, r.role_name]));
    for (const h of holders.rows) {
        const names = roleNameByHolder.get(h.id) || [];
        names.push(roleNameById.get(h.role_id));
        roleNameByHolder.set(h.id, names);
    }

    // Dedup recipients (a person can hold more than one required role)
    const recipients = [];
    const seen = new Set();
    for (const h of holders.rows) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        recipients.push({ id: h.id, first_name: h.first_name, email: h.email, roleNames: roleNameByHolder.get(h.id) });
    }

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

module.exports = {
    SIGNABLE_DOCUMENT_TYPES,
    getRequiredRoles,
    ensureSignatureSlots,
    signSlot,
    getSignatureStatus,
    notifyPendingSignatories,
};
