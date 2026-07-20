-- ============================================================
-- MIGRATION v1.10.0 — MEMBER SAVINGS REWORK
--
-- The original member_savings feature (v1.2.0) was a fixed-term,
-- self-service deposit certificate: whoever created it became the
-- owner, no approval was required, and the payout amount was locked
-- in upfront based on a fixed maturity date. That's kept working
-- unchanged for any existing rows (tagged entry_type = FIXED_TERM
-- below) — nothing is deleted or renamed.
--
-- Alongside it, this migration adds a second, FLEXIBLE entry type:
-- an ongoing per-member savings balance that grows from many deposits
-- over time, earns interest automatically at a single company-wide
-- rate (savings_settings), and pays out via a two-actor "handout"
-- flow instead of a lump-sum withdrawal:
--   1. DEPOSIT — entered directly by the Treasurer/Assistant Treasurer
--      on behalf of any member, OR requested by the member themself
--      via a new SAVINGS_DEPOSIT requisition. Either way it sits
--      PENDING_APPROVAL until a Treasurer/Assistant Treasurer approves
--      it — that approval is what posts the crediting transaction and
--      adds it to the member's running balance.
--   2. HANDOUT — entered by the Treasurer/Assistant Treasurer (principal
--      + an interest amount pre-filled from the member's accrued
--      interest, adjustable). Nothing is paid out yet — the receiving
--      member must confirm it themselves before the debit transaction
--      posts and their balance drops. They can also reject/dispute it.
--
-- New tables: savings_settings, savings_balances,
--             savings_interest_accrual, savings_handouts
-- Altered tables: member_savings (new columns, relaxed NOT NULLs,
--             widened status list), requisitions (new request type)
-- New permissions: SAVINGS_VIEW, SAVINGS_CREATE, SAVINGS_APPROVE,
--             SAVINGS_HANDOUT_CREATE, SAVINGS_SETTINGS_MANAGE
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Company-wide savings interest settings (singleton, id=1)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_settings (
    id                    SERIAL PRIMARY KEY,
    interest_rate         NUMERIC(8,4)  NOT NULL DEFAULT 0,
    interest_period       VARCHAR(20)   NOT NULL DEFAULT 'ANNUALLY'
                          CHECK (interest_period IN ('DAILY','WEEKLY','MONTHLY','ANNUALLY')),
    interest_calculation  VARCHAR(20)   NOT NULL DEFAULT 'SIMPLE'
                          CHECK (interest_calculation IN ('SIMPLE','COMPOUND')),
    updated_by            INTEGER REFERENCES users(id),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO savings_settings (id, interest_rate, interest_period, interest_calculation)
VALUES (1, 0, 'ANNUALLY', 'SIMPLE')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Running per-member FLEXIBLE savings balance
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_balances (
    id                   SERIAL PRIMARY KEY,
    user_id              INTEGER       NOT NULL UNIQUE REFERENCES users(id),
    principal_balance    NUMERIC(20,4) NOT NULL DEFAULT 0,
    accrued_interest     NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_interest_paid  NUMERIC(20,4) NOT NULL DEFAULT 0,
    currency_id          INTEGER REFERENCES currencies(id),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_savings_balance  CHECK (principal_balance >= 0),
    CONSTRAINT non_negative_accrued_interest CHECK (accrued_interest >= 0)
);

-- ------------------------------------------------------------
-- 3. Daily interest accrual ledger (mirrors loan_received_interest_accrual)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_interest_accrual (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    accrual_date       DATE          NOT NULL,
    rate_used          NUMERIC(8,4)  NOT NULL,
    principal_balance  NUMERIC(20,4) NOT NULL,
    interest_accrued   NUMERIC(20,4) NOT NULL,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, accrual_date)
);

-- ------------------------------------------------------------
-- 4. Extend member_savings for the new FLEXIBLE / approval-gated model
-- ------------------------------------------------------------
ALTER TABLE member_savings ALTER COLUMN maturity_date DROP NOT NULL;
ALTER TABLE member_savings ALTER COLUMN amount_at_maturity DROP NOT NULL;
ALTER TABLE member_savings ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE member_savings
    ADD COLUMN IF NOT EXISTS entry_type VARCHAR(20) NOT NULL DEFAULT 'FLEXIBLE'
        CHECK (entry_type IN ('FIXED_TERM','FLEXIBLE')),
    ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'TREASURY_DIRECT'
        CHECK (source IN ('TREASURY_DIRECT','REQUISITION')),
    ADD COLUMN IF NOT EXISTS requisition_id INTEGER REFERENCES requisitions(id),
    ADD COLUMN IF NOT EXISTS recorded_by INTEGER REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS secretary_approved_by INTEGER REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS secretary_approved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- Backfill: every row that existed before this migration was created
-- under the old fixed-term-only flow, so it always has a maturity_date.
-- Tag those as FIXED_TERM (the default above is FLEXIBLE, for new rows
-- created after this migration) and record who entered it as themself,
-- matching the old self-service behaviour exactly.
UPDATE member_savings
SET    entry_type  = 'FIXED_TERM',
       recorded_by = created_by
WHERE  maturity_date IS NOT NULL
AND    entry_type = 'FLEXIBLE';

