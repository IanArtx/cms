-- ============================================================
-- CHECK APPLIED MIGRATIONS
--
-- WHAT THIS IS FOR: this project has no built-in "which migrations
-- have I run" table (some frameworks like Django/Rails/Knex have one
-- automatically — this project's migration_vX.X.X.sql files are
-- plain SQL you run by hand, so nothing tracks that automatically).
-- This script answers the question a different way: for each known
-- migration file in the cms/ folder, it checks your ACTUAL database
-- for a "fingerprint" — a table or column that ONLY exists once that
-- specific migration has been run — and reports APPLIED or MISSING.
--
-- HOW TO USE (step by step):
--   1. Open your database in whatever tool you use to run SQL —
--      pgAdmin, DBeaver, Render's own dashboard "Connect" > psql, or
--      the psql command line. If you're not sure how, Render's
--      dashboard has a "Connect" button on your database page that
--      gives you a ready-to-paste psql command.
--   2. Paste this whole file in and run it as ONE query.
--   3. You'll get one row per version, oldest first, with a STATUS
--      column that says either "applied" or "MISSING — run migration_vX.X.X.sql".
--   4. Anything marked MISSING needs that file run (see
--      DEPLOYMENT_GUIDE.md / the reminder Claude gives after each
--      migration) before you use that version's feature.
--
-- This is READ-ONLY — it only runs SELECT, it cannot change or break
-- anything in your database no matter what it finds.
--
-- A few versions (1.13.0, 1.18.0, 1.20.1, 1.21.1, 1.23.1, 1.25.1,
-- 1.26.1, 1.26.2, 1.27.0-1.27.3, 1.28.1, 1.28.2, 1.28.3, 1.29.1,
-- 1.30.1, 1.31.0, 1.32.1) either shipped NO schema migration at all
-- (pure code/frontend fixes — nothing to check for) or only changed
-- data/text rather than adding a table or column (so there's no
-- reliable single fingerprint) — those are shown as "code-only" or
-- "data-only, check manually" rather than applied/missing.
-- ============================================================

