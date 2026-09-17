-- ============================================================
-- MIGRATION v1.58.0 — Savings-to-Capital Conversion
--
-- Requested directly: "the treasurer can decide to take money out of
-- one's savings account and top it up to their capital contributions
-- with an approval... to post the money on the usable account funds."
--
-- A Treasurer/Assistant Treasurer can redirect a member's own savings
-- principal into a capital contribution instead of paying it out as
-- cash. New standalone flow (not a variant of the existing Handout
-- action, per the confirmed design decision) — the destination
-- differs (a capital contribution landing in the usable/operational
-- account, not a cash payout to the member) and it produces a second
-- record (shareholder_contributions) that also changes the member's
-- shares_held/percentage.
--
-- Same "Treasurer enters it, only the member's own confirmation
-- actually moves the money" shape as a Savings Handout — this is
-- still the member's own savings being redirected, so their agreement
-- is required before anything posts (confirmed design decision).
--
-- Confirming:
--   1. Debits the SAVINGS account (inflow_type SAVINGS_TO_CAPITAL_OUT)
--      and decrements savings_balances.principal_balance — identical
--      mechanics to confirmSavingsHandout.
--   2. Runs the ordinary creditShareholderContribution() flow into the
--      chosen destination account — same shareholding recalculation
--      and capital-goal auto-attribution as any other contribution.
--
-- The destination account must share the SAVINGS account's own
-- currency — enforced in the controller, not here — since this system
-- never silently blends or converts currencies (same convention
-- documented for every other cross-account flow: Transfers, Record
-- Contribution, etc.).
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS savings_capital_conversions (
    id                          SERIAL PRIMARY KEY,
    reference_id                INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                     INTEGER       NOT NULL REFERENCES users(id),
    account_id                  INTEGER       NOT NULL REFERENCES accounts(id),
    destination_account_id      INTEGER       NOT NULL REFERENCES accounts(id),
    category_id                 INTEGER       NOT NULL REFERENCES categories(id),
    amount                      NUMERIC(20,4) NOT NULL,
    currency_id                 INTEGER       NOT NULL REFERENCES currencies(id),
    conversion_date              DATE          NOT NULL,
    notes                        TEXT,
    status                       VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                                 CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
    savings_transaction_id       INTEGER REFERENCES transactions(id),
    contribution_id              INTEGER REFERENCES shareholder_contributions(id),
    contribution_transaction_id  INTEGER REFERENCES transactions(id),
    entered_by                   INTEGER       NOT NULL REFERENCES users(id),
    confirmed_at                 TIMESTAMPTZ,
    rejected_reason               TEXT,
    rejected_at                   TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_savings_capital_conversion_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_savings_capital_conversions_user   ON savings_capital_conversions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_savings_capital_conversions_status ON savings_capital_conversions (status);

-- Widen transactions.inflow_type with SAVINGS_TO_CAPITAL_OUT
DO $$
DECLARE
    con_name text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transactions'::regclass
        AND pg_get_constraintdef(oid) LIKE '%SAVINGS_TO_CAPITAL_OUT%'
    ) THEN
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
                'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
                'SIDE_FUND_PAYOUT_OUT',
                'FINE_PAYMENT_IN',
                'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT',
                'GENERAL_PAYMENT_OUT',
                'SERVICE_FEE_ADVANCE_OUT',
                'SAVINGS_TO_CAPITAL_OUT'
            ));
    END IF;
END $$;

-- GL mapping: same liability account (2100) as SAVINGS_HANDOUT_OUT.
-- Only applied if the GL feature (v1.55.0) already exists on this
-- database — a fresh install picks it up straight from schema.sql,
-- and an older database without gl_inflow_type_mapping yet simply
-- skips this (nothing to map into).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gl_inflow_type_mapping') THEN
        INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
        SELECT v.inflow_type, ga.id, v.notes
        FROM (VALUES
            ('SAVINGS_TO_CAPITAL_OUT', '2100', 'Same account as SAVINGS_HANDOUT_OUT — money leaving the savings pool, here reclassified into capital (3000) rather than paid out in cash.')
        ) AS v(inflow_type, gl_code, notes)
        JOIN gl_accounts ga ON ga.code = v.gl_code
        ON CONFLICT (inflow_type) DO NOTHING;
    END IF;
END $$;

-- New permission — NOT auto-assigned to any role (this database seeds
-- no role_permissions rows; every grant is made by hand in Settings ->
-- Roles & Permissions). Grant SAVINGS_CAPITAL_CONVERT_CREATE to
-- Treasurer/Assistant Treasurer after this migration runs.
INSERT INTO permissions (code, module, description) VALUES
    ('SAVINGS_CAPITAL_CONVERT_CREATE', 'FINANCE', 'Redirect a member''s savings principal into a capital contribution, pending the member''s own confirmation (v1.58.0)')
ON CONFLICT (code) DO NOTHING;
