-- ============================================================
-- MIGRATION v1.53.0 — Service Fee self-service payment requests and
-- advances, plus richer transaction descriptions across every
-- Payment Confirmations flow.
--
-- 1. payment_confirmations.source_type gains 'SERVICE_FEE_ADVANCE' —
--    an advance disbursement against a service fee agreement,
--    recovered from future months rather than tied to any specific
--    already-earned period the way SERVICE_FEE_PAYMENT is.
--
-- 2. transactions.inflow_type gains 'SERVICE_FEE_ADVANCE_OUT'.
--
-- 3. service_fee_payment_requests / service_fee_payment_request_periods
--    — the contracted person's own self-service request to be paid
--    for one or more already-unpaid months (a single lump sum if more
--    than one). Approving one creates a normal payment_confirmations
--    entry through the exact same two-step flow a Treasurer-initiated
--    payment already uses.
--
-- 4. service_fee_advances / service_fee_advance_recoveries — an
--    advance request; once approved and its disbursement confirmed
--    received, it's recovered in full from the very next unpaid
--    month(s), oldest-future-first, as an internal accounting offset
--    (period.amount_paid incremented, no separate transaction) —
--    editable by the Treasurer at approval time before it's applied.
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied.
-- ============================================================

DO $$
DECLARE
    con_name text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'payment_confirmations'::regclass
        AND pg_get_constraintdef(oid) LIKE '%SERVICE_FEE_ADVANCE%'
    ) THEN
        SELECT conname INTO con_name
        FROM   pg_constraint
        WHERE  conrelid = 'payment_confirmations'::regclass
        AND    pg_get_constraintdef(oid) LIKE '%source_type%';
        IF con_name IS NOT NULL THEN
            EXECUTE 'ALTER TABLE payment_confirmations DROP CONSTRAINT ' || quote_ident(con_name);
        END IF;
        ALTER TABLE payment_confirmations
            ADD CONSTRAINT payment_confirmations_source_type_check
            CHECK (source_type IN ('GENERAL_PAYMENT', 'SERVICE_FEE_PAYMENT', 'SERVICE_FEE_ADVANCE'));
    END IF;
END $$;

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
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN',
            'DEPOSIT_CONTRIBUTION_IN', 'DEPOSIT_REFUND_OUT',
            'GENERAL_PAYMENT_OUT',
            'SERVICE_FEE_ADVANCE_OUT'
        ));
END $$;

CREATE TABLE IF NOT EXISTS service_fee_payment_requests (
    id              SERIAL PRIMARY KEY,
    agreement_id    INTEGER     NOT NULL REFERENCES service_fee_agreements(id),
    requested_by    INTEGER     NOT NULL REFERENCES users(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    notes           TEXT,
    reviewed_by     INTEGER REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    review_notes    TEXT,
    confirmation_id INTEGER REFERENCES payment_confirmations(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_fee_payment_request_periods (
    id         SERIAL PRIMARY KEY,
    request_id INTEGER       NOT NULL REFERENCES service_fee_payment_requests(id),
    period_id  INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount     NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    UNIQUE (request_id, period_id)
);

CREATE TABLE IF NOT EXISTS service_fee_advances (
    id                   SERIAL PRIMARY KEY,
    agreement_id         INTEGER       NOT NULL REFERENCES service_fee_agreements(id),
    amount               NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    reason               TEXT          NOT NULL,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    requested_by         INTEGER       NOT NULL REFERENCES users(id),
    reviewed_by          INTEGER REFERENCES users(id),
    reviewed_at          TIMESTAMPTZ,
    review_notes         TEXT,
    confirmation_id      INTEGER REFERENCES payment_confirmations(id),
    outstanding_balance  NUMERIC(20,4) NOT NULL DEFAULT 0,
    disbursed_at         TIMESTAMPTZ,
    transaction_id       INTEGER REFERENCES transactions(id),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_fee_advance_recoveries (
    id          SERIAL PRIMARY KEY,
    advance_id  INTEGER       NOT NULL REFERENCES service_fee_advances(id),
    period_id   INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount      NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    applied_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (advance_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_service_fee_payment_requests_agreement ON service_fee_payment_requests (agreement_id);
CREATE INDEX IF NOT EXISTS idx_service_fee_payment_requests_status    ON service_fee_payment_requests (status);
CREATE INDEX IF NOT EXISTS idx_service_fee_payment_request_periods_request ON service_fee_payment_request_periods (request_id);
CREATE INDEX IF NOT EXISTS idx_service_fee_advances_agreement         ON service_fee_advances (agreement_id);
CREATE INDEX IF NOT EXISTS idx_service_fee_advances_status            ON service_fee_advances (status);
CREATE INDEX IF NOT EXISTS idx_service_fee_advance_recoveries_advance ON service_fee_advance_recoveries (advance_id);
CREATE INDEX IF NOT EXISTS idx_service_fee_advance_recoveries_period  ON service_fee_advance_recoveries (period_id);
