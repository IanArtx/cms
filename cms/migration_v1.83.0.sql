-- ============================================================
-- MIGRATION v1.83.0 — Bank of Uganda exchange rates every morning,
-- the bank's rate compared with BoU's on every transfer, and realised
-- exchange gains / losses on transfers.
--
-- Requested directly:
--   "is there a way that we can make an api that reads fx rates and
--    fills in the necessary ones in the update FX rate field everyday
--    from the BOU website"
--   "keep a person in the loop is okay and name the source but also
--    not to override hand entered input"
--   (the two additions offered — "i like the addition"):
--     • on the transfer form, show that day's BoU rate next to the
--       bank's rate and the difference in UGX, and ask for a check
--       when the gap is unusually large;
--     • book the difference between the bank's rate and BoU's rate on
--       a transfer as a REALISED exchange gain / loss when it happens,
--       separately from the month-end (unrealised) revaluation.
--
-- Source: Bank of Uganda publishes its daily "OPENING RATES" workbook
-- on bou.or.ug (middle, buying and selling UGX rates for 25+
-- currencies). An optional second source (AllRatesToday, which
-- republishes the same BoU table) is used only as a cross-check or
-- backup when its key is set — never on its own.
--
-- Rules:
--   1. Nothing goes into the rate table by itself: each morning the
--      BoU rate becomes a SUGGESTION that the Treasurer (or Assistant
--      Treasurer / Admin) approves or rejects.
--   2. Every rate names its source: MANUAL (typed in by a person —
--      every rate that already exists), BOU, ALLRATESTODAY.
--   3. A hand-entered rate is never replaced: no suggestion is made
--      for a date that already has a rate, a suggestion still waiting
--      is closed when a rate is typed in for its date, and approving
--      is refused if a rate has appeared for that date meanwhile.
--   4. A suggestion that moved more than the jump limit (default 3 %)
--      from the previous rate, or that disagrees with the cross-check
--      source, is flagged for a closer look.
--
-- Realised FX: for each transfer leg in a foreign currency, the
-- difference between its value at the reference rate of its date and
-- the UGX actually received / paid is stored in transaction_fx_results
-- and booked to 4610 (gain) / 5610 (loss). Transfers in months already
-- revalued and closed keep their old treatment (the difference is in
-- that month's revaluation) — fx_realised_from records the boundary,
-- so closed months never change.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Where each rate came from
-- ------------------------------------------------------------
ALTER TABLE currency_exchange_rates
    ADD COLUMN IF NOT EXISTS source        VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN IF NOT EXISTS source_detail TEXT,
    ADD COLUMN IF NOT EXISTS suggestion_id INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'currency_exchange_rates_source_check') THEN
        ALTER TABLE currency_exchange_rates
            ADD CONSTRAINT currency_exchange_rates_source_check
            CHECK (source IN ('MANUAL', 'BOU', 'ALLRATESTODAY'));
    END IF;
END $$;

COMMENT ON COLUMN currency_exchange_rates.source IS
    'v1.83.0 — MANUAL = typed in by a person (every rate before v1.83.0); BOU = Bank of Uganda opening rate, approved by set_by; ALLRATESTODAY = the backup source, approved by set_by.';

