-- ============================================================
-- MIGRATION v1.30.0 — Payment Acknowledgements (Section 4.35)
--
-- Adds a two-way, two-step acknowledgement record for money paid OUT
-- to an individual: dividends, service fee payments, and expense
-- reimbursements. The system auto-creates one row (PENDING_ACK) the
-- moment a payment is actually disbursed — never created by hand.
-- The recipient reviews the amount/purpose and either acknowledges it
-- or disputes it (with a reason); once acknowledged, whoever holds
-- the new PAYMENT_ACK_MANAGE permission (Treasurer/Director) gives a
-- final sign-off, at which point a two-party printable document
-- (payer + recipient) becomes available. New permissions
-- PAYMENT_ACK_VIEW/PAYMENT_ACK_MANAGE (ungranted by default, per this
-- system's standard role_permissions convention — an Admin must grant
-- them via Settings > Roles & Permissions).
--
-- Mirrors schema.sql's GROUP 26 exactly. Safe to run once; CREATE
-- TABLE/INDEX will error harmlessly if already applied (same as every
-- other migration in this repo — this is the first-time application
-- of this table, not a repeatable idempotent patch).
-- ============================================================

BEGIN;

CREATE TABLE payment_acknowledgements (
    id                   SERIAL PRIMARY KEY,
    reference_id         INTEGER       NOT NULL REFERENCES references_registry(id),
    source_type          VARCHAR(30)   NOT NULL
                         CHECK (source_type IN ('DIVIDEND', 'SERVICE_FEE_PAYMENT', 'REIMBURSEMENT')),
    source_id            INTEGER       NOT NULL,
    transaction_id       INTEGER       REFERENCES transactions(id),
    payer_id             INTEGER       NOT NULL REFERENCES users(id),
    recipient_id         INTEGER       NOT NULL REFERENCES users(id),
    amount               NUMERIC(20,4) NOT NULL,
    currency_id          INTEGER       NOT NULL REFERENCES currencies(id),
    purpose              TEXT          NOT NULL,
    status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING_ACK'
                         CHECK (status IN ('PENDING_ACK', 'ACKNOWLEDGED', 'DISPUTED', 'FINAL_APPROVED')),
    acknowledged_at      TIMESTAMPTZ,
    acknowledgement_note TEXT,
    dispute_reason       TEXT,
    disputed_at          TIMESTAMPTZ,
    final_approved_by    INTEGER       REFERENCES users(id),
    final_approved_at    TIMESTAMPTZ,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_ack_amount CHECK (amount > 0)
);

CREATE INDEX idx_payment_ack_recipient ON payment_acknowledgements (recipient_id);
CREATE INDEX idx_payment_ack_status    ON payment_acknowledgements (status);
CREATE INDEX idx_payment_ack_source    ON payment_acknowledgements (source_type, source_id);

INSERT INTO permissions (code, module, description) VALUES
    ('PAYMENT_ACK_VIEW',   'FINANCE', 'View all payment acknowledgements (Treasury oversight, not just your own)'),
    ('PAYMENT_ACK_MANAGE', 'FINANCE', 'Give final sign-off on a payment acknowledgement once the recipient has confirmed it')
ON CONFLICT (code) DO NOTHING;

COMMIT;
