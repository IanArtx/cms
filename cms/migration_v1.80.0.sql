-- ============================================================
-- MIGRATION v1.80.0 — Requisitions (documents first, investments,
-- reversal), money spent on investments split into buying vs running,
-- and corrections to the statutory meeting documents.
--
-- Requested directly:
--   "i would like that requsitions have a functional reversal
--    functionality and before a requisition is approved fully to make a
--    transactional post a few perquisites like: linking / connecting to
--    a document and or an investment. This also brings me to linking
--    transactions of investments to them that can be accessed under the
--    individual investments or the main transactions page. In addition
--    i would like that money used to buy or sustain or operate an
--    investment is well categorised"
--   "signatories can be picked in the forms and that minutes and
--    resolutions can be generated of passed meetings and dates picked
--    accordingly and no date is reflected below the signature … the
--    signatures of the signatories be registered as captured in the
--    system … when documents are sent to documents page, one spot
--    remains unsigned"
-- Confirmed:
--   - Investment money: buying / expanding = asset (adds to the
--     investment's cost); running and maintenance = expenses of that
--     investment. New entries only — existing ones are listed on the
--     investment page to be classified one by one.
--   - Requisitions: at least one supporting document always; when it is
--     for an investment, the investment and the purpose too.
--   - A reversed requisition is marked REVERSED (a new one is raised to
--     pay again).
--   - Past meetings: the secretary records them; attendees can confirm
--     afterwards with their captured signature.
--
-- WHAT THIS ADDS (no money moves; existing figures do not change):
--   1. transactions.investment_cost_type  CAPITAL | OPERATING | MAINTENANCE
--      (NULL = recorded before v1.80 = treated as capital, as before).
--      Investment funding rows are set to CAPITAL.
--   2. Two ledger accounts: 5150 Investment Operating Costs and
--      5160 Investment Maintenance Costs.
--   3. requisitions: investment_id, investment_purpose, status REVERSED
--      and the reversal record (when, who, why, which entry).
--   4. requisition_document_links — documents connected to a requisition
--      before it is paid (copied to the transaction when it is paid).
--   5. Signature slots: one person may now hold two positions on the same
--      document (e.g. Director and Secretary) — each position gets its own
--      slot and one signature fills both. Documents that lost a slot this
--      way are repaired.
--   6. meeting_attendance / resolution_signatories keep a copy of the
--      signature captured when the person confirmed / signed.
--   7. company_meetings.recorded_after_event — a meeting entered after it
--      took place.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Buying vs running an investment
-- ------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS investment_cost_type VARCHAR(12);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_investment_cost_type_check') THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_investment_cost_type_check
            CHECK (investment_cost_type IS NULL OR investment_cost_type IN ('CAPITAL', 'OPERATING', 'MAINTENANCE'));
    END IF;
END $$;

-- Money put INTO an investment through "Fund" was always capital.
UPDATE transactions t
SET    investment_cost_type = 'CAPITAL'
FROM   investment_funding f
WHERE  f.transaction_id = t.id AND t.investment_cost_type IS NULL;

-- ------------------------------------------------------------
-- 2. Ledger accounts for running an investment
-- ------------------------------------------------------------
INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order)
VALUES
    ('5150', 'Investment Operating Costs', 'EXPENSE', 'DEBIT', 'EXPENSES', 'OPERATING',
     'Running costs of the company''s investments (feed, wages, fuel, utilities, transport …) — v1.80.0', 712),
    ('5160', 'Investment Maintenance Costs', 'EXPENSE', 'DEBIT', 'EXPENSES', 'OPERATING',
     'Repairs and upkeep that keep an investment running without adding to it — v1.80.0', 714)
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------
-- 3. Requisitions: investment, purpose and reversal
-- ------------------------------------------------------------
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS investment_id          INTEGER REFERENCES investments(id);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS investment_purpose     VARCHAR(12);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS reversed_at            TIMESTAMPTZ;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS reversed_by            INTEGER REFERENCES users(id);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS reversal_reason        TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);
DO $$
DECLARE r RECORD;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requisitions_investment_purpose_check') THEN
        ALTER TABLE requisitions ADD CONSTRAINT requisitions_investment_purpose_check
            CHECK (investment_purpose IS NULL OR investment_purpose IN ('CAPITAL', 'OPERATING', 'MAINTENANCE'));
    END IF;
    -- status: add REVERSED (the CHECK is recreated with the full list)
    FOR r IN
        SELECT conname FROM pg_constraint
        WHERE  conrelid = 'requisitions'::regclass AND contype = 'c'
        AND    pg_get_constraintdef(oid) LIKE '%CANCELLED%' AND pg_get_constraintdef(oid) NOT LIKE '%REVERSED%'
    LOOP
        EXECUTE format('ALTER TABLE requisitions DROP CONSTRAINT %I', r.conname);
        EXECUTE format('ALTER TABLE requisitions ADD CONSTRAINT %I CHECK (status IN (''PENDING'', ''APPROVED'', ''REJECTED'', ''CANCELLED'', ''REVERSED''))', r.conname);
    END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS idx_requisitions_investment ON requisitions (investment_id) WHERE investment_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4. Documents connected to a requisition
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requisition_document_links (
    id              SERIAL PRIMARY KEY,
    requisition_id  INTEGER      NOT NULL REFERENCES requisitions(id),
    document_id     INTEGER      NOT NULL REFERENCES documents(id),
    linked_by       INTEGER      NOT NULL REFERENCES users(id),
    linked_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    removed_at      TIMESTAMPTZ,
    removed_by      INTEGER      REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_requisition_doc_link_live
    ON requisition_document_links (requisition_id, document_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_requisition_doc_link_req ON requisition_document_links (requisition_id) WHERE removed_at IS NULL;

-- ------------------------------------------------------------
-- 5. One signature slot per POSITION (a person may hold two)
-- ------------------------------------------------------------
DROP INDEX IF EXISTS document_signatures_user_slot_unique;
CREATE UNIQUE INDEX IF NOT EXISTS document_signatures_user_position_unique
    ON document_signatures (target_type, target_id, required_user_id, (COALESCE(position_title, '')))
    WHERE required_user_id IS NOT NULL;

-- Repair: approved statutory / meeting documents whose template names a
-- person for a position that never got a slot (the same person already
-- had a slot for another position). If that person has already signed
-- the document, the new slot is filled with the same signature.
DO $$
DECLARE
    f RECORD;
    d RECORD;
    uid INTEGER;
    signed RECORD;
BEGIN
    FOR f IN SELECT * FROM (VALUES ('chairperson', 'Chairman'), ('secretary', 'Secretary'), ('director', 'Director')) AS v(k, title)
    LOOP
        FOR d IN
            SELECT id, template_data FROM documents
            WHERE  document_type IN ('MEETING_MINUTES', 'MEETING_AGENDA', 'RESOLUTION',
                                     'NOTICE_OF_MEETING', 'ATTENDANCE_REGISTER', 'CERTIFIED_RESOLUTION')
            AND    status NOT IN ('DELETED', 'SUPERSEDED')
            AND    template_data ? (f.k || '_user_id')
            AND    EXISTS (SELECT 1 FROM document_signatures s WHERE s.target_type = 'DOCUMENT' AND s.target_id = documents.id)
        LOOP
            BEGIN
                uid := (d.template_data ->> (f.k || '_user_id'))::int;
            EXCEPTION WHEN others THEN
                uid := NULL;
            END;
            CONTINUE WHEN uid IS NULL;
            CONTINUE WHEN EXISTS (
                SELECT 1 FROM document_signatures s
                WHERE  s.target_type = 'DOCUMENT' AND s.target_id = d.id
                AND    s.required_user_id = uid AND COALESCE(s.position_title, '') = f.title);
            SELECT * INTO signed FROM document_signatures s
            WHERE  s.target_type = 'DOCUMENT' AND s.target_id = d.id AND s.required_user_id = uid AND s.status = 'SIGNED'
            ORDER  BY s.signed_at LIMIT 1;
            IF FOUND THEN
                INSERT INTO document_signatures (target_type, target_id, required_user_id, position_title, status, signed_by, signature_snapshot_path, signed_at)
                VALUES ('DOCUMENT', d.id, uid, f.title, 'SIGNED', signed.signed_by, signed.signature_snapshot_path, signed.signed_at);
            ELSE
                INSERT INTO document_signatures (target_type, target_id, required_user_id, position_title)
                VALUES ('DOCUMENT', d.id, uid, f.title);
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- 6. Captured signatures on the register and written resolutions
-- ------------------------------------------------------------
ALTER TABLE meeting_attendance     ADD COLUMN IF NOT EXISTS signature_snapshot_path TEXT;
ALTER TABLE resolution_signatories ADD COLUMN IF NOT EXISTS signature_snapshot_path TEXT;

-- ------------------------------------------------------------
-- 7. Meetings recorded after they took place
-- ------------------------------------------------------------
ALTER TABLE company_meetings ADD COLUMN IF NOT EXISTS recorded_after_event BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
