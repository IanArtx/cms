-- ============================================================
-- MIGRATION v1.38.0 — MEMBER DEPOSIT TRACKING
-- ============================================================
-- Deposits are a per-member tracking counter, NOT a separate envelope
-- like the Side Fund: money posted for a deposit is a normal
-- transaction into whichever real account it was recorded against —
-- fully spendable/commingled through that account, per the brief
-- ("this amount is held in the account it is parented by... it is
-- not separate therefore its amount is spendable through the parent
-- account. It is only there to track how much each member has as
-- deposit in the company."). It does not contribute to shareholding.
--
-- Funding: a contribution slice (mirroring the existing Side Fund /
-- Savings slice pattern on POST /transactions/contributions) AND a
-- standalone inflow entry — both share one crediting core.
--
-- Target: a single company-wide target_amount (deposit_config,
-- admin-updatable) that every member's own balance is compared
-- against — a member sitting below it is flagged, not blocked.
--
-- Exit: on leaving, a member's deposit is refunded (into Savings,
-- same two-leg posting shape as the Side Fund exit payout) with a
-- deduction — MUTUAL_AGREEMENT is always a fixed 5%; FORCED is
-- entered by the admin at the time of exit and must be >= 50%.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- deposit_config — singleton, the one company-wide target amount.
-- No parent_account_id (unlike side_fund_config) — deposits are
-- deliberately not siloed to one account.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_config (
    id            INTEGER       PRIMARY KEY DEFAULT 1,
    target_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    currency_id   INTEGER REFERENCES currencies(id),
    updated_by    INTEGER REFERENCES users(id),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT single_deposit_config_row     CHECK (id = 1),
    CONSTRAINT non_negative_deposit_target   CHECK (target_amount >= 0)
);
INSERT INTO deposit_config (id, target_amount) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- deposit_balances — running per-member total, normalized into
-- deposit_config's own currency at credit time (via
-- sharePricingService.getExchangeRateOn) so it can be compared
-- directly against the single company-wide target regardless of
-- which currency any individual deposit was actually posted in.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_balances (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    balance    NUMERIC(20,4) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_deposit_balance CHECK (balance >= 0)
);

-- ------------------------------------------------------------
-- deposit_excusals — "each shareholder's deposit amount cannot be
-- zero unless otherwise excused". Presence of a row = this member is
-- excused from that expectation (monitoring/reporting only — nothing
-- in the schema hard-blocks a balance from reaching zero, since the
-- only way it decreases is a deliberate one-time exit refund).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_excusals (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id),
    excused_by  INTEGER NOT NULL REFERENCES users(id),
    excused_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason      TEXT
);

-- ------------------------------------------------------------
-- deposit_entries — audit trail of every deposit credit, whichever
-- of the two entry points posted it. normalized_amount/
-- exchange_rate_used record exactly what was applied to
-- deposit_balances at the time, so the running total stays
-- reconstructable even if exchange rates change later.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_entries (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    source             VARCHAR(20)   NOT NULL CHECK (source IN ('CONTRIBUTION_SLICE', 'STANDALONE')),
    account_id         INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id     INTEGER REFERENCES transactions(id),
    amount             NUMERIC(20,4) NOT NULL,
    currency_id        INTEGER       NOT NULL REFERENCES currencies(id),
    normalized_amount  NUMERIC(20,4) NOT NULL,
    exchange_rate_used NUMERIC(20,8) NOT NULL DEFAULT 1,
    entry_date         DATE          NOT NULL,
    recorded_by        INTEGER       NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_deposit_entry_amount CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_deposit_entries_user ON deposit_entries (user_id, entry_date DESC);

-- ------------------------------------------------------------
-- deposit_exit_events — one row per exit refund. deduction_percentage
-- is locked to exactly 5 for MUTUAL_AGREEMENT, and must be >= 50 (up
-- to 100) for FORCED, entered by the admin at the time of exit —
-- exactly the rule specified: "5% is taken out for the mutual
-- agreement and forced the percentage is specified at entry and
-- cannot be less than 50%".
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_exit_events (
    id                    SERIAL PRIMARY KEY,
    user_id               INTEGER       NOT NULL REFERENCES users(id),
    exit_type             VARCHAR(20)   NOT NULL CHECK (exit_type IN ('MUTUAL_AGREEMENT', 'FORCED')),
    deduction_percentage  NUMERIC(5,2)  NOT NULL,
    gross_balance         NUMERIC(20,4) NOT NULL,
    deduction_amount      NUMERIC(20,4) NOT NULL,
    net_payout            NUMERIC(20,4) NOT NULL,
    source_account_id     INTEGER REFERENCES accounts(id),
    transaction_id        INTEGER REFERENCES transactions(id),
    payment_ack_id        INTEGER REFERENCES payment_acknowledgements(id),
    processed_by          INTEGER       NOT NULL REFERENCES users(id),
    processed_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    notes                 TEXT,
    CONSTRAINT valid_deposit_exit_deduction CHECK (
        (exit_type = 'MUTUAL_AGREEMENT' AND deduction_percentage = 5) OR
        (exit_type = 'FORCED' AND deduction_percentage >= 50 AND deduction_percentage <= 100)
    )
);
CREATE INDEX IF NOT EXISTS idx_deposit_exit_events_user ON deposit_exit_events (user_id, processed_at DESC);

-- ------------------------------------------------------------
-- Widen transactions.inflow_type — DEPOSIT_CONTRIBUTION_IN (the
-- credit leg of either entry point), DEPOSIT_REFUND_OUT (the debit
-- leg of an exit refund; the credit leg into Savings reuses the
-- existing SAVINGS_DEPOSIT_IN value, same as the Side Fund exit
-- payout already does).
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%';

    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', con_name);
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
            'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT'
        ));
END $$;

-- ------------------------------------------------------------
-- Widen payment_acknowledgements.source_type — DEPOSIT_REFUND, the
-- exit-refund's credit-into-Savings leg, same paper-trail pattern as
-- the Side Fund exit payout (SIDE_FUND_PAYOUT).
-- ------------------------------------------------------------
ALTER TABLE payment_acknowledgements
    DROP CONSTRAINT IF EXISTS payment_acknowledgements_source_type_check;
ALTER TABLE payment_acknowledgements
    ADD CONSTRAINT payment_acknowledgements_source_type_check
    CHECK (source_type IN (
        'DIVIDEND', 'SERVICE_FEE_PAYMENT', 'REIMBURSEMENT', 'SAVINGS_HANDOUT',
        'SIDE_FUND_PAYOUT', 'DEPOSIT_REFUND'
    ));

-- ------------------------------------------------------------
-- Permissions (ungranted by default, same convention as every other
-- new permission in this system).
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, description) VALUES
    ('DEPOSIT_VIEW',   'FINANCE', 'View every member''s deposit standing (Treasury oversight)'),
    ('DEPOSIT_MANAGE', 'FINANCE', 'Update the deposit target, record standalone deposits, manage excusals, and process exit refunds')
ON CONFLICT (code) DO NOTHING;
