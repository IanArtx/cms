-- ============================================================
-- MIGRATION v1.44.0 — Signature system: role-wide access, visibility
-- gating, and a unified "pending my signature" view (Section 4.29)
--
-- Requested directly: signatures should appear on every approved
-- document and wherever a signature is required per the roles a
-- member holds; with more than one Director, any of them can sign
-- and their own specific name/signature is what appears (this part
-- was already true of the v1.23.0 design — signSlot matches on ROLE,
-- first pending slot wins, and records the actual signer's identity).
-- What was genuinely missing/broken, fixed here:
--
--   1. Signing a regular document required the DOCUMENT_APPROVE
--      permission on top of being a configured signatory role — an
--      Admin who added a role as a required signer in Settings ->
--      Signatories without separately granting it DOCUMENT_APPROVE
--      left that role unable to actually sign. Decoupled (routes.js,
--      no schema change) — signSlot's own role-holding check is
--      sufficient, same as the certificate-round sign route already
--      worked.
--   2. Share certificate signing rounds could only be viewed/signed
--      by Treasurer/Assistant Treasurer/Admin — a Director-only
--      signatory was notified but had no reachable page. Opened
--      GET /certificates/rounds/:id to anyone currently holding a
--      pending slot on that specific round (controller-level check,
--      no schema change); the bulk management list stays restricted.
--   3. No single place to see everything awaiting your signature —
--      new getMyPendingSignatures() spans both documents and
--      certificate rounds.
--   4. A document with open signature slots was fully visible in the
--      general Documents list to everyone, just flagged amber/green —
--      now hidden from anyone who isn't the creator, an Admin, or a
--      pending signatory, until every required role has signed.
--   5. Only 4 document types could ever require a signature
--      (RESOLUTION/LOAN_AGREEMENT/GRANT_AGREEMENT/SHARE_CERTIFICATE).
--      Widened to all 14, mirroring document_stamp_requirements'
--      own CHECK constraint — purely opt-in, nothing changes for a
--      type until an Admin actually configures required roles for it.
--
-- No new tables — this is a widened CHECK constraint plus a handful
-- of route/controller changes documented in the code itself.
-- ============================================================

BEGIN;

-- Postgres CHECK constraints can't be altered in place — drop and
-- re-add with the widened list. The constraint has no explicit name
-- in schema.sql, so it was auto-named by Postgres; this DO block
-- finds whatever that auto-generated name actually is rather than
-- hardcoding a guess, and is a no-op if the widened constraint (or
-- some differently-named equivalent) is already in place.
DO $$
DECLARE
    conname text;
BEGIN
    SELECT c.conname INTO conname
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'signature_requirements'
    AND    c.contype = 'c'
    AND    pg_get_constraintdef(c.oid) LIKE '%document_type%'
    LIMIT  1;

    IF conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE signature_requirements DROP CONSTRAINT %I', conname);
    END IF;

    ALTER TABLE signature_requirements
        ADD CONSTRAINT signature_requirements_document_type_check
        CHECK (document_type IN (
            'RESOLUTION', 'LOAN_AGREEMENT', 'GRANT_AGREEMENT', 'SHARE_CERTIFICATE',
            'CONTRACT', 'MEETING_MINUTES', 'MEETING_AGENDA', 'INVESTMENT_PROPOSAL',
            'FINANCIAL_REPORT_GENERAL', 'FINANCIAL_REPORT_INDIVIDUAL',
            'RECEIPT', 'AUDITOR_FEEDBACK', 'AUDIT_REPORT', 'OTHER'
        ));
EXCEPTION
    WHEN duplicate_object THEN
        -- Already widened by a previous run of this migration — fine.
        NULL;
END $$;

COMMIT;
