-- ============================================================
-- MIGRATION v1.82.0 — Guided tour and the new user manual
--
-- Requested directly:
--   "the system needs a guided tour functionality that shows the users
--    how to navigate through the system explaining the functionality of
--    the features and update of the about page which should in detail
--    describe the navigation (where to find what) and working of each
--    feature, what it does, steps to follow when going through the
--    features. This is what should be comprised in the downloadable
--    manual in the about section."
-- Confirmed: the main tour starts by itself the first time a person
-- signs in and is remembered in their account (so it does not start
-- again on another phone or computer); it can be taken again at any
-- time from the profile menu or the About page.
--
-- The only database change: each account remembers which tours it has
-- finished or skipped, e.g.
--   {"main": {"status": "done", "at": "2026-10-07T09:00:00Z"},
--    "page:transactions": {"status": "skipped", "at": "…"}}
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS tours_seen JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.tours_seen IS
    'v1.82.0 — guided tours this person has finished or skipped: {tour_id: {status: done|skipped, at}}. The main tour starts by itself only while "main" is missing.';

COMMIT;
