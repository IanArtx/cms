-- ============================================================
-- MIGRATION v1.37.0 -- FINES & PENALTIES (Section 4.x, CMS_BIBLE.md)
--
-- Treasury (Treasurer/Assistant Treasurer/Admin) can assign a fine to
-- a shareholder. It's special income to the company -- posted with
-- its own traceable inflow_type -- and can be paid into ANY account,
-- as long as that account's currency matches the currency the fine
-- was posted in (the fine is denominated once, at creation, and never
-- re-denominated).
--
-- Three reasons, the third ("Contribution failure") auto-calculating
-- the fine amount from three sub-fields entered at creation:
--   amount = defaulted_amount x (fine_percentage / 100)
-- e.g. failing to pay EUR 150 by 15.08.2026, at an 8% fine rate,
-- posts a EUR 12 fine. Meeting violation / General fines have their
-- amount entered directly instead.
--
-- A fine is cleared two ways, both landing in the same place (an
-- OUTSTANDING -> PAID status flip plus a real income transaction):
--   1. The Treasurer enters the payment directly (only a date and a
--      description needed -- see finesService.clearFine).
--   2. The member pays first, then submits a Requisition (new type
--      FINE_PAYMENT, requisitions.fine_id points at which fine) --
--      same "member paid externally, Treasurer reviews and it posts
--      for real on approval" pattern already used for
--      CONTRIBUTION_ACKNOWLEDGEMENT/SIDE_FUND_CONTRIBUTION.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fines (
    id                   SERIAL PRIMARY KEY,
    reference_id         INTEGER       NOT NULL REFERENCES references_registry(id),
    user_id              INTEGER       NOT NULL REFERENCES users(id),
    reason               VARCHAR(30)   NOT NULL
                         CHECK (reason IN ('CONTRIBUTION_FAILURE', 'MEETING_VIOLATION', 'GENERAL')),
    description          TEXT,
    currency_id          INTEGER       NOT NULL REFERENCES currencies(id),
    amount               NUMERIC(20,4) NOT NULL,
    -- Contribution-failure auto-calc inputs -- NULL for the other two
    -- reasons, required (enforced below) for this one.
    default_deadline     DATE,
    defaulted_amount     NUMERIC(20,4),
    fine_percentage      NUMERIC(8,4),
    status               VARCHAR(20)   NOT NULL DEFAULT 'OUTSTANDING'
                         CHECK (status IN ('OUTSTANDING', 'PAID')),
    -- Populated only once cleared/paid
    account_id           INTEGER REFERENCES accounts(id),
    transaction_id       INTEGER REFERENCES transactions(id),
    paid_date            DATE,
    payment_description  TEXT,
    cleared_by           INTEGER REFERENCES users(id),
    cleared_at           TIMESTAMPTZ,
    assigned_by          INTEGER       NOT NULL REFERENCES users(id),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_fine_amount CHECK (amount > 0),
    CONSTRAINT contribution_failure_fields CHECK (
        reason != 'CONTRIBUTION_FAILURE' OR
        (default_deadline IS NOT NULL AND defaulted_amount IS NOT NULL AND fine_percentage IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_fines_user   ON fines (user_id);
CREATE INDEX IF NOT EXISTS idx_fines_status ON fines (status);

-- requisitions needs to know WHICH fine a FINE_PAYMENT requisition is
-- paying off (unlike CONTRIBUTION_ACKNOWLEDGEMENT/SIDE_FUND_CONTRIBUTION,
-- a member can have more than one outstanding fine, possibly in
-- different currencies, so there's no safe "oldest first" cascade to
-- fall back on the way side fund dues has).
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS fine_id INTEGER REFERENCES fines(id);

-- Widen requisitions.requisition_type -- same widening pattern as
-- every other module here (SAVINGS_DEPOSIT, SIDE_FUND_CONTRIBUTION).
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'requisitions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%requisition_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE requisitions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE requisitions ADD CONSTRAINT requisitions_requisition_type_check
        CHECK (requisition_type IN (
            'EXPENSE', 'CONTRIBUTION_ACKNOWLEDGEMENT', 'SAVINGS_DEPOSIT',
            'SIDE_FUND_CONTRIBUTION', 'FINE_PAYMENT'
        ));
END $$;

-- Widen transactions.inflow_type so a fine payment posts as its own
-- traceable type -- "special income to the company", per the brief --
-- instead of being lumped into generic OTHER_INCOME.
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check
        CHECK (inflow_type IN (
            'CONTRIBUTION', 'GRANT', 'LOAN_RECEIVED', 'LOAN_REPAYMENT_IN',
            'INTEREST_IN', 'INVESTMENT_RETURN', 'TRANSFER_IN', 'OTHER_INCOME',
            'SAVINGS_DEPOSIT_IN', 'TRANSFER_OUT', 'LOAN_DISBURSED',
            'LOAN_REPAYMENT_OUT', 'INTEREST_OUT', 'EXPENSE', 'SAVINGS_HANDOUT_OUT',
            'GRANT_REFUND', 'SIDE_FUND_CONTRIBUTION_IN', 'SIDE_FUND_DIRECT_IN',
            'SAVINGS_POOL_OTHER_IN', 'SERVICE_FEE_OUT', 'SERVICE_REIMBURSEMENT_OUT',
            'DIVIDEND_OUT', 'DIVIDEND_SAVINGS_IN',
            'MMF_TOPUP_OUT', 'MMF_WITHDRAWAL_IN',
            'SIDE_FUND_PAYOUT_OUT',
            'FINE_PAYMENT_IN'
        ));
END $$;

INSERT INTO permissions (code, module, description) VALUES
    ('FINE_VIEW',   'FINANCE', 'View every member''s fines (Treasury oversight, not just your own)'),
    ('FINE_MANAGE', 'FINANCE', 'Assign fines to shareholders and clear/record fine payments')
ON CONFLICT (code) DO NOTHING;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend.
--   2. Grant FINE_VIEW/FINE_MANAGE to the Treasurer/Assistant
--      Treasurer/Admin roles via Settings > Roles & Permissions --
--      like every permission in this system, they start ungranted
--      for everyone, Admin included.
--   3. Every shareholder can immediately see their own fines (if any)
--      at /fines -- no permission needed for the self-scoped view.
-- ------------------------------------------------------------
