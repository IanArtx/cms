-- ============================================================
-- MIGRATION: v1.3.0 -> v1.4.0
-- Run this ONLY if you already created the database from the old
-- schema.sql (v1.3.0) before this fix. If you're setting up a fresh
-- database, ignore this file — just run the current schema.sql,
-- it already includes everything below.
--
-- Safe to run more than once: every step is guarded (IF NOT EXISTS,
-- ON CONFLICT, or a DO block that ignores "already exists" errors),
-- so re-running it won't fail or duplicate anything.
--
-- What this adds (see schema.sql v1.4.0 changelog for details):
--   1. New role: Assistant Treasurer
--   2. requisitions.requisition_type, requisitions.contribution_date
--      — lets a member ask the Treasurer to acknowledge and record
--      capital they've already contributed, instead of posting the
--      contribution themselves
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. New role — Assistant Treasurer
-- ----------------------------------------------------------
INSERT INTO roles (name, description, is_system_role)
SELECT 'Assistant Treasurer',
       'Supports Treasurer with financial recording and contribution acknowledgement',
       TRUE
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Assistant Treasurer');

-- ----------------------------------------------------------
-- 2. requisitions — contribution acknowledgement support
-- ----------------------------------------------------------
ALTER TABLE requisitions
    ADD COLUMN IF NOT EXISTS requisition_type  VARCHAR(30) NOT NULL DEFAULT 'EXPENSE',
    ADD COLUMN IF NOT EXISTS contribution_date DATE;

DO $$
BEGIN
    ALTER TABLE requisitions
        ADD CONSTRAINT requisitions_requisition_type_check
        CHECK (requisition_type IN ('EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;

-- ============================================================
-- Done. Your database is now equivalent to a fresh run of
-- schema.sql v1.4.0.
--
-- IMPORTANT MANUAL STEP:
-- After running this, go to Settings > Roles in the app and assign
-- the new "Assistant Treasurer" role's permissions the same way the
-- Treasurer role's finance permissions are set up, then assign the
-- role to whoever should hold it. Also double-check that the
-- FINANCE_TRANSACTION_CREATE permission is now ONLY assigned to
-- Treasurer / Assistant Treasurer — as of this version, the
-- "Record Contribution" and "Record Expense" endpoints are
-- restricted to those two roles in code (routes/transactions.js),
-- regardless of what FINANCE_TRANSACTION_CREATE is assigned to.
-- ============================================================
