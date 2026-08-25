-- ============================================================
-- MIGRATION v1.40.1 — Fixed: reversing a deposit's transaction left
-- its deposit_balances/deposit_entries completely untouched.
--
-- Reported directly: "the deposit amount remains unchanged even when
-- a reversal is initiated."
--
-- ROOT CAUSE: transactionsController.reverseTransaction is a generic,
-- ledger-only reversal — it always creates the opposite-direction
-- ledger entry and adjusts accounts.current_balance, but only ever
-- special-cased ONE side table (shareholder_contributions, via
-- transactions.contribution_id). Deposits (like Side Fund and
-- Savings) have no such linking column on `transactions` — they're
-- only identifiable via inflow_type — so reversing a deposit's
-- transaction never touched deposit_balances or deposit_entries at
-- all. This migration adds the columns needed to close that gap for
-- Deposits specifically (see the matching code change in
-- transactionsController.js).
--
-- WHAT THIS ADDS: three columns on deposit_entries so an entry can be
-- marked as reversed (mirroring transactions.is_reversed) — is_reversed
-- (BOOLEAN), reversed_at (TIMESTAMPTZ), reversed_by (INTEGER, who
-- initiated the reversal). deposit_balances itself needs no schema
-- change — it's just decremented in place, same shape as the existing
-- increment.
-- ============================================================

BEGIN;

ALTER TABLE deposit_entries
    ADD COLUMN is_reversed BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN reversed_at TIMESTAMPTZ,
    ADD COLUMN reversed_by INTEGER REFERENCES users(id);

COMMENT ON COLUMN deposit_entries.is_reversed IS
    'Set TRUE when the linked transaction is reversed (transactionsController.reverseTransaction) — '
    'the corresponding amount has already been decremented back out of deposit_balances.balance. '
    'The original row is kept (not deleted) so deposit history stays complete and auditable.';

COMMIT;
