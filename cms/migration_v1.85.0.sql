-- ============================================================
-- MIGRATION v1.85.0 — projects on their own, inside an investment,
-- or added to one later; documents on project and investment pages.
--
-- Requested directly:
--   "there is no way to enter project under investments or at all in
--    any forms"
--   "Projects can stand independently or with in or added later to an
--    investment. From the proposal to other related documents can be
--    directly uploaded on the project or investment page. (like bond
--    certificates)"
--
-- What this adds:
--   1. projects.investment_id may be empty — a project on its own.
--      Every project now has its own currency (the currency its budget
--      and spending are counted in): for a project inside an investment
--      it is the investment's account currency.
--   2. When a project on its own is added to an investment later, the
--      date and the person are kept (linked_to_investment_at / _by).
--   3. project_spending — money spent on a project on its own, recorded
--      through Record Expense with the project chosen (the ledger entry
--      stays an ordinary expense). Money for a project inside an
--      investment is still recorded as investment funding with the
--      project chosen (investment_funding.project_id), as before.
--   4. transactions.project_id — every ledger entry for a project
--      carries it (expenses for a project on its own, and investment
--      funding for a project inside an investment; existing funding
--      rows are filled in).
--   5. Document types BOND_CERTIFICATE, PROJECT_PROPOSAL, PROJECT_REPORT.
--   6. A default project category: Investment › Projects.
--
-- Nothing already recorded changes value. Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Projects on their own
-- ------------------------------------------------------------
ALTER TABLE projects ALTER COLUMN investment_id DROP NOT NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS currency_id            INTEGER REFERENCES currencies(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS linked_to_investment_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS linked_by              INTEGER REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status_note            TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_by             INTEGER REFERENCES users(id);

-- the currency of every existing project = its investment's account currency
UPDATE projects p
SET    currency_id = a.currency_id
FROM   investments i
JOIN   accounts a ON a.id = i.funding_account_id
WHERE  i.id = p.investment_id
AND    p.currency_id IS NULL;

COMMENT ON COLUMN projects.investment_id IS
    'v1.85.0 — empty for a project on its own; may be set later (linked_to_investment_at / linked_by).';
COMMENT ON COLUMN projects.currency_id IS
    'v1.85.0 — the currency the project''s budget and spending are counted in (inside an investment: the investment''s account currency).';

CREATE INDEX IF NOT EXISTS idx_projects_investment ON projects (investment_id);

-- ------------------------------------------------------------
-- 2. Money spent on a project on its own
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_spending (
    id             SERIAL PRIMARY KEY,
    project_id     INTEGER       NOT NULL REFERENCES projects(id),
    transaction_id INTEGER       NOT NULL REFERENCES transactions(id),
    amount         NUMERIC(20,4) NOT NULL CHECK (amount > 0),
    is_reversed    BOOLEAN       NOT NULL DEFAULT FALSE,
    reversed_at    TIMESTAMPTZ,
    reversed_by    INTEGER       REFERENCES users(id),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    UNIQUE (transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_project_spending_project ON project_spending (project_id);
COMMENT ON TABLE project_spending IS
    'v1.85.0 — expenses recorded for a project while it is on its own (not inside an investment). The ledger entry is an ordinary expense; a reversal marks the row reversed and takes the amount off the project''s spending.';

-- ------------------------------------------------------------
-- 3. Ledger entries carry their project
-- ------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id);
CREATE INDEX IF NOT EXISTS idx_transactions_project ON transactions (project_id) WHERE project_id IS NOT NULL;
UPDATE transactions t
SET    project_id = f.project_id
FROM   investment_funding f
WHERE  f.transaction_id = t.id
AND    f.project_id IS NOT NULL
AND    t.project_id IS NULL;

-- ------------------------------------------------------------
-- 4. New document types (each CHECK re-created with the full list)
-- ------------------------------------------------------------
DO $$
DECLARE
    all_types TEXT := $t$'MEETING_MINUTES','MEETING_AGENDA','INVESTMENT_PROPOSAL',
        'FINANCIAL_REPORT_GENERAL','FINANCIAL_REPORT_INDIVIDUAL','RECEIPT','RESOLUTION','CONTRACT',
        'LOAN_AGREEMENT','GRANT_AGREEMENT','AUDITOR_FEEDBACK','AUDIT_REPORT','OTHER','SHARE_CERTIFICATE',
        'NOTICE_OF_MEETING','PROXY_FORM','ATTENDANCE_REGISTER','WRITTEN_RESOLUTION','CERTIFIED_RESOLUTION',
        'BOND_CERTIFICATE','PROJECT_PROPOSAL','PROJECT_REPORT'$t$;
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
-- 5. Default project category: Investment › Projects
-- ------------------------------------------------------------
INSERT INTO categories (parent_id, module, name, abbreviation, description, is_active)
SELECT NULL, 'INVESTMENT', 'Projects', 'PRJ', 'Projects — on their own or inside an investment (v1.85.0)', TRUE
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE module = 'INVESTMENT' AND parent_id IS NULL AND name = 'Projects');
INSERT INTO category_paths (category_id, full_path, full_abbreviation, depth)
SELECT c.id, c.name, c.abbreviation, 0
FROM   categories c
WHERE  c.module = 'INVESTMENT' AND c.parent_id IS NULL AND c.name = 'Projects'
ON CONFLICT (category_id) DO NOTHING;

COMMIT;
