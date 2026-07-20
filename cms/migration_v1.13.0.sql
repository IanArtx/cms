-- ============================================================
-- MIGRATION v1.13.0 — PERMISSIONS MANAGEMENT UI + CORRECTIONS
--
-- 1. Permissions management. Until now, role_permissions could only
--    ever be changed with a direct database edit — there was no
--    route or UI for it anywhere in the app, which is why newly
--    added permissions (SAVINGS_*, SIDE_FUND_*, etc.) could never
--    actually be granted to anyone through Settings. This migration
--    itself makes no schema change for that (role_permissions
--    already existed) — the fix is the new GET /api/system/permissions,
--    GET /api/system/roles/:id/permissions, and PUT
--    /api/system/roles/:id/permissions routes, plus a "Permissions"
--    button per role on Settings > Roles.
--
-- 2. Correction: savings deposit approval was originally assigned to
--    Secretary/Assistant Secretary. Per correction, ALL financial
--    approvals belong to Treasurer/Assistant Treasurer only — this
--    updates the SAVINGS_APPROVE permission's description text and
--    the "who gets notified" list to match (the notify-list change
--    is in code, already deployed alongside this migration; this
--    statement only fixes the description text for anyone who
--    already ran migration_v1.10.0.sql with the old wording).
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

UPDATE permissions
SET    description = 'Approve a pending savings deposit (Treasurer/Assistant Treasurer)'
WHERE  code = 'SAVINGS_APPROVE'
AND    description = 'Approve a pending savings deposit (Secretary)';

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend.
--   2. Go to Settings > Roles. Every role now has a shield icon —
--      click it to see and grant/revoke that role's permissions
--      directly, no database access needed. This is how you should
--      grant every SAVINGS_*, SIDE_FUND_*, and any other permission
--      from now on.
--   3. If you already have roles you use for Treasurer/Assistant
--      Treasurer, go grant them:
--        SAVINGS_VIEW, SAVINGS_CREATE, SAVINGS_APPROVE,
--        SAVINGS_HANDOUT_CREATE, SAVINGS_SETTINGS_MANAGE,
--        SIDE_FUND_VIEW, SIDE_FUND_MANAGE,
--        SIDE_FUND_CONTRIBUTION_RECORD, SIDE_FUND_EXPENSE_RECORD
--      None of the Savings or Side Fund pages will show any action
--      buttons until this is done — that's not a bug, it's the
--      permission system working as intended.
--   4. Loans: a "Pay off remaining balance" option now exists on the
--      repayment form for both Loans Received and Loans Given. Using
--      it (instead of manually typing an amount) is now the
--      recommended way to close out a loan, since it computes the
--      exact amount needed to zero out both principal and interest
--      in one step — manually paying only the principal shown on
--      screen could leave a small remainder that kept accruing more
--      interest indefinitely, which is why some "paid off" loans
--      appeared to keep growing a balance.
-- ------------------------------------------------------------
