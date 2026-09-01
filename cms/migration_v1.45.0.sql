-- ============================================================
-- MIGRATION v1.45.0 — Person-specific signature slots + attendee
-- pickers on Meeting Minutes / Meeting Agenda / Resolution templates
--
-- Requested directly: the Chairperson/Secretary (and other attendee)
-- fields on these three templates should be fillable from a dropdown
-- of system users, or a typed free-text name for someone not in the
-- system. Selecting a real system user as Chairman or Secretary makes
-- THAT SPECIFIC PERSON a required signer on that one document — even
-- if they don't currently hold the "Secretary" role — while they
-- still have to actively log in and sign it themselves (same as every
-- other signature in this system; nothing is auto-signed). A typed
-- free-text name is just printed with a blank manual-signature line,
-- same as before this version, and never blocks the document.
--
-- Until now, document_signatures only knew how to require a ROLE
-- (required_role_id, NOT NULL). This widens it to also support
-- requiring one specific USER (required_user_id), with
-- position_title as a free-text display label ('Chairman',
-- 'Secretary') for that person's capacity on this one document.
-- Exactly one of required_role_id / required_user_id must be set —
-- role-based slots (Settings -> Signatories config) and person-based
-- slots (named in the document itself) can both be open on the same
-- document at once; it becomes FINAL once every slot of either kind
-- is signed, via the same existing signSlot()/getSignatureStatus()
-- pending-count logic.
-- ============================================================

BEGIN;

-- 1) required_role_id becomes optional (a person-based slot leaves
--    it NULL).
ALTER TABLE document_signatures ALTER COLUMN required_role_id DROP NOT NULL;

-- 2) Add the two new columns, idempotently.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'document_signatures' AND column_name = 'required_user_id'
    ) THEN
        ALTER TABLE document_signatures ADD COLUMN required_user_id INTEGER REFERENCES users(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'document_signatures' AND column_name = 'position_title'
    ) THEN
        ALTER TABLE document_signatures ADD COLUMN position_title VARCHAR(50);
    END IF;
END $$;

-- 3) Drop the old composite UNIQUE(target_type, target_id,
--    required_role_id) — it has no explicit name in schema.sql, so
--    this finds whatever Postgres auto-named it, same pattern as
--    migration_v1.44.0.sql. A plain UNIQUE constraint including a
--    now-nullable column would stop deduplicating role-based rows
--    once person-based rows (NULL required_role_id) exist alongside
--    them, so it's replaced with two partial unique indexes below.
DO $$
DECLARE
    conname text;
BEGIN
    SELECT c.conname INTO conname
    FROM   pg_constraint c
    JOIN   pg_class t ON t.oid = c.conrelid
    WHERE  t.relname = 'document_signatures'
    AND    c.contype = 'u';

    IF conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE document_signatures DROP CONSTRAINT %I', conname);
    END IF;
END $$;

-- 4) Exactly one of required_role_id / required_user_id must be set.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'document_signatures_slot_type_check'
    ) THEN
        ALTER TABLE document_signatures
            ADD CONSTRAINT document_signatures_slot_type_check
            CHECK (
                (required_role_id IS NOT NULL AND required_user_id IS NULL) OR
                (required_role_id IS NULL AND required_user_id IS NOT NULL)
            );
    END IF;
END $$;

-- 5) Replacement partial unique indexes (safe to re-run).
CREATE UNIQUE INDEX IF NOT EXISTS document_signatures_role_slot_unique
    ON document_signatures (target_type, target_id, required_role_id)
    WHERE required_role_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS document_signatures_user_slot_unique
    ON document_signatures (target_type, target_id, required_user_id)
    WHERE required_user_id IS NOT NULL;

COMMIT;
