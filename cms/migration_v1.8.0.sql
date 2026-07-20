-- ============================================================
-- MIGRATION v1.8.0
-- Adds: share_certificates — Certificate of Shares records.
-- Same format for both types, they only differ in how often
-- they're issued and which reference series/period they carry:
--   'MONTHLY' — issued on demand, or automatically on the 1st of
--               every month
--   'ANNUAL'  — issued on demand, or automatically on 1 January
--               for the year that just ended
--
-- Each certificate gets its own unique reference number via the
-- existing references_registry mechanism (module code 'SHC'),
-- e.g. SHC-MONTHLY-202608-00001 or SHC-ANNUAL-2026-00001.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS share_certificates (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id           INTEGER       NOT NULL REFERENCES users(id),
    certificate_type  VARCHAR(20)   NOT NULL
                      CHECK (certificate_type IN ('MONTHLY', 'ANNUAL')),
    period_label      VARCHAR(20)   NOT NULL,   -- '202607' (monthly) or '2026' (annual)
    shares_held       NUMERIC(20,4) NOT NULL,
    percentage        NUMERIC(8,4),
    price_per_share   NUMERIC(20,4),
    currency_id       INTEGER REFERENCES currencies(id),
    share_value       NUMERIC(20,4),
    issued_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    -- NULL issued_by means it was issued automatically by the
    -- monthly/annual schedule rather than a person clicking a button.
    issued_by         INTEGER REFERENCES users(id),
    email_sent        BOOLEAN       NOT NULL DEFAULT FALSE,
    email_error       TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_certs_user ON share_certificates (user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_certs_type ON share_certificates (certificate_type);

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Go to My Profile and try "Download Monthly Certificate" /
--      "Download Annual Certificate" — opens a print-ready,
--      branded Certificate of Shares in a new tab.
--   2. Go to Reports (Admin) and try "Issue Certificates Now" to
--      test the automatic email pipeline (renders a PDF with
--      headless Chrome and emails it) without waiting for the
--      1st of the month/year.
--   3. If cms_user doesn't already have full rights on new tables
--      created via an admin/pgAdmin connection, re-run:
--        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_user;
--        GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cms_user;
-- ------------------------------------------------------------
