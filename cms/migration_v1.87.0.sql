-- ============================================================
-- MIGRATION v1.87.0 — requisitions in four steps; settable notice
-- date; proxy forms filled in the system; removal of accounts that
-- never became members
--
-- Requested directly:
--   "the flow should follow: requisition > approval > release >
--    acknowledgement - all recorded and put in the respective document
--    showing all parties involved and what they did."
--   "the date of notice for meetings … be settable and not always
--    taking the entry date as issue date … (this should also affect
--    existing records that have not been closed)"
--   "the proxy form be fillable within the system for members who need
--    it (e.g. absent) where they can appoint members in the system or
--    just type the name of the appointee"
--   "if a person has no roles, unverified for long or flagged for
--    suspicious activities by the system, they don't appear in
--    dropdowns anywhere in the system and automatically their accounts
--    deleted after 7 days"
-- Confirmed: the approver and the person who releases the money are
-- different people; only the requester acknowledges; invited accounts
-- waiting for their role are kept; proxy forms close 48 hours before
-- the meeting (the Secretary can still record a late one).
--
-- What this adds:
--   1. requisitions: RELEASED and ACKNOWLEDGED; who released the money,
--      when, how (bank transfer, mobile money, cash, cheque) and the
--      payment reference; the requester's acknowledgement (date, note)
--      or a problem they reported; the filed Requisition Form document.
--      Money-out requisitions approved AND paid in one step before this
--      version become RELEASED (released by the person who approved
--      them, marked "one step, before v1.87.0"), so their requesters
--      can still acknowledge receipt. Nothing about their money changes.
--   2. Document type REQUISITION_FORM.
--   3. meeting_proxies — one appointment per member and meeting: the
--      proxy (a member chosen from the list, or a typed name), an
--      alternate, voting instructions, the member's signature, when
--      and by whom it was lodged (late ones with the reason), withdrawn
--      or revoked. governance_settings.proxy_deadline_hours (48).
--   4. company_meetings.notice_date_note — why the notice date was
--      corrected after it was entered.
--   5. access_control_settings.auto_remove_days (7) — accounts that
--      never held a role are removed after this many days (0 = never).
--
-- Nothing already recorded changes value. Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Requisitions: approve › release › acknowledge
-- ------------------------------------------------------------
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS released_by          INTEGER REFERENCES users(id);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS released_at          TIMESTAMPTZ;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS release_date         DATE;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS release_method       VARCHAR(20);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS release_reference    VARCHAR(120);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS release_notes        TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS acknowledged_at      TIMESTAMPTZ;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS acknowledged_date    DATE;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS acknowledgement_note TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS ack_issue_at         TIMESTAMPTZ;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS ack_issue_note       TEXT;
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS form_document_id     INTEGER REFERENCES documents(id);
ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS legacy_one_step      BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'requisitions'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%status%PENDING%'
    LOOP
        EXECUTE format('ALTER TABLE requisitions DROP CONSTRAINT %I', r.conname);
    END LOOP;
    ALTER TABLE requisitions ADD CONSTRAINT requisitions_status_check
        CHECK (status IN ('PENDING', 'APPROVED', 'RELEASED', 'ACKNOWLEDGED', 'REJECTED', 'CANCELLED', 'REVERSED'));
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'requisitions'::regclass AND conname = 'requisitions_release_method_check') THEN
        ALTER TABLE requisitions ADD CONSTRAINT requisitions_release_method_check
            CHECK (release_method IS NULL OR release_method IN ('BANK_TRANSFER', 'MOBILE_MONEY', 'CASH', 'CHEQUE', 'OTHER'));
    END IF;
END $$;

-- money-out requisitions approved and paid in one step before v1.87.0
UPDATE requisitions q
SET    status = 'RELEASED',
       released_by = q.reviewed_by,
       released_at = q.reviewed_at,
       release_date = COALESCE((SELECT t.value_date FROM transactions t WHERE t.id = q.transaction_id), q.reviewed_at::date),
       legacy_one_step = TRUE
WHERE  q.requisition_type = 'EXPENSE'
AND    q.status = 'APPROVED'
AND    q.transaction_id IS NOT NULL;

COMMENT ON COLUMN requisitions.legacy_one_step IS
    'v1.87.0 — approved and paid in one step before requisitions had separate approval, release and acknowledgement.';