-- ------------------------------------------------------------
-- 2. The morning suggestions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_rate_suggestions (
    id                  SERIAL PRIMARY KEY,
    rate_date           DATE          NOT NULL,          -- the date BoU published it for
    base_currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    target_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    rate                NUMERIC(20,6) NOT NULL CHECK (rate > 0),   -- the middle rate
    buying_rate         NUMERIC(20,6),
    selling_rate        NUMERIC(20,6),
    source              VARCHAR(20)   NOT NULL CHECK (source IN ('BOU', 'ALLRATESTODAY')),
    source_detail       TEXT,                            -- e.g. 'BoU OPENING RATES workbook, middle rate, file updated …'
    cross_check_rate    NUMERIC(20,6),                   -- the other source's rate, when available
    previous_rate       NUMERIC(20,6),                   -- the rate on file the day before
    change_pct          NUMERIC(10,4),
    flagged             BOOLEAN       NOT NULL DEFAULT FALSE,
    flag_reason         TEXT,
    status              VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'KEPT_MANUAL', 'SUPERSEDED')),
    decided_by          INTEGER       REFERENCES users(id),
    decided_at          TIMESTAMPTZ,
    decision_note       TEXT,
    approved_rate_id    INTEGER       REFERENCES currency_exchange_rates(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT fx_rate_suggestions_pair_check CHECK (base_currency_id <> target_currency_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fx_rate_suggestions_one_per_day
    ON fx_rate_suggestions (rate_date, base_currency_id, target_currency_id);
CREATE INDEX IF NOT EXISTS fx_rate_suggestions_pending
    ON fx_rate_suggestions (status) WHERE status = 'PENDING';

-- ------------------------------------------------------------
-- 3. A log of every attempt to read the rates (the Treasurer is told
--    the same day when BoU cannot be read)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_feed_runs (
    id            SERIAL PRIMARY KEY,
    run_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    trigger       VARCHAR(20)   NOT NULL CHECK (trigger IN ('SCHEDULE', 'BY_HAND')),
    run_by        INTEGER       REFERENCES users(id),
    status        VARCHAR(20)   NOT NULL CHECK (status IN ('NEW_SUGGESTIONS', 'NOTHING_NEW', 'FAILED', 'SWITCHED_OFF')),
    source_used   VARCHAR(20),
    rate_date     DATE,
    suggestions   INTEGER       NOT NULL DEFAULT 0,
    message       TEXT,
    details       JSONB         NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS fx_feed_runs_recent ON fx_feed_runs (run_at DESC);

-- ------------------------------------------------------------
-- 4. Settings (Admin can change them in Settings › Currencies)
-- ------------------------------------------------------------
ALTER TABLE company_settings
    ADD COLUMN IF NOT EXISTS fx_feed_enabled          BOOLEAN       NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS fx_feed_jump_limit_pct   NUMERIC(6,2)  NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS fx_transfer_warn_pct     NUMERIC(6,2)  NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS fx_realised_from         DATE;

-- Realised FX applies to transfers dated AFTER this date: the last
-- month end already revalued and closed when v1.83.0 was installed
-- (closed months never change), or 1900-01-01 = from the very start
-- when no month had been closed yet. Set once, never moved.
UPDATE company_settings
SET    fx_realised_from = COALESCE((SELECT MAX(period_end) FROM fx_revaluation_runs), DATE '1900-01-01')
WHERE  id = 1 AND fx_realised_from IS NULL;

-- ------------------------------------------------------------
-- 5. Ledger accounts for REALISED differences. The existing 4600 /
--    5600 stay the month-end (unrealised) revaluation results.
-- ------------------------------------------------------------
INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order) VALUES
    ('4610', 'Realised Foreign Exchange Gains', 'REVENUE', 'CREDIT', 'REVENUE', 'OPERATING',
     'v1.83.0 — gains made when currency is actually converted: a transfer got more than its value at the reference (BoU) rate of its date.', 661),
    ('5610', 'Realised Foreign Exchange Losses', 'EXPENSE', 'DEBIT', 'EXPENSES', 'OPERATING',
     'v1.83.0 — losses made when currency is actually converted: a transfer got less than its value at the reference (BoU) rate of its date.', 761)
ON CONFLICT (code) DO NOTHING;

UPDATE gl_accounts SET name = 'Foreign Exchange Gains (unrealised, revaluation)'
WHERE  code = '4600' AND name = 'Foreign Exchange Gains';
UPDATE gl_accounts SET name = 'Foreign Exchange Losses (unrealised, revaluation)'
WHERE  code = '5600' AND name = 'Foreign Exchange Losses';

-- ------------------------------------------------------------
-- 6. The realised result of each foreign-currency transfer leg.
--    adjustment = how much the leg's UGX value must move to sit at the
--    reference rate (+ = debit the cash account, a gain; - = credit it,
--    a loss). A reversal leg carries the opposite of its original.
--    Recomputed for open months whenever a rate is entered or a
--    transfer is posted (recompute_transfer_fx); closed months keep
--    their rows.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_fx_results (
    transaction_id   INTEGER       PRIMARY KEY REFERENCES transactions(id),
    transfer_id      INTEGER       NOT NULL REFERENCES transfers(id),
    value_date       DATE          NOT NULL,
    currency_id      INTEGER       NOT NULL REFERENCES currencies(id),
    amount           NUMERIC(20,4) NOT NULL,          -- the leg, in its own currency
    reference_rate   NUMERIC(30,12) NOT NULL,         -- rate table on value_date
    reference_value  NUMERIC(20,4) NOT NULL,          -- amount x reference_rate (UGX)
    actual_value     NUMERIC(20,4) NOT NULL,          -- the leg's UGX value from the transfer's own rate
    adjustment       NUMERIC(20,4) NOT NULL,          -- signed, see above
    computed_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transaction_fx_results_date ON transaction_fx_results (value_date);

CREATE OR REPLACE FUNCTION recompute_transfer_fx(p_from DATE DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_func    INTEGER;
    v_closed  DATE;
    v_cut     DATE;
    v_start   DATE;
    v_count   INTEGER;
BEGIN
    SELECT functional_currency_id, fx_realised_from INTO v_func, v_cut FROM company_settings WHERE id = 1;
    IF v_func IS NULL OR v_cut IS NULL THEN
        RETURN 0;
    END IF;
    SELECT MAX(period_end) INTO v_closed FROM fx_revaluation_runs;
    -- First date that may change: after the boundary, after the last
    -- closed month, and not before the caller's own date.
    v_start := GREATEST(v_cut + 1, COALESCE(v_closed + 1, DATE '1900-01-01'), COALESCE(p_from, DATE '1900-01-01'));

    DELETE FROM transaction_fx_results WHERE value_date >= v_start;

    -- Original legs: the foreign-currency side of a posted transfer,
    -- valued with the transfer's own rate.
    INSERT INTO transaction_fx_results
        (transaction_id, transfer_id, value_date, currency_id, amount, reference_rate, reference_value, actual_value, adjustment)
    SELECT t.id, t.transfer_id, t.value_date, t.currency_id, t.amount, x.ref,
           ROUND(t.amount * x.ref, 4), t.functional_amount,
           CASE WHEN t.transaction_type = 'CREDIT'
                THEN ROUND(t.amount * x.ref, 4) - t.functional_amount
                ELSE t.functional_amount - ROUND(t.amount * x.ref, 4) END
    FROM   transactions t
    CROSS JOIN LATERAL (SELECT fx_rate_on(t.currency_id, v_func, t.value_date) AS ref) x
    WHERE  t.status = 'POSTED'
    AND    t.transfer_id IS NOT NULL
    AND    t.inflow_type IN ('TRANSFER_IN', 'TRANSFER_OUT')
    AND    t.reversal_of IS NULL
    AND    t.currency_id <> v_func
    AND    t.functional_rate_source = 'TRANSFER'
    AND    t.functional_amount IS NOT NULL
    AND    t.value_date >= v_start
    AND    x.ref IS NOT NULL
    AND    ABS(CASE WHEN t.transaction_type = 'CREDIT'
                    THEN ROUND(t.amount * x.ref, 4) - t.functional_amount
                    ELSE t.functional_amount - ROUND(t.amount * x.ref, 4) END) >= 0.01;

    -- Reversal legs: the opposite of their original (whenever that was).
    INSERT INTO transaction_fx_results
        (transaction_id, transfer_id, value_date, currency_id, amount, reference_rate, reference_value, actual_value, adjustment)
    SELECT r.id, o.transfer_id, r.value_date, r.currency_id, r.amount, o.reference_rate,
           o.reference_value, o.actual_value, -o.adjustment
    FROM   transactions r
    JOIN   transaction_fx_results o ON o.transaction_id = r.reversal_of
    WHERE  r.status = 'POSTED'
    AND    r.value_date >= v_start
    ON CONFLICT (transaction_id) DO NOTHING;

    SELECT COUNT(*) INTO v_count FROM transaction_fx_results WHERE value_date >= v_start;
    RETURN v_count;
END $$;

-- ------------------------------------------------------------
-- 7. The transfer form check: what the reference rate was when the
--    transfer was entered, how far the bank's rate was from it, and
--    who confirmed a large gap ("I have checked the bank's rate").
-- ------------------------------------------------------------
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS reference_rate        NUMERIC(20,8);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS reference_rate_source VARCHAR(20);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS rate_gap_pct          NUMERIC(10,4);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS rate_gap_confirmed_by INTEGER REFERENCES users(id);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS rate_gap_confirmed_at TIMESTAMPTZ;
COMMENT ON COLUMN transfers.reference_rate IS
    'v1.83.0 — the rate on file (BoU or hand-entered) for the value date when the transfer was entered or last edited, in the same direction as exchange_rate. NULL when none was on file. For information only — the books use exchange_rate.';
COMMENT ON COLUMN transfers.rate_gap_pct IS
    'v1.83.0 — (exchange_rate − reference_rate) / reference_rate × 100. Above company_settings.fx_transfer_warn_pct (either way) the person had to confirm it (rate_gap_confirmed_by / _at).';

SELECT recompute_transfer_fx(NULL);

COMMIT;
