-- ============================================================
-- MIGRATION v1.30.2 — Payment Acknowledgements: add SAVINGS_HANDOUT
-- (Section 4.35)
--
-- Extends payment_acknowledgements.source_type to also cover savings
-- handouts (confirmSavingsHandout, savingsController.js) — the same
-- auto-create-on-payout / recipient-acknowledges / Treasury-final-
-- approves flow already used for dividends, service fee payments, and
-- expense reimbursements now also covers the moment a Flexible
-- Savings handout is confirmed and the money actually leaves the
-- Savings account.
--
-- This widens an existing CHECK constraint rather than creating
-- anything new, so — unlike most migrations in this repo — it IS
-- safe to run more than once (DROP CONSTRAINT IF EXISTS, then
-- re-ADD). Run this after migration_v1.30.0.sql has already been
-- applied; if you're setting up a brand-new database instead, just
-- run the current schema.sql, which already includes SAVINGS_HANDOUT
-- in the CHECK list from the start.
-- ============================================================

BEGIN;

ALTER TABLE payment_acknowledgements
    DROP CONSTRAINT IF EXISTS payment_acknowledgements_source_type_check;

ALTER TABLE payment_acknowledgements
    ADD CONSTRAINT payment_acknowledgements_source_type_check
    CHECK (source_type IN ('DIVIDEND', 'SERVICE_FEE_PAYMENT', 'REIMBURSEMENT', 'SAVINGS_HANDOUT'));

COMMIT;
