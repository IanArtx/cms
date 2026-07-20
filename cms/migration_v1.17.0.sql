-- ============================================================
-- MIGRATION v1.17.0 — FIX: SAVINGS HANDOUT CONFIRMATION CRASH
--
-- savings_handouts had no category_id column, so confirmSavingsHandout
-- was passing categoryId: null into postTransaction — but
-- transactions.category_id is NOT NULL. Every handout confirmation
-- threw a database error and rolled back; the feature was unusable.
--
-- Fix: add savings_handouts.category_id (NOT NULL, like every other
-- money-moving table in this schema), captured at handout-creation
-- time from a required category dropdown (same pattern already used
-- for member_savings deposits). Existing PENDING_CONFIRMATION or
-- CONFIRMED handouts created before this migration have no category
-- on file, so they're backfilled to the top-level FINANCE > Expense
-- category as a reasonable default — Treasurer/Assistant Treasurer
-- can re-categorize manually afterward if needed.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

ALTER TABLE savings_handouts
    ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);

-- Backfill any existing rows (created before this migration) to the
-- top-level FINANCE > Expense category.
DO $$
DECLARE
    expense_category_id INTEGER;
BEGIN
    SELECT id INTO expense_category_id
    FROM   categories
    WHERE  module = 'FINANCE' AND name = 'Expense' AND parent_id IS NULL
    LIMIT 1;

    IF expense_category_id IS NOT NULL THEN
        UPDATE savings_handouts
        SET    category_id = expense_category_id
        WHERE  category_id IS NULL;
    END IF;
END $$;

-- Only enforce NOT NULL once every existing row has a value — if the
-- backfill above found no "Expense" category (a customized category
-- tree), this step is skipped rather than failing the migration; run
-- it again after manually setting category_id on any remaining rows.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM savings_handouts WHERE category_id IS NULL) THEN
        ALTER TABLE savings_handouts ALTER COLUMN category_id SET NOT NULL;
    END IF;
END $$;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend.
--   2. "Record Savings Handout" now requires selecting a category,
--      same as recording a deposit.
--   3. Confirming a handout (member side) now succeeds instead of
--      erroring — this was the actual bug being fixed.
--   4. If the migration printed no error but you still see rows with
--      a NULL category_id (check: SELECT * FROM savings_handouts
--      WHERE category_id IS NULL), your category tree doesn't have a
--      FINANCE > Expense entry — set those rows manually, then run
--      this migration again to apply the NOT NULL constraint.
-- ------------------------------------------------------------
