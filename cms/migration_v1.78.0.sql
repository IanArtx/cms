-- ============================================================
-- MIGRATION v1.78.0 — Capital raising made easier to follow, goals
-- tied to investments, and documents connected to transactions
--
-- Requested directly:
--   "make the capital goal system more optimized and quick to access
--    on dashboards (company and individuals) and better navigation
--    through the page … make the names of the pledgers shown and also
--    have better informative statistics … secondary goals can be
--    tailored towards a proposed investments and money collected can
--    already be invested into that investment it is attached to …
--    transactions can be connected to a specific document at the point
--    of entry or later. a transaction can be connected to more than one
--    document and vice versa but after one, the system shows alert that
--    the transaction is already connected. documents should show
--    connected transactions and the other way round including count.
--    Connecting transactions shouldn't be mandatory. the transaction
--    connected shows the reference of the connected document(s) on the
--    printable version of the transaction"
-- Confirmed:
--   - Pledgers: every member sees names and amounts.
--   - Investment goals: the money goes through a selected operational
--     account (a normal transfer, with an exchange rate when the
--     currencies differ), then into the investment — never more than
--     the goal actually collected.
--   - The investment is an existing one or a new proposal made from
--     the goal form.
--   - At the point of entry: pick existing documents or upload a new one.
--
-- WHAT THIS ADDS (nothing existing is changed; no money moves):
--   1. capital_goals.investment_id — a SECONDARY goal can be tied to
--      one investment (existing or proposed).
--   2. transfers.capital_goal_id and investment_funding.capital_goal_id
--      — mark a transfer / an investment funding as made with a goal's
--      money, so the goal can show Collected → Moved → Invested →
--      Available, and the system can refuse to spend more than was
--      collected.
--   3. transaction_document_links — many-to-many links between
--      transactions and documents. Removing a link keeps its history
--      (removed_at / removed_by); a link can be added again later.
--
-- Safe to run more than once. Run it on BOTH databases.
-- ============================================================

BEGIN;

-- 1. Goal → investment ------------------------------------------------
ALTER TABLE capital_goals ADD COLUMN IF NOT EXISTS investment_id INTEGER REFERENCES investments(id);
CREATE INDEX IF NOT EXISTS idx_capital_goals_investment ON capital_goals (investment_id) WHERE investment_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capital_goals_investment_secondary_only') THEN
        ALTER TABLE capital_goals
            ADD CONSTRAINT capital_goals_investment_secondary_only
            CHECK (investment_id IS NULL OR goal_type = 'SECONDARY');
    END IF;
END $$;

-- 2. Goal money moved / invested ---------------------------------------
ALTER TABLE transfers          ADD COLUMN IF NOT EXISTS capital_goal_id INTEGER REFERENCES capital_goals(id);
ALTER TABLE investment_funding ADD COLUMN IF NOT EXISTS capital_goal_id INTEGER REFERENCES capital_goals(id);
CREATE INDEX IF NOT EXISTS idx_transfers_capital_goal          ON transfers (capital_goal_id)          WHERE capital_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_investment_funding_capital_goal ON investment_funding (capital_goal_id) WHERE capital_goal_id IS NOT NULL;

-- 3. Transactions ↔ documents -------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_document_links (
    id              SERIAL       PRIMARY KEY,
    transaction_id  INTEGER      NOT NULL REFERENCES transactions(id),
    document_id     INTEGER      NOT NULL REFERENCES documents(id),
    note            TEXT,
    linked_by       INTEGER      NOT NULL REFERENCES users(id),
    linked_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    linked_via      VARCHAR(20)  NOT NULL DEFAULT 'LATER'
                    CHECK (linked_via IN ('AT_ENTRY', 'LATER')),
    removed_at      TIMESTAMPTZ,
    removed_by      INTEGER      REFERENCES users(id)
);

-- One live link per pair (a removed link can be made again).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tx_doc_link_live
    ON transaction_document_links (transaction_id, document_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tx_doc_link_tx  ON transaction_document_links (transaction_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tx_doc_link_doc ON transaction_document_links (document_id)    WHERE removed_at IS NULL;

COMMIT;
