-- ============================================================
-- MIGRATION v1.76.0 — Fixed exchange rate for every date before a
-- cut-off date (company decision)
--
-- Requested directly:
--   "would like that each euro is valued at UGX 4000 for any date in
--    both companies before 20th Aug 2025"
-- Confirmed:
--   - The live databases already have the monthly rates from
--     fx_rates.csv loaded (update guide step C1); the opening share
--     conversion (step C2) has NOT run yet.
--   - Transfers from the Euro account to a UGX account keep their own
--     recorded rate: the shillings that actually arrived in the bank
--     stay exactly as recorded.
--
-- WHAT THIS MIGRATION DOES
--   Only adds the rule itself — it changes no rate and no amount:
--
--   fx_fixed_rate_periods — one row per fixed rule:
--       1 base = rate target, for every date BEFORE valid_before.
--   Seeded with: 1 EUR = 4,000 UGX before 2025-08-20.
--
--   Once the rule exists, the system refuses anything that would
--   break it: a different rate entered in Settings for a date before
--   the cut-off (either direction of the pair), a CSV row in
--   backfill_v1.66.0_fx_rates.js, or a manual rate on a single
--   transaction dated before the cut-off.
--
-- APPLYING THE RULE TO THE BOOKS — a separate, one-time step with a
-- dry run first (it changes money values, so you see them first):
--     node update_live_database.js --url "…" --script apply_fixed_rates_v1.76.0.js --dry-run
--     node update_live_database.js --url "…" --script apply_fixed_rates_v1.76.0.js
-- See that file's header for exactly what it changes.
--
-- Safe to run more than once. Run it on BOTH databases.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fx_fixed_rate_periods (
    id                  SERIAL        PRIMARY KEY,
    base_currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    target_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    rate                NUMERIC(20,6) NOT NULL,
    valid_before        DATE          NOT NULL,     -- the rule covers every date BEFORE this one
    reason              TEXT          NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    applied_at          TIMESTAMPTZ,                -- set by apply_fixed_rates_v1.76.0.js
    applied_summary     JSONB,
    CONSTRAINT fx_fixed_rate_positive   CHECK (rate > 0),
    CONSTRAINT fx_fixed_rate_two_ccys   CHECK (base_currency_id <> target_currency_id),
    CONSTRAINT fx_fixed_rate_one_per_pair UNIQUE (base_currency_id, target_currency_id)
);

-- The rule asked for. Skipped (no error) on a database that has no
-- EUR or UGX currency.
INSERT INTO fx_fixed_rate_periods (base_currency_id, target_currency_id, rate, valid_before, reason)
SELECT e.id, u.id, 4000, DATE '2025-08-20',
       'Company decision (v1.76.0): 1 EUR is valued at UGX 4,000 for every date before 20 August 2025, in both companies.'
FROM   currencies e, currencies u
WHERE  e.code = 'EUR' AND u.code = 'UGX'
ON CONFLICT (base_currency_id, target_currency_id) DO NOTHING;

COMMIT;
