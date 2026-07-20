-- ============================================================
-- MIGRATION: v1.2.0 -> v1.3.0
-- Run this ONLY if you already created the database from the old
-- schema.sql (v1.2.0) before this fix. If you're setting up a fresh
-- database, ignore this file — just run the current schema.sql,
-- it already includes everything below.
--
-- Safe to run more than once: every step is guarded (IF NOT EXISTS,
-- or a DO block that ignores "already exists" errors), so re-running
-- it won't fail or duplicate anything.
--
-- What this adds (see schema.sql v1.3.0 changelog for details):
--   1. investments: investment_type, face_value, coupon_rate,
--      coupon_frequency, tax_withholding_rate + the bond_fields_required
--      check constraint
--   2. New table: bond_coupons (the generated payment schedule for
--      BOND-type investments)
--   3. Indexes for all of the above
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. investments — bond-specific fields
-- ----------------------------------------------------------
ALTER TABLE investments
    ADD COLUMN IF NOT EXISTS investment_type       VARCHAR(20)   NOT NULL DEFAULT 'STANDARD',
    ADD COLUMN IF NOT EXISTS face_value             NUMERIC(20,4),
    ADD COLUMN IF NOT EXISTS coupon_rate             NUMERIC(8,4),
    ADD COLUMN IF NOT EXISTS coupon_frequency        VARCHAR(20),
    ADD COLUMN IF NOT EXISTS tax_withholding_rate    NUMERIC(8,4)  NOT NULL DEFAULT 0;

DO $$
BEGIN
    ALTER TABLE investments
        ADD CONSTRAINT investments_investment_type_check
        CHECK (investment_type IN ('STANDARD', 'BOND'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE investments
        ADD CONSTRAINT investments_coupon_frequency_check
        CHECK (coupon_frequency IN (
            'MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY', 'AT_MATURITY'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE investments
        ADD CONSTRAINT bond_fields_required
        CHECK (
            investment_type != 'BOND' OR (
                face_value        IS NOT NULL AND face_value > 0 AND
                coupon_rate        IS NOT NULL AND coupon_rate >= 0 AND
                coupon_frequency    IS NOT NULL AND
                start_date          IS NOT NULL AND
                expected_end_date   IS NOT NULL
            )
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------
-- 2. bond_coupons — payment schedule for BOND investments
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS bond_coupons (
    id                   SERIAL PRIMARY KEY,
    investment_id        INTEGER       NOT NULL REFERENCES investments(id),
    coupon_number        INTEGER       NOT NULL,
    due_date             DATE          NOT NULL,
    gross_amount         NUMERIC(20,4) NOT NULL,
    tax_amount           NUMERIC(20,4) NOT NULL DEFAULT 0,
    net_amount           NUMERIC(20,4) NOT NULL,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'PAID', 'MISSED')),
    investment_return_id INTEGER REFERENCES investment_returns(id),
    paid_at              TIMESTAMPTZ,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_coupon_gross CHECK (gross_amount > 0),
    CONSTRAINT unique_investment_coupon UNIQUE (investment_id, coupon_number)
);

-- ----------------------------------------------------------
-- 3. Indexes
-- ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_investments_type        ON investments (investment_type);
CREATE INDEX IF NOT EXISTS idx_bond_coupons_investment  ON bond_coupons (investment_id);
CREATE INDEX IF NOT EXISTS idx_bond_coupons_status      ON bond_coupons (status);
CREATE INDEX IF NOT EXISTS idx_bond_coupons_due_date    ON bond_coupons (due_date);

COMMIT;

-- ============================================================
-- Done. Your database is now equivalent to a fresh run of
-- schema.sql v1.3.0.
-- ============================================================
