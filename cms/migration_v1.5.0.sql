-- ============================================================
-- MIGRATION v1.5.0
-- Adds:
--   1. investment_transactions — EXPENSE/INFLOW/TAX entries recorded
--      directly against a single investment's own operating budget,
--      each automatically posted to the general ledger.
--   2. company_settings — single-row table for company branding
--      (name, address, logo, brand colors), editable by a System
--      Admin through Settings > Company without a redeploy.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. investment_transactions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investment_transactions (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    investment_id  INTEGER       NOT NULL REFERENCES investments(id),
    transaction_id INTEGER       NOT NULL REFERENCES transactions(id),
    entry_type     VARCHAR(20)   NOT NULL
                   CHECK (entry_type IN ('EXPENSE', 'INFLOW', 'TAX')),
    amount         NUMERIC(20,4) NOT NULL,
    description    TEXT          NOT NULL,
    entry_date     DATE          NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_inv_txn_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_inv_txn_investment ON investment_transactions (investment_id);
CREATE INDEX IF NOT EXISTS idx_inv_txn_type       ON investment_transactions (entry_type);

-- ------------------------------------------------------------
-- 2. company_settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
    id              INTEGER      PRIMARY KEY DEFAULT 1,
    company_name    VARCHAR(200) NOT NULL,
    company_address TEXT,
    logo_url        TEXT,
    primary_color   VARCHAR(7)   NOT NULL DEFAULT '#1e3a5f',
    accent_color    VARCHAR(7)   NOT NULL DEFAULT '#c9a227',
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by      INTEGER REFERENCES users(id),
    CONSTRAINT single_row_only CHECK (id = 1)
);

-- Seed the one settings row if it doesn't already exist. If you already
-- have real values entered via env vars (COMPANY_NAME / COMPANY_ADDRESS),
-- this uses them as the starting point so nothing appears to "reset."
INSERT INTO company_settings (id, company_name, company_address)
SELECT 1, 'ZWECK TUKULA Ltd', 'WAKISO, UGANDA'
WHERE NOT EXISTS (SELECT 1 FROM company_settings WHERE id = 1);

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Go to Settings > Company (System Admin) and confirm/update the
--      company name, address, logo, and brand colors — the row seeded
--      above is just a starting point copied from your current .env.
--   2. No permission assignment is needed for this — company settings
--      edits are restricted to the "Admin" role directly, the same
--      pattern used for contribution recording in v1.4.0.
-- ------------------------------------------------------------
