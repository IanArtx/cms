-- ============================================================
-- MIGRATION v1.16.0 — PROFILE PICTURES: DISPLAY + AVATAR SET
--
-- Fixes a gap where an uploaded profile photo (users.photo_path)
-- was correctly stored on the backend and correctly served via the
-- static /uploads mount, but the frontend never actually displayed
-- it anywhere — every avatar location in the app (top bar, sidebar,
-- Users list, Profile page) showed only initials, regardless of
-- whether a photo existed.
--
-- 1. New users.gender (VARCHAR) column — MALE / FEMALE / OTHER,
--    optional. Used only to pick a sensible default illustrated
--    avatar; never required, never shown elsewhere in the UI.
-- 2. New users.avatar_choice (VARCHAR) column — stores the id of a
--    built-in illustrated avatar (e.g. 'male-1', 'female-2',
--    'neutral-1') a user can pick instead of uploading a real photo.
--
-- Display priority (frontend, code-only change alongside this
-- migration): real uploaded photo_path -> chosen avatar_choice
-- illustration -> initials (existing fallback, unchanged).
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
    ADD COLUMN IF NOT EXISTS avatar_choice VARCHAR(30);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'users'::regclass
        AND pg_get_constraintdef(oid) LIKE '%gender%IN%MALE%'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_gender_check
            CHECK (gender IN ('MALE','FEMALE','OTHER'));
    END IF;
END $$;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and rebuild/refresh the frontend.
--   2. On the Profile page, a new "Choose an avatar" option appears
--      next to the existing photo upload — pick a gender to see a
--      matching set of illustrated avatars, or keep using a real
--      uploaded photo. Uploaded photos always take priority.
--   3. Anywhere an avatar appears (top bar, sidebar, Users list,
--      Profile page), it now shows, in order: the uploaded photo if
--      one exists, otherwise the chosen illustrated avatar, otherwise
--      initials (the old default) — nothing changes for users who
--      never touch the new feature.
-- ------------------------------------------------------------
