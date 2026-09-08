-- ============================================================
-- MIGRATION v1.51.0
--
-- 1. capital_goals.effective_from — the date pledging/iteration/fine
--    machinery actually starts for a PRIMARY (or SECONDARY) goal.
--    Must be the 1st of a month, and (when set) within
--    [start_date, end_date]. NULL means "same as start_date" (the
--    default, zero-behaviour-change case for every goal created
--    before this version, and for any new goal that doesn't need a
--    transition gap). Any month whose period is BEFORE
--    effective_from's own period is "historical" — its monthly call
--    is generated already CLOSED, with no pledging/iteration/fines,
--    and its "collected" figure is a read-only aggregate of the
--    real shareholder_contributions already recorded in that month
--    (see capitalGoalCallService.getPeriodCollected).
--
-- 2. capital_goal_settings — new singleton toggle table. Capital
--    Goal Tracking (the whole feature: goals, monthly calls,
--    pledges, fines, the Dashboard widgets) is no longer assumed to
--    be in use by every company — an Admin can switch it off
--    entirely (hides the UI, skips the daily cron sweep, and the
--    write endpoints reject with a clear error) without losing any
--    existing data, and switch it back on later with no migration
--    needed. Defaults to TRUE (enabled) so every existing deployment
--    keeps working exactly as before until an Admin deliberately
--    changes it.
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied.
-- ============================================================

ALTER TABLE capital_goals ADD COLUMN IF NOT EXISTS effective_from DATE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'capital_goal_effective_from_first_of_month'
    ) THEN
        ALTER TABLE capital_goals
            ADD CONSTRAINT capital_goal_effective_from_first_of_month
            CHECK (effective_from IS NULL OR EXTRACT(DAY FROM effective_from) = 1);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS capital_goal_settings (
    id               INTEGER     PRIMARY KEY DEFAULT 1,
    tracking_enabled BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_by       INTEGER REFERENCES users(id),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT single_row_only_capital_goal_settings CHECK (id = 1)
);

INSERT INTO capital_goal_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
