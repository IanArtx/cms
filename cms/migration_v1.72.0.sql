-- ============================================================
-- MIGRATION v1.72.0 — Reversals that unwind investment & money market
-- fund records, repair of past reversals, second-person approval of
-- reversals, and the "four eyes" rule on every approval.
--
-- Requested directly:
--   "reversals for money that went to investments (MMF particularly
--    confirmed) goes back to primary account but is never deducted
--    from the investment. this should be addressed and also reconcile
--    past / historical transactions"
--   "I would like that activities can't be both created and at the
--    same time approved by the same person (exception to the admin)"
-- Confirmed decisions:
--   1. Investments + MMF are fixed now; reversals of entries belonging
--      to modules not yet unwound (loans, grants, transfers, service
--      fees, pledges, fines, savings conversions, tax payments …) are
--      refused with a message until each module is done.
--   2. Past mismatches are corrected automatically by this migration
--      and every change is logged in record_corrections (shown on the
--      Records check page).
--   3. A reversal that would push a fund below zero, or touches a
--      closed fund / investment, is refused.
--   4. Every approval step refuses the person who created (or benefits
--      from) the item — an Admin may approve their own. Reversals
--      become requests that a second person approves.
--
-- The LEDGER was never wrong: the Trial Balance / Balance Sheet are
-- worked out from the transactions themselves, reversals included.
-- Only the figures stored on the fund / investment records drifted.
-- This migration moves no money and posts no ledger entries.
--
-- Safe to run once. Run BEFORE starting the v1.72.0 backend.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Reversal requests (second-person approval)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reversal_requests (
    id                       SERIAL PRIMARY KEY,
    transaction_id           INTEGER      NOT NULL REFERENCES transactions(id),
    reason                   TEXT         NOT NULL,
    status                   VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    -- What the rehearsal said would happen ("2 linked entries …; MMF
    -- balance reduced by …"), shown to the approver.
    effect_summary           TEXT,
    linked_count             INTEGER      NOT NULL DEFAULT 1,
    requested_by             INTEGER      NOT NULL REFERENCES users(id),
    requested_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    decided_by               INTEGER      REFERENCES users(id),
    decided_at               TIMESTAMPTZ,
    decision_note            TEXT,
    reversal_transaction_id  INTEGER      REFERENCES transactions(id)
);
-- Only one open request per transaction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reversal_requests_pending
    ON reversal_requests (transaction_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_reversal_requests_status ON reversal_requests (status, requested_at DESC);

-- ------------------------------------------------------------
-- 2. "Reversed" markers on the sub-ledger rows
-- ------------------------------------------------------------
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE mmf_transactions        ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE investment_funding      ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE investment_returns      ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS reversed_by INTEGER REFERENCES users(id);
ALTER TABLE investment_transactions ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id);

-- ------------------------------------------------------------
-- 3. Log of every automatic correction (Reports › Records check)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS record_corrections (
    id            SERIAL PRIMARY KEY,
    run_label     VARCHAR(40)  NOT NULL,           -- e.g. 'v1.72.0 migration'
    record_type   VARCHAR(40)  NOT NULL,           -- mmf_accounts / investments / bond_coupons
    record_id     INTEGER      NOT NULL,
    record_name   TEXT,
    field_name    VARCHAR(60),
    old_value     TEXT,
    new_value     TEXT,
    note          TEXT,
    needs_attention BOOLEAN    NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 4. REPAIR PAST REVERSALS
-- ------------------------------------------------------------
-- 4a. Mark sub-ledger rows whose ledger entry was reversed. Remember
--     exactly which rows this run marked (only those are corrected).
CREATE TEMP TABLE v172_marked (tbl TEXT, row_id INTEGER, tx_id INTEGER) ON COMMIT DROP;

WITH m AS (
    UPDATE mmf_transactions x
    SET    is_reversed = TRUE, reversed_at = rv.posted_at, reversed_by = rv.created_by, reversal_transaction_id = rv.id
    FROM   transactions t
    JOIN   transactions rv ON rv.reversal_of = t.id AND rv.is_reversal = TRUE
    WHERE  x.transaction_id = t.id AND t.is_reversed = TRUE AND x.is_reversed = FALSE
    RETURNING x.id, x.transaction_id
) INSERT INTO v172_marked SELECT 'mmf_transactions', id, transaction_id FROM m;

WITH m AS (
    UPDATE investment_funding x
    SET    is_reversed = TRUE, reversed_at = rv.posted_at, reversed_by = rv.created_by, reversal_transaction_id = rv.id
    FROM   transactions t
    JOIN   transactions rv ON rv.reversal_of = t.id AND rv.is_reversal = TRUE
    WHERE  x.transaction_id = t.id AND t.is_reversed = TRUE AND x.is_reversed = FALSE
    RETURNING x.id, x.transaction_id
) INSERT INTO v172_marked SELECT 'investment_funding', id, transaction_id FROM m;

WITH m AS (
    UPDATE investment_returns x
    SET    is_reversed = TRUE, reversed_at = rv.posted_at, reversed_by = rv.created_by, reversal_transaction_id = rv.id
    FROM   transactions t
    JOIN   transactions rv ON rv.reversal_of = t.id AND rv.is_reversal = TRUE
    WHERE  x.transaction_id = t.id AND t.is_reversed = TRUE AND x.is_reversed = FALSE
    RETURNING x.id, x.transaction_id
) INSERT INTO v172_marked SELECT 'investment_returns', id, transaction_id FROM m;

WITH m AS (
    UPDATE investment_transactions x
    SET    is_reversed = TRUE, reversed_at = rv.posted_at, reversed_by = rv.created_by, reversal_transaction_id = rv.id
    FROM   transactions t
    JOIN   transactions rv ON rv.reversal_of = t.id AND rv.is_reversal = TRUE
    WHERE  x.transaction_id = t.id AND t.is_reversed = TRUE AND x.is_reversed = FALSE
    RETURNING x.id, x.transaction_id
) INSERT INTO v172_marked SELECT 'investment_transactions', id, transaction_id FROM m;

-- 4b. Money market funds touched by a reversed top-up / withdrawal:
--     rebuild their five stored figures from the entries that still
--     stand (the same arithmetic the fund pages have always used).
DO $$
DECLARE
    f RECORD;
    n RECORD;
BEGIN
    FOR f IN
        SELECT DISTINCT m.*
        FROM   mmf_accounts m
        JOIN   mmf_transactions mt ON mt.mmf_account_id = m.id
        JOIN   v172_marked k ON k.tbl = 'mmf_transactions' AND k.row_id = mt.id
    LOOP
        SELECT
            COALESCE(SUM(CASE WHEN entry_type = 'TOPUP' THEN amount END), 0)          AS topups,
            COALESCE(SUM(CASE WHEN entry_type = 'WITHDRAWAL' THEN amount END), 0)     AS withdrawals,
            COALESCE(SUM(CASE WHEN entry_type = 'INTEREST' THEN amount END), 0)       AS interest,
            COALESCE(SUM(CASE WHEN entry_type = 'MANAGEMENT_FEE' THEN amount END), 0) AS fees
        INTO n
        FROM mmf_transactions WHERE mmf_account_id = f.id AND is_reversed = FALSE;

        IF f.current_balance <> n.topups + n.interest - n.withdrawals - n.fees THEN
            INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note, needs_attention)
            VALUES ('v1.72.0 migration', 'mmf_accounts', f.id, f.name, 'current_balance', f.current_balance::text,
                    (n.topups + n.interest - n.withdrawals - n.fees)::text,
                    'Reversed top-up / withdrawal taken out of the fund balance',
                    (n.topups + n.interest - n.withdrawals - n.fees) < 0 OR f.status <> 'ACTIVE');
        END IF;
        IF f.total_principal_in <> n.topups THEN
            INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note)
            VALUES ('v1.72.0 migration', 'mmf_accounts', f.id, f.name, 'total_principal_in', f.total_principal_in::text, n.topups::text,
                    'Reversed top-ups no longer counted as money put in');
        END IF;
        IF f.total_withdrawn <> n.withdrawals THEN
            INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note)
            VALUES ('v1.72.0 migration', 'mmf_accounts', f.id, f.name, 'total_withdrawn', f.total_withdrawn::text, n.withdrawals::text,
                    'Reversed withdrawals no longer counted');
        END IF;

        UPDATE mmf_accounts
        SET    current_balance       = n.topups + n.interest - n.withdrawals - n.fees,
               total_principal_in    = n.topups,
               total_withdrawn       = n.withdrawals,
               total_interest        = n.interest,
               total_management_fees = n.fees
        WHERE  id = f.id;
    END LOOP;