-- Relax the maturity_after_deposit check to allow NULL (FLEXIBLE rows)
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'member_savings'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%maturity_date%deposit_date%';
    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE member_savings DROP CONSTRAINT %I', con_name);
    END IF;
END $$;

ALTER TABLE member_savings ADD CONSTRAINT maturity_after_deposit
    CHECK (maturity_date IS NULL OR maturity_date > deposit_date);

-- Widen the status list to include the new approval states
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'member_savings'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%status%ACTIVE%WITHDRAWN%';
    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE member_savings DROP CONSTRAINT %I', con_name);
    END IF;
END $$;

ALTER TABLE member_savings ADD CONSTRAINT member_savings_status_check
    CHECK (status IN ('PENDING_APPROVAL','ACTIVE','WITHDRAWN','REJECTED','CANCELLED'));

-- ------------------------------------------------------------
-- 5. Savings handouts — two-actor payout flow for FLEXIBLE savings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_handouts (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id           INTEGER       NOT NULL REFERENCES users(id),
    account_id        INTEGER       NOT NULL REFERENCES accounts(id),
    principal_amount  NUMERIC(20,4) NOT NULL,
    interest_amount   NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_amount      NUMERIC(20,4) NOT NULL,
    currency_id       INTEGER       NOT NULL REFERENCES currencies(id),
    handout_date      DATE          NOT NULL,
    notes             TEXT,
    status            VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                      CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
    transaction_id    INTEGER REFERENCES transactions(id),
    entered_by        INTEGER       NOT NULL REFERENCES users(id),
    confirmed_at      TIMESTAMPTZ,
    rejected_reason   TEXT,
    rejected_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_handout_principal CHECK (principal_amount > 0),
    CONSTRAINT positive_handout_total     CHECK (total_amount > 0)
);

-- ------------------------------------------------------------
-- 6a. Transactions: dedicated inflow_type values for savings, so
--     deposits/handouts are traceable in reports instead of hiding
--     under the generic OTHER_INCOME/EXPENSE buckets.
-- ------------------------------------------------------------
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
        EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', con_name);
    END IF;
END $$;

ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check
    CHECK (inflow_type IN (
        'CONTRIBUTION', 'GRANT', 'LOAN_RECEIVED', 'LOAN_REPAYMENT_IN',
        'INTEREST_IN', 'INVESTMENT_RETURN', 'TRANSFER_IN', 'OTHER_INCOME',
        'SAVINGS_DEPOSIT_IN', 'TRANSFER_OUT', 'LOAN_DISBURSED',
        'LOAN_REPAYMENT_OUT', 'INTEREST_OUT', 'EXPENSE',
        'SAVINGS_HANDOUT_OUT', 'GRANT_REFUND'
    ));

-- ------------------------------------------------------------
-- 6b. Requisitions: allow SAVINGS_DEPOSIT as a request type
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'requisitions'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%requisition_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE requisitions DROP CONSTRAINT %I', con_name);
    END IF;
END $$;

ALTER TABLE requisitions ADD CONSTRAINT requisitions_requisition_type_check
    CHECK (requisition_type IN ('EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT'));

-- ------------------------------------------------------------
-- 7. New permissions
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, description) VALUES
    ('SAVINGS_VIEW',            'FINANCE', 'View all members'' savings records'),
    ('SAVINGS_CREATE',          'FINANCE', 'Record a savings deposit on behalf of a member'),
    ('SAVINGS_APPROVE',         'FINANCE', 'Approve a pending savings deposit (Treasurer/Assistant Treasurer)'),
    ('SAVINGS_HANDOUT_CREATE',  'FINANCE', 'Enter a savings handout for a member (Treasurer)'),
    ('SAVINGS_SETTINGS_MANAGE', 'FINANCE', 'Change the company-wide savings interest rate')
ON CONFLICT (code) DO NOTHING;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend so it
--      picks up the code changes deployed alongside this migration.
--   2. Go to Settings > Roles & Permissions and grant the five new
--      SAVINGS_* permissions to the right roles — suggested:
--        - SAVINGS_VIEW            -> Treasurer, Assistant Treasurer, Director
--        - SAVINGS_CREATE          -> Treasurer, Assistant Treasurer
--        - SAVINGS_APPROVE         -> Treasurer, Assistant Treasurer
--        - SAVINGS_HANDOUT_CREATE  -> Treasurer, Assistant Treasurer
--        - SAVINGS_SETTINGS_MANAGE -> Admin, Treasurer
--      Nothing works for anyone until these are granted — permissions
--      are never auto-assigned by a migration.
--   3. Go to Settings (or the new Savings page, if you added a settings
--      panel there) and set the company-wide savings interest rate —
--      it starts at 0% until you do.
--   4. Existing savings records (if any) keep working exactly as before
--      — they're now tagged "Fixed-Term" and still use the old
--      lump-sum withdrawal-at-maturity flow. All new deposits going
--      forward use the new flexible balance + approval flow.
--   5. If cms_user doesn't already have full rights on changed tables
--      via an admin/pgAdmin connection, re-run:
--        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_user;
--        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cms_user;
-- ------------------------------------------------------------
