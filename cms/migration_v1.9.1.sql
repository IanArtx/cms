-- ============================================================
-- MIGRATION v1.9.1
--
-- Adds: company_settings.motto — a short tagline, editable from
-- Settings > Company alongside the existing About fields.
--
-- Also fixes (code-only, no schema change needed, deployed alongside
-- this migration):
--   - The company name in the TopBar was reading a static, build-time
--     value instead of the live Settings > Company value, so editing
--     it there never changed what appeared in the top bar.
--   - The About page's Mission, Vision, and Core Values were entirely
--     hardcoded placeholder text — editing them in Settings > Company
--     never had any effect on what the About page showed. Now reads
--     the live values (and shows a "not set yet" hint if empty),
--     plus a new Description section and the Motto added here.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

ALTER TABLE company_settings
    ADD COLUMN IF NOT EXISTS motto VARCHAR(300);

COMMENT ON COLUMN company_settings.motto IS
    'Short company tagline, shown on the About page alongside '
    'Mission/Vision/Core Values.';

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend and refresh/rebuild the frontend so it
--      picks up the code changes deployed alongside this migration.
--   2. Go to Settings > Company and fill in (or re-save) Motto,
--      Description, Mission, Vision, and Core Values.
--   3. Check the top bar — the company name next to the page title
--      should now match Settings immediately, no rebuild needed for
--      future edits.
--   4. Check About & Manual > Company Info — Motto, Description, and
--      Mission & Values should now show exactly what's in Settings.
--   5. If cms_user doesn't already have full rights on changed tables
--      via an admin/pgAdmin connection, re-run:
--        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_user;
--        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cms_user;
-- ------------------------------------------------------------
