-- ============================================================
-- MIGRATION v1.73.0 — Money entries held for approval
--
-- Requested directly:
--   "lets also make the approval rule apply for transactions as well
--    for any one that is not the treasurer or admin"
-- Confirmed decisions:
--   1. Held until approved — nothing is posted, no balance changes and
--      no reference number is used until it is approved.
--   2. Approved by the Treasurer or an Admin (never the person who
--      recorded it).
--   3. Every money entry — not only the Transactions page but every
--      action that moves money straight away (MMF top-ups, investment
--      funding / returns / coupons, loan repayments, grant tranches,
--      side fund, deposits, fines, tax payments …).
--
-- One new table. Nothing existing is changed; no money moves.
-- Safe to run more than once.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS held_money_entries (
    id                     SERIAL PRIMARY KEY,
    route_key              VARCHAR(60)   NOT NULL,   -- which action, e.g. 'transactions.expense'
    label                  VARCHAR(120)  NOT NULL,   -- plain-English name shown on the list
    method                 VARCHAR(10)   NOT NULL,
    path                   TEXT          NOT NULL,   -- the address it was sent to (for the record)
    params                 JSONB         NOT NULL DEFAULT '{}',
    body                   JSONB         NOT NULL DEFAULT '{}',  -- the checked form values
    query_params           JSONB         NOT NULL DEFAULT '{}',
    subject                TEXT,                      -- e.g. 'Investment: GoU 2yr bond'
    account_name           TEXT,
    amount                 NUMERIC(20,4),
    currency_code          VARCHAR(10),
    note                   TEXT,
    status                 VARCHAR(12)   NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'EXECUTING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
    created_by             INTEGER       NOT NULL REFERENCES users(id),
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    decided_by             INTEGER       REFERENCES users(id),
    decided_at             TIMESTAMPTZ,
    decision_note          TEXT,
    last_error             TEXT,          -- why the last approval attempt could not post it
    last_error_at          TIMESTAMPTZ,
    result_message         TEXT,
    posted_transaction_ids INTEGER[]
);

CREATE INDEX IF NOT EXISTS idx_held_money_entries_status  ON held_money_entries(status);
CREATE INDEX IF NOT EXISTS idx_held_money_entries_creator ON held_money_entries(created_by);

COMMENT ON TABLE held_money_entries IS
    'v1.73.0 — money entries recorded by someone who is not the Treasurer or an Admin, held until the Treasurer or an Admin approves them. On approval the original action is run on behalf of the recorder and the ledger rows store approved_by = the approver.';

COMMIT;
