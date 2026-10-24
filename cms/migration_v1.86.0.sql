-- ============================================================
-- MIGRATION v1.86.0 — access control: invitations, declining access,
-- automatic clean-up of unanswered registrations
--
-- Requested directly: "we really need to get the security of the
-- system solid because i have noticed on the online systems there are
-- some accounts that are demanding access and i don't recognise them at
-- all. I need a standard way to reject access and keep the system
-- secure".
--
-- What this adds:
--   1. access_control_settings (one row) — how new accounts are made:
--        INVITE_ONLY (default) — only with an invitation an Admin sent
--                                to that email address;
--        OPEN                  — anyone may register, an Admin assigns
--                                (or declines) the role;
--        CLOSED                — nobody can register;
--      plus the clean-up limits and blocked email domains.
--   2. account_invitations — one per invitation (the link's token is
--      stored hashed; it expires; used / revoked are recorded).
--   3. blocked_emails — addresses that may not register again.
--   4. users: who declined the account, when and why; where it
--      registered from (IP, browser); the invitation it used; when its
--      email verification link expires.
--
-- Nothing already recorded changes. Safe to run more than once.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS access_control_settings (
    id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    registration_mode       VARCHAR(20) NOT NULL DEFAULT 'INVITE_ONLY'
                            CHECK (registration_mode IN ('INVITE_ONLY', 'OPEN', 'CLOSED')),
    unverified_expiry_days  INTEGER     NOT NULL DEFAULT 3  CHECK (unverified_expiry_days BETWEEN 1 AND 60),
    pending_expiry_days     INTEGER     NOT NULL DEFAULT 30 CHECK (pending_expiry_days BETWEEN 0 AND 365),
    invite_valid_days       INTEGER     NOT NULL DEFAULT 7  CHECK (invite_valid_days BETWEEN 1 AND 60),
    blocked_domains         TEXT[]      NOT NULL DEFAULT '{}',
    notify_admins           BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by              INTEGER     REFERENCES users(id)
);
INSERT INTO access_control_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE access_control_settings IS
    'v1.86.0 — how new accounts are made (INVITE_ONLY / OPEN / CLOSED), automatic clean-up limits (unverified_expiry_days; pending_expiry_days, 0 = never) and email domains that may not register.';

CREATE TABLE IF NOT EXISTS account_invitations (
    id               SERIAL PRIMARY KEY,
    email            VARCHAR(255) NOT NULL,
    first_name       VARCHAR(100),
    last_name        VARCHAR(100),
    role_id          INTEGER      REFERENCES roles(id),
    note             TEXT,
    token_hash       VARCHAR(128) NOT NULL UNIQUE,
    expires_at       TIMESTAMPTZ  NOT NULL,
    invited_by       INTEGER      NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    sent_count       INTEGER      NOT NULL DEFAULT 1,
    last_sent_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    used_at          TIMESTAMPTZ,
    used_by_user_id  INTEGER      REFERENCES users(id),
    revoked_at       TIMESTAMPTZ,
    revoked_by       INTEGER      REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_account_invitations_email ON account_invitations (lower(email));

CREATE TABLE IF NOT EXISTS blocked_emails (
    id          SERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    reason      TEXT,
    blocked_by  INTEGER      REFERENCES users(id),
    blocked_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_blocked_emails_email ON blocked_emails (lower(email));

ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_at                TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_by                INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registered_ip              VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS registered_user_agent      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invitation_id              INTEGER REFERENCES account_invitations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ;
COMMENT ON COLUMN users.rejected_at IS
    'v1.86.0 — access declined (by an Admin, or automatically: not verified / no role in time). The account is inactive and kept for the record; it can be restored.';

-- registrations from before v1.86.0: where they came from, from the audit log
UPDATE users u
SET    registered_ip = a.ip_address
FROM   (SELECT DISTINCT ON (record_id) record_id, ip_address::text AS ip_address FROM audit_log
        WHERE action = 'USER_REGISTER' AND record_type = 'users' ORDER BY record_id, created_at) a
WHERE  a.record_id = u.id AND u.registered_ip IS NULL AND a.ip_address IS NOT NULL;

COMMIT;
