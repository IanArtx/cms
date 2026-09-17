-- ============================================================
-- MIGRATION v1.59.0 — Settle Fines With Savings
--
-- Requested directly: "a similar set of actions can be taken that
-- fines can be settled with savings one has accumulated. From both
-- the shareholder's side (through requests) and treasurer's side (by
-- entry), one can select their outstanding balances / fines /
-- penalties / surcharges individually (not exceeding the amount in
-- their individual savings accounts), to pay up and the same approval
-- steps follow accordingly." Scoped to the existing Fines module
-- (contribution-failure, meeting-violation, and general fines) per
-- the confirmed answer to a clarifying question.
--
-- Two entry points, mirroring the Savings module's own established
-- shape:
--   1. Treasurer/Assistant Treasurer enters it directly on a member's
--      behalf (source=TREASURY_DIRECT) — sits PENDING_CONFIRMATION
--      until the member themselves confirms (same shape as a Savings
--      Handout / v1.58.0's Savings-to-Capital Conversion).
--   2. A member requests it themselves (source=MEMBER_REQUEST) — sits
--      PENDING_APPROVAL until a Treasurer/Assistant Treasurer approves
--      it (same shape as a self-service Savings Deposit requisition).
--
-- Settling debits the SAVINGS account once for the combined total,
-- then reuses finesService.clearFine() once per selected fine — the
-- exact same crediting core every other fine-clearing path already
-- shares. No new permission — reuses FINE_MANAGE (clearing a fine via
-- savings is still clearing a fine) for both the Treasury-direct entry
-- and the Treasurer's approve/deny of a member's request.
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS savings_fine_settlements (
    id                       SERIAL PRIMARY KEY,
    reference_id             INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                  INTEGER       NOT NULL REFERENCES users(id),
    account_id               INTEGER       NOT NULL REFERENCES accounts(id),
    destination_account_id   INTEGER       NOT NULL REFERENCES accounts(id),
    total_amount             NUMERIC(20,4) NOT NULL,
    currency_id              INTEGER       NOT NULL REFERENCES currencies(id),
    settlement_date           DATE          NOT NULL,
    notes                     TEXT,
    source                    VARCHAR(20)   NOT NULL
                              CHECK (source IN ('TREASURY_DIRECT','MEMBER_REQUEST')),
    status                    VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                              CHECK (status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL','SETTLED','REJECTED')),
    savings_transaction_id    INTEGER REFERENCES transactions(id),
    initiated_by              INTEGER       NOT NULL REFERENCES users(id),
    reviewed_by                INTEGER REFERENCES users(id),
    reviewed_at                TIMESTAMPTZ,
    review_notes                TEXT,
    created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_savings_fine_settlement_total CHECK (total_amount > 0)
);

CREATE TABLE IF NOT EXISTS savings_fine_settlement_items (
    id                   SERIAL PRIMARY KEY,
    settlement_id         INTEGER       NOT NULL REFERENCES savings_fine_settlements(id),
    fine_id               INTEGER       NOT NULL REFERENCES fines(id),
    amount                NUMERIC(20,4) NOT NULL,
    fine_transaction_id   INTEGER REFERENCES transactions(id),
    UNIQUE (settlement_id, fine_id)
);

CREATE INDEX IF NOT EXISTS idx_savings_fine_settlements_user   ON savings_fine_settlements (user_id, status);
CREATE INDEX IF NOT EXISTS idx_savings_fine_settlements_status ON savings_fine_settlements (status);
CREATE INDEX IF NOT EXISTS idx_savings_fine_settlement_items_settlement ON savings_fine_settlement_items (settlement_id);
CREATE INDEX IF NOT EXISTS idx_savings_fine_settlement_items_fine        ON savings_fine_settlement_items (fine_id);

-- Widen transactions.inflow_type with SAVINGS_FINE_SETTLEMENT_OUT
DO $$
DECLARE
    con_name text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transactions'::regclass
        AND pg_get_constraintdef(oid) LIKE '%SAVINGS_FINE_SETTLEMENT_OUT%'
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
                'SAVINGS_TO_CAPITAL_OUT',
                'SAVINGS_FINE_SETTLEMENT_OUT'
            ));
    END IF;
END $$;

-- GL mapping: same liability account (2100) as SAVINGS_HANDOUT_OUT /
-- SAVINGS_TO_CAPITAL_OUT. Only applied if the GL feature (v1.55.0)
-- already exists on this database.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gl_inflow_type_mapping') THEN
        INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
        SELECT v.inflow_type, ga.id, v.notes
        FROM (VALUES
            ('SAVINGS_FINE_SETTLEMENT_OUT', '2100', 'Same account as SAVINGS_HANDOUT_OUT/SAVINGS_TO_CAPITAL_OUT — money leaving the savings pool, here used to settle one or more fines (4400) instead of being paid out or converted to capital.')
        ) AS v(inflow_type, gl_code, notes)
        JOIN gl_accounts ga ON ga.code = v.gl_code
        ON CONFLICT (inflow_type) DO NOTHING;
    END IF;
END $$;

-- No new permission — reuses FINE_MANAGE (clearing a fine via savings
-- is still clearing a fine) for the Treasurer's direct entry AND for
-- approving/denying a member's own request.