SELECT version, what_it_added, status FROM (
    VALUES
    (1,  '1.2.0',  'dividend_distributions table',        CASE WHEN to_regclass('public.dividend_distributions') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.2.0.sql' END),
    (2,  '1.3.0',  'bond_coupons table',                   CASE WHEN to_regclass('public.bond_coupons') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.3.0.sql' END),
    (3,  '1.4.0',  'requisitions.contribution_date column',CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='requisitions' AND column_name='contribution_date') THEN 'applied' ELSE 'MISSING — run migration_v1.4.0.sql' END),
    (4,  '1.5.0',  'investment_transactions table',        CASE WHEN to_regclass('public.investment_transactions') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.5.0.sql' END),
    (5,  '1.6.0',  'notifications table',                  CASE WHEN to_regclass('public.notifications') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.6.0.sql' END),
    (6,  '1.7.0',  'currency_exchange_rates table',         CASE WHEN to_regclass('public.currency_exchange_rates') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.7.0.sql' END),
    (7,  '1.8.0',  'share_certificates table',              CASE WHEN to_regclass('public.share_certificates') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.8.0.sql' END),
    (8,  '1.9.0',  'investments.first_coupon_date column',  CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='investments' AND column_name='first_coupon_date') THEN 'applied' ELSE 'MISSING — run migration_v1.9.0.sql' END),
    (9,  '1.9.1',  'company_settings.motto column',         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='company_settings' AND column_name='motto') THEN 'applied' ELSE 'MISSING — run migration_v1.9.1.sql' END),
    (10, '1.10.0', 'savings_balances table',                CASE WHEN to_regclass('public.savings_balances') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.10.0.sql' END),
    (11, '1.11.0', 'side_fund_config table',                CASE WHEN to_regclass('public.side_fund_config') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.11.0.sql' END),
    (12, '1.12.0', 'accounts.is_virtual column',             CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='accounts' AND column_name='is_virtual') THEN 'applied' ELSE 'MISSING — run migration_v1.12.0.sql' END),
    (13, '1.13.0', '(text-only permission description update)', 'data-only, check manually if unsure'),
    (14, '1.14.0', 'savings_pool_inflows table',            CASE WHEN to_regclass('public.savings_pool_inflows') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.14.0.sql' END),
    (15, '1.15.0', 'documents.template_data column',        CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='documents' AND column_name='template_data') THEN 'applied' ELSE 'MISSING — run migration_v1.15.0.sql' END),
    (16, '1.16.0', 'users.avatar_choice column',             CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='avatar_choice') THEN 'applied' ELSE 'MISSING — run migration_v1.16.0.sql' END),
    (17, '1.17.0', 'savings_handouts.category_id column',   CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='savings_handouts' AND column_name='category_id') THEN 'applied' ELSE 'MISSING — run migration_v1.17.0.sql' END),
    (18, '1.18.0', 'RECEIPT document_templates row seeded', CASE WHEN EXISTS (SELECT 1 FROM document_templates WHERE template_type = 'RECEIPT') THEN 'applied' ELSE 'MISSING — run migration_v1.18.0.sql' END),
    (19, '1.19.0', 'audit_engagements table',                CASE WHEN to_regclass('public.audit_engagements') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.19.0.sql' END),
    (20, '1.20.0', 'audit_submissions table',                CASE WHEN to_regclass('public.audit_submissions') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.20.0.sql' END),
    (21, '1.20.1', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (22, '1.21.0', 'staff_document_grants table',            CASE WHEN to_regclass('public.staff_document_grants') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.21.0.sql' END),
    (23, '1.21.1', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (24, '1.22.0', 'dividends.transaction_id column',        CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dividends' AND column_name='transaction_id') THEN 'applied' ELSE 'MISSING — run migration_v1.22.0.sql' END),
    (25, '1.23.0', 'membership_agreement table',              CASE WHEN to_regclass('public.membership_agreement') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.23.0.sql' END),
    (26, '1.23.1', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (27, '1.24.0', 'company_stamps table',                    CASE WHEN to_regclass('public.company_stamps') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.24.0.sql' END),
    (28, '1.24.1', 'company_settings.stamps_enabled column', CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='company_settings' AND column_name='stamps_enabled') THEN 'applied' ELSE 'MISSING — run migration_v1.24.1.sql' END),
    (29, '1.25.0', 'side_fund_member_overrides table',        CASE WHEN to_regclass('public.side_fund_member_overrides') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.25.0.sql' END),
    (30, '1.25.1', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (31, '1.26.0', 'side_fund_dues.due_date column',          CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='side_fund_dues' AND column_name='due_date') THEN 'applied' ELSE 'MISSING — run migration_v1.26.0.sql' END),
    (32, '1.26.1', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (33, '1.26.2', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (34, '1.27.0-1.27.3', '(code-only, no schema migration — 4 versions)', 'code-only — nothing to check'),
    (35, '1.28.0', 'mmf_accounts table',                      CASE WHEN to_regclass('public.mmf_accounts') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.28.0.sql' END),
    (36, '1.28.1', 'MEETING_AGENDA document_templates row seeded', CASE WHEN EXISTS (SELECT 1 FROM document_templates WHERE template_type = 'MEETING_AGENDA') THEN 'applied' ELSE 'MISSING — run migration_v1.28.1.sql' END),
    (37, '1.28.2', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (38, '1.28.3', '(data cleanup only — broken photo_path values)', 'data-only, check manually if unsure'),
    (39, '1.29.0', 'capital_goals table',                     CASE WHEN to_regclass('public.capital_goals') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.29.0.sql' END),
    (40, '1.29.1', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (41, '1.30.0', 'payment_acknowledgements table',          CASE WHEN to_regclass('public.payment_acknowledgements') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.30.0.sql' END),
    (42, '1.30.1', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (43, '1.30.2', 'payment_acknowledgements.source_type allows SAVINGS_HANDOUT', CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_acknowledgements_source_type_check' AND pg_get_constraintdef(oid) LIKE '%SAVINGS_HANDOUT%') THEN 'applied' ELSE 'MISSING — run migration_v1.30.2.sql' END),
    (44, '1.31.0', '(code-only, no schema migration)',       'code-only — nothing to check'),
    (45, '1.32.0', 'side_fund_members table',                 CASE WHEN to_regclass('public.side_fund_members') IS NOT NULL THEN 'applied' ELSE 'MISSING — run migration_v1.32.0.sql' END),
    (46, '1.32.1', '(code-only, no schema migration)',       'code-only — nothing to check')
) AS checks(sort_order, version, what_it_added, status)
ORDER BY sort_order;
