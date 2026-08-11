-- ============================================================
-- MIGRATION v1.21.0 — ADMINISTRATIVE OFFICER ROLE + SERVICE FEES
--
-- Adds a way to give hired, contracted staff (ground work,
-- meeting minutes, correspondence with authorities) a real login
-- with a deliberately restricted view — full access to Events and
-- Documents, but NO access to company finances except individual
-- documents an Admin explicitly grants. Introduces:
--   - a new "Administrative Officer" system role
--   - staff_document_grants — per-document, per-user access grants
--     (the same pattern the External Audit Portal uses for
--     auditor document access, minus the "engagement" wrapper,
--     since this isn't a time-boxed relationship)
--   - service_fee_agreements — a recurring monthly service-fee
--     arrangement with a contracted person (deliberately NOT called
--     "payroll" — this is a contracted-service relationship, not an
--     employment/payroll classification, which is a legal question
--     outside this software's scope)
--   - service_fee_payments — history of actual fee payments, each
--     tied to a real posted ledger transaction
--   - service_reimbursement_requests — ad hoc expense reimbursement
--     requests from a contracted person, reviewed by the Treasurer
--
-- Also widens transactions.inflow_type with two new values
-- (SERVICE_FEE_OUT, SERVICE_REIMBURSEMENT_OUT) so these ledger
-- entries are traceable back to this module the same way every
-- other module's money movements are.
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. New role — Administrative Officer
-- ----------------------------------------------------------
INSERT INTO roles (name, description, is_system_role)
SELECT 'Administrative Officer',
       'Hired/contracted staff — meetings, minutes, and correspondence; no finance access except individually granted documents',
       TRUE
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Administrative Officer');

-- ----------------------------------------------------------
-- 2. New category for service fee / reimbursement transactions
-- ----------------------------------------------------------
INSERT INTO categories (parent_id, module, name, abbreviation, description)
SELECT NULL, 'FINANCE', 'Service Fees', 'SVC', 'Contracted staff service fees and expense reimbursements'
WHERE NOT EXISTS (
    SELECT 1 FROM categories WHERE module = 'FINANCE' AND abbreviation = 'SVC'
);

INSERT INTO category_paths (category_id, full_path, full_abbreviation, depth)
SELECT c.id, c.name, c.abbreviation, 0
FROM   categories c
WHERE  c.module = 'FINANCE' AND c.abbreviation = 'SVC'
AND    NOT EXISTS (SELECT 1 FROM category_paths cp WHERE cp.category_id = c.id);

-- ----------------------------------------------------------
-- 3. Widen transactions.inflow_type
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
            'SERVICE_FEE_OUT', 'SERVICE_REIMBURSEMENT_OUT'
        ));
END $$;

-- ----------------------------------------------------------
-- 4. staff_document_grants
-- Direct, ongoing per-user document access grant — no time-boxed
-- "engagement" wrapper, unlike the Audit Portal, since this is a
-- standing staff relationship rather than a fixed-period audit.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_document_grants (
    id          SERIAL PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    granted_by  INTEGER NOT NULL REFERENCES users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ,
    revoked_by  INTEGER REFERENCES users(id),
    UNIQUE (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_document_grants_user ON staff_document_grants (user_id);
CREATE INDEX IF NOT EXISTS idx_staff_document_grants_doc  ON staff_document_grants (document_id);

-- ----------------------------------------------------------
-- 5. service_fee_agreements
-- One row per contracted person's standing monthly fee arrangement.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_fee_agreements (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    monthly_amount NUMERIC(20,4) NOT NULL,
    currency_id    INTEGER NOT NULL REFERENCES currencies(id),
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    category_id    INTEGER NOT NULL REFERENCES categories(id),
    start_date     DATE NOT NULL,
    end_date       DATE,
    status         VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'ENDED')),
    notes          TEXT,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_monthly_amount CHECK (monthly_amount > 0),
    CONSTRAINT service_fee_end_after_start CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_service_fee_agreements_user ON service_fee_agreements (user_id);

-- ----------------------------------------------------------
-- 6. service_fee_payments
-- Each actual monthly payment, tied to a real posted transaction.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_fee_payments (
    id             SERIAL PRIMARY KEY,
    agreement_id   INTEGER NOT NULL REFERENCES service_fee_agreements(id),
    amount         NUMERIC(20,4) NOT NULL,
    payment_date   DATE NOT NULL,
    transaction_id INTEGER REFERENCES transactions(id),
    notes          TEXT,
    paid_by        INTEGER NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_service_fee_payment CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_service_fee_payments_agreement ON service_fee_payments (agreement_id);

-- ----------------------------------------------------------
-- 7. service_reimbursement_requests
-- Ad hoc expense reimbursement requests from a contracted person —
-- structurally similar to a Requisitions EXPENSE request, kept as
-- its own table since Requisitions' other request type
-- (CONTRIBUTION_ACKNOWLEDGEMENT) is fundamentally a shareholder
-- concept that doesn't apply to contracted, non-shareholder staff.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_reimbursement_requests (
    id                SERIAL PRIMARY KEY,
    reference_id      INTEGER NOT NULL REFERENCES references_registry(id),
    user_id           INTEGER NOT NULL REFERENCES users(id),
    amount            NUMERIC(20,4) NOT NULL,
    currency_id       INTEGER NOT NULL REFERENCES currencies(id),
    category_id       INTEGER NOT NULL REFERENCES categories(id),
    description       TEXT NOT NULL,
    expense_date      DATE NOT NULL,
    receipt_file_path TEXT,
    receipt_file_name TEXT,
    status            VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    account_id        INTEGER REFERENCES accounts(id),
    transaction_id     INTEGER REFERENCES transactions(id),
    reviewed_by       INTEGER REFERENCES users(id),
    reviewed_at       TIMESTAMPTZ,
    review_notes      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_reimbursement_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_service_reimbursement_requests_user ON service_reimbursement_requests (user_id);

COMMIT;

-- After running this migration:
--   1. Restart/redeploy the backend so the new routes
--      (/api/staff-access/*, /api/service-fees/*) and the
--      Administrative Officer role are picked up.
--   2. An Admin registers/assigns the "Administrative Officer" role
--      to the hired person's account (Users -> Assign Role), the
--      same way any other role is assigned.
--   3. An Admin grants that role the EVENT_VIEW, EVENT_CREATE,
--      DOCUMENT_VIEW, DOCUMENT_UPLOAD, and DOCUMENT_GENERATE
--      permissions via Settings -> Roles & Permissions — like every
--      role in this system, "Administrative Officer" starts with
--      zero permissions granted, this is not optional to skip.
--   4. An Admin creates a Service Fee agreement for the person
--      (new Service Fees page) — monthly amount, currency, paying
--      account, start date.
--   5. Financial documents remain invisible to this role by default;
--      an Admin shares individual ones from the Documents page's new
--      "Grant to staff" action when a specific exception is needed.
