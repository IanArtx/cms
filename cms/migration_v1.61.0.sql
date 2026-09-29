-- ============================================================
-- MIGRATION v1.61.0 — Multi-Currency Savings
--
-- Requested directly: "i would also like that the savings account have
-- allowance to hold multiple currencies. This should work in a way
-- that members can hold and receive money dependent on the currency
-- it comes in and out. the money come be transferred within the
-- savings account at an exchange rate just like the normal transfer
-- except that no charges apply here. any transactions in the savings
-- account also should follow a currency based manner."
--
-- Three clarifying questions were asked and answered, all recommended
-- options chosen:
--   - Architecture: ONE SAVINGS ACCOUNT PER CURRENCY (was: exactly one,
--     ever) — mirrors how Primary/Secondary accounts already work.
--   - Approval flow for an internal currency conversion: Treasurer
--     enters it, member confirms — same shape as Savings-to-Capital
--     Conversion (v1.58.0).
--   - Scope: FLEXIBLE running balances only — a FIXED_TERM deposit is
--     already a point-in-time lump sum in its own fixed currency and
--     is left untouched by this migration.
--
-- What this migration does:
--   1. Widens "exactly one active SAVINGS account" to "one active
--      SAVINGS account per currency".
--   2. Widens savings_balances from one row per member to one row per
--      (member, currency) — currency_id becomes NOT NULL.
--   3. Widens savings_interest_accrual the same way, so the daily
--      accrual job can credit each currency's balance separately.
--   4. Creates savings_currency_conversions — the new internal
--      "convert my own savings from one currency I hold into another"
--      action, at a manually-entered rate, no charges.
--   5. Widens transactions.inflow_type with the new conversion pair
--      and extends the GL mapping (both legs stay inside the savings
--      pool's own liability account, 2100).
--   6. Adds the new SAVINGS_CURRENCY_CONVERT_CREATE permission.
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied. Existing single-currency data is preserved
-- exactly as-is (a member's one existing savings_balances row simply
-- becomes their one row for whatever currency it was already in).
-- ============================================================

-- ------------------------------------------------------------
-- 1. One SAVINGS account per currency (was: exactly one, ever)
-- ------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_one_savings_account') THEN
        DROP INDEX idx_one_savings_account;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_one_savings_account_per_currency') THEN
        CREATE UNIQUE INDEX idx_one_savings_account_per_currency
            ON accounts (account_type, currency_id)
            WHERE account_type = 'SAVINGS' AND is_active = TRUE;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 2. savings_balances: one row per (user, currency), currency_id
--    NOT NULL. Existing rows already carry a real currency_id in
--    practice (every write path sets it), but back-fill defensively
--    from the (at-the-time singleton) SAVINGS account just in case.
-- ------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM savings_balances WHERE currency_id IS NULL
    ) THEN
        UPDATE savings_balances
        SET    currency_id = (
            SELECT id FROM accounts
            WHERE  account_type = 'SAVINGS' AND is_active = TRUE
            ORDER BY id LIMIT 1
        )
        WHERE  currency_id IS NULL;
    END IF;
END $$;

DO $$
BEGIN
    -- Drop the old one-row-per-user UNIQUE constraint, whatever
    -- Postgres auto-named it, if it's still there.
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'savings_balances'::regclass
        AND   contype = 'u'
        AND   pg_get_constraintdef(oid) = 'UNIQUE (user_id)'
    ) THEN
        EXECUTE (
            SELECT 'ALTER TABLE savings_balances DROP CONSTRAINT ' || quote_ident(conname)
            FROM   pg_constraint
            WHERE  conrelid = 'savings_balances'::regclass
            AND    contype = 'u'
            AND    pg_get_constraintdef(oid) = 'UNIQUE (user_id)'
        );
    END IF;

    -- currency_id NOT NULL — only if the backfill above left nothing behind.
    IF NOT EXISTS (SELECT 1 FROM savings_balances WHERE currency_id IS NULL) THEN
        ALTER TABLE savings_balances ALTER COLUMN currency_id SET NOT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'savings_balances'::regclass
        AND   contype = 'u'
        AND   pg_get_constraintdef(oid) = 'UNIQUE (user_id, currency_id)'
    ) THEN
        ALTER TABLE savings_balances ADD CONSTRAINT savings_balances_user_id_currency_id_key UNIQUE (user_id, currency_id);
    END IF;
END $$;

-- ------------------------------------------------------------
-- 3. savings_interest_accrual: add currency_id, back-filled from
--    each user's (pre-migration, singleton) savings_balances row,
--    then re-key the daily-uniqueness constraint to include it.
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'savings_interest_accrual' AND column_name = 'currency_id'
    ) THEN
        ALTER TABLE savings_interest_accrual ADD COLUMN currency_id INTEGER REFERENCES currencies(id);
    END IF;
END $$;

UPDATE savings_interest_accrual sia
SET    currency_id = sb.currency_id
FROM   savings_balances sb
WHERE  sia.currency_id IS NULL
AND    sb.user_id = sia.user_id;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM savings_interest_accrual WHERE currency_id IS NULL) THEN
        ALTER TABLE savings_interest_accrual ALTER COLUMN currency_id SET NOT NULL;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'savings_interest_accrual'::regclass
        AND   contype = 'u'
        AND   pg_get_constraintdef(oid) = 'UNIQUE (user_id, accrual_date)'
    ) THEN
        EXECUTE (
            SELECT 'ALTER TABLE savings_interest_accrual DROP CONSTRAINT ' || quote_ident(conname)
            FROM   pg_constraint
            WHERE  conrelid = 'savings_interest_accrual'::regclass
            AND    contype = 'u'
            AND    pg_get_constraintdef(oid) = 'UNIQUE (user_id, accrual_date)'
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'savings_interest_accrual'::regclass
        AND   contype = 'u'
        AND   pg_get_constraintdef(oid) = 'UNIQUE (user_id, currency_id, accrual_date)'
    ) THEN
        ALTER TABLE savings_interest_accrual
            ADD CONSTRAINT savings_interest_accrual_user_id_currency_id_accrual_date_key
            UNIQUE (user_id, currency_id, accrual_date);
    END IF;
