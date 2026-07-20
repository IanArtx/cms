-- ============================================================
-- MIGRATION v1.9.0
--
-- Adds:
--   1. investments.first_coupon_date — lets a bond bought after it
--      was already running (not at issuance) have its payment
--      schedule anchored on the issuer's actual next coupon date
--      instead of assuming payments start one period after purchase.
--   2. references_registry.public_id — a short random (non-sequential)
--      ID generated alongside every existing reference code, safe to
--      print or search without revealing how many records exist or
--      in what order. Backfilled for every existing reference below.
--
-- Also fixes (code-only, no schema change needed, deployed alongside
-- this migration):
--   - Bond coupon payments now record the GROSS interest and any
--     withholding TAX as two separate, auditable entries instead of
--     silently netting them into one figure.
--   - The Requisitions category dropdown now only shows FINANCE
--     categories instead of every category in the system.
--   - The Company Archive view now also shows any document archived
--     via the regular "Archive" action, not just documents uploaded
--     directly into it.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Bond first coupon date
-- ------------------------------------------------------------
ALTER TABLE investments
    ADD COLUMN IF NOT EXISTS first_coupon_date DATE;

COMMENT ON COLUMN investments.first_coupon_date IS
    'Only set for a bond bought after it was already running — the '
    'issuer''s next coupon date, used to anchor the generated payment '
    'schedule instead of assuming payments start one period after '
    'start_date.';

-- ------------------------------------------------------------
-- 2. Random public ID on every reference
-- ------------------------------------------------------------
ALTER TABLE references_registry
    ADD COLUMN IF NOT EXISTS public_id VARCHAR(10);

COMMENT ON COLUMN references_registry.public_id IS
    'Short random (non-sequential) ID generated alongside the '
    'sequential reference_code — safe to print/search/quote without '
    'revealing how many records of that kind exist or in what order.';

-- Backfill every existing reference that doesn't have one yet.
-- Uses the same alphabet as the application code (no 0/O/1/I/L, so
-- it's easy to read aloud or copy off a printed document).
DO $$
DECLARE
    rec        RECORD;
    new_id     TEXT;
    alphabet   TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    i          INT;
    tries      INT;
BEGIN
    FOR rec IN SELECT id FROM references_registry WHERE public_id IS NULL LOOP
        tries := 0;
        LOOP
            new_id := '';
            FOR i IN 1..10 LOOP
                new_id := new_id || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
            END LOOP;
            tries := tries + 1;
            EXIT WHEN tries > 10 OR NOT EXISTS (
                SELECT 1 FROM references_registry WHERE public_id = new_id
            );
        END LOOP;
        UPDATE references_registry SET public_id = new_id WHERE id = rec.id;
    END LOOP;
END $$;

-- Now that every row has a value, enforce uniqueness going forward.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'references_registry_public_id_key'
    ) THEN
        ALTER TABLE references_registry ADD CONSTRAINT references_registry_public_id_key UNIQUE (public_id);
    END IF;
END $$;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend so it picks up the code changes deployed
--      alongside this migration (bond coupon accounting, category
--      filter, archive fix, public ID generation/search).
--   2. Pay a bond coupon on an existing bond investment and check its
--      detail page — you should now see the gross interest and the
--      withholding tax as two separate entries instead of one net
--      figure.
--   3. Create a new bond investment and try setting "First Coupon
--      Date" — leave it blank for a normal bond, set it for one
--      bought partway through its life.
--   4. Search (topbar magnifying glass) using an existing reference
--      code — public IDs are generated for all new records from now
--      on, and every existing record now has one too.
--   5. Archive a document and confirm it now appears in Documents >
--      Company Archive.
--   6. If cms_user doesn't already have full rights on changed tables
--      via an admin/pgAdmin connection, re-run:
--        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_user;
--        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cms_user;
-- ------------------------------------------------------------
