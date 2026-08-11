// ============================================================
// STAMP SERVICE (v1.24.0, Section 4.30)
// Applies Admin-uploaded company stamps/seals to a document or
// certificate signing round once it becomes FULLY approved/signed.
// Mirrors signatureService's shape: a lookup of "what's configured
// for this document type" plus an idempotent "apply it" step, shared
// by both callers (documentsController, certificatesController /
// certificateService) the same way document_signatures is shared.
//
// Best-effort by design, same as notification sending elsewhere in
// this codebase — a stamp-application failure must never roll back
// or block the underlying approval/signing action itself.
// ============================================================

const { query } = require('../config/database');

// ============================================================
// IS THE COMPANY-WIDE STAMPS SWITCH ON? (v1.24.1)
// A single master toggle (company_settings.stamps_enabled, Admin-
// editable in Settings -> Stamps) that overrides everything below
// it — even a document type with active document_stamp_requirements
// rows gets no stamp applied while this is FALSE. Defaults FALSE, so
// a database that just ran migration_v1.24.0.sql (stamps built, but
// not yet reviewed by the Admin) stays inert until deliberately
// switched on.
// ============================================================
const areStampsEnabled = async () => {
    const result = await query('SELECT stamps_enabled FROM company_settings WHERE id = 1');
    return result.rows[0]?.stamps_enabled === true;
};

// ============================================================
// GET ACTIVE STAMPS configured for a document type
// ============================================================
const getActiveStampsForType = async (documentType) => {
    const result = await query(`
        SELECT cs.id, cs.name, cs.file_path, cs.mime_type
        FROM   document_stamp_requirements dsr
        JOIN   company_stamps cs ON cs.id = dsr.stamp_id AND cs.is_active = TRUE
        WHERE  dsr.document_type = $1 AND dsr.is_active = TRUE
        ORDER  BY cs.name
    `, [documentType]);
    return result.rows;
};

// ============================================================
// APPLY STAMPS to a target (idempotent — safe to call more than
// once). Returns the list of stamps applied (empty array if nothing
// is configured for this document type — the normal, unstamped
// case). Snapshots into document_stamps_applied so a later change to
// document_stamp_requirements never retroactively alters something
// already finalised.
// ============================================================
const applyStamps = async (targetType, targetId, documentType) => {
    if (!(await areStampsEnabled())) {
        // Master switch is off — behave exactly as if nothing were
        // configured for this document type, regardless of what
        // document_stamp_requirements actually says.
        return [];
    }
    const stamps = await getActiveStampsForType(documentType);
    for (const stamp of stamps) {
        await query(`
            INSERT INTO document_stamps_applied (target_type, target_id, stamp_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (target_type, target_id, stamp_id) DO NOTHING
        `, [targetType, targetId, stamp.id]);
    }
    return stamps;
};

// ============================================================
// GET APPLIED STAMPS for a target — what actually got baked onto
// this specific document/round, regardless of what
// document_stamp_requirements says right now.
// ============================================================
const getAppliedStamps = async (targetType, targetId) => {
    const result = await query(`
        SELECT dsa.stamp_id, cs.name, cs.file_path, cs.mime_type, dsa.applied_at
        FROM   document_stamps_applied dsa
        JOIN   company_stamps cs ON cs.id = dsa.stamp_id
        WHERE  dsa.target_type = $1 AND dsa.target_id = $2
        ORDER  BY cs.name
    `, [targetType, targetId]);
    return result.rows;
};

module.exports = {
    areStampsEnabled,
    getActiveStampsForType,
    applyStamps,
    getAppliedStamps,
};
