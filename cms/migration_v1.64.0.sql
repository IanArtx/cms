-- ============================================================
-- MIGRATION v1.64.0
-- 1. Account-activity reporting + currency-aware GL Suite use only
--    existing tables — no schema change needed for those.
-- 2. Share certificates: point-in-time snapshot date + mandatory
--    signing before send. Adds `as_of_date` to both
--    certificate_signing_rounds (one value per round) and
--    share_certificates (denormalized per certificate for easy
--    display without a join).
--
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE certificate_signing_rounds
    ADD COLUMN IF NOT EXISTS as_of_date DATE;

ALTER TABLE share_certificates
    ADD COLUMN IF NOT EXISTS as_of_date DATE;
