-- ============================================================
-- MIGRATION v1.84.0 — shares allotted inside the company, certificates
-- only for shares registered with URSB, and the share-register
-- correction (exchange rate of the day).
--
-- Requested directly:
--   "shares are alloted internally within the company but issued
--    officially when registered at the URSB. So a shareholder keeps
--    track of how much they hold in shares and ownership and get their
--    share certificates once the register is updated and the system
--    still tracks the overflow. The share certificates should also show
--    the increase and effective date."
--   "the AGM or any minutes that record attendance with a showing of the
--    shareholding shows only the registered shares one holds"
--   "issuance should follow the step in the first statement, but first
--    now only what is registered"
--   Option A for the 62 contributions valued at 4,000 in the share
--   register but at the rate of the day in the books
--   (rebuild_share_register_v1.84.0.js).
--
-- What this adds:
--   1. Certificate type REGISTRATION — issued when a member's
--      URSB-registered shares change (a return of allotment marked
--      filed, or the URSB figure entered/changed), showing the shares
--      registered before, the increase and the effective date.
--   2. share_certificates.basis — REGISTERED for every certificate from
--      now on; INTERNAL marks the certificates issued before v1.84.0
--      (they showed the shares allotted inside the company).
--   3. share_allotments.rate_correction — allotments added by the
--      v1.84.0 share-register correction.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Certificate types
-- ------------------------------------------------------------
ALTER TABLE share_certificates DROP CONSTRAINT IF EXISTS share_certificates_certificate_type_check;
ALTER TABLE share_certificates ADD CONSTRAINT share_certificates_certificate_type_check
    CHECK (certificate_type IN ('MONTHLY', 'ANNUAL', 'REGISTRATION'));
ALTER TABLE certificate_signing_rounds DROP CONSTRAINT IF EXISTS certificate_signing_rounds_certificate_type_check;
ALTER TABLE certificate_signing_rounds ADD CONSTRAINT certificate_signing_rounds_certificate_type_check
    CHECK (certificate_type IN ('MONTHLY', 'ANNUAL', 'REGISTRATION'));

-- ------------------------------------------------------------
-- 2. What a certificate is based on, and the registration change
-- ------------------------------------------------------------
ALTER TABLE share_certificates ADD COLUMN IF NOT EXISTS basis               VARCHAR(20) NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE share_certificates ADD COLUMN IF NOT EXISTS registered_previous INTEGER;
ALTER TABLE share_certificates ADD COLUMN IF NOT EXISTS registered_increase INTEGER;
ALTER TABLE share_certificates ADD COLUMN IF NOT EXISTS effective_date      DATE;
ALTER TABLE share_certificates ADD COLUMN IF NOT EXISTS total_registered    INTEGER;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_certificates_basis_check') THEN
        ALTER TABLE share_certificates ADD CONSTRAINT share_certificates_basis_check CHECK (basis IN ('INTERNAL', 'REGISTERED'));
    END IF;
END $$;
COMMENT ON COLUMN share_certificates.basis IS
    'v1.84.0 — REGISTERED: shares registered with URSB (every certificate from v1.84.0 on). INTERNAL: certificates issued before v1.84.0, which showed the shares allotted inside the company.';
COMMENT ON COLUMN share_certificates.registered_previous IS
    'v1.84.0 — shares registered before this certificate''s change (REGISTRATION certificates), or on the holder''s previous registered certificate.';
COMMENT ON COLUMN share_certificates.effective_date IS
    'v1.84.0 — the date the shares on the certificate became registered (return of allotment filed / URSB figure as at).';

-- ------------------------------------------------------------
-- 3. Allotments added by the share-register correction
-- ------------------------------------------------------------
ALTER TABLE share_allotments ADD COLUMN IF NOT EXISTS rate_correction BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN share_allotments.rate_correction IS
    'v1.84.0 — added by rebuild_share_register_v1.84.0.js: extra whole shares from valuing a contribution at the exchange rate of its day instead of 4,000. Dated on the contribution''s own date; its return of allotment is still to be filed.';

COMMIT;