END $$;

-- 4c. Investments: take back out exactly what each reversed record had
--     added (same rules as src/services/reversalLinksService.js).
DO $$
DECLARE
    inv RECORD;
    spend_back NUMERIC;
    returns_back NUMERIC;
    new_spend NUMERIC;
    new_sup NUMERIC;
    planned NUMERIC;
    c RECORD;
    note_text TEXT;
BEGIN
    FOR inv IN
        SELECT DISTINCT i.*
        FROM   investments i
        WHERE  EXISTS (SELECT 1 FROM investment_funding x JOIN v172_marked k ON k.tbl = 'investment_funding' AND k.row_id = x.id WHERE x.investment_id = i.id)
            OR EXISTS (SELECT 1 FROM investment_returns x JOIN v172_marked k ON k.tbl = 'investment_returns' AND k.row_id = x.id WHERE x.investment_id = i.id)
            OR EXISTS (SELECT 1 FROM investment_transactions x JOIN v172_marked k ON k.tbl = 'investment_transactions' AND k.row_id = x.id WHERE x.investment_id = i.id)
    LOOP
        -- Spend: funding + EXPENSE + TAX (except tax legs of a manual
        -- return or a treasury-bill maturity, which never counted).
        SELECT COALESCE(SUM(x.amount), 0) INTO spend_back
        FROM   investment_funding x JOIN v172_marked k ON k.tbl = 'investment_funding' AND k.row_id = x.id
        WHERE  x.investment_id = inv.id;

        spend_back := spend_back + COALESCE((
            SELECT SUM(x.amount)
            FROM   investment_transactions x
            JOIN   v172_marked k ON k.tbl = 'investment_transactions' AND k.row_id = x.id
            WHERE  x.investment_id = inv.id
            AND    (x.entry_type = 'EXPENSE'
                    OR (x.entry_type = 'TAX' AND NOT EXISTS (
                        SELECT 1 FROM tax_at_source s
                        WHERE  s.tax_transaction_id = x.transaction_id
                        AND    s.source_type IN ('INVESTMENT_RETURN', 'TREASURY_BILL'))))
        ), 0);

        -- Returns: the face value paid with a final coupon never counted;
        -- a treasury bill's maturity counted only its discount.
        SELECT COALESCE(SUM(
            CASE
                WHEN x.return_type = 'PRINCIPAL' AND inv.investment_type = 'BOND'
                     AND x.notes LIKE '%alongside final coupon #%' THEN 0
                WHEN x.return_type = 'PRINCIPAL' AND inv.investment_type = 'TREASURY_BILL'
                     THEN GREATEST(0, x.amount - COALESCE(inv.settlement_value, 0))
                ELSE x.amount
            END), 0) INTO returns_back
        FROM   investment_returns x JOIN v172_marked k ON k.tbl = 'investment_returns' AND k.row_id = x.id
        WHERE  x.investment_id = inv.id;

        planned   := COALESCE(inv.planned_budget, 0);
        new_spend := inv.actual_expenditure - spend_back;
        new_sup   := GREATEST(0, inv.supplementary_budget
                       + (GREATEST(0, new_spend - planned) - GREATEST(0, inv.actual_expenditure - planned)));

        IF spend_back <> 0 THEN
            INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note, needs_attention)
            VALUES ('v1.72.0 migration', 'investments', inv.id, inv.name, 'actual_expenditure',
                    inv.actual_expenditure::text, new_spend::text,
                    'Reversed funding / expenses / tax taken back out of "Spent"', new_spend < 0);
            IF new_sup <> inv.supplementary_budget THEN
                INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note)
                VALUES ('v1.72.0 migration', 'investments', inv.id, inv.name, 'supplementary_budget',
                        inv.supplementary_budget::text, new_sup::text, 'Recalculated with the corrected spend');
            END IF;
        END IF;
        IF returns_back <> 0 THEN
            INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note, needs_attention)
            VALUES ('v1.72.0 migration', 'investments', inv.id, inv.name, 'total_returns',
                    inv.total_returns::text, (inv.total_returns - returns_back)::text,
                    'Reversed returns no longer counted', (inv.total_returns - returns_back) < 0);
        END IF;

        UPDATE investments
        SET    actual_expenditure   = new_spend,
               supplementary_budget = new_sup,
               total_returns        = total_returns - returns_back
        WHERE  id = inv.id;

        -- Project spend follows its reversed funding.
        UPDATE projects p
        SET    actual_expenditure = GREATEST(0, p.actual_expenditure - s.amt)
        FROM  (SELECT x.project_id, SUM(x.amount) AS amt
               FROM investment_funding x JOIN v172_marked k ON k.tbl = 'investment_funding' AND k.row_id = x.id
               WHERE x.investment_id = inv.id AND x.project_id IS NOT NULL
               GROUP BY x.project_id) s
        WHERE  p.id = s.project_id;
    END LOOP;

    -- Coupons whose interest was reversed are unpaid again.
    FOR c IN
        SELECT bc.id, bc.coupon_number, i.id AS inv_id, i.name AS inv_name, ir.transaction_id AS income_tx
        FROM   bond_coupons bc
        JOIN   investment_returns ir ON ir.id = bc.investment_return_id
        JOIN   v172_marked k ON k.tbl = 'investment_returns' AND k.row_id = ir.id
        JOIN   investments i ON i.id = bc.investment_id
    LOOP
        UPDATE bond_coupons
        SET    status = 'PENDING', investment_return_id = NULL, paid_at = NULL,
               actual_gross_amount = NULL, actual_tax_amount = NULL, actual_net_amount = NULL,
               adjusted_by = NULL, adjusted_at = NULL
        WHERE  id = c.id;
        INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note)
        VALUES ('v1.72.0 migration', 'bond_coupons', c.id, c.inv_name || ' — coupon #' || c.coupon_number,
                'status', 'PAID', 'PENDING', 'Its interest entry had been reversed');
    END LOOP;

    -- Investments completed by a maturity whose money was reversed.
    FOR c IN
        SELECT DISTINCT i.id, i.name
        FROM   investments i
        JOIN   investment_returns ir ON ir.investment_id = i.id AND ir.return_type = 'PRINCIPAL'
        JOIN   v172_marked k ON k.tbl = 'investment_returns' AND k.row_id = ir.id
        WHERE  i.status = 'COMPLETED'
        AND    NOT EXISTS (SELECT 1 FROM investment_returns o
                           WHERE o.investment_id = i.id AND o.return_type = 'PRINCIPAL' AND o.is_reversed = FALSE)
    LOOP
        UPDATE investments SET status = 'ACTIVE', actual_end_date = NULL WHERE id = c.id;
        INSERT INTO record_corrections (run_label, record_type, record_id, record_name, field_name, old_value, new_value, note)
        VALUES ('v1.72.0 migration', 'investments', c.id, c.name, 'status', 'COMPLETED', 'ACTIVE',
                'Its maturity (face value repaid) had been reversed');
    END LOOP;

    -- Half-reversed events: the income was reversed but its tax entry
    -- (or the other way round) still stands. Flagged, not guessed at.
    FOR c IN
        SELECT s.id, s.investment_id, i.name, s.income_transaction_id, s.tax_transaction_id,
               ti.is_reversed AS income_rev, tt.is_reversed AS tax_rev
        FROM   tax_at_source s
        JOIN   investments i ON i.id = s.investment_id
        JOIN   transactions ti ON ti.id = s.income_transaction_id
        JOIN   transactions tt ON tt.id = s.tax_transaction_id
        WHERE  ti.is_reversed <> tt.is_reversed
    LOOP
        note_text := CASE WHEN c.income_rev
                     THEN 'The income entry (transaction #' || c.income_transaction_id || ') was reversed but its tax entry (#' || c.tax_transaction_id || ') still stands — reverse the tax entry too.'
                     ELSE 'The tax entry (transaction #' || c.tax_transaction_id || ') was reversed but its income entry (#' || c.income_transaction_id || ') still stands — check which is right.'
                END;
        -- Running this file again must not list the same flag twice.
        IF NOT EXISTS (SELECT 1 FROM record_corrections
                       WHERE needs_attention AND record_type = 'investments'
                         AND record_id = c.investment_id AND note = note_text) THEN
            INSERT INTO record_corrections (run_label, record_type, record_id, record_name, note, needs_attention)
            VALUES ('v1.72.0 migration', 'investments', c.investment_id, c.name, note_text, TRUE);
        END IF;
    END LOOP;
END $$;

COMMIT;

-- After running, see what was corrected:
--   SELECT * FROM record_corrections ORDER BY id;
-- (also shown in the app: Reports & ledger › Records check)
