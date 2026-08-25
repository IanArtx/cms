-- ============================================================
-- MIGRATION v1.41.0 — Side Fund & Savings reversal rollback, plus
-- the append-only tracking Side Fund needed to make it possible.
--
-- Continues the fix started in v1.40.1 (Deposits): reversing a
-- transaction (transactionsController.reverseTransaction) was a
-- generic, ledger-only operation that only ever special-cased ONE
-- side table (shareholder_contributions). Side Fund and Savings
-- contributions/handouts had the identical gap — reversing their
-- transaction correctly adjusted the ledger and account balance, but
-- left side_fund_dues/side_fund_member_credit and
-- savings_balances/member_savings/savings_handouts completely
-- untouched.
--
-- SIDE FUND is the harder of the two: a single payment can cascade
-- across several dues (oldest-unpaid-first) and any leftover gets
-- banked as running credit, and side_fund_dues.transaction_id is
-- last-write-wins (a due paid off across separate payments only
-- remembers the most recent one) — so there was no reliable way to
-- answer "what did transaction X actually do?" This migration adds
-- side_fund_payment_applications, a proper append-only application
-- log, written by sideFundService.applySideFundPayment itself (see
-- the matching code change) — one row per due touched, plus one row
-- if a payment banked credit — so a reversal has an exact, immutable
-- record to undo, regardless of how many dues/members one
-- transaction spanned (this also correctly handles bulkPayDues, one
-- transaction paying many different members' dues at once).
--
-- SAVINGS needed only new columns, not a new table: member_savings
-- and savings_handouts already carry a `transaction_id` and a real
-- lifecycle `status` column, so — mirroring the existing
-- shareholder_contributions convention (status flips to 'REVERSED'
-- rather than a separate boolean) — both just get 'REVERSED' added to
-- their status CHECK, plus reversed_at/reversed_by for who/when.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- SIDE FUND — new append-only application log
-- ------------------------------------------------------------
CREATE TABLE side_fund_payment_applications (
    id               SERIAL PRIMARY KEY,
    transaction_id   INTEGER       NOT NULL REFERENCES transactions(id),
    user_id          INTEGER       NOT NULL REFERENCES users(id),
    due_id           INTEGER REFERENCES side_fund_dues(id),
    application_type VARCHAR(20)   NOT NULL
                     CHECK (application_type IN ('DUE_PAYMENT', 'CREDIT_BANKED')),
    amount           NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    is_reversed      BOOLEAN       NOT NULL DEFAULT FALSE,
    reversed_at      TIMESTAMPTZ,
    reversed_by      INTEGER REFERENCES users(id),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT due_payment_needs_due_id CHECK (application_type != 'DUE_PAYMENT' OR due_id IS NOT NULL)
);
CREATE INDEX idx_side_fund_applications_tx ON side_fund_payment_applications (transaction_id);

COMMENT ON TABLE side_fund_payment_applications IS
    'Append-only record of exactly what one transaction applied to the side '
    'fund (which due(s), how much, and any amount banked as overpayment '
    'credit) — needed because side_fund_dues.transaction_id is last-write-'
    'wins and side_fund_member_credit has no history. Populated going '
    'forward only — transactions from before this migration have no rows '
    'here, so reversing one of those older transactions cannot roll back '
    'its side fund effect (the ledger/account-balance reversal still '
    'happens; only the dues/credit rollback is skipped, with a note in the '
    'response and audit log).';

-- ------------------------------------------------------------
-- SAVINGS — reversal columns on the two tables that can be reversed
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'member_savings'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%PENDING_APPROVAL%ACTIVE%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE member_savings DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE member_savings ADD CONSTRAINT member_savings_status_check
        CHECK (status IN ('PENDING_APPROVAL','ACTIVE','WITHDRAWN','REJECTED','CANCELLED','REVERSED'));
END $$;

ALTER TABLE member_savings
    ADD COLUMN reversed_at TIMESTAMPTZ,
    ADD COLUMN reversed_by INTEGER REFERENCES users(id);

DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'savings_handouts'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%PENDING_CONFIRMATION%CONFIRMED%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE savings_handouts DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE savings_handouts ADD CONSTRAINT savings_handouts_status_check
        CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED','REVERSED'));
END $$;

ALTER TABLE savings_handouts
    ADD COLUMN reversed_at TIMESTAMPTZ,
    ADD COLUMN reversed_by INTEGER REFERENCES users(id);

COMMIT;
