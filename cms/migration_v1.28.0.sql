-- ============================================================
-- MIGRATION v1.28.0 — MONEY MARKET FUND (MMF) SUB-ACCOUNTS
--                    + CHART OF ACCOUNTS PAGE
--
-- Adds support for Money Market Fund sub-accounts (Section 4.31):
-- a company can place part of an existing account's balance into
-- one or more MMF sub-accounts. Money moved into an MMF stops
-- counting toward its parent account's real/spendable balance (it's
-- genuinely gone from that account, sitting with the MMF provider),
-- but is tracked in its own running balance here — principal in,
-- minus withdrawals, plus manually-recorded monthly interest, minus
-- its one allowed expense (a management fee). A withdrawal credits
-- the money back to the parent account for real. Multiple MMFs are
-- allowed at once, each tied to exactly one parent account.
--
-- Also adds the two permission codes (MMF_VIEW, MMF_MANAGE) needed
-- for the new module, and widens transactions.inflow_type so an MMF
-- top-up/withdrawal posts as its own traceable type.
--
-- The Chart of Accounts page (Section 4.32) needs no schema change —
-- it's a read-only aggregation across tables that already exist.
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. mmf_accounts
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS mmf_accounts (
    id                     SERIAL PRIMARY KEY,
    reference_id           INTEGER       NOT NULL REFERENCES references_registry(id),
    parent_account_id      INTEGER       NOT NULL REFERENCES accounts(id),
    name                   VARCHAR(200)  NOT NULL,
    provider               VARCHAR(200),
    description            TEXT,
    currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    current_balance        NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_principal_in     NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_withdrawn        NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_interest         NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_management_fees  NUMERIC(20,4) NOT NULL DEFAULT 0,
    status                 VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'CLOSED')),
    opened_date            DATE          NOT NULL DEFAULT CURRENT_DATE,
    closed_date            DATE,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by             INTEGER       NOT NULL REFERENCES users(id)
);

-- ----------------------------------------------------------
-- 2. mmf_transactions
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS mmf_transactions (
    id               SERIAL PRIMARY KEY,
    reference_id     INTEGER       NOT NULL REFERENCES references_registry(id),
    mmf_account_id   INTEGER       NOT NULL REFERENCES mmf_accounts(id),
    transaction_id   INTEGER REFERENCES transactions(id),
    entry_type       VARCHAR(20)   NOT NULL
                     CHECK (entry_type IN ('TOPUP', 'WITHDRAWAL', 'INTEREST', 'MANAGEMENT_FEE')),
    amount           NUMERIC(20,4) NOT NULL,
    interest_period  DATE,
    description      TEXT,
    entry_date       DATE          NOT NULL,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by       INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_mmf_txn_amount CHECK (amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mmf_interest_period_unique
    ON mmf_transactions (mmf_account_id, interest_period)
    WHERE entry_type = 'INTEREST';

CREATE INDEX IF NOT EXISTS idx_mmf_transactions_account ON mmf_transactions (mmf_account_id);
CREATE INDEX IF NOT EXISTS idx_mmf_accounts_parent      ON mmf_accounts (parent_account_id);

-- ----------------------------------------------------------
-- 3. Widen transactions.inflow_type
-- ----------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check
        CHECK (inflow_type IN (
            'CONTRIBUTION', 'GRANT', 'LOAN_RECEIVED', 'LOAN_REPAYMENT_IN',
            'INTEREST_IN', 'INVESTMENT_RETURN', 'TRANSFER_IN', 'OTHER_INCOME',
            'SAVINGS_DEPOSIT_IN', 'TRANSFER_OUT', 'LOAN_DISBURSED',
            'LOAN_REPAYMENT_OUT', 'INTEREST_OUT', 'EXPENSE', 'SAVINGS_HANDOUT_OUT',
            'GRANT_REFUND', 'SIDE_FUND_CONTRIBUTION_IN', 'SIDE_FUND_DIRECT_IN',
            'SAVINGS_POOL_OTHER_IN', 'SERVICE_FEE_OUT', 'SERVICE_REIMBURSEMENT_OUT',
            'DIVIDEND_OUT', 'DIVIDEND_SAVINGS_IN',
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN'
        ));
END $$;

-- ----------------------------------------------------------
-- 4. New permissions
-- ----------------------------------------------------------
INSERT INTO permissions (code, module, description) VALUES
    ('MMF_VIEW',   'INVESTMENTS', 'View Money Market Fund sub-accounts and their performance'),
    ('MMF_MANAGE', 'INVESTMENTS', 'Create/close MMF sub-accounts and record top-ups, withdrawals, interest and management fees')
ON CONFLICT (code) DO NOTHING;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
-- Grant MMF_VIEW / MMF_MANAGE to whichever roles should use this
-- (Treasurer/Admin, typically) via Settings > Roles > Permissions —
-- new permissions are never auto-granted to any role, including
-- Admin, same as every other permission in this system.
-- ------------------------------------------------------------
