-- ============================================================
-- MIGRATION v1.89.0 — personal access rules: limits (and extras) for
-- one person, whatever roles they hold
--
-- Requested directly (13 Nov 2026):
--   "i would also like that the admin can limit one's individual actions
--    like approvals or any permission depite the role they hold since
--    even directors and secretaries can have different roles and
--    limitations with in the company"
-- Confirmed (13 Nov 2026):
--   • both directions — take away a permission a role gives, or give one
--     person a single extra permission without a whole role;
--   • approval limits by amount (a ceiling per currency);
--   • limits by account / area; time-limited rules (lifted automatically
--     on their end date); limits on signing (resolutions, certificates,
--     financial statements); whole pages hidden from one person.
--
-- What this adds:
--   user_access_rules — one row per rule. Kinds:
--     PERMISSION_REMOVE  the person loses one permission their roles give
--     PERMISSION_ADD     the person gains one permission without a role
--     ACTION_BLOCK       the person may not do one action (approve
--                        transfers, release requisitions, sign documents …)
--     APPROVAL_LIMIT     the person may approve only up to max_amount in
--                        currency_code, and/or only on account_ids
--     AREA_HIDE          a whole page / part of the system is hidden
--   A rule applies from starts_on to ends_on (inclusive, Kampala date);
--   ending it early keeps the row (ended_at, ended_by, end_reason).
--
-- Also (v1.89.0): written resolutions saved to Documents collect the
-- company secretary's signature and follow the signing — no table change.
--
-- Nothing already recorded changes. Safe to run more than once.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_access_rules (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind             VARCHAR(20) NOT NULL CHECK (kind IN
                        ('PERMISSION_REMOVE', 'PERMISSION_ADD', 'ACTION_BLOCK', 'APPROVAL_LIMIT', 'AREA_HIDE')),
    permission_code  VARCHAR(100),          -- PERMISSION_REMOVE / PERMISSION_ADD
    action_code      VARCHAR(60),           -- ACTION_BLOCK / APPROVAL_LIMIT (ALL_MONEY_APPROVALS = every approval with an amount)
    area_code        VARCHAR(60),           -- AREA_HIDE (the menu page's id, e.g. 'tax')
    currency_code    VARCHAR(3),            -- APPROVAL_LIMIT with an amount
    max_amount       NUMERIC(20, 2) CHECK (max_amount IS NULL OR max_amount >= 0),
    account_ids      INTEGER[],             -- APPROVAL_LIMIT: only these accounts (empty = any account)
    reason           TEXT NOT NULL,
    starts_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    ends_on          DATE,
    created_by       INTEGER REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMPTZ,
    ended_by         INTEGER REFERENCES users(id),
    end_reason       TEXT,
    CONSTRAINT user_access_rules_dates CHECK (ends_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT user_access_rules_shape CHECK (
        (kind IN ('PERMISSION_REMOVE', 'PERMISSION_ADD') AND permission_code IS NOT NULL)
     OR (kind = 'ACTION_BLOCK' AND action_code IS NOT NULL)
     OR (kind = 'APPROVAL_LIMIT' AND action_code IS NOT NULL
         AND ((currency_code IS NOT NULL AND max_amount IS NOT NULL) OR COALESCE(array_length(account_ids, 1), 0) > 0))
     OR (kind = 'AREA_HIDE' AND area_code IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_user_access_rules_user ON user_access_rules (user_id) WHERE ended_at IS NULL;
COMMENT ON TABLE user_access_rules IS
    'v1.89.0 — rules for one person on top of their roles: a permission taken away or added, an action blocked, an approval ceiling per currency or to certain accounts, or a part of the system hidden. Active from starts_on to ends_on (Kampala dates) unless ended early.';

COMMIT;
