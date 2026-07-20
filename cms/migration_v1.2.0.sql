-- ============================================================
-- MIGRATION: v1.1.0 -> v1.2.0
-- Run this ONLY if you already created the database from the old
-- schema.sql (v1.1.0) before this fix. If you're setting up a fresh
-- database, ignore this file — just run the current schema.sql,
-- it already includes everything below.
--
-- Safe to run more than once: every step is guarded (IF NOT EXISTS,
-- or a DO block that ignores "already exists" errors), so re-running
-- it won't fail or duplicate anything.
--
-- What this adds (see schema.sql v1.2.0 changelog for details):
--   1. transfers: sending_bank_charge, receiving_bank_charge,
--      sending_charge_tx_id, receiving_charge_tx_id
--   2. transactions: contributed_by
--   3. Five new tables: dividends, dividend_distributions,
--      authority_payments, member_savings, requisitions
--   4. Indexes for all of the above
--   5. Backfills category_paths for the seed categories (Income,
--      Expense, Active, Pipeline, etc.) — these were inserted directly
--      by schema.sql's seed data and skipped the category_paths row
--      that the categories API route normally creates alongside a new
--      category. Without it, every screen that shows a category's full
--      path (investments, grants, loans, requisitions, documents,
--      events, transactions) INNER JOINs category_paths and silently
--      gets zero rows back for anything using a seed category — e.g.
--      an investment's detail page returning "not found" even though
--      the investment exists.
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. transfers — bank charge amounts + linked charge transactions
-- ----------------------------------------------------------
ALTER TABLE transfers
    ADD COLUMN IF NOT EXISTS sending_bank_charge    NUMERIC(20,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS receiving_bank_charge   NUMERIC(20,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sending_charge_tx_id    INTEGER,
    ADD COLUMN IF NOT EXISTS receiving_charge_tx_id  INTEGER;

DO $$
BEGIN
    ALTER TABLE transfers
        ADD CONSTRAINT non_negative_charges
        CHECK (sending_bank_charge >= 0 AND receiving_bank_charge >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE transfers
        ADD CONSTRAINT fk_transfers_sending_charge_tx
        FOREIGN KEY (sending_charge_tx_id) REFERENCES transactions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE transfers
        ADD CONSTRAINT fk_transfers_receiving_charge_tx
        FOREIGN KEY (receiving_charge_tx_id) REFERENCES transactions(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------
-- 2. transactions — who the transaction was recorded on behalf of
-- ----------------------------------------------------------
ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS contributed_by INTEGER;

DO $$
BEGIN
    ALTER TABLE transactions
        ADD CONSTRAINT fk_transactions_contributed_by
        FOREIGN KEY (contributed_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------
-- 3. New tables
-- ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS dividends (
    id               SERIAL PRIMARY KEY,
    reference_id     INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id       INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id      INTEGER       NOT NULL REFERENCES currencies(id),
    category_id      INTEGER       NOT NULL REFERENCES categories(id),
    total_amount     NUMERIC(20,4) NOT NULL,
    period_label     VARCHAR(100),
    declaration_date DATE          NOT NULL,
    payment_date     TIMESTAMPTZ,
    status           VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','PAID','CANCELLED')),
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by       INTEGER       NOT NULL REFERENCES users(id),
    approved_by      INTEGER REFERENCES users(id),
    approved_at      TIMESTAMPTZ,
    CONSTRAINT positive_dividend_total CHECK (total_amount > 0)
);

CREATE TABLE IF NOT EXISTS dividend_distributions (
    id                 SERIAL PRIMARY KEY,
    dividend_id        INTEGER       NOT NULL REFERENCES dividends(id),
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    shares_at_time     NUMERIC(20,4) NOT NULL,
    percentage_at_time NUMERIC(8,4)  NOT NULL,
    amount             NUMERIC(20,4) NOT NULL,
    status             VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','PAID')),
    transaction_id     INTEGER REFERENCES transactions(id),
    paid_at            TIMESTAMPTZ,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_distribution_amount CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS authority_payments (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    account_id     INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    category_id    INTEGER       NOT NULL REFERENCES categories(id),
    transaction_id INTEGER       NOT NULL REFERENCES transactions(id),
    authority_type VARCHAR(20)   NOT NULL
                   CHECK (authority_type IN ('URA','URSB','BANK','NSSF','OTHER')),
    authority_name VARCHAR(255)  NOT NULL,
    payment_type   VARCHAR(100),
    authority_ref  VARCHAR(150),
    amount         NUMERIC(20,4) NOT NULL,
    payment_date   DATE          NOT NULL,
    notes          TEXT,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_authority_amount CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS member_savings (
    id                         SERIAL PRIMARY KEY,
    reference_id               INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id                    INTEGER       NOT NULL REFERENCES users(id),
    account_id                 INTEGER       NOT NULL REFERENCES accounts(id),
    currency_id                INTEGER       NOT NULL REFERENCES currencies(id),
    category_id                INTEGER       NOT NULL REFERENCES categories(id),
    principal_amount           NUMERIC(20,4) NOT NULL,
    interest_rate              NUMERIC(8,4)  NOT NULL DEFAULT 0,
    interest_period             VARCHAR(20)   NOT NULL DEFAULT 'ANNUALLY'
                                CHECK (interest_period IN ('DAILY','WEEKLY','MONTHLY','ANNUALLY')),
    deposit_date                DATE          NOT NULL,
    maturity_date               DATE          NOT NULL,
    amount_at_maturity          NUMERIC(20,4) NOT NULL,
    status                      VARCHAR(30)   NOT NULL DEFAULT 'ACTIVE'
                                CHECK (status IN ('ACTIVE','WITHDRAWN','CANCELLED')),
    notes                       TEXT,
    transaction_id              INTEGER       NOT NULL REFERENCES transactions(id),
    withdrawal_transaction_id   INTEGER REFERENCES transactions(id),
    withdrawn_at                TIMESTAMPTZ,
    withdrawn_by                INTEGER REFERENCES users(id),
    created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by                  INTEGER       NOT NULL REFERENCES users(id),
    CONSTRAINT positive_savings_principal CHECK (principal_amount > 0),
    CONSTRAINT maturity_after_deposit CHECK (maturity_date > deposit_date)
);

CREATE TABLE IF NOT EXISTS requisitions (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER       NOT NULL REFERENCES references_registry(id),
    requested_by      INTEGER       NOT NULL REFERENCES users(id),
    category_id       INTEGER       NOT NULL REFERENCES categories(id),
    title             VARCHAR(255)  NOT NULL,
    description       TEXT,
    amount_requested  NUMERIC(20,4) NOT NULL,
    purpose           TEXT          NOT NULL,
    required_by_date  DATE,
    priority          VARCHAR(20)   NOT NULL DEFAULT 'NORMAL'
                      CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
    status            VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
    account_id        INTEGER REFERENCES accounts(id),
    currency_id       INTEGER REFERENCES currencies(id),
    amount_approved   NUMERIC(20,4),
    transaction_id    INTEGER REFERENCES transactions(id),
    reviewed_by       INTEGER REFERENCES users(id),
    reviewed_at       TIMESTAMPTZ,
    review_notes      TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_amount_requested CHECK (amount_requested > 0),
    CONSTRAINT positive_amount_approved  CHECK (amount_approved IS NULL OR amount_approved > 0)
);

-- ----------------------------------------------------------
-- 4. Indexes
-- ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_dividends_status       ON dividends (status);
CREATE INDEX IF NOT EXISTS idx_dividends_account      ON dividends (account_id);
CREATE INDEX IF NOT EXISTS idx_dividend_dist_dividend ON dividend_distributions (dividend_id);
CREATE INDEX IF NOT EXISTS idx_dividend_dist_user     ON dividend_distributions (user_id);

CREATE INDEX IF NOT EXISTS idx_authority_payments_type    ON authority_payments (authority_type);
CREATE INDEX IF NOT EXISTS idx_authority_payments_account ON authority_payments (account_id);

CREATE INDEX IF NOT EXISTS idx_member_savings_user     ON member_savings (user_id);
CREATE INDEX IF NOT EXISTS idx_member_savings_status   ON member_savings (status);
CREATE INDEX IF NOT EXISTS idx_member_savings_maturity ON member_savings (maturity_date);

CREATE INDEX IF NOT EXISTS idx_requisitions_status       ON requisitions (status);
CREATE INDEX IF NOT EXISTS idx_requisitions_requested_by ON requisitions (requested_by);
CREATE INDEX IF NOT EXISTS idx_requisitions_priority     ON requisitions (priority);

-- ----------------------------------------------------------
-- 5. Backfill category_paths for any category that's missing one
--    (covers the seed categories, and any others created before this
--    was noticed). Safe to re-run — only inserts rows that don't exist.
-- ----------------------------------------------------------
INSERT INTO category_paths (category_id, full_path, full_abbreviation, depth)
SELECT c.id, c.name, c.abbreviation, 0
FROM categories c
WHERE c.parent_id IS NULL
AND   NOT EXISTS (
    SELECT 1 FROM category_paths cp WHERE cp.category_id = c.id
);

COMMIT;

-- ============================================================
-- Done. Your database is now equivalent to a fresh run of
-- schema.sql v1.2.0.
-- ============================================================
