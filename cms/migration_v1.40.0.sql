-- ============================================================
-- MIGRATION v1.40.0 — Bonds & Investments overhaul
--
-- Run this against an EXISTING database that already has
-- migration_v1.39.0.sql applied. Brand-new databases should just
-- load the full schema.sql instead (it already includes all of
-- this in-place).
--
-- WHAT THIS ADDS:
--
--   1. Bond settlement value — a bond is often bought at a discount
--      or premium to its face value (e.g. a UGX 10,000,000 bond
--      settled at 96% = UGX 9,600,000 actually spent), while the
--      coupon (interest) math always stays on the face value. A new
--      `investments.settlement_value` column records the real price
--      paid so the app can show the discount/premium % — this is
--      purely informational, it does not change any coupon math.
--
--   2. Bond coupon actual-payment override — sometimes the coupon
--      actually paid differs from what was scheduled. A new "Record
--      Actual Payment" action (backend: payBondCoupon now accepts an
--      optional actual_gross_amount) lets a Treasurer enter what was
--      really received; tax is auto-recalculated on that new gross
--      amount using the bond's tax_withholding_rate. Only that one
--      coupon is affected — the rest of the schedule is untouched.
--      The scheduled gross/tax/net columns are left as the ORIGINAL
--      forecast; the new actual_* columns record what really
--      happened, only when it differs.
--
--   3. Supplementary budget — when money added to an investment
--      (capital funding, operational expenses/tax) pushes total
--      spend past planned_budget, the excess is automatically
--      tracked in a new `investments.supplementary_budget` running
--      total. No separate manual action needed — it's detected and
--      logged automatically every time spend crosses the budget
--      line.
--
--   4. Fixed spent-tracking bug — operational transactions
--      (EXPENSE/TAX entries recorded against an investment's own
--      operating budget) now also add to `actual_expenditure` (the
--      "Spent" figure), same as capital funding already did. Before
--      this fix, money spent via "Record Operational Transaction"
--      left the funding account but was never counted as spent
--      against the investment.
--
--   5. Mid-term termination workflow — a new two-step close-out:
--      the investment's responsible person confirms all
--      returns/expenses/transactions are up to date, then a
--      Treasurer/Director gives final sign-off, which locks in a
--      closing report stating whether the investment profited or
--      lost money, and by how much. Two new statuses
--      (PENDING_TERMINATION, TERMINATED) and a handful of new
--      tracking columns support this — deliberately NOT reachable
--      via the generic PATCH /:id/status endpoint, only via the
--      dedicated /terminate/* endpoints, so the workflow can't be
--      bypassed.
--
--   6. Profit/loss flag — derived at read-time from existing
--      total_returns vs actual_expenditure figures (no new stored
--      column — same pattern as the existing roi_percentage).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Bond settlement value
-- ------------------------------------------------------------
ALTER TABLE investments
    ADD COLUMN settlement_value NUMERIC(20,4);

ALTER TABLE investments
    ADD CONSTRAINT positive_settlement_value
    CHECK (settlement_value IS NULL OR settlement_value > 0);

COMMENT ON COLUMN investments.settlement_value IS
    'Actual price paid to acquire a BOND, if different from face_value '
    '(discount/premium). NULL means bought at par (100% of face value). '
    'Informational only — coupon math always uses face_value.';

-- ------------------------------------------------------------
-- 2. Bond coupon actual-payment override (bond_coupons)
-- ------------------------------------------------------------
ALTER TABLE bond_coupons
    ADD COLUMN actual_gross_amount NUMERIC(20,4),
    ADD COLUMN actual_tax_amount   NUMERIC(20,4),
    ADD COLUMN actual_net_amount   NUMERIC(20,4),
    ADD COLUMN adjusted_by         INTEGER REFERENCES users(id),
    ADD COLUMN adjusted_at         TIMESTAMPTZ;

ALTER TABLE bond_coupons
    ADD CONSTRAINT positive_actual_coupon_gross
    CHECK (actual_gross_amount IS NULL OR actual_gross_amount > 0);

COMMENT ON COLUMN bond_coupons.actual_gross_amount IS
    'Set only when the amount actually received differs from the '
    'scheduled gross_amount. Tax/net are recalculated from this using '
    'the bond''s tax_withholding_rate. NULL means paid exactly as scheduled.';

-- ------------------------------------------------------------
-- 3. Supplementary budget (investments)
-- ------------------------------------------------------------
ALTER TABLE investments
    ADD COLUMN supplementary_budget NUMERIC(20,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN investments.supplementary_budget IS
    'Auto-tracked running total of spend that pushed actual_expenditure '
    'past planned_budget. Updated automatically by fundInvestment and '
    'recordInvestmentTransaction — never set directly by the user.';

-- ------------------------------------------------------------
-- 5. Mid-term termination workflow (investments)
-- ------------------------------------------------------------
ALTER TABLE investments
    ADD COLUMN status_before_termination VARCHAR(30),
    ADD COLUMN termination_requested_by  INTEGER REFERENCES users(id),
    ADD COLUMN termination_requested_at  TIMESTAMPTZ,
    ADD COLUMN termination_reason        TEXT,
    ADD COLUMN records_confirmed_by      INTEGER REFERENCES users(id),
    ADD COLUMN records_confirmed_at      TIMESTAMPTZ,
    ADD COLUMN termination_approved_by   INTEGER REFERENCES users(id),
    ADD COLUMN termination_approved_at   TIMESTAMPTZ,
    ADD COLUMN termination_report        TEXT;

-- Widen the status check constraint to add the two new termination
-- statuses. Postgres has no "ALTER CHECK", so drop (by its actual
-- auto-generated name, looked up dynamically — same pattern used
-- throughout this migration history) and recreate.
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'investments'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%status%PENDING%ACTIVE%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE investments DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE investments ADD CONSTRAINT investments_status_check
        CHECK (status IN (
            'PENDING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED',
            'PENDING_TERMINATION','TERMINATED'
        ));
END $$;

COMMENT ON COLUMN investments.status_before_termination IS
    'Snapshot of status immediately before a termination request, so a '
    'rejected termination can restore it exactly (ACTIVE vs ON_HOLD).';

COMMIT;
