-- ============================================================
-- MIGRATION v1.70.0 — Tax: withholding tax (both directions),
-- corporate income tax, provisional tax, tax years, reminders,
-- and the accounting corrections the tax figures depend on.
--
-- Requested directly:
--   "walk me through how the system shall keep track of payable tax
--    and keep track of what is paid across all income streams WHT on
--    bonds and bills, corporate tax e.t.c."
--   "The URA has not yet designated the company as a withholding tax
--    agent but i would like the system to track it as though it were
--    true ... a toggle on-off button ... turning it off shouldn't
--    affect the tracking but rather a notice made in document to alert
--    all members of this change."
--   "the companies' TINs and Registration number be settable in
--    settings not hardcoded"
--   "as per now the service fees are termed as a necessary expense and
--    no ties with WHT, and if later any agreement is subject to this
--    structure, it should be amended to provide the entries"
-- Confirmed decisions:
--   1. The 6% agent WHT on suppliers/service fees is SHADOW-ONLY while
--      the company is not designated (recorded, no money held back).
--   2. The first tax year starts on the incorporation date; anything
--      dated before it is shown separately and only included if the
--      Treasurer ticks "include pre-incorporation" on that year.
--   3. Past entries are not rewritten; they are only RE-CLASSIFIED in
--      the reports (coupon tax, bond principal).
--   4. Treasury bill is a new investment type.
--   5. The Treasurer prepares the corporate tax computation; a Director
--      approves it.
--   + Each expense category carries a tax setting (DEDUCTIBLE /
--      NOT_DEDUCTIBLE / CAPITAL), overridable per transaction.
--
-- WHAT THIS ADDS (the logic lives in src/services/taxService.js and
-- src/services/glService.js):
--
--  1. company_settings — tin, registration_number, incorporation_date,
--     wht_agent_designated (+ effective date) and a history table
--     wht_agent_status_history. Each switch writes a notice to ALL
--     members (documents.audience = 'ALL_MEMBERS').
--  2. users.tin + users.tax_residency (RESIDENT / NON_RESIDENT) — the
--     rate withheld from a member's dividend or savings interest.
--  3. tax_rates — every rate the system uses, DATED (a change in the law
--     is a new row, old figures keep their old rate). Seeded from the
--     published Uganda rates (reviewed January 2026) — VERIFY them on
--     the Tax page > Rates before the first filing.
--  4. tax_at_source — tax deducted FROM the company by whoever paid it
--     (bond coupons, treasury bills, bank interest ...): gross, tax,
--     net, FINAL or CREDITABLE, certificate received.
--  5. wht_withholdings — tax the company deducts FROM others (dividends,
--     members' savings interest, interest to a non-resident lender,
--     service fees / suppliers under the 6% agent rule). Shadow rows
--     (is_shadow) are the "as if designated" records: no money held.
--  6. wht_remittances — the monthly payment of withheld tax to URA
--     (due the 15th of the following month), with the PRN.
--  7. tax_years (+ tax_year_adjustments) — one row per income year
--     (1 July – 30 June; the first starts at incorporation): provisional
--     estimate, the computation (worksheet) snapshot, prepared / approved
--     / filed, loss carried forward.
--  8. tax_payments — provisional instalments, the final balance, late
--     payment interest and refunds, each a real transaction.
--  9. tax_reminders_sent — so a deadline reminder goes out once per day.
-- 10. categories.tax_treatment / transactions.tax_treatment — whether an
--     expense is DEDUCTIBLE (default), NOT_DEDUCTIBLE or CAPITAL.
-- 11. transactions.gl_override_account_code — lets one transaction name
--     its own ledger account (used for tax legs and bond principal).
-- 12. WHT settings on service fee agreements (by amendment, with a
--     trail), loans received (non-resident lender), dividend
--     distributions, savings handouts and payment confirmations.
-- 13. investments.investment_type gains 'TREASURY_BILL'.
-- 14. Chart of accounts: 1500 WHT Recoverable, 1510 Provisional Tax
--     Paid, 2500 WHT Payable to URA, 2510 Corporate Income Tax Payable,
--     5700 Income Tax – Final WHT, 5710 Income Tax – Corporate,
--     5720 Tax Penalties & Interest; new inflow types
--     WHT_REMITTANCE_OUT, PROVISIONAL_TAX_OUT, INCOME_TAX_OUT,
--     TAX_PENALTY_OUT, TAX_REFUND_IN.
-- 15. RE-CLASSIFICATION of existing entries (reports only — no amount,
--     date or balance is changed):
--       - every bond coupon / investment "TAX" leg now goes to 5700
--         (it used to be counted as money invested, 1400) and gets a
--         tax_at_source row;
--       - every bond face-value repayment (return type PRINCIPAL) now
--         goes back to 1400 (it used to be counted as income, 4100).
--
-- Idempotent. Apply to BOTH databases:
--   node run_migration.js migration_v1.70.0.sql
-- After running it, open Tax > Settings and enter the TIN, registration
-- number and incorporation date, and check the rates.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. COMPANY REGISTRATION + WHT AGENT STATUS
-- ------------------------------------------------------------
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tin                      VARCHAR(20);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS registration_number      VARCHAR(50);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS incorporation_date       DATE;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tax_office               VARCHAR(100);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS wht_agent_designated     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS wht_agent_effective_date DATE;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tax_settings_updated_at  TIMESTAMPTZ;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS tax_settings_updated_by  INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS wht_agent_status_history (
    id                 SERIAL PRIMARY KEY,
    designated         BOOLEAN      NOT NULL,
    effective_date     DATE         NOT NULL,
    notes              TEXT,
    notice_document_id INTEGER      REFERENCES documents(id),
    changed_by         INTEGER      NOT NULL REFERENCES users(id),
    changed_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 2. MEMBERS' TAX DETAILS
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS tin           VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_residency VARCHAR(20) NOT NULL DEFAULT 'RESIDENT';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_tax_residency_check') THEN
        ALTER TABLE users ADD CONSTRAINT users_tax_residency_check
            CHECK (tax_residency IN ('RESIDENT', 'NON_RESIDENT'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 3. TAX RATES (dated)
-- rate is a PERCENTAGE (30 = 30%). treatment only matters for tax
-- deducted FROM the company: FINAL (that is the end of it — the income
-- is left out of the corporate tax computation) or CREDITABLE (it is a
-- prepayment, set off against the corporate tax of the year).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_rates (
    id               SERIAL PRIMARY KEY,
    code             VARCHAR(40)   NOT NULL,
    name             VARCHAR(200)  NOT NULL,
    rate             NUMERIC(7,4)  NOT NULL CHECK (rate >= 0 AND rate <= 100),
    treatment        VARCHAR(15)   CHECK (treatment IS NULL OR treatment IN ('FINAL', 'CREDITABLE')),
    threshold_amount NUMERIC(20,4),                 -- in the functional currency (UGX)
    legal_reference  TEXT,
    notes            TEXT,
    effective_from   DATE          NOT NULL,
    effective_to     DATE,
    created_by       INTEGER       REFERENCES users(id),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_rates_code_from_unique UNIQUE (code, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_tax_rates_code ON tax_rates (code, effective_from);

INSERT INTO tax_rates (code, name, rate, treatment, threshold_amount, legal_reference, notes, effective_from)
VALUES
 ('CIT_RATE', 'Corporate income tax rate', 30, NULL, NULL,
  'Income Tax Act Cap. 338, Second Schedule', 'Applied to the chargeable income of the year.', '2000-01-01'),
 ('WHT_GOV_SECURITIES_SHORT', 'Tax on interest from government securities (term under 10 years) — treasury bills and bonds', 20, 'FINAL', NULL,
  'Income Tax Act s.117 (as amended)', 'Deducted by Bank of Uganda / the issuer. Final tax.', '2000-01-01'),
 ('WHT_GOV_SECURITIES_LONG', 'Tax on interest from government securities (term 10 years or more)', 10, 'FINAL', NULL,
  'Income Tax Act s.117 (as amended)', 'Deducted by Bank of Uganda / the issuer. Final tax.', '2000-01-01'),
 ('WHT_INTEREST_RECEIVED', 'Tax deducted from interest received (banks, other payers)', 15, 'CREDITABLE', NULL,
  'Income Tax Act s.117', 'Creditable against the company''s corporate tax.', '2000-01-01'),
 ('WHT_DIVIDEND_RECEIVED', 'Tax deducted from dividends received', 15, 'CREDITABLE', NULL,
  'Income Tax Act s.118', 'Verify: a holding of 25% or more in a resident company may be exempt.', '2000-01-01'),
 ('WHT_DIVIDEND_PAID_RESIDENT', 'Withholding tax on dividends paid to resident shareholders', 15, NULL, NULL,
  'Income Tax Act s.118', 'Deducted by the company from each shareholder''s dividend.', '2000-01-01'),
 ('WHT_DIVIDEND_PAID_NON_RESIDENT', 'Withholding tax on dividends paid to non-resident shareholders', 15, NULL, NULL,
  'Income Tax Act s.83', 'Check any double tax agreement with the shareholder''s country.', '2000-01-01'),
 ('WHT_INTEREST_PAID_RESIDENT', 'Withholding tax on interest paid to residents (e.g. members'' savings interest)', 15, NULL, NULL,
  'Income Tax Act s.117', 'Deducted from the interest part of a savings handout.', '2000-01-01'),
 ('WHT_INTEREST_PAID_NON_RESIDENT', 'Withholding tax on interest paid to non-residents (e.g. a foreign lender)', 15, NULL, NULL,
  'Income Tax Act s.83', 'Check any double tax agreement with the lender''s country.', '2000-01-01'),
 ('WHT_AGENT_PAYMENTS', 'Withholding by designated agents on payments for goods and services (above the threshold)', 6, NULL, 1000000,
  'Income Tax Act s.119', 'Only real once URA designates the company; until then recorded as shadow.', '2000-01-01'),
 ('WHT_NON_RESIDENT_SERVICES', 'Withholding tax on fees paid to non-residents', 15, NULL, NULL,
  'Income Tax Act s.85', NULL, '2000-01-01'),
 ('LATE_PAYMENT_INTEREST', 'Interest on tax paid late (per month)', 2, NULL, NULL,
  'Tax Procedures Code Act s.43', 'Per month, simple interest on the unpaid tax.', '2000-01-01')
ON CONFLICT (code, effective_from) DO NOTHING;

-- ------------------------------------------------------------
-- 4. TAX DEDUCTED FROM THE COMPANY (at source)
-- cash_leg = TRUE: the tax has its own transaction (tax_transaction_id)
--   that points at 5700 / 1500 via transactions.gl_override_account_code.
-- cash_leg = FALSE: the tax was paid inside another amount (e.g. a
--   treasury bill whose tax was added to the purchase price) — the
--   ledger moves it out of contra_gl_code into 5700 / 1500 (glService).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_at_source (
    id                        SERIAL PRIMARY KEY,
    reference_id              INTEGER       REFERENCES references_registry(id),
    source_type               VARCHAR(30)   NOT NULL
                              CHECK (source_type IN ('BOND_COUPON', 'TREASURY_BILL', 'INVESTMENT_RETURN',
                                                     'INVESTMENT_TAX_ENTRY', 'BANK_INTEREST', 'MMF',
                                                     'DIVIDEND_RECEIVED', 'OTHER_INCOME', 'OTHER')),
    payer_name                VARCHAR(200),
    payer_tin                 VARCHAR(20),
    investment_id             INTEGER       REFERENCES investments(id),
    bond_coupon_id            INTEGER       REFERENCES bond_coupons(id),
    income_transaction_id     INTEGER       REFERENCES transactions(id),
    tax_transaction_id        INTEGER       REFERENCES transactions(id),
    cash_leg                  BOOLEAN       NOT NULL DEFAULT TRUE,
    contra_gl_code            VARCHAR(10),
    tax_rate_code             VARCHAR(40),
    rate                      NUMERIC(7,4),
    treatment                 VARCHAR(15)   NOT NULL CHECK (treatment IN ('FINAL', 'CREDITABLE')),
    gross_amount              NUMERIC(20,4) NOT NULL CHECK (gross_amount >= 0),
    tax_amount                NUMERIC(20,4) NOT NULL CHECK (tax_amount > 0),
    net_amount                NUMERIC(20,4) NOT NULL,
    currency_id               INTEGER       NOT NULL REFERENCES currencies(id),
    deduction_date            DATE          NOT NULL,
    functional_rate           NUMERIC(20,8),
    gross_functional          NUMERIC(20,2),
    tax_functional            NUMERIC(20,2),
    certificate_number        VARCHAR(60),
    certificate_received_at   DATE,
    certificate_document_id   INTEGER       REFERENCES documents(id),
    credit_claimed_tax_year_id INTEGER,
    status                    VARCHAR(15)   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
    reversed_at               DATE,
    is_backfilled             BOOLEAN       NOT NULL DEFAULT FALSE,
    notes                     TEXT,
    created_by                INTEGER       REFERENCES users(id),
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_at_source_noncash_contra CHECK (cash_leg OR contra_gl_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_tax_at_source_date ON tax_at_source (deduction_date);
CREATE UNIQUE INDEX IF NOT EXISTS tax_at_source_one_per_tax_tx
    ON tax_at_source (tax_transaction_id) WHERE tax_transaction_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5. TAX THE COMPANY WITHHOLDS FROM OTHERS
-- tax_functional is what is owed to URA, in UGX, fixed at the rate on
-- the withholding date. debit_gl_code is where the GROSS payment was
-- charged — glService adds Dr <debit_gl_code> / Cr 2500 for the tax
-- (the cash transaction itself only carries the NET amount paid).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wht_remittances (
    id                   SERIAL PRIMARY KEY,
    reference_id         INTEGER       REFERENCES references_registry(id),
    period_month         DATE          NOT NULL,     -- first day of the month the tax was withheld in
    due_date             DATE          NOT NULL,     -- the 15th of the following month
    total_tax_functional NUMERIC(20,2) NOT NULL CHECK (total_tax_functional > 0),
    account_id           INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id       INTEGER       REFERENCES transactions(id),
    prn                  VARCHAR(40),
    return_reference     VARCHAR(60),
    paid_date            DATE          NOT NULL,
    status               VARCHAR(15)   NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'REVERSED')),
    notes                TEXT,
    created_by           INTEGER       NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wht_withholdings (
    id                       SERIAL PRIMARY KEY,
    reference_id             INTEGER       REFERENCES references_registry(id),
    payment_type             VARCHAR(30)   NOT NULL
                             CHECK (payment_type IN ('DIVIDEND', 'SAVINGS_INTEREST', 'LOAN_INTEREST', 'SERVICE_FEE',
                                                     'SUPPLIER', 'NON_RESIDENT_SERVICE', 'OTHER')),
    payee_user_id            INTEGER       REFERENCES users(id),
    payee_name               VARCHAR(200)  NOT NULL,
    payee_tin                VARCHAR(20),
    payee_residency          VARCHAR(20)   NOT NULL DEFAULT 'RESIDENT' CHECK (payee_residency IN ('RESIDENT', 'NON_RESIDENT')),
    tax_rate_code            VARCHAR(40),
    rate                     NUMERIC(7,4)  NOT NULL,
    gross_amount             NUMERIC(20,4) NOT NULL CHECK (gross_amount > 0),
    tax_amount               NUMERIC(20,4) NOT NULL CHECK (tax_amount >= 0),
    net_amount               NUMERIC(20,4) NOT NULL,
    currency_id              INTEGER       NOT NULL REFERENCES currencies(id),
    withholding_date         DATE          NOT NULL,
    functional_rate          NUMERIC(20,8),
    tax_functional           NUMERIC(20,2),
    debit_gl_code            VARCHAR(10),
    source_transaction_id    INTEGER       REFERENCES transactions(id),
    dividend_distribution_id INTEGER       REFERENCES dividend_distributions(id),
    savings_handout_id       INTEGER       REFERENCES savings_handouts(id),
    loan_repayment_id        INTEGER       REFERENCES loan_received_repayments(id),
    service_fee_payment_id   INTEGER       REFERENCES service_fee_payments(id),
    is_shadow                BOOLEAN       NOT NULL DEFAULT FALSE,
    shadow_reason            TEXT,
    remittance_id            INTEGER       REFERENCES wht_remittances(id),
    status                   VARCHAR(15)   NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'REMITTED', 'SHADOW', 'REVERSED')),
    reversal_date            DATE,
    certificate_document_id  INTEGER       REFERENCES documents(id),
    notes                    TEXT,
    created_by               INTEGER       REFERENCES users(id),
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT wht_real_needs_ugx_value CHECK (is_shadow OR status = 'REVERSED' OR tax_functional IS NOT NULL),
    CONSTRAINT wht_real_needs_debit_gl CHECK (is_shadow OR debit_gl_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_wht_withholdings_date   ON wht_withholdings (withholding_date);
CREATE INDEX IF NOT EXISTS idx_wht_withholdings_status ON wht_withholdings (status);
CREATE INDEX IF NOT EXISTS idx_wht_withholdings_payee  ON wht_withholdings (payee_user_id);

-- ------------------------------------------------------------
-- 6. TAX YEARS, ADJUSTMENTS, PAYMENTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tax_years (
    id                            SERIAL PRIMARY KEY,
    label                         VARCHAR(30)   NOT NULL,
    start_date                    DATE          NOT NULL UNIQUE,
    end_date                      DATE          NOT NULL,
    is_first_year                 BOOLEAN       NOT NULL DEFAULT FALSE,
    status                        VARCHAR(15)   NOT NULL DEFAULT 'OPEN'
                                  CHECK (status IN ('OPEN', 'PREPARED', 'APPROVED', 'FILED')),
    include_pre_incorporation     BOOLEAN       NOT NULL DEFAULT FALSE,
    fx_revaluation_taxable        BOOLEAN       NOT NULL DEFAULT TRUE,
    provisional_estimate          NUMERIC(20,2),          -- estimated chargeable income (UGX)
    provisional_tax_estimate      NUMERIC(20,2),          -- estimate x rate
    provisional_set_by            INTEGER       REFERENCES users(id),
    provisional_set_at            TIMESTAMPTZ,
    computation                   JSONB,                  -- the worksheet snapshot, frozen at PREPARED
    profit_before_tax             NUMERIC(20,2),
    total_add_backs               NUMERIC(20,2),
    total_deductions              NUMERIC(20,2),
    chargeable_income             NUMERIC(20,2),
    loss_brought_forward          NUMERIC(20,2),
    loss_utilised                 NUMERIC(20,2),
    taxable_income                NUMERIC(20,2),
    loss_carried_forward          NUMERIC(20,2),
    tax_rate                      NUMERIC(7,4),
    gross_tax                     NUMERIC(20,2),
    wht_credits                   NUMERIC(20,2),
    provisional_paid              NUMERIC(20,2),
    balance_due                   NUMERIC(20,2),
    prepared_by                   INTEGER       REFERENCES users(id),
    prepared_at                   TIMESTAMPTZ,
    approved_by                   INTEGER       REFERENCES users(id),
    approved_at                   TIMESTAMPTZ,
    returned_reason               TEXT,
    filed_by                      INTEGER       REFERENCES users(id),
    filed_at                      TIMESTAMPTZ,
    filing_date                   DATE,
    return_reference              VARCHAR(60),
    computation_document_id       INTEGER       REFERENCES documents(id),
    notes                         TEXT,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_years_dates CHECK (end_date > start_date)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_at_source_claim_year_fk') THEN
        ALTER TABLE tax_at_source ADD CONSTRAINT tax_at_source_claim_year_fk
            FOREIGN KEY (credit_claimed_tax_year_id) REFERENCES tax_years(id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS tax_year_adjustments (
    id              SERIAL PRIMARY KEY,
    tax_year_id     INTEGER       NOT NULL REFERENCES tax_years(id) ON DELETE CASCADE,
    kind            VARCHAR(15)   NOT NULL CHECK (kind IN ('ADD_BACK', 'DEDUCTION')),
    description     TEXT          NOT NULL,
    amount          NUMERIC(20,2) NOT NULL CHECK (amount > 0),
    legal_reference TEXT,
    created_by      INTEGER       NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tax_payments (
    id              SERIAL PRIMARY KEY,
    reference_id    INTEGER       REFERENCES references_registry(id),
    tax_year_id     INTEGER       REFERENCES tax_years(id),
    payment_kind    VARCHAR(25)   NOT NULL
                    CHECK (payment_kind IN ('PROVISIONAL', 'INCOME_TAX_BALANCE', 'LATE_INTEREST', 'REFUND_RECEIVED')),
    instalment_no   SMALLINT,
    amount          NUMERIC(20,2) NOT NULL CHECK (amount > 0),
    account_id      INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id  INTEGER       REFERENCES transactions(id),
    prn             VARCHAR(40),
    paid_date       DATE          NOT NULL,
    status          VARCHAR(15)   NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'REVERSED')),
    notes           TEXT,
    created_by      INTEGER       NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tax_reminders_sent (
    id          SERIAL PRIMARY KEY,
    reminder_key VARCHAR(120) NOT NULL,
    sent_on     DATE         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_reminders_sent_unique UNIQUE (reminder_key, sent_on)
);

-- ------------------------------------------------------------
-- 7. EXPENSE TAX TREATMENT (categories + per transaction)
-- NULL on a category = inherit from its parent (top level: DEDUCTIBLE).
-- NULL on a transaction = use its category's.
-- ------------------------------------------------------------
ALTER TABLE categories   ADD COLUMN IF NOT EXISTS tax_treatment VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_treatment VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gl_override_account_code VARCHAR(10);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_tax_treatment_check') THEN
        ALTER TABLE categories ADD CONSTRAINT categories_tax_treatment_check
            CHECK (tax_treatment IS NULL OR tax_treatment IN ('DEDUCTIBLE', 'NOT_DEDUCTIBLE', 'CAPITAL'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_tax_treatment_check') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_tax_treatment_check
            CHECK (tax_treatment IS NULL OR tax_treatment IN ('DEDUCTIBLE', 'NOT_DEDUCTIBLE', 'CAPITAL'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 8. WHT SETTINGS ON THE MODULES THAT PAY PEOPLE
-- ------------------------------------------------------------
-- Service fees: off by default ("no ties with WHT"); switched on by an
-- amendment with a reason and an effective date (trail below).
ALTER TABLE service_fee_agreements ADD COLUMN IF NOT EXISTS wht_applicable     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE service_fee_agreements ADD COLUMN IF NOT EXISTS wht_rate_code      VARCHAR(40);
ALTER TABLE service_fee_agreements ADD COLUMN IF NOT EXISTS wht_effective_from DATE;
CREATE TABLE IF NOT EXISTS service_fee_wht_amendments (
    id                 SERIAL PRIMARY KEY,
    agreement_id       INTEGER      NOT NULL REFERENCES service_fee_agreements(id),
    previous_applicable BOOLEAN     NOT NULL,
    new_applicable     BOOLEAN      NOT NULL,
    previous_rate_code VARCHAR(40),
    new_rate_code      VARCHAR(40),
    effective_from     DATE         NOT NULL,
    reason             TEXT         NOT NULL,
    amended_by         INTEGER      NOT NULL REFERENCES users(id),
    amended_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_confirmations ADD COLUMN IF NOT EXISTS wht_amount    NUMERIC(20,4);
ALTER TABLE payment_confirmations ADD COLUMN IF NOT EXISTS wht_is_shadow BOOLEAN;

-- Loans received: interest paid to a lender outside Uganda has tax withheld.
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS lender_residency VARCHAR(20) NOT NULL DEFAULT 'RESIDENT';
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS lender_tin       VARCHAR(20);
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS wht_applicable   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loans_received ADD COLUMN IF NOT EXISTS wht_rate_code    VARCHAR(40);
ALTER TABLE loan_received_repayments ADD COLUMN IF NOT EXISTS wht_amount NUMERIC(20,4) NOT NULL DEFAULT 0;
ALTER TABLE loan_received_repayments ADD COLUMN IF NOT EXISTS cash_paid  NUMERIC(20,4);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loans_received_lender_residency_check') THEN
        ALTER TABLE loans_received ADD CONSTRAINT loans_received_lender_residency_check
            CHECK (lender_residency IN ('RESIDENT', 'NON_RESIDENT'));
    END IF;
END $$;

ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS wht_rate   NUMERIC(7,4);
ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS wht_amount NUMERIC(20,4);
ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS net_amount NUMERIC(20,4);

ALTER TABLE savings_handouts ADD COLUMN IF NOT EXISTS wht_rate   NUMERIC(7,4);
ALTER TABLE savings_handouts ADD COLUMN IF NOT EXISTS wht_amount NUMERIC(20,4) NOT NULL DEFAULT 0;
ALTER TABLE savings_handouts ADD COLUMN IF NOT EXISTS net_amount NUMERIC(20,4);

-- ------------------------------------------------------------
-- 9. TREASURY BILLS
-- ------------------------------------------------------------
DO $$
DECLARE con_name text;
BEGIN
    SELECT conname INTO con_name FROM pg_constraint
    WHERE  conrelid = 'investments'::regclass AND contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%investment_type%' AND pg_get_constraintdef(oid) LIKE '%STANDARD%'
    AND    pg_get_constraintdef(oid) NOT LIKE '%TREASURY_BILL%'
    LIMIT 1;
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE investments DROP CONSTRAINT ' || quote_ident(con_name);
        ALTER TABLE investments ADD CONSTRAINT investments_investment_type_check
            CHECK (investment_type IN ('STANDARD', 'BOND', 'TREASURY_BILL'));
    END IF;
END $$;
ALTER TABLE investments ADD COLUMN IF NOT EXISTS tbill_tax_timing VARCHAR(15);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'investments_tbill_tax_timing_check') THEN
        ALTER TABLE investments ADD CONSTRAINT investments_tbill_tax_timing_check
            CHECK (tbill_tax_timing IS NULL OR tbill_tax_timing IN ('AT_MATURITY', 'AT_PURCHASE'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 10. documents.audience gains 'ALL_MEMBERS' (every member, whether
-- or not they hold shares — used for the WHT agent status notice).
-- ------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_audience_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%ALL_MEMBERS%') THEN
        ALTER TABLE documents DROP CONSTRAINT documents_audience_check;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_audience_check') THEN
        ALTER TABLE documents ADD CONSTRAINT documents_audience_check
            CHECK (audience IS NULL OR audience IN ('ALL_SHAREHOLDERS', 'ALL_MEMBERS'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 11. transactions.inflow_type gains the five tax payment types.
-- Rebuilt from the constraint's CURRENT list (nothing dropped).
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
    con_def  text;
    vals     text[];
BEGIN
    SELECT conname, pg_get_constraintdef(oid) INTO con_name, con_def
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%'
    LIMIT  1;

    IF con_def IS NOT NULL AND con_def LIKE '%TAX_REFUND_IN%' THEN
        RETURN;
    END IF;

    SELECT array_agg(DISTINCT m[1]) INTO vals
    FROM   regexp_matches(COALESCE(con_def, ''), '''([A-Z_]+)''', 'g') AS m;
    vals := COALESCE(vals, ARRAY[]::text[])
         || ARRAY['WHT_REMITTANCE_OUT', 'PROVISIONAL_TAX_OUT', 'INCOME_TAX_OUT', 'TAX_PENALTY_OUT', 'TAX_REFUND_IN'];
    SELECT array_agg(DISTINCT v) INTO vals FROM unnest(vals) AS v;

    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    EXECUTE 'ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check CHECK (inflow_type IN ('
        || (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) AS v)
        || '))';
END $$;

-- ------------------------------------------------------------
-- 12. CHART OF ACCOUNTS
-- ------------------------------------------------------------
INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order, is_monetary)
VALUES
    ('1500', 'Withholding Tax Recoverable', 'ASSET', 'DEBIT', 'TAX_ASSETS', 'OPERATING',
     'CREDITABLE tax deducted from the company''s income by the payer (e.g. bank interest). A prepayment of corporate tax: set off against the year''s tax when the return is filed.', 220, FALSE),
    ('1510', 'Provisional Tax Paid', 'ASSET', 'DEBIT', 'TAX_ASSETS', 'OPERATING',
     'Provisional (instalment) corporate tax paid to URA during the year. Set off against the year''s tax when the return is filed.', 225, FALSE),
    ('2500', 'Withholding Tax Payable (URA)', 'LIABILITY', 'CREDIT', 'TAX_LIABILITIES', 'OPERATING',
     'Tax the company deducted from payments it made (dividends, members'' savings interest, foreign lender interest, fees) and must pay to URA by the 15th of the following month.', 445, FALSE),
    ('2510', 'Corporate Income Tax Payable', 'LIABILITY', 'CREDIT', 'TAX_LIABILITIES', 'OPERATING',
     'Corporate income tax of approved tax years, less what has been set off or paid. A debit balance is tax refundable.', 447, FALSE),
    ('5700', 'Income Tax — Final Withholding Tax', 'EXPENSE', 'DEBIT', 'INCOME_TAX', 'OPERATING',
     'FINAL tax deducted at source from income (government securities, treasury bills). Part of the income tax charge, not an operating expense.', 790, FALSE),
    ('5710', 'Income Tax — Corporate (Current Year)', 'EXPENSE', 'DEBIT', 'INCOME_TAX', 'OPERATING',
     'Corporate income tax on the chargeable income of each approved tax year.', 795, FALSE),
    ('5720', 'Tax Penalties and Late Payment Interest', 'EXPENSE', 'DEBIT', 'EXPENSES', 'OPERATING',
     'Interest and penalties charged by URA for late filing or payment. Not deductible for tax.', 770, FALSE)
ON CONFLICT (code) DO NOTHING;

INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT v.inflow_type, ga.id, v.notes
FROM (VALUES
    ('WHT_REMITTANCE_OUT',  '2500', 'v1.70.0 — withheld tax paid over to URA.'),
    ('PROVISIONAL_TAX_OUT', '1510', 'v1.70.0 — provisional corporate tax instalment paid to URA.'),
    ('INCOME_TAX_OUT',      '2510', 'v1.70.0 — balance of corporate income tax paid to URA.'),
    ('TAX_PENALTY_OUT',     '5720', 'v1.70.0 — late payment interest / penalty paid to URA.'),
    ('TAX_REFUND_IN',       '2510', 'v1.70.0 — tax refunded by URA.')
) AS v(inflow_type, code, notes)
JOIN gl_accounts ga ON ga.code = v.code
ON CONFLICT (inflow_type) DO NOTHING;

-- ------------------------------------------------------------
-- 13. RE-CLASSIFICATION OF EXISTING ENTRIES (reports only)
-- a) Every investment "TAX" leg (bond coupon withholding tax and
--    manual TAX entries) was an EXPENSE carrying investment_id, which
--    the ledger counted as money INVESTED (1400). It is income tax
--    deducted at source: FINAL for government securities -> 5700.
-- ------------------------------------------------------------
UPDATE transactions t
SET    gl_override_account_code = '5700'
FROM   investment_transactions it
WHERE  it.transaction_id = t.id
AND    it.entry_type = 'TAX'
AND    t.gl_override_account_code IS NULL;

-- Their reversals follow them.
UPDATE transactions r
SET    gl_override_account_code = o.gl_override_account_code
FROM   transactions o
WHERE  r.reversal_of = o.id
AND    o.gl_override_account_code IS NOT NULL
AND    r.gl_override_account_code IS NULL;

-- ...and each gets a row in the register of tax deducted from us.
INSERT INTO tax_at_source (
    source_type, payer_name, investment_id, bond_coupon_id, income_transaction_id, tax_transaction_id,
    cash_leg, tax_rate_code, rate, treatment, gross_amount, tax_amount, net_amount, currency_id,
    deduction_date, functional_rate, gross_functional, tax_functional, status, is_backfilled, notes)
SELECT
    CASE WHEN bc.id IS NOT NULL THEN 'BOND_COUPON' ELSE 'INVESTMENT_TAX_ENTRY' END,
    i.name,
    i.id,
    bc.id,
    ir.transaction_id,
    t.id,
    TRUE,
    CASE WHEN i.investment_type = 'BOND' AND COALESCE(i.bond_term_years, 0) >= 10 THEN 'WHT_GOV_SECURITIES_LONG'
         WHEN i.investment_type = 'BOND' THEN 'WHT_GOV_SECURITIES_SHORT' ELSE NULL END,
    NULLIF(i.tax_withholding_rate, 0),
    'FINAL',
    COALESCE(bc.actual_gross_amount, bc.gross_amount, t.amount),
    t.amount,
    COALESCE(bc.actual_gross_amount, bc.gross_amount, t.amount) - t.amount,
    t.currency_id,
    t.value_date,
    t.functional_rate,
    ROUND(COALESCE(bc.actual_gross_amount, bc.gross_amount, t.amount) * COALESCE(t.functional_rate, 0), 2),
    t.functional_amount,
    CASE WHEN t.is_reversed THEN 'REVERSED' ELSE 'ACTIVE' END,
    TRUE,
    'Recorded before v1.70.0; added to the tax register by the migration. Check the treatment (FINAL / CREDITABLE) and attach the certificate.'
FROM   investment_transactions it
JOIN   transactions t  ON t.id = it.transaction_id AND t.is_reversal = FALSE
JOIN   investments  i  ON i.id = it.investment_id
LEFT JOIN bond_coupons bc ON bc.investment_id = i.id
       AND bc.status = 'PAID'
       AND bc.paid_at IS NOT NULL
       AND it.description = 'Withholding tax on bond coupon #' || bc.coupon_number
LEFT JOIN investment_returns ir ON ir.id = bc.investment_return_id
WHERE  it.entry_type = 'TAX'
AND    t.amount > 0
AND    NOT EXISTS (SELECT 1 FROM tax_at_source s WHERE s.tax_transaction_id = t.id);

-- b) A bond's face value repaid at maturity (return type PRINCIPAL) is
--    the company's own money coming back, not income: -> 1400.
UPDATE transactions t
SET    gl_override_account_code = '1400'
FROM   investment_returns ir
WHERE  ir.transaction_id = t.id
AND    ir.return_type = 'PRINCIPAL'
AND    t.gl_override_account_code IS NULL;

UPDATE transactions r
SET    gl_override_account_code = o.gl_override_account_code
FROM   transactions o
WHERE  r.reversal_of = o.id
AND    o.gl_override_account_code IS NOT NULL
AND    r.gl_override_account_code IS NULL;

COMMIT;
