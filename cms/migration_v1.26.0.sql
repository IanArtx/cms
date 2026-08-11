-- ============================================================
-- MIGRATION v1.26.0 — SIDE FUND: STRICTLY PER-MEMBER ATTRIBUTION
--
-- Reworks how money gets INTO the side fund so every shilling is
-- always tied to a specific member's own due, never an unattributed
-- lump sum:
--
-- 1. due_date on side_fund_dues. A due's period ('YYYY-MM') already
--    implied a due date (the last day of that month, since the fund
--    is a flat monthly amount and the next month's job marks it
--    DEFAULTED once that date has passed) — this makes it an actual
--    stored column instead of something recomputed from `period`
--    every time, so overdue amounts can be reported per member
--    precisely and consistently everywhere. Backfilled for existing
--    rows as the last day of their own period's month.
--
-- 2. requisitions.requisition_type widened to accept
--    'SIDE_FUND_CONTRIBUTION' — a member can now request/acknowledge
--    a side fund payment the same way they already can for a capital
--    contribution or a savings deposit (Section 4.9).
--
-- The removal of the old "Add Funds Directly" (unattributed lump-sum
-- top-up) feature and the new bulk/split/requisition payment paths
-- are code-only changes (they all reuse the existing side_fund_dues /
-- side_fund_member_credit / side_fund_credit_ledger tables from
-- v1.25.0) and need no schema change beyond the two above.
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. side_fund_dues.due_date
-- ----------------------------------------------------------
ALTER TABLE side_fund_dues ADD COLUMN IF NOT EXISTS due_date DATE;

UPDATE side_fund_dues
SET    due_date = (period || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day'
WHERE  due_date IS NULL;

ALTER TABLE side_fund_dues ALTER COLUMN due_date SET NOT NULL;

-- ----------------------------------------------------------
-- 2. Widen requisitions.requisition_type
-- ----------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'requisitions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%requisition_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE requisitions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE requisitions ADD CONSTRAINT requisitions_requisition_type_check
        CHECK (requisition_type IN (
            'EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT', 'SIDE_FUND_CONTRIBUTION'
        ));
END $$;

COMMIT;

-- ============================================================
-- After running this migration:
--   1. Restart the backend so the new bulk-pay endpoint, the
--      Transactions contribution side-fund split, and the
--      Side Fund Contribution requisition type are picked up.
--   2. The "Add Funds Directly" feature is gone — POST
--      /api/side-fund/inflows no longer exists. If any code or
--      external script still calls it, it will now 404.
--   3. Existing side_fund_dues rows now have due_date populated
--      (backfilled from their own period) — nothing else about them
--      changes; no re-generation or re-calculation needed.
--   4. Existing requisitions are unaffected — only new ones can use
--      the SIDE_FUND_CONTRIBUTION type.
-- ============================================================
