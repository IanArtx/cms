-- ============================================================
-- MIGRATION v1.6.0
-- Adds:
--   1. notifications — in-app "bell" activity feed per user.
--   2. share_price_history — company-wide price-per-share over time.
--   3. accounts.reference_prefix — optional per-account short code
--      used as that account's own reference-code prefix.
--
-- Safe to run more than once — every statement checks first.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. notifications
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER      NOT NULL REFERENCES users(id),
    type         VARCHAR(50)  NOT NULL,
    title        VARCHAR(200) NOT NULL,
    body         TEXT,
    link         VARCHAR(300),
    related_module      VARCHAR(50),
    related_record_type VARCHAR(50),
    related_record_id   INTEGER,
    is_read      BOOLEAN      NOT NULL DEFAULT FALSE,
    read_at      TIMESTAMPTZ,
    email_sent   BOOLEAN      NOT NULL DEFAULT FALSE,
    email_error  TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user      ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, is_read);

-- ------------------------------------------------------------
-- 2. share_price_history
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_price_history (
    id               SERIAL PRIMARY KEY,
    price_per_share  NUMERIC(20,4) NOT NULL,
    currency_id      INTEGER       NOT NULL REFERENCES currencies(id),
    effective_from   DATE          NOT NULL,
    effective_to     DATE,
    set_by           INTEGER       NOT NULL REFERENCES users(id),
    notes            TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_share_price CHECK (price_per_share > 0)
);

-- ------------------------------------------------------------
-- 3. accounts.reference_prefix
-- ------------------------------------------------------------
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS reference_prefix VARCHAR(10);

DO $$
BEGIN
    ALTER TABLE accounts ADD CONSTRAINT accounts_reference_prefix_key UNIQUE (reference_prefix);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Go to Accounts and set an initial share price under the new
--      "Share Price" card (Treasurer/Admin) — the shareholder
--      dashboard will show "—" for share value until one is set.
--   2. Existing secondary accounts keep using the generic "SA-"
--      reference prefix until you optionally give them their own
--      short code via the account edit form.
--   3. The notifications bell starts empty — it only fills up from
--      actions taken after this migration runs (existing historical
--      records don't get backfilled with notifications).
-- ------------------------------------------------------------
