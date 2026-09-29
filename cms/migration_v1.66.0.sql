-- ============================================================
-- MIGRATION v1.66.0 — Functional-currency (UGX) consolidation,
-- foreign-exchange revaluation, and Side Fund as a members'
-- liability.
--
-- Requested directly: the financial statements "aren't to the
-- legally, reliable and professionally reliant level that they
-- should be". Under IFRS for SMEs (adopted in Uganda by ICPAU) a
-- company keeps ONE set of books in its FUNCTIONAL currency and
-- reports foreign-currency items by translating them — it does not
-- publish one separate balance sheet per currency (the v1.64.0
-- behaviour, which is kept below as a supporting "by original
-- currency" view, but is no longer the official statement).
--
-- Confirmed company facts this migration is built on:
--   - Registered in Uganda; financial year ends 30 June (starts 1 July).
--   - Functional currency: UGX. Shareholders also want to see EUR
--     (the "presentation" currency, shown as a convenience
--     translation — see the GL page).
--   - Capital contributions and savings were received in EUR.
--   - The Side Fund is MEMBERS' money (not a company reserve), which
--     the members can spend — so it is a liability the company owes
--     them, not company income. (Confirmed directly.)
--
-- WHAT THIS ADDS
--
-- 1. company_settings.functional_currency_id / presentation_currency_id
--    / fiscal_year_start_month — seeded to UGX / EUR / 7 (July).
--
-- 2. fx_rate_on(from, to, date) — the ONE rate lookup the database
--    uses: the currency_exchange_rates row effective on that date,
--    either direction (inverse used if only the other direction is
--    on file). Unlike sharePricingService's lookup it does NOT fall
--    back to the earliest rate on file — for the books, a missing
--    rate is reported as missing, never guessed.
--
-- 3. transactions.functional_amount (+ rate, source, note) — the UGX
--    value of every transaction, FIXED on the transaction's own
--    value_date. Filled automatically by a trigger on every insert,
--    so none of the ~20 modules that post money needed changing:
--      SAME_CURRENCY — already UGX, rate 1.
--      TRANSFER      — a transfer leg (or its bank charge) uses the
--                      transfer's OWN actual rate, taken from the
--                      transfer record, so both legs carry exactly
--                      the same UGX value and the clearing account
--                      (1050) nets to zero in UGX.
--      REVERSAL      — a reversal uses the rate of the row it
--                      reverses, so it cancels it exactly.
--      RATE_TABLE    — anything else: the rate effective on the
--                      value_date in Settings > Exchange Rates.
--      MANUAL        — set by a System Admin for one transaction
--                      (e.g. the bank's own rate from a proof of
--                      transfer); survives any later recalculation.
--    A transaction with no rate available keeps functional_amount
--    NULL and is listed on the GL page's "FX & Revaluation" tab until
--    a rate is entered — it is never silently valued at a guess.
--
-- 4. Existing transactions are valued in place (step 4 below) with
--    exactly the same rules, oldest first.
--
-- 5. gl_accounts.is_monetary + three new GL accounts:
--      2400 Side Fund Payable (Members)  — LIABILITY
--      4600 Foreign Exchange Gains       — REVENUE
--      5600 Foreign Exchange Losses      — EXPENSE
--    "Monetary" = an amount of currency held, owed or receivable
--    (cash, loans, savings, deposits, MMF holdings, the side fund). Only monetary
--    balances are revalued at each month end; capital, investments
--    at cost, income and expenses stay at their historical rate
--    forever.
--
-- 6. Side Fund reclassified: SIDE_FUND_CONTRIBUTION_IN,
--    SIDE_FUND_DIRECT_IN and SIDE_FUND_PAYOUT_OUT now map to 2400
--    instead of 4300 (income) / 5200 (expense). Side fund EXPENSES
--    (posted as generic EXPENSE) are redirected to 2400 in
--    glService.js the same way investment purchases already are.
--    4300 and 5200 are kept (history, and so the mapping can be
--    reverted from the Ledger Accounts tab) but marked inactive.
--
-- 7. fx_revaluation_runs / fx_revaluation_lines — the month-end
--    revaluation record. Each run revalues every foreign-currency
--    monetary balance to that month end's closing rate and books the
--    difference as an FX gain or loss. Runs are STORED (with the
--    rates used), so a closed month never changes after the fact.
--
-- No new permissions: running a revaluation reuses
-- FINANCE_TRANSACTION_APPROVE; setting a manual rate reuses
-- SYSTEM_CONFIG.
--
-- Idempotent — safe to run more than once. Apply it to BOTH
-- databases (investabo_db and zwecktukula_db):
--   node run_migration.js migration_v1.66.0.sql
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. company_settings — functional / presentation currency and
--    the first month of the financial year.
-- ------------------------------------------------------------
ALTER TABLE company_settings
    ADD COLUMN IF NOT EXISTS functional_currency_id   INTEGER REFERENCES currencies(id),
    ADD COLUMN IF NOT EXISTS presentation_currency_id INTEGER REFERENCES currencies(id),
    ADD COLUMN IF NOT EXISTS fiscal_year_start_month  SMALLINT NOT NULL DEFAULT 7;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_settings_fy_start_month_check') THEN
        ALTER TABLE company_settings
            ADD CONSTRAINT company_settings_fy_start_month_check
            CHECK (fiscal_year_start_month BETWEEN 1 AND 12);
    END IF;
END $$;

UPDATE company_settings
SET    functional_currency_id = (SELECT id FROM currencies WHERE code = 'UGX' LIMIT 1)
WHERE  id = 1 AND functional_currency_id IS NULL;

UPDATE company_settings
SET    presentation_currency_id = (SELECT id FROM currencies WHERE code = 'EUR' LIMIT 1)
WHERE  id = 1 AND presentation_currency_id IS NULL;

-- ------------------------------------------------------------
-- 2. fx_rate_on — the database's single rate lookup.
--    Returns how many units of p_to one unit of p_from is worth on
--    p_date (e.g. EUR -> UGX = 4100), or NULL if no rate covers
--    that date in either direction.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION fx_rate_on(p_from INTEGER, p_to INTEGER, p_date DATE)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_rate NUMERIC;
BEGIN
    IF p_from IS NULL OR p_to IS NULL OR p_date IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_from = p_to THEN
        RETURN 1;
    END IF;

    SELECT rate INTO v_rate
    FROM   currency_exchange_rates
    WHERE  base_currency_id = p_from AND target_currency_id = p_to
    AND    effective_from <= p_date
    AND    (effective_to IS NULL OR effective_to > p_date)
    ORDER  BY effective_from DESC, id DESC
    LIMIT  1;
    IF v_rate IS NOT NULL THEN
        RETURN v_rate;
    END IF;

    SELECT 1 / rate INTO v_rate
    FROM   currency_exchange_rates
    WHERE  base_currency_id = p_to AND target_currency_id = p_from
    AND    effective_from <= p_date
    AND    (effective_to IS NULL OR effective_to > p_date)
    ORDER  BY effective_from DESC, id DESC
    LIMIT  1;
    RETURN v_rate;
END $$;

-- ------------------------------------------------------------
-- 3. transactions — the UGX (functional) value of every row.
-- ------------------------------------------------------------
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS functional_amount      NUMERIC(20,4),
    ADD COLUMN IF NOT EXISTS functional_rate        NUMERIC(30,12),
    ADD COLUMN IF NOT EXISTS functional_rate_source VARCHAR(20),
    ADD COLUMN IF NOT EXISTS functional_rate_note   TEXT,
    ADD COLUMN IF NOT EXISTS functional_set_by      INTEGER REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS functional_set_at      TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_functional_rate_source_check') THEN
        ALTER TABLE transactions
            ADD CONSTRAINT transactions_functional_rate_source_check
            CHECK (functional_rate_source IS NULL OR functional_rate_source IN
                   ('SAME_CURRENCY', 'TRANSFER', 'REVERSAL', 'RATE_TABLE', 'MANUAL'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_functional_rate_positive') THEN
        ALTER TABLE transactions
            ADD CONSTRAINT transactions_functional_rate_positive
            CHECK (functional_rate IS NULL OR functional_rate > 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_functional_missing
    ON transactions (value_date)
    WHERE functional_amount IS NULL;

-- The trigger function. Runs BEFORE the row is written, so the
-- value is stored in the same statement that posts the money —
-- there is never a moment where a posted transaction exists
-- without its UGX value (unless no rate is available at all).
CREATE OR REPLACE FUNCTION set_transaction_functional_amount()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_func   INTEGER;
    v_rate   NUMERIC;
    v_source VARCHAR(20);
    v_value  NUMERIC;
    tr       RECORD;
BEGIN
    SELECT functional_currency_id INTO v_func FROM company_settings WHERE id = 1;
    IF v_func IS NULL THEN
        -- No functional currency configured yet — nothing to value against.
        NEW.functional_amount := NULL;
        NEW.functional_rate := NULL;
        NEW.functional_rate_source := NULL;
        RETURN NEW;
    END IF;

    -- A MANUAL rate set by an Admin is kept for as long as the
    -- transaction stays in the same currency — only the amount is
    -- re-multiplied, in case the amount itself was corrected.
    IF NEW.functional_rate_source = 'MANUAL'
       AND NEW.functional_rate IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.currency_id = OLD.currency_id) THEN
        NEW.functional_amount := ROUND(NEW.amount * NEW.functional_rate, 4);
        RETURN NEW;
    END IF;

    v_rate := NULL;
    v_source := NULL;

    IF NEW.currency_id = v_func THEN
        v_rate := 1;
        v_source := 'SAME_CURRENCY';
    END IF;

    -- A reversal cancels its original at the ORIGINAL's rate.
    IF v_rate IS NULL AND NEW.reversal_of IS NOT NULL THEN
        SELECT functional_rate INTO v_rate
        FROM   transactions
        WHERE  id = NEW.reversal_of AND currency_id = NEW.currency_id;
        IF v_rate IS NOT NULL THEN
            v_source := 'REVERSAL';
        END IF;
    END IF;

    -- A transfer leg (or a bank charge posted with the transfer)
    -- uses the transfer's own actual rate. v_value = the UGX value
    -- of the whole transfer; each leg's rate is v_value divided by
    -- that leg's own amount, so both legs carry the same UGX value.
    IF v_rate IS NULL AND NEW.transfer_id IS NOT NULL THEN
        SELECT * INTO tr FROM transfers WHERE id = NEW.transfer_id;
        IF FOUND THEN
            IF tr.currency_received_id = v_func THEN
                v_value := tr.amount_received;
            ELSIF tr.currency_sent_id = v_func THEN
                v_value := tr.amount_sent;
            ELSE
                v_value := tr.amount_sent * fx_rate_on(tr.currency_sent_id, v_func, tr.value_date);
            END IF;

            IF v_value IS NOT NULL THEN
                IF NEW.currency_id = tr.currency_sent_id THEN
                    v_rate := v_value / tr.amount_sent;
                    v_source := 'TRANSFER';
                ELSIF NEW.currency_id = tr.currency_received_id THEN
                    v_rate := v_value / tr.amount_received;
                    v_source := 'TRANSFER';
                END IF;
            END IF;
        END IF;
    END IF;

    -- Everything else: the rate table, on the transaction's own date.
    IF v_rate IS NULL THEN
        v_rate := fx_rate_on(NEW.currency_id, v_func, NEW.value_date);
        IF v_rate IS NOT NULL THEN
            v_source := 'RATE_TABLE';
        END IF;
    END IF;

    NEW.functional_rate := v_rate;
    NEW.functional_rate_source := v_source;
    NEW.functional_amount := CASE WHEN v_rate IS NULL THEN NULL
                                  ELSE ROUND(NEW.amount * v_rate, 4) END;
    IF v_source IS DISTINCT FROM 'MANUAL' THEN
        NEW.functional_rate_note := NULL;
        NEW.functional_set_by := NULL;
        NEW.functional_set_at := NULL;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_transactions_functional_amount ON transactions;
CREATE TRIGGER trg_transactions_functional_amount
    BEFORE INSERT OR UPDATE OF amount, currency_id, value_date, transfer_id, reversal_of,
                               functional_rate, functional_rate_source
    ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION set_transaction_functional_amount();

-- ------------------------------------------------------------
-- 4. Value every EXISTING transaction with the same rules.
--    "SET functional_rate_source = functional_rate_source" changes
--    nothing by itself — it only wakes the trigger up for each row.
--    Originals first, reversals second (a reversal needs its
--    original's rate to exist already).
-- ------------------------------------------------------------
UPDATE transactions
SET    functional_rate_source = functional_rate_source
WHERE  reversal_of IS NULL;

UPDATE transactions
SET    functional_rate_source = functional_rate_source
WHERE  reversal_of IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Chart of accounts — monetary flag + three new accounts.
-- ------------------------------------------------------------
ALTER TABLE gl_accounts
    ADD COLUMN IF NOT EXISTS is_monetary BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order) VALUES
    ('2400', 'Side Fund Payable (Members)', 'LIABILITY', 'CREDIT', 'LIABILITIES', 'FINANCING',
     'Members'' side fund money the company holds for them. Dues and top-ups increase it; payouts and side fund expenses reduce it. It is the members'' money, not company income (confirmed policy, v1.66.0).', 440),
    ('4600', 'Foreign Exchange Gains', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING',
     'Gains from revaluing foreign-currency balances (cash, savings, loans, deposits) to the month-end closing rate. Non-cash.', 660),
    ('5600', 'Foreign Exchange Losses', 'EXPENSE', 'DEBIT', 'EXPENSES', 'OPERATING',
     'Losses from revaluing foreign-currency balances to the month-end closing rate. Non-cash.', 760)
ON CONFLICT (code) DO NOTHING;

-- 1050 (Inter-Account Transfers) is deliberately NOT monetary: it is a
-- clearing account whose two legs always carry the same UGX value
-- (the transfer's own rate), so it nets to zero in UGX by itself.
-- Revaluing one leg of it would break that.
UPDATE gl_accounts
SET    is_monetary = TRUE
WHERE  code IN ('1000', '1100', '1200', '1300', '2000', '2100', '2200', '2400');

-- ------------------------------------------------------------
-- 6. Side Fund = members' money (a liability), not income/expense.
-- ------------------------------------------------------------
UPDATE gl_inflow_type_mapping m
SET    gl_account_id = ga.id,
       notes = CASE m.inflow_type
                   WHEN 'SIDE_FUND_PAYOUT_OUT' THEN 'v1.66.0: members'' money paid back out of the side fund — reduces Side Fund Payable (2400). Was 5200 Side Fund Payouts.'
                   ELSE 'v1.66.0: members'' money received into the side fund — increases Side Fund Payable (2400). Was 4300 Side Fund Dues Income.'
               END,
       updated_at = NOW()
FROM   gl_accounts ga
WHERE  ga.code = '2400'
AND    m.inflow_type IN ('SIDE_FUND_CONTRIBUTION_IN', 'SIDE_FUND_DIRECT_IN', 'SIDE_FUND_PAYOUT_OUT')
AND    m.gl_account_id <> ga.id;

UPDATE gl_accounts
SET    is_active = FALSE,
       description = description || ' — Inactive since v1.66.0: the side fund is members'' money, now booked to 2400 Side Fund Payable.'
WHERE  code IN ('4300', '5200')
AND    is_active = TRUE;

-- ------------------------------------------------------------
-- 7. Month-end FX revaluation record.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_revaluation_runs (
    id                      SERIAL PRIMARY KEY,
    period_end              DATE          NOT NULL UNIQUE,   -- always the last day of a month
    functional_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    rates_used              JSONB         NOT NULL DEFAULT '[]'::jsonb,  -- [{currencyId, currencyCode, rate}] closing rates applied
    total_gain              NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_loss              NUMERIC(20,4) NOT NULL DEFAULT 0,
    notes                   TEXT,
    run_by                  INTEGER       NOT NULL REFERENCES users(id),
    run_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- One row per revalued balance. account_id is the bank/cash account
-- the balance is attributed to (the same attribution every GL line
-- carries); NULL for company-level non-cash balances.
CREATE TABLE IF NOT EXISTS fx_revaluation_lines (
    id                SERIAL PRIMARY KEY,
    run_id            INTEGER       NOT NULL REFERENCES fx_revaluation_runs(id) ON DELETE CASCADE,
    gl_account_id     INTEGER       NOT NULL REFERENCES gl_accounts(id),
    account_id        INTEGER REFERENCES accounts(id),
    currency_id       INTEGER       NOT NULL REFERENCES currencies(id),
    foreign_balance   NUMERIC(20,4) NOT NULL,   -- balance in the foreign currency (debit positive)
    closing_rate      NUMERIC(30,12) NOT NULL,
    carrying_before   NUMERIC(20,4) NOT NULL,   -- UGX value on the books before this run
    revalued_balance  NUMERIC(20,4) NOT NULL,   -- foreign_balance x closing_rate
    adjustment        NUMERIC(20,4) NOT NULL    -- revalued_balance - carrying_before (+ = debit the balance, gain on an asset / loss on a liability)
);

CREATE INDEX IF NOT EXISTS idx_fx_revaluation_lines_run ON fx_revaluation_lines (run_id);

COMMIT;
