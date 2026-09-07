-- ============================================================
-- MIGRATION v1.48.0
-- 1. Capital call activation (no schema change — activate-call-
--    schedule reuses capital_goals.goal_type/fiscal_year/
--    call_deadline_day, all already nullable since v1.43.0).
-- 2. Configurable capital call fines — new capital_call_fine_settings
--    singleton table, replacing four previously hardcoded constants
--    in capitalGoalCallService.js (ITERATION1_GRACE_DAYS,
--    ITERATION2_WINDOW_DAYS, FINE_PERCENTAGE_WITHIN_GRACE,
--    FINE_PERCENTAGE_AFTER_GRACE). Defaults match those exact prior
--    values, so existing behaviour is unchanged until an Admin edits
--    them via Settings > Capital Call Fines.
-- Idempotent — safe to run against a database that already has
-- some or all of this applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS capital_call_fine_settings (
    id                            INTEGER      PRIMARY KEY DEFAULT 1,
    grace_days                    INTEGER      NOT NULL DEFAULT 7,
    fine_percentage_within_grace  NUMERIC(5,2) NOT NULL DEFAULT 5,
    fine_percentage_after_grace   NUMERIC(5,2) NOT NULL DEFAULT 10,
    iteration2_window_days        INTEGER      NOT NULL DEFAULT 7,
    updated_by                    INTEGER REFERENCES users(id),
    updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT single_row_only_fine_settings CHECK (id = 1)
);

INSERT INTO capital_call_fine_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
