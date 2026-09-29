-- ============================================================
-- MIGRATION v1.69.0 — Share capital done the legal way: nominal
-- value, share premium, whole shares allotted at every contribution,
-- members' share credit (with refunds), registered-capital tracking,
-- returns of allotment, and dual-approved share value changes.
--
-- Requested directly:
--   "nominal share price is different for both companies and I would
--    like to keep it updatable / editable but with some preconditions
--    anytime it is changed: 1. approval by two directors or a director
--    and treasurer but not the same person. 2. linked to an approved
--    board resolution in documents ... this change also auto generates
--    a document / formal notice accessible by all shareholders"
--   "the system allots the shares but warns and keeps track of the
--    excess to do in a filing"
--   "shares are always allotted at each contribution"
--   "existing fractional shares should stay as credit (but the refund
--    option should be available for that credit)"
--   "Admin role alone plays no approver role in change of the share
--    price"
--   Registered values: Investabo UGX 50,000 x 98 shares;
--                      Zweck      UGX 100,000 x 600 shares.
--
-- WHAT THIS ADDS (tables only — the money logic is in
-- src/services/shareCapitalService.js):
--
--  1. share_nominal_history — the NOMINAL (par) value of one ordinary
--     share and the number of shares REGISTERED with URSB (authorised
--     share capital), with dated history. NOT seeded: entered and
--     edited on the Share Capital page (Overview > Registered values)
--     until the first shares are allotted; after that, changed only
--     through Share Capital > Changes.
--
--  2. share_allotments — one row per allotment of WHOLE shares:
--     at each contribution, at the one-off opening conversion, and at
--     a split / consolidation. Stores nominal value, issue price, the
--     share capital (shares x nominal) and share premium
--     (shares x (issue price - nominal)) parts, whether it went beyond
--     the registered number of shares, and the return-of-allotment
--     filing due date (Companies Act 2012 s.61 — 60 days).
--
--  3. member_capital_credit_entries — each member's SHARE CREDIT:
--     money paid in that has not (yet) bought a whole share. Signed
--     ledger (in the share currency, UGX): + contribution, - shares
--     allotted, - refund, + consolidation leftover, and reversals.
--
--  4. capital_credit_refunds — a Treasury request to pay a member's
--     credit back, approved by a DIFFERENT person, then paid out as a
--     real transaction (new inflow type CAPITAL_CREDIT_REFUND_OUT).
--
--  5. share_capital_change_requests — a change to the issue price, the
--     nominal value (split / consolidation) or the registered number of
--     shares. Needs a FINAL board resolution from Documents and two
--     different approvers (two Directors, or a Director and the
--     Treasurer). Admin alone can never approve.
--
--  6. documents.audience — 'ALL_SHAREHOLDERS' puts a company notice
--     (the auto-generated share value change notice) into every
--     shareholder's My Documents.
--
--  7. Chart of accounts — 3000 becomes "Share Capital (Ordinary)",
--     new 3010 Share Premium and 3020 Capital Pending Allotment
--     (Members' Share Credit). Contributions now land in 3020 and are
--     moved to 3000/3010 when shares are allotted (synthetic ledger
--     lines built from share_allotments in glService.js).
--
-- NOTHING IS ALLOTTED BY THIS FILE. After running it, open
-- Share Capital > Overview, enter the REGISTERED VALUES (nominal value,
-- registered shares and their history), then run the OPENING
-- CONVERSION (preview
-- first), or run  node backfill_v1.69.0_share_allotments.js
-- It turns every approved contribution to date into whole shares plus
-- credit, at the share price that applied on each contribution's own
-- date, so no historical holding is re-priced. Until it has been run,
-- new contributions are refused with a message saying so.
--
-- Idempotent. Apply to BOTH databases:
--   node run_migration.js migration_v1.69.0.sql
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. NOMINAL VALUE + REGISTERED SHARES (history)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_nominal_history (
    id                 SERIAL PRIMARY KEY,
    nominal_value      NUMERIC(20,4) NOT NULL CHECK (nominal_value > 0),
    currency_id        INTEGER       NOT NULL REFERENCES currencies(id),
    -- Number of shares registered with URSB (authorised). NULL = not
    -- recorded yet (no limit is tracked until it is set).
    registered_shares  INTEGER       CHECK (registered_shares IS NULL OR registered_shares > 0),
    effective_from     DATE          NOT NULL,
    effective_to       DATE,
    change_request_id  INTEGER,
    set_by             INTEGER REFERENCES users(id),
    notes              TEXT,
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS share_nominal_history_one_current
    ON share_nominal_history ((TRUE)) WHERE effective_to IS NULL;

-- ------------------------------------------------------------
-- 2. SHARE ALLOTMENTS (whole shares)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_allotments (
    id                        SERIAL PRIMARY KEY,
    reference_id              INTEGER       REFERENCES references_registry(id),
    user_id                   INTEGER       NOT NULL REFERENCES users(id),
    contribution_id           INTEGER       REFERENCES shareholder_contributions(id),
    change_request_id         INTEGER,
    source                    VARCHAR(30)   NOT NULL
                              CHECK (source IN ('CONTRIBUTION','OPENING_CONVERSION','SPLIT','CONSOLIDATION')),
    allotment_date            DATE          NOT NULL,
    -- Whole shares. Negative only for a CONSOLIDATION (shares taken
    -- away when several old shares become one new share).
    shares                    INTEGER       NOT NULL CHECK (shares <> 0),
    nominal_value             NUMERIC(20,4) NOT NULL,
    issue_price               NUMERIC(20,4) NOT NULL,
    currency_id               INTEGER       NOT NULL REFERENCES currencies(id),
    consideration_amount      NUMERIC(20,2) NOT NULL DEFAULT 0,  -- shares x issue price (what the credit paid)
    share_capital_amount      NUMERIC(20,2) NOT NULL DEFAULT 0,  -- shares x nominal value
    share_premium_amount      NUMERIC(20,2) NOT NULL DEFAULT 0,  -- shares x (issue price - nominal value)
    -- Registered-capital tracking, snapshotted at allotment time.
    registered_shares         INTEGER,
    total_shares_after        INTEGER,
    shares_beyond_registered  INTEGER       NOT NULL DEFAULT 0,
    -- Return of allotment (Companies Act 2012 s.61 — within 60 days).
    return_due_date           DATE,
    return_filed_at           DATE,
    return_reference          VARCHAR(100),
    return_filed_by           INTEGER REFERENCES users(id),
    status                    VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','REVERSED')),
    reversed_at               DATE,
    reversed_by               INTEGER REFERENCES users(id),
    reversal_reason           TEXT,
    notes                     TEXT,
    created_by                INTEGER REFERENCES users(id),
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT share_allotment_sign CHECK (shares > 0 OR source = 'CONSOLIDATION')
);
CREATE INDEX IF NOT EXISTS idx_share_allotments_user ON share_allotments (user_id, allotment_date);
CREATE INDEX IF NOT EXISTS idx_share_allotments_contribution ON share_allotments (contribution_id);
CREATE INDEX IF NOT EXISTS idx_share_allotments_date ON share_allotments (allotment_date);

-- ------------------------------------------------------------
-- 3. MEMBERS' SHARE CREDIT (signed ledger, share currency)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_capital_credit_entries (
    id                 SERIAL PRIMARY KEY,
    user_id            INTEGER       NOT NULL REFERENCES users(id),
    entry_date         DATE          NOT NULL,
    entry_type         VARCHAR(30)   NOT NULL
                       CHECK (entry_type IN ('CONTRIBUTION','ALLOTMENT','REFUND','CONSOLIDATION_LEFTOVER',
                                             'CONTRIBUTION_REVERSAL','ALLOTMENT_REVERSAL')),
    amount             NUMERIC(20,2) NOT NULL,   -- + adds to credit, - uses it
    currency_id        INTEGER       NOT NULL REFERENCES currencies(id),
    contribution_id    INTEGER       REFERENCES shareholder_contributions(id),
    allotment_id       INTEGER       REFERENCES share_allotments(id),
    refund_id          INTEGER,
    change_request_id  INTEGER,
    -- How a contribution's value in the share currency was arrived at.
    original_amount    NUMERIC(20,4),
    original_currency_id INTEGER     REFERENCES currencies(id),
    rate_used          NUMERIC(30,12),
    notes              TEXT,
    created_by         INTEGER REFERENCES users(id),
    created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_member_credit_user ON member_capital_credit_entries (user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_member_credit_contribution ON member_capital_credit_entries (contribution_id);

-- ------------------------------------------------------------
-- 4. SHARE CREDIT REFUNDS (maker-checker)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_credit_refunds (
    id                  SERIAL PRIMARY KEY,
    reference_id        INTEGER       REFERENCES references_registry(id),
    user_id             INTEGER       NOT NULL REFERENCES users(id),
    credit_amount       NUMERIC(20,2) NOT NULL CHECK (credit_amount > 0),  -- in the share currency
    credit_currency_id  INTEGER       NOT NULL REFERENCES currencies(id),
    account_id          INTEGER       NOT NULL REFERENCES accounts(id),   -- paid from
    payout_amount       NUMERIC(20,2),                                    -- in the account's currency
    payout_currency_id  INTEGER       REFERENCES currencies(id),
    rate_used           NUMERIC(30,12),
    reason              TEXT          NOT NULL,
    status              VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','PAID','REJECTED','CANCELLED')),
    requested_by        INTEGER       NOT NULL REFERENCES users(id),
    requested_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    decided_by          INTEGER REFERENCES users(id),
    decided_at          TIMESTAMPTZ,
    decision_note       TEXT,
    payout_date         DATE,
    transaction_id      INTEGER REFERENCES transactions(id),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_capital_credit_refunds_user ON capital_credit_refunds (user_id);

-- ------------------------------------------------------------
-- 5. SHARE CAPITAL CHANGE REQUESTS (two different approvers)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_capital_change_requests (
    id                      SERIAL PRIMARY KEY,
    reference_id            INTEGER       REFERENCES references_registry(id),
    change_type             VARCHAR(30)   NOT NULL
                            CHECK (change_type IN ('ISSUE_PRICE','NOMINAL_VALUE','REGISTERED_SHARES')),
    currency_id             INTEGER       NOT NULL REFERENCES currencies(id),
    current_value           NUMERIC(20,4),
    proposed_value          NUMERIC(20,4) NOT NULL CHECK (proposed_value > 0),
    effective_date          DATE          NOT NULL,
    resolution_document_id  INTEGER       NOT NULL REFERENCES documents(id),
    reason                  TEXT          NOT NULL,
    status                  VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING','APPLIED','REJECTED','CANCELLED')),
    requested_by            INTEGER       NOT NULL REFERENCES users(id),
    requested_role          VARCHAR(30)   NOT NULL,
    requested_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    approved_by             INTEGER REFERENCES users(id),
    approved_role           VARCHAR(30),
    approved_at             TIMESTAMPTZ,
    rejected_by             INTEGER REFERENCES users(id),
    rejected_at             TIMESTAMPTZ,
    decision_note           TEXT,
    applied_at              TIMESTAMPTZ,
    result_summary          JSONB,
    notice_document_id      INTEGER REFERENCES documents(id),
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT share_change_two_people CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS share_capital_change_one_pending
    ON share_capital_change_requests (change_type) WHERE status = 'PENDING';

-- ------------------------------------------------------------
-- 6. ONE-ROW SETTINGS (opening conversion status, filing days)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS share_capital_settings (
    id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    allotment_return_days   INTEGER      NOT NULL DEFAULT 60,
    opening_converted_at    TIMESTAMPTZ,
    opening_converted_by    INTEGER REFERENCES users(id),
    opening_summary         JSONB,
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
INSERT INTO share_capital_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- 7. NOMINAL VALUE + REGISTERED SHARES ARE SET IN THE SYSTEM
-- Nothing is seeded here. A Director or the Treasurer enters the
-- nominal value per share, the number of registered shares and their
-- history on the Share Capital page (Overview > Registered values).
-- They can be edited freely until the first shares are allotted; after
-- that, every change goes through Share Capital > Changes (board
-- resolution + two approvers).
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 8. documents.audience
-- ------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS audience VARCHAR(30);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_audience_check') THEN
        ALTER TABLE documents ADD CONSTRAINT documents_audience_check
            CHECK (audience IS NULL OR audience IN ('ALL_SHAREHOLDERS'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_documents_audience ON documents (audience) WHERE audience IS NOT NULL;

-- ------------------------------------------------------------
-- 9. Late foreign keys (tables above reference each other)
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_nominal_history_request_fk') THEN
        ALTER TABLE share_nominal_history ADD CONSTRAINT share_nominal_history_request_fk
            FOREIGN KEY (change_request_id) REFERENCES share_capital_change_requests(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'share_allotments_request_fk') THEN
        ALTER TABLE share_allotments ADD CONSTRAINT share_allotments_request_fk
            FOREIGN KEY (change_request_id) REFERENCES share_capital_change_requests(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_credit_refund_fk') THEN
        ALTER TABLE member_capital_credit_entries ADD CONSTRAINT member_credit_refund_fk
            FOREIGN KEY (refund_id) REFERENCES capital_credit_refunds(id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_credit_request_fk') THEN
        ALTER TABLE member_capital_credit_entries ADD CONSTRAINT member_credit_request_fk
            FOREIGN KEY (change_request_id) REFERENCES share_capital_change_requests(id);
    END IF;
END $$;

-- ------------------------------------------------------------
-- 10. transactions.inflow_type gains CAPITAL_CREDIT_REFUND_OUT.
-- Rebuilt from the constraint's CURRENT list (whatever earlier
-- versions added), so nothing already allowed is dropped.
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
    con_def  text;
    vals     text[];
BEGIN
    SELECT conname, pg_get_constraintdef(oid) INTO con_name, con_def
    FROM   pg_constraint
    WHERE  conrelid = 'transactions'::regclass
    AND    contype = 'c'
    AND    pg_get_constraintdef(oid) LIKE '%inflow_type%'
    LIMIT  1;

    IF con_def IS NOT NULL AND con_def LIKE '%CAPITAL_CREDIT_REFUND_OUT%' THEN
        RETURN;
    END IF;

    SELECT array_agg(DISTINCT m[1]) INTO vals
    FROM   regexp_matches(COALESCE(con_def, ''), '''([A-Z_]+)''', 'g') AS m;
    vals := COALESCE(vals, ARRAY[]::text[]) || ARRAY['CAPITAL_CREDIT_REFUND_OUT'];

    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE transactions DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    EXECUTE 'ALTER TABLE transactions ADD CONSTRAINT transactions_inflow_type_check CHECK (inflow_type IN ('
        || (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) AS v)
        || '))';
END $$;

-- ------------------------------------------------------------
-- 11. CHART OF ACCOUNTS
-- ------------------------------------------------------------
UPDATE gl_accounts
SET    name = 'Share Capital (Ordinary)',
       description = 'Nominal (par) value of the ordinary shares allotted: whole shares x nominal value per share. Moved here from 3020 when shares are allotted.'
WHERE  code = '3000';

INSERT INTO gl_accounts (code, name, account_type, normal_balance, statement_section, cash_flow_category, description, display_order, is_monetary)
VALUES
    ('3010', 'Share Premium', 'EQUITY', 'CREDIT', 'EQUITY', 'FINANCING',
     'Amount paid for allotted shares above their nominal value: whole shares x (issue price - nominal value). May only be used as the Companies Act 2012 s.67 allows (e.g. bonus shares).', 505, FALSE),
    ('3020', 'Capital Pending Allotment (Members'' Share Credit)', 'EQUITY', 'CREDIT', 'EQUITY', 'FINANCING',
     'Capital paid in by members that has not yet bought a whole share. Every contribution lands here; the value of shares allotted moves out to 3000/3010. Its balance equals the total of all members'' share credit. Reduced by approved credit refunds.', 507, FALSE)
ON CONFLICT (code) DO NOTHING;

UPDATE gl_inflow_type_mapping m
SET    gl_account_id = ga.id,
       notes = 'v1.69.0 — capital paid in lands in Capital Pending Allotment; shares allotted move it to Share Capital (3000) / Share Premium (3010).',
       updated_at = NOW()
FROM   gl_accounts ga
WHERE  ga.code = '3020' AND m.inflow_type = 'CONTRIBUTION';

INSERT INTO gl_inflow_type_mapping (inflow_type, gl_account_id, notes)
SELECT 'CAPITAL_CREDIT_REFUND_OUT', ga.id, 'v1.69.0 — a member''s unused share credit paid back to them.'
FROM   gl_accounts ga WHERE ga.code = '3020'
ON CONFLICT (inflow_type) DO NOTHING;

-- ------------------------------------------------------------
-- 12. A database with no approved contributions has nothing to
-- convert — mark the opening conversion as done so contributions can
-- be recorded straight away (a brand-new installation).
-- ------------------------------------------------------------
UPDATE share_capital_settings
SET    opening_converted_at = NOW(),
       opening_summary = '{"contributions":0,"members":[],"totalShares":0,"totalCredit":0,"allottedBelowNominal":[],"note":"Nothing to convert — no approved contributions when v1.69.0 was installed."}'::jsonb,
       updated_at = NOW()
WHERE  id = 1
AND    opening_converted_at IS NULL
AND    NOT EXISTS (SELECT 1 FROM shareholder_contributions WHERE status = 'APPROVED')
AND    NOT EXISTS (SELECT 1 FROM share_allotments);

COMMIT;
