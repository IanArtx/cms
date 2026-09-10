-- ============================================================
-- MIGRATION v1.52.0 — Service Fee monthly period tracking
--
-- Retrofits a proper "which month is this?" concept onto Service
-- Fees, which today is just a running list of undated payments
-- against a flat monthly_amount. Mirrors side_fund_dues/
-- side_fund_payment_applications (the closest existing analog — a
-- flat recurring amount, no pledge/iteration/fine machinery), NOT
-- the capital_goal_calls "historical read-only aggregate" pattern,
-- since there's no "tracking wasn't turned on yet" concept here —
-- monthly tracking is being retrofitted for every existing
-- agreement's ENTIRE history, all at once, via the companion
-- backfill script (backfill_v1.52.0_service_fees.js).
--
-- 1. service_fee_agreements.payment_day — the day of the month each
--    period is due, mirroring capital_goals.call_deadline_day
--    (1-28, so dateInPeriod() can always resolve a real calendar
--    date without special-casing short months). NOT NULL — every
--    agreement needs one so the due-date reminder job has something
--    to check. Backfilled from each agreement's own start_date so
--    existing agreements keep behaving the same way they always
--    implicitly have (billed from whatever day they started on).
--
-- 2. service_fee_monthly_periods — one row per agreement per
--    calendar month from the agreement's start_date through the
--    current month. amount_due/amount_paid/status are CACHED
--    columns (recomputed by serviceFeeService whenever a payment is
--    applied or an override is set) — same shape as side_fund_dues,
--    not the live-computed-on-read style capital_goal_calls uses,
--    because a flat monthly fee has no pledge/fine layer sitting on
--    top of it that would make a cached column drift-prone.
--    amount_override/override_reason/override_by/override_at let the
--    Treasurer change a SINGLE historical month's amount_due without
--    touching the agreement's ongoing monthly_amount (that's what
--    service_fee_agreement_amendments is for — a going-forward
--    change, the wrong tool for a one-off month) — audited via
--    logAction rather than a dedicated history table, matching the
--    scope of everything else this table needs to do.
--
-- 3. service_fee_payment_applications — append-only record of
--    exactly which period(s) a real, CONFIRMED service_fee_payments
--    row settled, and how much of it went to each — mirrors
--    side_fund_payment_applications. Needed because one payment
--    (e.g. "settle all past months") can span several periods, and
--    because a single period can be paid across more than one
--    payment (partial payments).
--
-- 4. service_fee_payment_confirmation_periods — the PENDING version
--    of the above. payment_confirmations has no JSON/metadata column
--    and only a single source_id (the agreement, not a period), so
--    there's nowhere on that table to carry a per-period breakdown
--    while a bulk settlement sits in PENDING_CONFIRMATION waiting on
--    the recipient. This table carries it: written when the
--    confirmation is created (one row for a single-month payment,
--    several for a bulk settlement), read by confirmPayment() once
--    the real service_fee_payments row exists, to populate #3 above.
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied.
-- ============================================================

ALTER TABLE service_fee_agreements ADD COLUMN IF NOT EXISTS payment_day SMALLINT;

UPDATE service_fee_agreements
SET    payment_day = LEAST(EXTRACT(DAY FROM start_date)::INT, 28)
WHERE  payment_day IS NULL;

ALTER TABLE service_fee_agreements ALTER COLUMN payment_day SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'service_fee_payment_day_range'
    ) THEN
        ALTER TABLE service_fee_agreements
            ADD CONSTRAINT service_fee_payment_day_range
            CHECK (payment_day BETWEEN 1 AND 28);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS service_fee_monthly_periods (
    id               SERIAL PRIMARY KEY,
    agreement_id     INTEGER       NOT NULL REFERENCES service_fee_agreements(id),
    period           CHAR(7)       NOT NULL,  -- 'YYYY-MM'
    amount_due       NUMERIC(20,4) NOT NULL,
    amount_paid      NUMERIC(20,4) NOT NULL DEFAULT 0,
    status           VARCHAR(20)   NOT NULL DEFAULT 'UNPAID'
                     CHECK (status IN ('UNPAID', 'PARTIAL', 'PAID')),
    due_date         DATE          NOT NULL,
    amount_override  NUMERIC(20,4),
    override_reason  TEXT,
    override_by      INTEGER REFERENCES users(id),
    override_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT non_negative_service_fee_period_due      CHECK (amount_due >= 0),
    CONSTRAINT non_negative_service_fee_period_paid     CHECK (amount_paid >= 0),
    CONSTRAINT non_negative_service_fee_period_override CHECK (amount_override IS NULL OR amount_override >= 0),
    UNIQUE (agreement_id, period)
);
CREATE INDEX IF NOT EXISTS idx_service_fee_periods_agreement ON service_fee_monthly_periods (agreement_id);
CREATE INDEX IF NOT EXISTS idx_service_fee_periods_due_date  ON service_fee_monthly_periods (due_date);

CREATE TABLE IF NOT EXISTS service_fee_payment_applications (
    id             SERIAL PRIMARY KEY,
    payment_id     INTEGER       NOT NULL REFERENCES service_fee_payments(id),
    period_id      INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount         NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (payment_id, period_id)
);
CREATE INDEX IF NOT EXISTS idx_service_fee_applications_payment ON service_fee_payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS idx_service_fee_applications_period  ON service_fee_payment_applications (period_id);

CREATE TABLE IF NOT EXISTS service_fee_payment_confirmation_periods (
    id               SERIAL PRIMARY KEY,
    confirmation_id  INTEGER       NOT NULL REFERENCES payment_confirmations(id),
    period_id        INTEGER       NOT NULL REFERENCES service_fee_monthly_periods(id),
    amount           NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (confirmation_id, period_id)
);
CREATE INDEX IF NOT EXISTS idx_service_fee_confirmation_periods_confirmation ON service_fee_payment_confirmation_periods (confirmation_id);

-- Dedup table for the due-date reminder cron job — mirrors the audit
-- engagement reminder pattern (scheduler.js): ON CONFLICT DO NOTHING
-- guarantees at most one reminder per (agreement, period, calendar
-- day), so a job that runs daily until a period is settled never
-- double-notifies within the same day even if the sweep is retried.
CREATE TABLE IF NOT EXISTS service_fee_due_reminders_sent (
    id            SERIAL PRIMARY KEY,
    agreement_id  INTEGER     NOT NULL REFERENCES service_fee_agreements(id),
    period_id     INTEGER     NOT NULL REFERENCES service_fee_monthly_periods(id),
    sent_date     DATE        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agreement_id, period_id, sent_date)
);
