-- ============================================================
-- MIGRATION v1.14.0 — DEDICATED SAVINGS ACCOUNT, GENERAL FLOOR
-- LIMITS, SIDE FUND DIRECT/BATCH INFLOW, SIDE FUND BALANCE DISPLAY
--
-- 1. New account_type 'SAVINGS'. All member savings transactions
--    (existing and future) are meant to reference this one dedicated
--    account instead of Primary. It behaves like any other account
--    (same bank-details/virtual settings) except:
--      - it can NEVER take part in a transfer (already impossible —
--        transfersController only allows PRIMARY<->SECONDARY legs,
--        so this needed no code change at all)
--      - it is permanently exempt from floor-limit enforcement and
--        may sit at exactly zero at any time
--      - it only ever receives CREDIT postings — member deposits/
--        handouts, or the new non-member "pool inflow" below (e.g.
--        investment profit returned to the pool). No expense/DEBIT
--        is ever posted against it directly.
--    Only one active SAVINGS account may exist at a time (mirrors the
--    existing one-Primary-account rule) so every savings transaction
--    has one unambiguous account to reference.
--
-- 2. Floor limits generalized. Previously only the Primary account
--    could have a floor limit; from this version any account can
--    (the underlying primary_account_floor_limits table was already
--    schema-generic — this is purely an application-logic change).
--    The SAVINGS account remains permanently exempt.
--
-- 3. Side Fund: money can now be added directly/in bulk (not tied to
--    an individual member's monthly due) — e.g. an existing balance
--    or a lump-sum top-up. New inflow_type 'SIDE_FUND_DIRECT_IN'.
--
-- 4. New table savings_pool_inflows: a non-member inflow into the
--    SAVINGS account's pool (e.g. investment profit), going through
--    the same Treasurer/Assistant Treasurer two-step approval
--    pipeline as a member deposit. Reuses the existing SAVINGS_CREATE
--    / SAVINGS_APPROVE permissions — nothing new to grant.
--
-- 5. Any account holding an active side fund now displays its
--    "general" balance with the side fund's allocation excluded (the
--    real ledger total is unchanged — this is a display-only split).
--    The allocation is shown as its own figure, including on the
--    Dashboard, while the actual top-up/contribution transactions
--    remain fully visible in that account's own transaction ledger.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

-- 1. Widen accounts.account_type to allow 'SAVINGS'
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'accounts'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%account_type%PRIMARY%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE accounts DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE accounts ADD CONSTRAINT accounts_account_type_check
        CHECK (account_type IN ('PRIMARY','SECONDARY','SAVINGS'));
END $$;

-- 2. Enforce a single active SAVINGS account
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_savings_account
    ON accounts (account_type)
    WHERE account_type = 'SAVINGS' AND is_active = TRUE;

-- 3. Widen transactions.inflow_type
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%CONTRIBUTION%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check
        CHECK (inflow_type IN (
            'CONTRIBUTION', 'GRANT', 'LOAN_RECEIVED', 'LOAN_REPAYMENT_IN',
            'INTEREST_IN', 'INVESTMENT_RETURN', 'TRANSFER_IN', 'OTHER_INCOME',
            'SAVINGS_DEPOSIT_IN', 'TRANSFER_OUT', 'LOAN_DISBURSED',
            'LOAN_REPAYMENT_OUT', 'INTEREST_OUT', 'EXPENSE',
            'SAVINGS_HANDOUT_OUT', 'GRANT_REFUND', 'SIDE_FUND_CONTRIBUTION_IN',
            'SIDE_FUND_DIRECT_IN', 'SAVINGS_POOL_OTHER_IN'
        ));
END $$;

-- 4. New table: savings_pool_inflows
CREATE TABLE IF NOT EXISTS savings_pool_inflows (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER REFERENCES references_registry(id),
    account_id     INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    category_id    INTEGER       NOT NULL REFERENCES categories(id),
    amount         NUMERIC(20,4) NOT NULL,
    value_date     DATE          NOT NULL,
    description    TEXT          NOT NULL,
    status         VARCHAR(20)   NOT NULL DEFAULT 'PENDING_APPROVAL'
                   CHECK (status IN ('PENDING_APPROVAL','ACTIVE','REJECTED')),
    recorded_by    INTEGER       NOT NULL REFERENCES users(id),
    approved_by    INTEGER REFERENCES users(id),
    approved_at    TIMESTAMPTZ,
    review_notes   TEXT,
    transaction_id INTEGER REFERENCES transactions(id),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_savings_pool_inflow CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_savings_pool_inflows_status ON savings_pool_inflows (status);

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend.
--   2. Go to Accounts and set up the SAVINGS account (one-time, same
--      form as setting up the Primary account). Until this exists,
--      new savings deposits will be rejected with "Savings account
--      has not been set up yet."
--   3. IMPORTANT — existing data: any savings deposits/handouts
--      recorded before this migration are still linked to whatever
--      account they were posted against at the time (almost
--      certainly the Primary account) — this migration does NOT
--      retroactively move historical transactions or balances. Only
--      NEW savings activity after you set up the SAVINGS account will
--      flow through it. If you want old savings balances physically
--      moved out of Primary and into the new SAVINGS account, do that
--      as a deliberate one-off transfer/adjustment — do not attempt
--      it by editing rows directly.
--   4. Floor limits: every account (Treasurer/Assistant Treasurer)
--      can now have its own floor limit set from Accounts > [account]
--      > Floor Limit, except the SAVINGS account which is always
--      exempt.
--   5. Side Fund: Treasurer/Assistant Treasurer can now add a
--      direct/batch top-up (not tied to a member) from the Side Fund
--      page.
--   6. Savings "other inflow" (e.g. investment profit returned to the
--      pool) uses the existing SAVINGS_CREATE/SAVINGS_APPROVE
--      permissions — anyone already granted those can use it, no new
--      permission to grant.
-- ------------------------------------------------------------
