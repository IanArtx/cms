-- ============================================================
-- MIGRATION v1.63.0 — Online Events (Google Meet auto-creation) +
--                      "Notify Everyone" event audience
--
-- Requested directly: "is it possible that the system creates
-- automatically an online meeting event (on google meet for example)
-- when an event is expected to be online or have people attend
-- online?" followed by "yes please build it also add the option to
-- alert shareholders/individual selection/directors/everyone by email
-- when an event is created."
--
-- Three clarifying questions were asked and answered before building:
--   - Google Meet OAuth setup: WALK ME THROUGH IT NOW — a guided,
--     one-time Google Cloud Console session with the user (their own
--     Google login required; Claude cannot do this step for them).
--   - When to send the audience alert: KEEP IT AT APPROVAL — matches
--     the existing behaviour (event_notifications' role/individual
--     recipients are already only emailed once a Director approves,
--     not at creation/DRAFT). "Everyone" simply becomes a fourth
--     audience option alongside the existing per-person/per-role
--     picker, not a new send trigger.
--   - "Everyone" scope: EVERY ACTIVE USER, ANY ROLE — including
--     Admin/Treasurer/Secretary, not just Shareholders/Directors.
--
-- Shareholders and Directors were already coverable via the existing
-- event_notifications.role_id targeting (both are real rows in
-- `roles`), and "individual selection" already existed via
-- event_notifications.user_id — so this migration's schema changes
-- are only what's genuinely new: the online/meeting-link fields on
-- `events`, the notify_all_users flag for the "Everyone" audience,
-- and a new table to hold the Google OAuth connection.
-- ============================================================

-- ----------------------------------------------------------
-- Online meeting fields on events
-- ----------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_online BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS meeting_link TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS meeting_provider VARCHAR(20);
ALTER TABLE events ADD COLUMN IF NOT EXISTS google_calendar_event_id VARCHAR(255);
ALTER TABLE events ADD COLUMN IF NOT EXISTS notify_all_users BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'events_meeting_provider_check'
    ) THEN
        ALTER TABLE events ADD CONSTRAINT events_meeting_provider_check
            CHECK (meeting_provider IN ('GOOGLE_MEET','MANUAL'));
    END IF;
END $$;

-- ----------------------------------------------------------
-- Google Calendar / Meet integration — single-row settings table
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS google_calendar_settings (
    id                   INTEGER      PRIMARY KEY DEFAULT 1,
    is_connected         BOOLEAN      NOT NULL DEFAULT FALSE,
    refresh_token        TEXT,
    google_account_email VARCHAR(255),
    calendar_id          VARCHAR(255) NOT NULL DEFAULT 'primary',
    connected_by         INTEGER REFERENCES users(id),
    connected_at         TIMESTAMPTZ,
    CONSTRAINT single_row_only CHECK (id = 1)
);

INSERT INTO google_calendar_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Idempotent — safe to run against a database that already has these
-- columns/table (e.g. re-running after a partial deploy).
