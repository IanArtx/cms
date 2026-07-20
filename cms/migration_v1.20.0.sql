-- ============================================================
-- MIGRATION v1.20.0 — AUDITOR SUBMISSION WORKFLOW
--
-- Extends the v1.19.0 external audit portal with:
--   - required auditor profile fields (company name/initials/phone),
--     used to build that auditor's reference-code prefix
--   - a running comment log per engagement
--   - staged report-file uploads
--   - a "Finish Audit" submission, requiring BOTH a Director and a
--     Secretary to approve before the system generates reference
--     codes, creates the actual documents, and archives them
--   - extension-of-access requests, reviewed by a Director or
--     Secretary
--   - a dedup table backing the daily access-expiry reminder job
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. Auditor profile fields on users
-- ----------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS auditor_company_name     VARCHAR(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS auditor_company_initials VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS auditor_contact_phone    VARCHAR(30);

-- ----------------------------------------------------------
-- 2. documents.document_type — add AUDITOR_FEEDBACK, AUDIT_REPORT
-- ----------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'documents'::regclass
        AND pg_get_constraintdef(oid) LIKE '%AUDITOR_FEEDBACK%'
    ) THEN
        ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
        ALTER TABLE documents
            ADD CONSTRAINT documents_document_type_check
            CHECK (document_type IN (
                'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
                'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL',
                'RECEIPT','RESOLUTION','CONTRACT','LOAN_AGREEMENT','GRANT_AGREEMENT',
                'AUDITOR_FEEDBACK','AUDIT_REPORT','OTHER'
            ));
    END IF;
END $$;

-- ----------------------------------------------------------
-- 3. audit_submissions
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_submissions (
    id                  SERIAL PRIMARY KEY,
    engagement_id       INTEGER      NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    submitted_by        INTEGER      NOT NULL REFERENCES users(id),
    submitted_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    status              VARCHAR(20)  NOT NULL DEFAULT 'SUBMITTED'
                        CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
    director_approved_by INTEGER REFERENCES users(id),
    director_approved_at TIMESTAMPTZ,
    secretary_approved_by INTEGER REFERENCES users(id),
    secretary_approved_at TIMESTAMPTZ,
    rejected_by         INTEGER REFERENCES users(id),
    rejected_at         TIMESTAMPTZ,
    rejection_reason    TEXT,
    feedback_document_id INTEGER REFERENCES documents(id)
);

-- ----------------------------------------------------------
-- 4. audit_engagement_comments
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_engagement_comments (
    id            SERIAL PRIMARY KEY,
    engagement_id INTEGER     NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    user_id       INTEGER     NOT NULL REFERENCES users(id),
    comment_text  TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    submission_id INTEGER REFERENCES audit_submissions(id)
);

-- ----------------------------------------------------------
-- 5. audit_submission_files
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_submission_files (
    id                SERIAL PRIMARY KEY,
    engagement_id     INTEGER      NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    submission_id     INTEGER REFERENCES audit_submissions(id),
    file_path         TEXT         NOT NULL,
    file_name         TEXT         NOT NULL,
    file_size_bytes   BIGINT,
    mime_type         VARCHAR(100),
    uploaded_by       INTEGER      NOT NULL REFERENCES users(id),
    uploaded_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    document_id       INTEGER REFERENCES documents(id)
);

-- ----------------------------------------------------------
-- 6. audit_extension_requests
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_extension_requests (
    id                            SERIAL PRIMARY KEY,
    engagement_id                 INTEGER      NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    requested_by                  INTEGER      NOT NULL REFERENCES users(id),
    current_access_expires_at     TIMESTAMPTZ,
    requested_new_access_expires_at TIMESTAMPTZ NOT NULL,
    reason                        TEXT         NOT NULL,
    status                        VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                                  CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    reviewed_by                   INTEGER REFERENCES users(id),
    reviewed_at                   TIMESTAMPTZ,
    reviewer_notes                TEXT,
    created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------
-- 7. audit_engagement_reminders_sent
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_engagement_reminders_sent (
    id            SERIAL PRIMARY KEY,
    engagement_id INTEGER     NOT NULL REFERENCES audit_engagements(id) ON DELETE CASCADE,
    days_before   INTEGER     NOT NULL,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (engagement_id, days_before)
);

-- ----------------------------------------------------------
-- 8. Indexes
-- ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_submissions_engagement        ON audit_submissions (engagement_id);
CREATE INDEX IF NOT EXISTS idx_audit_submissions_status             ON audit_submissions (status);
CREATE INDEX IF NOT EXISTS idx_audit_engagement_comments_engagement ON audit_engagement_comments (engagement_id);
CREATE INDEX IF NOT EXISTS idx_audit_engagement_comments_submission ON audit_engagement_comments (submission_id);
CREATE INDEX IF NOT EXISTS idx_audit_submission_files_engagement    ON audit_submission_files (engagement_id);
CREATE INDEX IF NOT EXISTS idx_audit_submission_files_submission    ON audit_submission_files (submission_id);
CREATE INDEX IF NOT EXISTS idx_audit_extension_requests_engagement  ON audit_extension_requests (engagement_id);
CREATE INDEX IF NOT EXISTS idx_audit_extension_requests_status      ON audit_extension_requests (status);

COMMIT;

-- After running this migration:
--   1. Restart/redeploy the backend so the new routes and the
--      reminder cron job are picked up.
--   2. Nothing to configure manually — an auditor will be prompted
--      to fill in their company name/initials/phone the first time
--      they open the External Audit portal after this deploys.
