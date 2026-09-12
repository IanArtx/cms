-- ============================================================
-- MIGRATION v1.54.0 — Service Fee monthly period exclusions, and a
-- system-wide repair pass for confirmed payments that never got
-- applied to any period (see backfill_v1.54.0_orphaned_service_fee_payments.js).
--
-- 1. service_fee_monthly_periods.status gains 'EXCLUDED' — a month
--    waived out of the agreement entirely: not owed, not counted as
--    outstanding/overdue, and deliberately NOT counted as PAID either,
--    since no money actually moved. Reversible (see include-period).
--
-- 2. service_fee_monthly_periods gains excluded_reason/excluded_by/
--    excluded_at — deliberately separate from the existing
--    amount_override/override_reason/override_by/override_at columns,
--    since Exclude and Override are two different actions (cancel the
--    obligation vs. change what it's worth).
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied.
-- ============================================================

DO $$
DECLARE
    con_name text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'service_fee_monthly_periods'::regclass
        AND pg_get_constraintdef(oid) LIKE '%EXCLUDED%'
    ) THEN
        SELECT conname INTO con_name
        FROM   pg_constraint
        WHERE  conrelid = 'service_fee_monthly_periods'::regclass
        AND    pg_get_constraintdef(oid) LIKE '%status%'
        AND    pg_get_constraintdef(oid) LIKE '%UNPAID%';
        IF con_name IS NOT NULL THEN
            EXECUTE 'ALTER TABLE service_fee_monthly_periods DROP CONSTRAINT ' || quote_ident(con_name);
        END IF;
        ALTER TABLE service_fee_monthly_periods
            ADD CONSTRAINT service_fee_monthly_periods_status_check
            CHECK (status IN ('UNPAID', 'PARTIAL', 'PAID', 'EXCLUDED'));
    END IF;
END $$;

ALTER TABLE service_fee_monthly_periods ADD COLUMN IF NOT EXISTS excluded_reason TEXT;
ALTER TABLE service_fee_monthly_periods ADD COLUMN IF NOT EXISTS excluded_by INTEGER REFERENCES users(id);
ALTER TABLE service_fee_monthly_periods ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ;
