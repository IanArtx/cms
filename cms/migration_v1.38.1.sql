-- ============================================================
-- MIGRATION v1.38.1 — DEPOSITS: ACTIVATION SWITCH + PARENT ACCOUNT
-- ============================================================
-- Fixes a gap in v1.38.0: Member Deposit Tracking shipped as an
-- always-on feature with the account chosen freely per entry. It
-- should instead behave like the Side Fund — an optional feature,
-- off by default, "parented" to one specific account chosen when
-- activating it. UNLIKE the Side Fund, that parent account is NOT a
-- separate envelope (no current_balance counter) — deposits stay
-- ordinary transactions into that one account, fully spendable from
-- it, exactly as before. Only WHICH account is now fixed by
-- deposit_config rather than chosen per transaction.
--
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE deposit_config ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deposit_config ADD COLUMN IF NOT EXISTS parent_account_id INTEGER REFERENCES accounts(id);
