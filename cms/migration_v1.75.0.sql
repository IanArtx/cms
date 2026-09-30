-- ============================================================
-- MIGRATION v1.75.0 — Smoother password and email-address changes
--
-- Requested directly:
--   "I would like to enable people change their email addresses and
--    passwords more smoothly now"
-- Confirmed decisions:
--   1. After a password change or a "forgot password" reset, every
--      OTHER signed-in device is signed out (the device used to change
--      it stays signed in).
--   2. Email change is self-service: it only takes effect once the
--      member clicks the link sent to the NEW address; the OLD address
--      is told and can cancel (or undo, if it was already confirmed).
--   3. An Admin can start an email change for a member (e.g. lost
--      inbox) — the member must still confirm from the new address,
--      both addresses are told, and it is audit-logged.
--
-- Nothing existing is changed; no money moves. Safe to run again.
-- ============================================================

BEGIN;

-- Every sign-in carries the account's session_version. Changing or
-- resetting the password adds 1, which ends every older sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version     INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_changed_at    TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS email_change_requests (
    id                   SERIAL       PRIMARY KEY,
    user_id              INTEGER      NOT NULL REFERENCES users(id),
    old_email            VARCHAR(255) NOT NULL,
    new_email            VARCHAR(255) NOT NULL,
    -- Only SHA-256 hashes of the two link tokens are stored, never the
    -- tokens themselves (someone reading the database can't use them).
    confirm_token_hash   CHAR(64)     NOT NULL,
    cancel_token_hash    CHAR(64)     NOT NULL,
    status               VARCHAR(12)  NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED', 'REVERTED')),
    requested_by         INTEGER      NOT NULL REFERENCES users(id),
    requested_by_admin   BOOLEAN      NOT NULL DEFAULT FALSE,
    admin_reason         TEXT,
    expires_at           TIMESTAMPTZ  NOT NULL,           -- confirm link: 48 hours
    undo_until           TIMESTAMPTZ,                     -- old-address "this wasn't me": 7 days
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    confirmed_at         TIMESTAMPTZ,
    cancelled_at         TIMESTAMPTZ,
    cancelled_by         INTEGER      REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_change_one_pending
    ON email_change_requests(user_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_email_change_confirm_hash ON email_change_requests(confirm_token_hash);
CREATE INDEX IF NOT EXISTS idx_email_change_cancel_hash  ON email_change_requests(cancel_token_hash);

COMMIT;
