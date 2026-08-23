-- ============================================================
-- MIGRATION v1.39.0 — PAYMENT CONFIRMATIONS
-- ============================================================
-- Treasury can now post a "you received this money" entry to any
-- active user in the system, stating how it was paid (Cash, Bank
-- Transfer, or Mobile Money — MTN/Airtel/Other — with a transaction
-- ID required for Bank Transfer/Mobile Money). Unlike
-- payment_acknowledgements (which is always created the instant a
-- payment has ALREADY posted, purely as a post-hoc paper trail),
-- this is the opposite order: the entry is created FIRST, and the
-- real transaction is only posted once the recipient confirms it.
-- If the recipient disputes it instead, no transaction is ever
-- created — Treasury cancels the entry and reissues a corrected one.
--
-- Also used to replace Service Fees' old instant-post payment flow
-- (serviceFeesController.recordPayment) — a service fee payment now
-- goes through this same pending-until-confirmed flow, source_type
-- 'SERVICE_FEE_PAYMENT', rather than posting immediately.
--
-- Idempotent — safe to run more than once.
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_confirmations (
    id                     SERIAL PRIMARY KEY,
    reference_id           INTEGER       NOT NULL REFERENCES references_registry(id),
    source_type            VARCHAR(20)   NOT NULL
                           CHECK (source_type IN ('GENERAL_PAYMENT', 'SERVICE_FEE_PAYMENT')),
    source_id              INTEGER,
    account_id             INTEGER       NOT NULL REFERENCES accounts(id),
    category_id            INTEGER       NOT NULL REFERENCES categories(id),
    payer_id               INTEGER       NOT NULL REFERENCES users(id),
    recipient_id           INTEGER       NOT NULL REFERENCES users(id),
    amount                 NUMERIC(20,4) NOT NULL,
    currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    payment_method         VARCHAR(20)   NOT NULL
                           CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'MOBILE_MONEY')),
    mobile_money_provider  VARCHAR(20)
                           CHECK (mobile_money_provider IN ('MTN', 'AIRTEL', 'OTHER')),
    external_reference     VARCHAR(100),
    purpose                TEXT          NOT NULL,
    entry_date             DATE          NOT NULL,
    status                 VARCHAR(20)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                           CHECK (status IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED', 'CANCELLED')),
    transaction_id         INTEGER REFERENCES transactions(id),
    confirmation_note      TEXT,
    confirmed_at           TIMESTAMPTZ,
    dispute_reason         TEXT,
    disputed_at            TIMESTAMPTZ,
    cancellation_reason    TEXT,
    cancelled_by           INTEGER REFERENCES users(id),
    cancelled_at           TIMESTAMPTZ,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_payment_confirmation_amount CHECK (amount > 0),
    CONSTRAINT valid_mobile_money_provider CHECK (
        (payment_method = 'MOBILE_MONEY' AND mobile_money_provider IS NOT NULL) OR
        (payment_method != 'MOBILE_MONEY' AND mobile_money_provider IS NULL)
    ),
    CONSTRAINT valid_payment_confirmation_reference CHECK (
        (payment_method = 'CASH' AND external_reference IS NULL) OR
        (payment_method IN ('BANK_TRANSFER', 'MOBILE_MONEY')
            AND external_reference IS NOT NULL AND length(trim(external_reference)) > 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_payment_confirmations_recipient ON payment_confirmations (recipient_id);
CREATE INDEX IF NOT EXISTS idx_payment_confirmations_status    ON payment_confirmations (status);
CREATE INDEX IF NOT EXISTS idx_payment_confirmations_source    ON payment_confirmations (source_type, source_id);

-- Widen transactions.inflow_type for the one genuinely new value this
-- feature introduces (SERVICE_FEE_OUT already exists and is reused
-- for confirmed SERVICE_FEE_PAYMENT entries).
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
            'GENERAL_PAYMENT_OUT'
        ));
END $$;

-- Permissions are deliberately NOT duplicated here — this feature
-- reuses the existing PAYMENT_ACK_VIEW / PAYMENT_ACK_MANAGE
-- permissions (already seeded by migration_v1.30.0.sql), since it
-- lives in the same Payment Acknowledgements page/module.
