-- ============================================================
-- MIGRATION v1.12.0 — ACCOUNT BANK DETAILS + SAME-CURRENCY TRANSFER RULE
--
-- Every account (Primary or Secondary) now records standard bank
-- details — bank name, branch, account number, SWIFT/routing code —
-- unless it's explicitly marked as a virtual account (an internal
-- notional/tracking account with no real bank behind it, e.g. the
-- side fund's parent account doesn't need a second set of bank
-- details of its own — it lives inside a real account that already
-- has them). Multiple accounts CAN share the same currency, and even
-- the same bank, as long as their own account numbers/branches
-- differ — nothing here is globally unique.
--
-- Existing accounts are backfilled as virtual (is_virtual = TRUE) so
-- this migration never fails on missing bank details for accounts
-- that already exist — go back and fill in real details (or leave
-- them virtual) via Accounts > Edit once this is applied.
--
-- Also: two accounts sharing the same currency now always transfer
-- at an exchange rate of 1 (enforced server-side, ignoring whatever
-- was submitted) — bank charges still apply independently on either
-- leg. This is a code-only behaviour change (transfersController.js)
-- with no schema impact, listed here for the version record.
--
-- Altered tables: accounts (new columns is_virtual, bank_name,
--             bank_branch, bank_account_number, swift_routing_code)
-- No new permissions — reuses SYSTEM_CONFIG for creating/editing
-- accounts, same as before.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS is_virtual           BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS bank_name             VARCHAR(150),
    ADD COLUMN IF NOT EXISTS bank_branch           VARCHAR(150),
    ADD COLUMN IF NOT EXISTS bank_account_number   VARCHAR(100),
    ADD COLUMN IF NOT EXISTS swift_routing_code    VARCHAR(50);

-- Backfill: every account that existed before this migration was
-- created without any bank details concept at all, so there's no
-- real data to preserve here — tag them virtual so the new CHECK
-- constraint below doesn't reject them. An Admin can go fill in real
-- bank details (which automatically clears the virtual flag) later.
UPDATE accounts
SET    is_virtual = TRUE
WHERE  bank_name IS NULL
AND    bank_account_number IS NULL;

DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'accounts'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%is_virtual%bank_name%';
    IF con_name IS NULL THEN
        ALTER TABLE accounts ADD CONSTRAINT bank_details_required_unless_virtual CHECK (
            is_virtual = TRUE OR (bank_name IS NOT NULL AND bank_account_number IS NOT NULL)
        );
    END IF;
END $$;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend so it
--      picks up the code changes deployed alongside this migration
--      (accountsController.js validation + transfersController.js
--      same-currency exchange rate rule).
--   2. Every existing account is now tagged "virtual" (no bank
--      details required) so this migration never fails on old data.
--      Go to Accounts, edit each real account, untick "virtual" and
--      fill in its actual bank name/branch/account number/SWIFT or
--      routing code — this is the real record of where the money
--      physically sits.
--   3. Nothing else changes — permissions, balances, and transaction
--      history are untouched.
-- ------------------------------------------------------------
