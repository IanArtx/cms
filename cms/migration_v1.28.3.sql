-- ============================================================
-- MIGRATION v1.28.3 — Normalise pre-fix profile photo paths
--
-- updateProfilePhoto (usersController.js) used to store multer's raw
-- on-disk path in users.photo_path (e.g. "uploads/profiles/xxx.jpg"
-- on Linux, or "C:\...\uploads\profiles\xxx.jpg" on a Windows local
-- dev machine) instead of a clean "/uploads/..." URL path. The
-- frontend's getPhotoUrl() builds "<api origin>/<photo_path>" and the
-- static file server only answers under the "/uploads" prefix (see
-- server.js) — so any photo uploaded before this fix produced a
-- photo_path that never actually resolved to a working image, and
-- the avatar silently fell back to initials (Avatar.jsx's onError
-- handler). This is a one-time data cleanup for rows already written
-- with the old, broken format; the code fix (same release) stops any
-- new upload from creating another one.
--
-- Safe to run more than once — the WHERE clause only touches rows
-- that don't already match the correct "/uploads/profiles/..." form.
-- ============================================================

BEGIN;

UPDATE users
SET    photo_path = '/uploads/profiles/' || regexp_replace(photo_path, '^.*[\\/]', '')
WHERE  photo_path IS NOT NULL
AND    photo_path !~ '^/uploads/profiles/';

COMMIT;
