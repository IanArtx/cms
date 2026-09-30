-- ============================================================
-- MIGRATION v1.74.0 — Maintenance mode
--
-- Requested directly:
--   "add a page that shows whenever I would like to make updates to
--    the system. This is triggered by admin in settings and informs
--    all except the admin that the system is under maintenance. It
--    should be independent of any errors in the system else where and
--    also a status on the admin side to show that this mode is still
--    on when enabled"
-- Confirmed decisions:
--   1. Switched in Settings › Maintenance (stored here); the Render
--      setting MAINTENANCE_MODE=on also forces it on (for when the
--      database itself is being worked on).
--   2. Only the Admin role keeps using the system.
--   3. Automatic nightly jobs are paused while it is on; each skipped
--      run is recorded and caught up automatically when it is turned
--      off (the daily interest jobs once per missed date).
--   4. Optional "email all members" tick box when switching.
--
-- Three new tables. Nothing existing changes; no money moves.
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- The switch itself — one row only (id = 1).
CREATE TABLE IF NOT EXISTS system_maintenance (
    id               INTEGER      PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    is_on            BOOLEAN      NOT NULL DEFAULT FALSE,
    message          TEXT,                         -- shown to members on the maintenance page
    expected_end     TIMESTAMPTZ,                  -- optional "back by"
    started_at       TIMESTAMPTZ,
    started_by       INTEGER      REFERENCES users(id),
    ended_at         TIMESTAMPTZ,
    ended_by         INTEGER      REFERENCES users(id),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
INSERT INTO system_maintenance (id, is_on) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;

-- History of every switch on/off.
CREATE TABLE IF NOT EXISTS maintenance_events (
    id              SERIAL       PRIMARY KEY,
    event           VARCHAR(10)  NOT NULL CHECK (event IN ('ON', 'OFF', 'UPDATE')),
    message         TEXT,
    expected_end    TIMESTAMPTZ,
    emailed_members BOOLEAN      NOT NULL DEFAULT FALSE,
    user_id         INTEGER      REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Nightly jobs that were skipped because maintenance was on, and when
-- they were caught up afterwards.
CREATE TABLE IF NOT EXISTS maintenance_skipped_jobs (
    id              SERIAL       PRIMARY KEY,
    job_name        VARCHAR(80)  NOT NULL,
    run_date        DATE         NOT NULL,     -- the date the job would have processed
    skipped_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    caught_up_at    TIMESTAMPTZ,
    result          TEXT,                      -- 'done' or the error message
    UNIQUE (job_name, run_date)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_skipped_pending
    ON maintenance_skipped_jobs(caught_up_at) WHERE caught_up_at IS NULL;

COMMIT;
