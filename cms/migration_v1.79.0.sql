-- ============================================================
-- MIGRATION v1.79.0 — Company meetings, attendance register and
-- statutory resolutions (fileable with URSB)
--
-- Requested directly:
--   "i would like a very well defined template for the AGM and well
--    organised register of attendees since this should be a fileable
--    version on the URSB. This should be done for the normal minutes,
--    board resolutions, special resolutions and other system generated
--    documents. These documents aid us and sometimes are submitted
--    during the filing of the annual returns and thus i would like
--    them to standard."
-- Confirmed:
--   - Attendance: system check-in only. Everyone entitled to attend is
--     listed automatically; each attendee confirms (signs) digitally
--     from their own account.
--   - Scope: AGM pack (notice, proxy form, register, minutes), board
--     meetings, ordinary / special / board / written resolutions with a
--     certified copy for filing, and the same standard for every other
--     system-generated document.
--   - Quorum and notice: Companies Act / Table A defaults, editable.
--   - Voting: show of hands only.
--
-- WHAT THIS ADDS (nothing existing is changed; no money moves):
--   1. governance_settings — notice periods, quorums, majority for a
--      special resolution, filing period, and the legal references
--      printed on the documents. One row, editable by an Admin.
--   2. company_meetings — AGM / EGM / BOARD meetings: date, venue,
--      chair, secretary, agenda, notice, quorum, minutes.
--   3. meeting_attendance — the register of attendees (one row per
--      person entitled to attend, plus people "in attendance"), with the
--      member's digital confirmation (time + verification code).
--   4. meeting_resolutions — every resolution (ordinary, special,
--      board, written) with its show-of-hands count, result, and the
--      Registrar filing deadline / filing record.
--   5. resolution_signatories — signatures on WRITTEN resolutions
--      (every member / director signs digitally).
--   6. New document types NOTICE_OF_MEETING, PROXY_FORM,
--      ATTENDANCE_REGISTER, WRITTEN_RESOLUTION, CERTIFIED_RESOLUTION
--      (documents, templates, signature and stamp settings).
--   7. Company settings: registered office and postal address for the
--      statutory letterhead.
--   8. Permissions MEETING_VIEW / MEETING_MANAGE.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. GOVERNANCE SETTINGS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS governance_settings (
    id                              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    agm_notice_days                 INTEGER NOT NULL DEFAULT 21 CHECK (agm_notice_days >= 0),
    special_resolution_notice_days  INTEGER NOT NULL DEFAULT 21 CHECK (special_resolution_notice_days >= 0),
    general_meeting_notice_days     INTEGER NOT NULL DEFAULT 14 CHECK (general_meeting_notice_days >= 0),
    board_meeting_notice_days       INTEGER NOT NULL DEFAULT 7  CHECK (board_meeting_notice_days >= 0),
    member_quorum                   INTEGER NOT NULL DEFAULT 2  CHECK (member_quorum >= 1),
    board_quorum                    INTEGER NOT NULL DEFAULT 2  CHECK (board_quorum >= 1),
    special_resolution_majority_pct NUMERIC(5,2) NOT NULL DEFAULT 75 CHECK (special_resolution_majority_pct > 50 AND special_resolution_majority_pct <= 100),
    short_notice_consent_pct        NUMERIC(5,2) NOT NULL DEFAULT 95 CHECK (short_notice_consent_pct > 50 AND short_notice_consent_pct <= 100),
    resolution_filing_days          INTEGER NOT NULL DEFAULT 15 CHECK (resolution_filing_days >= 0),
    -- On a show of hands a proxy does not vote unless the Articles allow it.
    proxy_votes_on_show_of_hands    BOOLEAN NOT NULL DEFAULT FALSE,
    agm_max_interval_months         INTEGER NOT NULL DEFAULT 15 CHECK (agm_max_interval_months >= 1),
    act_name                        VARCHAR(200) NOT NULL DEFAULT 'Companies Act, 2012',
    -- Printed in the heading of resolutions, e.g. "PRIVATE COMPANY LIMITED BY SHARES".
    company_type                    VARCHAR(120) NOT NULL DEFAULT 'Private Company Limited by Shares',
    -- Section references printed on the documents. Kept editable because
    -- the revised edition of the Act renumbers sections — the company
    -- secretary confirms them against the edition in use.
    legal_references                JSONB NOT NULL DEFAULT '{
        "agm": "s.138",
        "notice": "s.140",
        "quorum": "s.141",
        "proxy": "s.143",
        "special_resolution": "s.148",
        "filing": "s.150",
        "minutes": "s.152"
    }'::jsonb,
    articles_note                   TEXT,
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by                      INTEGER REFERENCES users(id)
);
INSERT INTO governance_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 2. MEETINGS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_meetings (
    id                    SERIAL PRIMARY KEY,
    reference_id          INTEGER NOT NULL REFERENCES references_registry(id),
    meeting_type          VARCHAR(10) NOT NULL CHECK (meeting_type IN ('AGM', 'EGM', 'BOARD')),
    sequence_number       INTEGER,                 -- "the 3rd Annual General Meeting"
    title                 VARCHAR(255) NOT NULL,
    financial_year        VARCHAR(40),             -- AGM: the year whose accounts are laid
    meeting_date          DATE NOT NULL,
    start_time            TIME NOT NULL,
    end_time              TIME,
    venue                 TEXT,
    mode                  VARCHAR(10) NOT NULL DEFAULT 'PHYSICAL' CHECK (mode IN ('PHYSICAL', 'VIRTUAL', 'HYBRID')),
    virtual_link          TEXT,
    chairperson_user_id   INTEGER REFERENCES users(id),
    chairperson_name      VARCHAR(200),
    secretary_user_id     INTEGER REFERENCES users(id),
    secretary_name        VARCHAR(200),
    agenda                JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ no, title, description, business }]
    has_special_business  BOOLEAN NOT NULL DEFAULT FALSE,
    notice_issued_at      TIMESTAMPTZ,
    notice_issued_by      INTEGER REFERENCES users(id),
    notice_days_required  INTEGER,
    notice_days_given     INTEGER,
    short_notice_consent  BOOLEAN NOT NULL DEFAULT FALSE,
    short_notice_note     TEXT,
    quorum_required       INTEGER,
    opened_at             TIMESTAMPTZ,
    opened_by             INTEGER REFERENCES users(id),
    quorum_at_opening     INTEGER,
    closed_at             TIMESTAMPTZ,
    closed_by             INTEGER REFERENCES users(id),
    minutes               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { opening, previous_minutes, items:[{ no, title, discussion, decision }], aob, closing, next_meeting }
    status                VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'NOTICE_ISSUED', 'IN_PROGRESS', 'CLOSED', 'CANCELLED')),
    cancelled_reason      TEXT,
    created_by            INTEGER NOT NULL REFERENCES users(id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_company_meetings_date ON company_meetings (meeting_date DESC);

-- ------------------------------------------------------------
-- 3. REGISTER OF ATTENDEES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_attendance (
    id                 SERIAL PRIMARY KEY,
    meeting_id         INTEGER NOT NULL REFERENCES company_meetings(id) ON DELETE CASCADE,
    user_id            INTEGER REFERENCES users(id),
    name               VARCHAR(200) NOT NULL,
    -- MEMBER / DIRECTOR count for the quorum and vote; IN_ATTENDANCE
    -- (company secretary, auditor, guest) is recorded but never counted.
    capacity           VARCHAR(20) NOT NULL CHECK (capacity IN ('MEMBER', 'DIRECTOR', 'IN_ATTENDANCE')),
    designation        VARCHAR(120),            -- e.g. Chairperson, Director, Auditor
    shares_held        NUMERIC(20,4),           -- members: shares on the register when the list was made
    status             VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'PRESENT', 'PRESENT_VIRTUAL', 'BY_PROXY', 'APOLOGY', 'ABSENT')),
    proxy_name         VARCHAR(200),
    proxy_user_id      INTEGER REFERENCES users(id),
    marked_at          TIMESTAMPTZ,
    marked_by          INTEGER REFERENCES users(id),
    confirmed_at       TIMESTAMPTZ,             -- the attendee's own digital signature
    confirmation_code  VARCHAR(16),
    confirmed_ip       VARCHAR(64),
    sort_order         INTEGER NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_attendance_user
    ON meeting_attendance (meeting_id, user_id, capacity) WHERE user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4. RESOLUTIONS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_resolutions (
    id                     SERIAL PRIMARY KEY,
    reference_id           INTEGER NOT NULL REFERENCES references_registry(id),
    meeting_id             INTEGER REFERENCES company_meetings(id),   -- NULL for a written resolution
    kind                   VARCHAR(20) NOT NULL
                           CHECK (kind IN ('ORDINARY', 'SPECIAL', 'BOARD', 'WRITTEN_MEMBERS', 'WRITTEN_BOARD')),
    -- A written members' resolution can stand in for a special one.
    treated_as_special     BOOLEAN NOT NULL DEFAULT FALSE,
    resolution_number      VARCHAR(30) NOT NULL,      -- e.g. SR 1/2026
    agenda_no              INTEGER,
    title                  VARCHAR(255) NOT NULL,
    preamble               TEXT,                       -- "WHEREAS …"
    clauses                JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["THAT …", …]
    proposed_by_user_id    INTEGER REFERENCES users(id),
    proposed_by_name       VARCHAR(200),
    seconded_by_user_id    INTEGER REFERENCES users(id),
    seconded_by_name       VARCHAR(200),
    votes_for              INTEGER CHECK (votes_for >= 0),
    votes_against          INTEGER CHECK (votes_against >= 0),
    votes_abstain          INTEGER CHECK (votes_abstain >= 0),
    voters_present         INTEGER,
    chair_casting_vote     VARCHAR(10) CHECK (chair_casting_vote IN ('FOR', 'AGAINST')),   -- only on equal votes
    majority_required_pct  NUMERIC(5,2),
    result                 VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (result IN ('PENDING', 'CARRIED', 'LOST', 'WITHDRAWN')),
    passed_on              DATE,
    recorded_at            TIMESTAMPTZ,
    recorded_by            INTEGER REFERENCES users(id),
    filing_required        BOOLEAN NOT NULL DEFAULT FALSE,
    filing_due_date        DATE,
    filed_on               DATE,
    filing_reference       VARCHAR(120),
    filed_by               INTEGER REFERENCES users(id),
    created_by             INTEGER NOT NULL REFERENCES users(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_resolutions_meeting ON meeting_resolutions (meeting_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_resolutions_number ON meeting_resolutions (resolution_number);

-- ------------------------------------------------------------
-- 5. SIGNATURES ON WRITTEN RESOLUTIONS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resolution_signatories (
    id                 SERIAL PRIMARY KEY,
    resolution_id      INTEGER NOT NULL REFERENCES meeting_resolutions(id) ON DELETE CASCADE,
    user_id            INTEGER NOT NULL REFERENCES users(id),
    name               VARCHAR(200) NOT NULL,
    capacity           VARCHAR(20) NOT NULL CHECK (capacity IN ('MEMBER', 'DIRECTOR')),
    shares_held        NUMERIC(20,4),
    decision           VARCHAR(10) CHECK (decision IN ('AGREE', 'DISAGREE')),
    signed_at          TIMESTAMPTZ,
    confirmation_code  VARCHAR(16),
    signed_ip          VARCHAR(64),
    UNIQUE (resolution_id, user_id)
);

-- ------------------------------------------------------------
-- 6. NEW DOCUMENT TYPES
-- Each CHECK is re-created as the full list (old values + new), so
-- every existing row stays valid.
-- ------------------------------------------------------------
DO $$
DECLARE
    all_types TEXT := $t$'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
        'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL','RECEIPT','RESOLUTION','CONTRACT',
        'LOAN_AGREEMENT','GRANT_AGREEMENT','AUDITOR_FEEDBACK','AUDIT_REPORT','OTHER','SHARE_CERTIFICATE',
        'NOTICE_OF_MEETING','PROXY_FORM','ATTENDANCE_REGISTER','WRITTEN_RESOLUTION','CERTIFIED_RESOLUTION'$t$;
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

-- document_type columns of the signature / stamp settings were VARCHAR(30)
-- — every new type fits (the longest is 20 characters).

INSERT INTO document_templates (name, template_type, description, template_body)
SELECT v.name, v.ttype, v.descr, 'Rendered client-side — see exportUtils.js (statutory meeting documents, v1.79.0).'
FROM (VALUES
    ('Notice of Meeting',     'NOTICE_OF_MEETING',    'Statutory notice of an AGM, EGM or board meeting, with the agenda and the proxy statement.'),
    ('Proxy Form',            'PROXY_FORM',           'Form for a member to appoint a proxy to attend and vote at a general meeting.'),
    ('Attendance Register',   'ATTENDANCE_REGISTER',  'Register of attendees with shares held, capacity, digital confirmations and the quorum.'),
    ('Written Resolution',    'WRITTEN_RESOLUTION',   'Resolution in writing signed by every member or every director entitled to vote.'),
    ('Certified Resolution',  'CERTIFIED_RESOLUTION', 'Certified true copy of a resolution for filing with the Registrar of Companies.')
) AS v(name, ttype, descr)
WHERE NOT EXISTS (SELECT 1 FROM document_templates t WHERE t.template_type = v.ttype);

-- ------------------------------------------------------------
-- 7. COMPANY ADDRESSES FOR THE STATUTORY LETTERHEAD
-- ------------------------------------------------------------
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS registered_office VARCHAR(300);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS postal_address    VARCHAR(200);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS company_email     VARCHAR(150);
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS company_phone     VARCHAR(50);

-- ------------------------------------------------------------
-- 8. PERMISSIONS
-- Granted to the roles that run meetings. An Admin can change this
-- under Settings › Roles; the routes also accept those roles directly.
-- ------------------------------------------------------------
INSERT INTO permissions (code, module, description) VALUES
    ('MEETING_VIEW',   'GOVERNANCE', 'See company meetings, registers, minutes and resolutions (v1.79.0)'),
    ('MEETING_MANAGE', 'GOVERNANCE', 'Convene meetings, issue notices, keep the register, record resolutions and minutes (v1.79.0)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id, granted_by)
SELECT r.id, p.id, g.uid
FROM   roles r
JOIN   permissions p ON p.code = 'MEETING_MANAGE'
CROSS JOIN (SELECT MIN(id) AS uid FROM users) g
WHERE  r.name IN ('Admin', 'Director', 'Secretary', 'Assistant Secretary')
AND    g.uid IS NOT NULL
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id, granted_by)
SELECT r.id, p.id, g.uid
FROM   roles r
JOIN   permissions p ON p.code = 'MEETING_VIEW'
CROSS JOIN (SELECT MIN(id) AS uid FROM users) g
WHERE  r.name IN ('Admin', 'Director', 'Treasurer', 'Assistant Treasurer', 'Secretary',
                  'Assistant Secretary', 'Coordinator', 'Shareholder')
AND    g.uid IS NOT NULL
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
