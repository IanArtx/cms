-- ============================================================
-- MIGRATION v1.32.0 — Side Fund membership checklist & exit payouts
-- (Section 4.10)
--
-- Before this migration, EVERY active shareholder automatically owed
-- a monthly side fund due — there was no way to opt a member out.
-- This introduces an explicit in/out checklist (side_fund_members):
-- dues are now only generated for a member while is_in = TRUE, and
-- only from their own start_period onward. start_period can be set in
-- the past — adding a member with start_period = '2025-01' backfills
-- a PENDING due for every month from then to the current one, so
-- their overdue balance reflects the true historical obligation.
--
-- Removing a member (is_in -> FALSE) settles their standing and, if
-- positive, transfers the payout straight into their own Savings
-- balance, going through the same Payment Acknowledgement two-party
-- sign-off used by every other money-paid-OUT-to-an-individual flow
-- in this system (dividends, service fee payments, reimbursements,
-- savings handouts). See schema.sql's GROUP 27 for the full payout
-- formula.
--
-- Widens two existing CHECK constraints (safe to run more than once —
-- DROP CONSTRAINT IF EXISTS, then re-ADD) and creates two new tables
-- (NOT safe to run twice — CREATE TABLE will error harmlessly if
-- already applied, same as every other new-table migration here).
--
-- IMPORTANT — backfill step: every member who already has side fund
-- due history (side_fund_dues rows, from before this migration) is
-- automatically added to the new checklist as is_in = TRUE, with
-- start_period set to the earliest period they already have a due
-- for. Without this, generateDuesForPeriod would silently stop
-- creating new monthly dues for every existing member the moment this
-- deploys, since it now sources membership from side_fund_members
-- instead of shareholding_registry. No new side_fund_dues rows are
-- created by this backfill — it only seeds the checklist so future
-- monthly generation keeps working exactly as before for anyone
-- already participating.
-- ============================================================

BEGIN;

-- ---- Widen transactions.inflow_type for the payout-to-savings DEBIT leg ----
ALTER TABLE transactions
    DROP CONSTRAINT IF EXISTS transactions_inflow_type_check;

ALTER TABLE transactions
    ADD CONSTRAINT transactions_inflow_type_check
    CHECK (inflow_type IN (
        'CONTRIBUTION', 'GRANT', 'LOAN_RECEIVED', 'LOAN_REPAYMENT_IN',
        'INTEREST_IN', 'INVESTMENT_RETURN', 'TRANSFER_IN', 'OTHER_INCOME',
        'SAVINGS_DEPOSIT_IN', 'TRANSFER_OUT', 'LOAN_DISBURSED',
        'LOAN_REPAYMENT_OUT', 'INTEREST_OUT', 'EXPENSE', 'SAVINGS_HANDOUT_OUT',
        'GRANT_REFUND', 'SIDE_FUND_CONTRIBUTION_IN', 'SIDE_FUND_DIRECT_IN',
        'SAVINGS_POOL_OTHER_IN', 'SERVICE_FEE_OUT', 'SERVICE_REIMBURSEMENT_OUT',
        'DIVIDEND_OUT', 'DIVIDEND_SAVINGS_IN',
        'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
        'SIDE_FUND_PAYOUT_OUT'
    ));

-- ---- Widen payment_acknowledgements.source_type for exit payouts ----
ALTER TABLE payment_acknowledgements
    DROP CONSTRAINT IF EXISTS payment_acknowledgements_source_type_check;

ALTER TABLE payment_acknowledgements
    ADD CONSTRAINT payment_acknowledgements_source_type_check
    CHECK (source_type IN ('DIVIDEND', 'SERVICE_FEE_PAYMENT', 'REIMBURSEMENT', 'SAVINGS_HANDOUT', 'SIDE_FUND_PAYOUT'));

-- ---- The checklist itself ----
CREATE TABLE side_fund_members (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id),
    is_in        BOOLEAN NOT NULL DEFAULT FALSE,
    start_period CHAR(7),
    added_by     INTEGER REFERENCES users(id),
    added_at     TIMESTAMPTZ,
    removed_by   INTEGER REFERENCES users(id),
    removed_at   TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT side_fund_member_start_period_format
        CHECK (start_period IS NULL OR start_period ~ '^\d{4}-\d{2}$'),
    CONSTRAINT side_fund_member_in_needs_start_period
        CHECK (is_in = FALSE OR start_period IS NOT NULL)
);

-- ---- Join/leave audit trail ----
CREATE TABLE side_fund_membership_events (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER     NOT NULL REFERENCES users(id),
    event_type     VARCHAR(10) NOT NULL CHECK (event_type IN ('JOINED', 'REMOVED')),
    start_period   CHAR(7),
    dues_paid      NUMERIC(20,4),
    credit_applied NUMERIC(20,4),
    member_count   INTEGER,
    total_expenses NUMERIC(20,4),
    expense_share  NUMERIC(20,4),
    payout_amount  NUMERIC(20,4),
    payment_ack_id INTEGER REFERENCES payment_acknowledgements(id),
    performed_by   INTEGER NOT NULL REFERENCES users(id),
    performed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes          TEXT
);
CREATE INDEX idx_side_fund_membership_events_user ON side_fund_membership_events (user_id, performed_at DESC);

-- ---- Backfill: preserve continuity for everyone already participating ----
INSERT INTO side_fund_members (user_id, is_in, start_period, added_at)
SELECT user_id, TRUE, MIN(period), NOW()
FROM   side_fund_dues
GROUP  BY user_id
ON CONFLICT (user_id) DO NOTHING;

COMMIT;
