-- ============================================================
-- MIGRATION v1.7.0
-- Adds:
--   1. company_settings: description, mission, vision, core_values
--      — "About" content, editable the same way as branding
--      (Settings > Company, Admin only).
--   2. currency_exchange_rates — monthly, company-set exchange
--      rates used ONLY to DISPLAY the share price/value in
--      currencies other than the one it was set in. Settable by
--      Treasurer, Assistant Treasurer, or Admin.
--
-- Safe to run more than once — every statement checks first.
--
-- NOTE: if you are running this on a database where ALTER TABLE
-- on pre-existing tables fails with "must be owner of table ...",
-- run this through pgAdmin's Query Tool (connected as your admin/
-- postgres login) rather than through the app's own cms_user —
-- see migration_v1.6.0's notes for why.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. company_settings — About content
-- ------------------------------------------------------------
ALTER TABLE company_settings
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS mission     TEXT,
    ADD COLUMN IF NOT EXISTS vision      TEXT,
    ADD COLUMN IF NOT EXISTS core_values TEXT;

-- ------------------------------------------------------------
-- 2. currency_exchange_rates
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS currency_exchange_rates (
    id                  SERIAL PRIMARY KEY,
    base_currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    target_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    rate                NUMERIC(20,6) NOT NULL,
    effective_from      DATE          NOT NULL,
    effective_to        DATE,
    set_by              INTEGER       NOT NULL REFERENCES users(id),
    notes               TEXT,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_exchange_rate CHECK (rate > 0),
    CONSTRAINT different_currencies   CHECK (base_currency_id != target_currency_id)
);

CREATE INDEX IF NOT EXISTS idx_fx_rates_current
    ON currency_exchange_rates (base_currency_id, target_currency_id)
    WHERE effective_to IS NULL;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Go to Settings > Company (Admin) and fill in the new
--      Description, Mission, Vision, and Core Values fields.
--   2. Go to Accounts and set an initial exchange rate under the
--      new "Exchange Rates" card (Treasurer/Assistant Treasurer/
--      Admin) — this is only used to show the share price/value
--      converted into other currencies, it does not affect any
--      contribution or transaction amounts.
--   3. If you skipped the permissions grant block from v1.6.0's
--      troubleshooting, run it again — this migration creates a
--      new table (currency_exchange_rates) whose auto-increment
--      sequence will need the same USAGE grant for cms_user if it
--      was created through an admin/pgAdmin connection:
--        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_user;
--        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cms_user;
-- ------------------------------------------------------------
