-- ============================================================
-- MIGRATION v1.19.0 — EXTERNAL AUDIT PORTAL
--
-- Adds a way to give an external audit firm a dedicated, narrowly
-- scoped, revocable login instead of ever handing out a real
-- member/staff role. Introduces:
--   - a new "Auditor" system role (grants nothing by itself)
--   - audit_engagements — one row per named audit engagement
--     (e.g. "2025 Annual Audit — Firm X"), with its own date range
--     and optional access expiry
--   - audit_engagement_accounts — which accounts an engagement can
--     see transactions for
--   - audit_engagement_users — which user logins belong to an
--     engagement
--   - audit_engagement_documents — which specific documents an
--     Admin has chosen to make previewable for an engagement
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. New role — Auditor
-- ----------------------------------------------------------
INSERT INTO roles (name, description, is_system_role)
SELECT 'Auditor',
       'External auditor — read-only access to a specific scoped audit engagement, nothing else',
       TRUE
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Auditor');

-- ----------------------------------------------------------
-- 2. audit_engagements
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_engagements (
    id                 SERIAL PRIMARY KEY,
    name               VARCHAR(200) NOT NULL,
    description        TEXT,
    period_start       DATE         NOT NULL,
    period_end         DATE         NOT NULL,
    access_expires_at  TIMESTAMPTZ,
    status             VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','REVOKED')),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by         INTEGER      NOT NULL REFERENCES users(id),
    revoked_at         TIMESTAMPTZ,
    revoked_by         INTEGER REFERENCES users(id),
    CONSTRAINT check_audit_period_valid CHECK (period_end >= period_start)
);

-- ----------------------------------------------------------
-- 3. audit_engagement_accounts
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_engagement_accounts (
    engagement_id INTEGER NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    PRIMARY KEY (engagement_id, account_id)
);

-- ----------------------------------------------------------
-- 4. audit_engagement_users
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_engagement_users (
    engagement_id INTEGER NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by      INTEGER REFERENCES users(id),
    PRIMARY KEY (engagement_id, user_id)
);

-- ----------------------------------------------------------
-- 5. audit_engagement_documents
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_engagement_documents (
    engagement_id INTEGER NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    document_id   INTEGER NOT NULL REFERENCES documents(id),
    added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by      INTEGER REFERENCES users(id),
    PRIMARY KEY (engagement_id, document_id)
);

-- ----------------------------------------------------------
-- 6. Indexes
-- ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_engagement_accounts_engagement  ON audit_engagement_accounts (engagement_id);
CREATE INDEX IF NOT EXISTS idx_audit_engagement_users_user           ON audit_engagement_users (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_engagement_documents_engagement ON audit_engagement_documents (engagement_id);

COMMIT;

-- After running this migration:
--   1. Restart/redeploy the backend so the new routes (/api/audit/*)
--      and controller are picked up.
--   2. An Admin creates an engagement from the new "External Audit"
--      page (Settings area), picks the accounts and date range to
--      expose, and adds the auditor's email — the auditor must
--      already have registered (or does so now, requesting the
--      "Auditor" role, which is auto-granted the moment an Admin
--      attaches them to an engagement).
--   3. Optionally attach specific documents the auditor should be
--      able to preview (financial reports, resolutions, etc.).
--   4. The auditor logs in normally and lands on their own
--      dedicated /audit page — nothing else in the app is visible
--      to that role.