END $$;

-- ------------------------------------------------------------
-- 4. New table — internal currency conversion within a member's own
--    savings. Manually-entered exchange rate (same convention as
--    transfers.exchange_rate), no bank charges (money never leaves
--    the club's own accounts). Treasurer enters, member confirms —
--    same shape as savings_capital_conversions.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_currency_conversions (
    id                          SERIAL PRIMARY KEY,
    reference_id                INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                     INTEGER       NOT NULL REFERENCES users(id),
    from_account_id             INTEGER       NOT NULL REFERENCES accounts(id),
    from_currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    from_amount                 NUMERIC(20,4) NOT NULL,
    to_account_id               INTEGER       NOT NULL REFERENCES accounts(id),
    to_currency_id              INTEGER       NOT NULL REFERENCES currencies(id),
    to_amount                   NUMERIC(20,4) NOT NULL,
    exchange_rate               NUMERIC(20,8) NOT NULL,
    exchange_rate_entered_by    INTEGER       NOT NULL REFERENCES users(id),
    conversion_date              DATE          NOT NULL,
    notes                        TEXT,
    status                       VARCHAR(30)   NOT NULL DEFAULT 'PENDING_CONFIRMATION'
                                 CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
    from_transaction_id          INTEGER REFERENCES transactions(id),
    to_transaction_id            INTEGER REFERENCES transactions(id),
    entered_by                   INTEGER       NOT NULL REFERENCES users(id),
    confirmed_at                 TIMESTAMPTZ,
    rejected_reason               TEXT,
    rejected_at                   TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_conversion_from_amount CHECK (from_amount > 0),
    CONSTRAINT positive_conversion_to_amount   CHECK (to_amount > 0),
    CONSTRAINT positive_conversion_rate        CHECK (exchange_rate > 0),
    CONSTRAINT conversion_different_currencies CHECK (from_currency_id != to_currency_id)
);

CREATE INDEX IF NOT EXISTS idx_savings_currency_conversions_user   ON savings_currency_conversions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_savings_currency_conversions_status ON savings_currency_conversions (status);

-- ------------------------------------------------------------
-- 5. Widen transactions.inflow_type with the new conversion pair.
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'transactions'::regclass
        AND pg_get_constraintdef(oid) LIKE '%SAVINGS_CURRENCY_CONV_OUT%'
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
                'SAVINGS_FINE_SETTLEMENT_OUT',
                'SAVINGS_CURRENCY_CONV_OUT', 'SAVINGS_CURRENCY_CONV_IN'
            ));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 6. GL mapping — both legs stay inside the savings pool's own
--    liability account (2100). Only applied if the GL feature
--    (v1.55.0) already exists on this database.
--    Note: values deliberately abbreviated ("CONV" not "CONVERSION")
--    to fit gl_inflow_type_mapping.inflow_type's VARCHAR(30) limit —
--    'SAVINGS_CURRENCY_CONVERSION_OUT' (31 chars) does not fit.
-- ------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gl_inflow_type_mapping') THEN
        INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
        SELECT v.inflow_type, ga.id, v.notes
        FROM (VALUES
            ('SAVINGS_CURRENCY_CONV_OUT', '2100', 'Money leaving one currency''s Savings account as part of an internal currency conversion — same liability account as SAVINGS_HANDOUT_OUT, since it is still the member''s own savings, just changing currency.'),
            ('SAVINGS_CURRENCY_CONV_IN',  '2100', 'The matching credit into the destination currency''s Savings account for the same internal conversion — same liability account as SAVINGS_DEPOSIT_IN.')
        ) AS v(inflow_type, gl_code, notes)
        JOIN gl_accounts ga ON ga.code = v.gl_code
        ON CONFLICT (inflow_type) DO NOTHING;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 7. New permission.
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, description) VALUES
    ('SAVINGS_CURRENCY_CONVERT_CREATE', 'FINANCE', 'Convert a member''s own savings from one currency they hold into another, pending the member''s own confirmation (v1.61.0)')
ON CONFLICT (code) DO NOTHING;

-- Informational only, safe to ignore: lists every currency that
-- currently has NO SAVINGS account yet, based on currencies already
-- in use elsewhere in the system (Primary/Secondary accounts, or any
-- existing savings_balances row) — a pointer to which SAVINGS
-- accounts may be worth setting up next, now that more than one can
-- exist. Nothing is created automatically; Accounts remains a manual,
-- deliberate action (Section 4.1 / 4.11).
SELECT DISTINCT c.id, c.code, c.name
FROM   currencies c
WHERE  (
    EXISTS (SELECT 1 FROM accounts a WHERE a.currency_id = c.id AND a.is_active = TRUE)
    OR EXISTS (SELECT 1 FROM savings_balances sb WHERE sb.currency_id = c.id)
)
AND NOT EXISTS (
    SELECT 1 FROM accounts sa
    WHERE sa.account_type = 'SAVINGS' AND sa.is_active = TRUE AND sa.currency_id = c.id
);
