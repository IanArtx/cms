-- ============================================================
-- MIGRATION v1.22.0 — DIVIDENDS PAID INTO SHAREHOLDER SAVINGS
--
-- Changes what "approving a dividend" actually does. Previously a
-- single lump-sum debit left the declaring account and each
-- shareholder's proportional share was only ever a calculated
-- record (dividend_distributions) — the money itself was assumed to
-- be handed to shareholders outside the system. Now, approving a
-- dividend also credits every shareholder's own internal Savings
-- balance (savings_balances) with their share, making it real,
-- withdrawable money inside the system via the existing Savings
-- handout flow (Section 4.11).
--
-- Currency: the system has exactly one Savings account, so every
-- shareholder's balance is denominated in that account's currency.
-- If the dividend's declaring account uses a different currency, a
-- human enters the actual conversion rate at approval time — this
-- system's currency_exchange_rates table is documented as
-- "display-only, never used for real money movements" (Section 4.4),
-- so dividend conversion follows the same manual-entry precedent
-- already used for cross-currency Transfers (Section 4.3) rather
-- than silently reusing a stored monthly rate.
--
-- Adds:
--   - transactions.inflow_type: DIVIDEND_OUT (the debit leg, source
--     account), DIVIDEND_SAVINGS_IN (the credit leg, Savings account)
--   - dividends.transaction_id — the debit leg
--   - dividends.savings_transaction_id — the credit leg
--   - dividends.exchange_rate — the rate applied (1 if same currency)
--   - dividend_distributions.credited_amount — each shareholder's
--     actual credit to savings_balances, in the Savings account's
--     currency (separate from `amount`, which stays the declared
--     share in the dividend's own currency)
--   - dividend_distributions.exchange_rate — same rate, copied onto
--     each row for a self-contained audit trail per shareholder
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. Widen transactions.inflow_type
-- ----------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%CONTRIBUTION%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check
        CHECK (inflow_type IN (
            'CONTRIBUTION', 'GRANT', 'LOAN_RECEIVED', 'LOAN_REPAYMENT_IN',
            'INTEREST_IN', 'INVESTMENT_RETURN', 'TRANSFER_IN', 'OTHER_INCOME',
            'SAVINGS_DEPOSIT_IN', 'TRANSFER_OUT', 'LOAN_DISBURSED',
            'LOAN_REPAYMENT_OUT', 'INTEREST_OUT', 'EXPENSE',
            'SAVINGS_HANDOUT_OUT', 'GRANT_REFUND',
            'SIDE_FUND_CONTRIBUTION_IN', 'SIDE_FUND_DIRECT_IN',
            'SAVINGS_POOL_OTHER_IN',
            'SERVICE_FEE_OUT', 'SERVICE_REIMBURSEMENT_OUT',
            'DIVIDEND_OUT', 'DIVIDEND_SAVINGS_IN'
        ));
END $$;

-- ----------------------------------------------------------
-- 2. dividends — record both legs of the approval and the rate used
-- ----------------------------------------------------------
ALTER TABLE dividends ADD COLUMN IF NOT EXISTS transaction_id INTEGER REFERENCES transactions(id);
ALTER TABLE dividends ADD COLUMN IF NOT EXISTS savings_transaction_id INTEGER REFERENCES transactions(id);
ALTER TABLE dividends ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20,8);

-- ----------------------------------------------------------
-- 3. dividend_distributions — what each shareholder was actually
--    credited, once converted into the Savings account's currency
-- ----------------------------------------------------------
ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS credited_amount NUMERIC(20,4);
ALTER TABLE dividend_distributions ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20,8);

COMMIT;

-- ============================================================
-- After running this migration:
--   1. Restart the backend so the widened inflow_type list and the
--      new approveDividend logic are picked up.
--   2. If the Savings account (Accounts -> Savings) has not been set
--      up yet, set it up first — dividend approval now requires it
--      to exist, the same way the rest of the Savings module does.
--   3. Nothing else to configure — existing PENDING dividends declare
--      and edit exactly as before; the new behaviour only applies
--      from the next approval onward. Already-PAID dividends are
--      untouched (their old single-transaction, no-savings-credit
--      history is left exactly as it was).
-- ============================================================
