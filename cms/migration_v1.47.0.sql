-- ============================================================
-- MIGRATION v1.47.0 — Full monitoring visibility for Treasurers/Admins
-- across Acknowledgements, Fines, Requisitions and Service Fees; a
-- Service Fee agreement detail page with payment + amendment history.
--
-- Requested directly: "i would like that the treasurers / admins can
-- see all pending transactions under acknowledgments, fines,
-- requisitions and service fee payments for all members even through
-- they don't have permission to approve beyond their scope but only
-- to monitor if one has approved or not. In addition under service
-- fees, let there be a detail page under each agreement... Any
-- adjustments to the service money shows that the effective change
-- date and the change history."
--
-- Of the four modules named, only Requisitions actually had a bug —
-- its frontend gated the "All Requisitions" tab on BOTH
-- FINANCE_TRANSACTION_CREATE and FINANCE_VIEW_ALL, when the backend's
-- own GET / route only ever required FINANCE_VIEW_ALL. That was a
-- code-only fix (RequisitionsPage.jsx — new canViewAll flag), no
-- schema change. Payment Acknowledgements/Confirmations and Fines
-- were already gated on a single view permission with no such bug.
--
-- Service Fees was the real gap: the only one of the five "pending
-- transaction" modules still gated by hardcoded requireRoles([...])
-- instead of the permission system every other module uses. This
-- migration adds the two permissions that close it, plus the new
-- amendment-history table backing the "effective change date and
-- change history" ask.
-- ============================================================

BEGIN;

-- 1) New SERVICE_FEE_VIEW / SERVICE_FEE_MANAGE permissions — like
--    every permission in this system, NOT auto-granted to any role
--    (including Admin); an Admin must grant them explicitly via
--    Settings -> Roles -> Permissions after this migration runs.
--    Until granted, nobody can reach the Service Fees module at all —
--    grant SERVICE_FEE_VIEW (and SERVICE_FEE_MANAGE, if they should
--    also record payments/amend/terminate) to whichever roles held
--    the old hardcoded access (Admin, Treasurer, Assistant Treasurer)
--    to preserve today's behaviour.
INSERT INTO permissions (code, module, description) VALUES
    ('SERVICE_FEE_VIEW',   'FINANCE', 'View all service fee agreements, payment history, and reimbursement requests'),
    ('SERVICE_FEE_MANAGE', 'FINANCE', 'Create/edit/terminate service fee agreements, record payments, and review reimbursements')
ON CONFLICT (code) DO NOTHING;

-- 2) Amendment history for service_fee_agreements.monthly_amount —
--    mirrors loan_received_rate_amendments: the previous amount is
--    never overwritten, one append-only row per change, so the new
--    agreement detail page can show an exact effective-dated history
--    of every adjustment instead of just the current figure.
CREATE TABLE IF NOT EXISTS service_fee_agreement_amendments (
    id               SERIAL PRIMARY KEY,
    agreement_id     INTEGER       NOT NULL REFERENCES service_fee_agreements(id),
    previous_amount  NUMERIC(20,4) NOT NULL,
    new_amount       NUMERIC(20,4) NOT NULL,
    reason           TEXT          NOT NULL,
    effective_from   DATE          NOT NULL,
    amended_by       INTEGER       NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_service_fee_amendment_amounts
        CHECK (previous_amount > 0 AND new_amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_service_fee_amendments_agreement
    ON service_fee_agreement_amendments (agreement_id);

COMMIT;