-- ------------------------------------------------------------
-- 2. Document type REQUISITION_FORM (each CHECK re-created with the full list)
-- ------------------------------------------------------------
DO $$
DECLARE
    all_types TEXT := $t$'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
        'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL','RECEIPT','RESOLUTION','CONTRACT',
        'LOAN_AGREEMENT','GRANT_AGREEMENT','AUDITOR_FEEDBACK','AUDIT_REPORT','OTHER','SHARE_CERTIFICATE',
        'NOTICE_OF_MEETING','PROXY_FORM','ATTENDANCE_REGISTER','WRITTEN_RESOLUTION','CERTIFIED_RESOLUTION',
        'BOND_CERTIFICATE','PROJECT_PROPOSAL','PROJECT_REPORT','REQUISITION_FORM'$t$;
    r RECORD;
BEGIN
    FOR r IN
        SELECT c.conrelid::regclass::text AS tbl, c.conname,
               CASE WHEN c.conrelid = 'document_templates'::regclass THEN 'template_type' ELSE 'document_type' END AS col
        FROM   pg_constraint c
        WHERE  c.contype = 'c'
        AND    c.conrelid IN ('documents'::regclass, 'document_templates'::regclass,
                              'signature_requirements'::regclass, 'document_stamp_requirements'::regclass)
        AND    pg_get_constraintdef(c.oid) LIKE '%MEETING_MINUTES%'
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s))', r.tbl, r.conname, r.col, all_types);
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. Proxy forms filled in the system
-- ------------------------------------------------------------
ALTER TABLE governance_settings ADD COLUMN IF NOT EXISTS proxy_deadline_hours INTEGER NOT NULL DEFAULT 48;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'governance_settings'::regclass AND conname = 'governance_settings_proxy_deadline_check') THEN
        ALTER TABLE governance_settings ADD CONSTRAINT governance_settings_proxy_deadline_check CHECK (proxy_deadline_hours BETWEEN 0 AND 168);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS meeting_proxies (
    id                 SERIAL PRIMARY KEY,
    meeting_id         INTEGER NOT NULL REFERENCES company_meetings(id) ON DELETE CASCADE,
    attendance_id      INTEGER REFERENCES meeting_attendance(id) ON DELETE SET NULL,
    member_user_id     INTEGER NOT NULL REFERENCES users(id),
    member_address     TEXT,
    proxy_user_id      INTEGER REFERENCES users(id),
    proxy_name         VARCHAR(200) NOT NULL,
    proxy_address      TEXT,
    alternate_user_id  INTEGER REFERENCES users(id),
    alternate_name     VARCHAR(200),
    alternate_address  TEXT,
    -- { "res:<resolution id>": "FOR" | "AGAINST" | "ABSTAIN", "item:<agenda no>": … }
    -- anything not listed: the proxy votes or abstains as he/she thinks fit
    instructions       JSONB NOT NULL DEFAULT '{}'::jsonb,
    signature_url      TEXT,              -- snapshot of the member's signature
    signed_at          TIMESTAMPTZ,
    lodged_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lodged_by          INTEGER NOT NULL REFERENCES users(id),
    lodged_late        BOOLEAN NOT NULL DEFAULT FALSE,
    late_reason        TEXT,
    status             VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WITHDRAWN', 'REVOKED')),
    ended_at           TIMESTAMPTZ,
    ended_by           INTEGER REFERENCES users(id),
    end_reason         TEXT,
    document_id        INTEGER REFERENCES documents(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_proxies_active
    ON meeting_proxies (meeting_id, member_user_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_meeting_proxies_meeting ON meeting_proxies (meeting_id);
COMMENT ON TABLE meeting_proxies IS
    'v1.87.0 — a member''s appointment of a proxy for one general meeting, filled in and signed in the system (or recorded by the Secretary from a paper form). Lodged up to proxy_deadline_hours before the meeting; the Secretary may record a late one with the reason. Attending in person revokes it.';

-- ------------------------------------------------------------
-- 4. Notice date corrected after it was entered
-- ------------------------------------------------------------
ALTER TABLE company_meetings ADD COLUMN IF NOT EXISTS notice_date_note TEXT;

-- ------------------------------------------------------------
-- 5. Accounts that never became members are removed
-- ------------------------------------------------------------
ALTER TABLE access_control_settings ADD COLUMN IF NOT EXISTS auto_remove_days INTEGER NOT NULL DEFAULT 7;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'access_control_settings'::regclass AND conname = 'access_control_settings_auto_remove_check') THEN
        ALTER TABLE access_control_settings ADD CONSTRAINT access_control_settings_auto_remove_check CHECK (auto_remove_days BETWEEN 0 AND 60);
    END IF;
END $$;
COMMENT ON COLUMN access_control_settings.auto_remove_days IS
    'v1.87.0 — accounts that never held a role (not verified, flagged, declined or simply never approved) are removed this many days after registering; one with any record is declined and kept instead. Invited accounts waiting for their role are kept. 0 = never.';

COMMIT;
