-- ============================================================
-- MIGRATION v1.90.0 — months closed and locked; the tax filing
-- confirmation; pledges pardoned; each contribution in one goal
--
-- Requested directly (13 Nov 2026):
--   "i would also like that the system can assist or produce an assisting
--    document showing the values to fill the tax fillings (provisional and
--    final) using the system entered data (all months have to be closed
--    and once the filling is done and the certification or confirmation
--    is uploaded and approved in the system there cannot be any other
--    alterations for those months)"
--   "I would also like that pledges can be pardoned with and without
--    leaving the penalties and if a person contributes outside pledges
--    (did not pledge but contributed), this section should show that
--    instead of recording them as pledged … the primary goal will also
--    record currently any money that entires the system as contributions
--    even that belonging to other goals instead of keeping all of them
--    seperate."
-- Confirmed (13 Nov 2026): the Treasurer closes months; the Admin may
-- reopen one, with a reason, only until a tax filing is approved; once a
-- Director approves the uploaded URA confirmation nobody can change those
-- months. A pledge is pardoned by the Treasurer or a Director with a
-- reason. Earlier contributions stay "without a pledge"; a pledge only
-- counts payments made after it; each contribution belongs to one goal.
--
-- What this adds:
--   1. accounting_periods / accounting_period_events — each month OPEN,
--      CLOSED or LOCKED, and the history of closing / reopening / locking.
--   2. cms_assert_period_open() and triggers on transactions,
--      currency_exchange_rates, fx_revaluation_runs, tax_at_source and
--      wht_withholdings: the DATABASE itself refuses any change to the
--      figures of a closed or locked month, whichever screen tries.
--   3. tax_years — the URA confirmation (uploaded document, who approved
--      it) and the date the months were locked.
--   4. capital_goal_pledges — pardoning (who, when, why, amount, whether
--      the penalties were waived too) and system-generated pledges marked.
--      fines — status WAIVED (who, when, why).
--   5. shareholder_contributions.capital_goal_id — the one goal a
--      contribution belongs to (filled in for the past where it is clear).
--
-- Nothing already recorded changes amount. Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Months
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_periods (
    period_month  DATE PRIMARY KEY CHECK (EXTRACT(DAY FROM period_month) = 1),  -- the 1st of the month
    status        VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),
    closed_by     INTEGER REFERENCES users(id),
    closed_at     TIMESTAMPTZ,
    close_note    TEXT,
    figures       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- totals of the month when it was closed
    locked_at     TIMESTAMPTZ,
    locked_by     INTEGER REFERENCES users(id),
    tax_year_id   INTEGER REFERENCES tax_years(id),      -- the tax filing that locked it
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE accounting_periods IS
    'v1.90.0 — one row per month that has been closed at least once. CLOSED: no entry dated in it can be added, changed or removed (reopen first — Admin, with a reason). LOCKED: closed for good after the tax filing confirmation for its year was approved.';

CREATE TABLE IF NOT EXISTS accounting_period_events (
    id            SERIAL PRIMARY KEY,
    period_month  DATE NOT NULL,
    action        VARCHAR(10) NOT NULL CHECK (action IN ('CLOSE', 'REOPEN', 'LOCK')),
    user_id       INTEGER REFERENCES users(id),
    at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason        TEXT,
    details       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_accounting_period_events_month ON accounting_period_events (period_month, at DESC);

-- ------------------------------------------------------------
-- 2. The database guard
--    SET LOCAL cms.period_guard = 'off' inside a transaction lets a
--    maintenance script through (never used by the application).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cms_assert_period_open(d DATE, what TEXT) RETURNS VOID AS $$
DECLARE st VARCHAR(10);
BEGIN
    IF d IS NULL OR COALESCE(current_setting('cms.period_guard', TRUE), 'on') = 'off' THEN RETURN; END IF;
    SELECT status INTO st FROM accounting_periods
     WHERE period_month = date_trunc('month', d)::date AND status IN ('CLOSED', 'LOCKED');
    IF st IS NOT NULL THEN
        RAISE EXCEPTION 'PERIOD_CLOSED|%|%|%', to_char(d, 'YYYY-MM'), st, what USING ERRCODE = 'P0001';
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Transactions: adding, removing or changing the figures of an entry dated
-- in a closed month. Bookkeeping columns (running balances, "reversed"
-- flag, notes columns) may still change.
CREATE OR REPLACE FUNCTION cms_guard_transactions() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM cms_assert_period_open(NEW.value_date, 'add an entry');
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM cms_assert_period_open(OLD.value_date, 'remove an entry');
        RETURN OLD;
    END IF;
    IF (NEW.value_date, NEW.amount, NEW.currency_id, NEW.account_id, NEW.transaction_type, NEW.inflow_type,
        NEW.category_id, NEW.status, NEW.functional_amount, NEW.functional_rate, NEW.tax_treatment,
        NEW.gl_override_account_code, NEW.investment_id, NEW.investment_cost_type, NEW.reversal_of, NEW.description)
       IS DISTINCT FROM
       (OLD.value_date, OLD.amount, OLD.currency_id, OLD.account_id, OLD.transaction_type, OLD.inflow_type,
        OLD.category_id, OLD.status, OLD.functional_amount, OLD.functional_rate, OLD.tax_treatment,
        OLD.gl_override_account_code, OLD.investment_id, OLD.investment_cost_type, OLD.reversal_of, OLD.description) THEN
        PERFORM cms_assert_period_open(OLD.value_date, 'change an entry');
        PERFORM cms_assert_period_open(NEW.value_date, 'move an entry');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_transactions_period ON transactions;
CREATE TRIGGER trg_guard_transactions_period BEFORE INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION cms_guard_transactions();

-- Exchange rates: a rate that applies to a date in a closed month cannot
-- be added, changed or removed (it would change that month's UGX values).
CREATE OR REPLACE FUNCTION cms_guard_exchange_rates() RETURNS TRIGGER AS $$
DECLARE last_closed DATE;
BEGIN
    IF COALESCE(current_setting('cms.period_guard', TRUE), 'on') = 'off' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT (MAX(period_month) + INTERVAL '1 month' - INTERVAL '1 day')::date INTO last_closed
      FROM accounting_periods WHERE status IN ('CLOSED', 'LOCKED');
    IF last_closed IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM cms_assert_period_open(NEW.effective_from::date, 'add an exchange rate');
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.effective_from::date <= last_closed THEN
            PERFORM cms_assert_period_open(LEAST(OLD.effective_from::date, last_closed), 'remove an exchange rate');
            RAISE EXCEPTION 'PERIOD_CLOSED|%|CLOSED|remove an exchange rate', to_char(last_closed, 'YYYY-MM') USING ERRCODE = 'P0001';
        END IF;
        RETURN OLD;
    END IF;
    IF (NEW.rate, NEW.base_currency_id, NEW.target_currency_id, NEW.effective_from)
       IS DISTINCT FROM (OLD.rate, OLD.base_currency_id, OLD.target_currency_id, OLD.effective_from)
       AND LEAST(OLD.effective_from, NEW.effective_from)::date <= last_closed THEN
        RAISE EXCEPTION 'PERIOD_CLOSED|%|CLOSED|change an exchange rate', to_char(last_closed, 'YYYY-MM') USING ERRCODE = 'P0001';
    END IF;
    IF NEW.effective_to IS DISTINCT FROM OLD.effective_to
       AND LEAST(COALESCE(OLD.effective_to, 'infinity'::date), COALESCE(NEW.effective_to, 'infinity'::date))::date <= last_closed THEN
        RAISE EXCEPTION 'PERIOD_CLOSED|%|CLOSED|change the dates of an exchange rate', to_char(last_closed, 'YYYY-MM') USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_exchange_rates_period ON currency_exchange_rates;
CREATE TRIGGER trg_guard_exchange_rates_period BEFORE INSERT OR UPDATE OR DELETE ON currency_exchange_rates
    FOR EACH ROW EXECUTE FUNCTION cms_guard_exchange_rates();

-- Month-end FX revaluations of a closed month stay as they are.
CREATE OR REPLACE FUNCTION cms_guard_fx_revaluation() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM cms_assert_period_open(OLD.period_end, 'undo a month-end revaluation');
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN PERFORM cms_assert_period_open(OLD.period_end, 'change a month-end revaluation'); END IF;
    PERFORM cms_assert_period_open(NEW.period_end, 'run a month-end revaluation');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_fx_revaluation_period ON fx_revaluation_runs;
CREATE TRIGGER trg_guard_fx_revaluation_period BEFORE INSERT OR UPDATE OR DELETE ON fx_revaluation_runs
    FOR EACH ROW EXECUTE FUNCTION cms_guard_fx_revaluation();

-- Tax deducted from the company (tax_at_source).
CREATE OR REPLACE FUNCTION cms_guard_tax_at_source() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN PERFORM cms_assert_period_open(NEW.deduction_date, 'record tax deducted'); RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN PERFORM cms_assert_period_open(OLD.deduction_date, 'remove tax deducted'); RETURN OLD; END IF;
    IF (NEW.deduction_date, NEW.treatment, NEW.gross_amount, NEW.tax_amount, NEW.currency_id, NEW.functional_rate,
        NEW.gross_functional, NEW.tax_functional, NEW.contra_gl_code, NEW.cash_leg)
       IS DISTINCT FROM
       (OLD.deduction_date, OLD.treatment, OLD.gross_amount, OLD.tax_amount, OLD.currency_id, OLD.functional_rate,
        OLD.gross_functional, OLD.tax_functional, OLD.contra_gl_code, OLD.cash_leg) THEN
        PERFORM cms_assert_period_open(OLD.deduction_date, 'change tax deducted');
        PERFORM cms_assert_period_open(NEW.deduction_date, 'move tax deducted');
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM cms_assert_period_open(COALESCE(NEW.reversed_at::date, CURRENT_DATE), 'reverse tax deducted');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_tax_at_source_period ON tax_at_source;
CREATE TRIGGER trg_guard_tax_at_source_period BEFORE INSERT OR UPDATE OR DELETE ON tax_at_source
    FOR EACH ROW EXECUTE FUNCTION cms_guard_tax_at_source();

-- Tax the company withheld (wht_withholdings).
CREATE OR REPLACE FUNCTION cms_guard_wht() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT NEW.is_shadow THEN PERFORM cms_assert_period_open(NEW.withholding_date, 'record tax withheld'); END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF NOT OLD.is_shadow THEN PERFORM cms_assert_period_open(OLD.withholding_date, 'remove tax withheld'); END IF;
        RETURN OLD;
    END IF;
    IF (NEW.withholding_date, NEW.gross_amount, NEW.tax_amount, NEW.currency_id, NEW.functional_rate, NEW.tax_functional,
        NEW.debit_gl_code, NEW.is_shadow)
       IS DISTINCT FROM
       (OLD.withholding_date, OLD.gross_amount, OLD.tax_amount, OLD.currency_id, OLD.functional_rate, OLD.tax_functional,
        OLD.debit_gl_code, OLD.is_shadow) AND NOT (OLD.is_shadow AND NEW.is_shadow) THEN
        PERFORM cms_assert_period_open(OLD.withholding_date, 'change tax withheld');
        PERFORM cms_assert_period_open(NEW.withholding_date, 'move tax withheld');
    END IF;
    IF NEW.status = 'REVERSED' AND OLD.status IS DISTINCT FROM 'REVERSED' AND NOT NEW.is_shadow THEN
        PERFORM cms_assert_period_open(COALESCE(NEW.reversal_date, CURRENT_DATE), 'reverse tax withheld');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_guard_wht_period ON wht_withholdings;
CREATE TRIGGER trg_guard_wht_period BEFORE INSERT OR UPDATE OR DELETE ON wht_withholdings
    FOR EACH ROW EXECUTE FUNCTION cms_guard_wht();

-- ------------------------------------------------------------
-- 3. The URA confirmation of a filed return
-- ------------------------------------------------------------
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS confirmation_document_id INTEGER REFERENCES documents(id);
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS confirmation_uploaded_by INTEGER REFERENCES users(id);
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS confirmation_uploaded_at TIMESTAMPTZ;
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS confirmation_approved_by INTEGER REFERENCES users(id);
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS confirmation_approved_at TIMESTAMPTZ;
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS months_locked_at TIMESTAMPTZ;
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS provisional_return_reference VARCHAR(100);
ALTER TABLE tax_years ADD COLUMN IF NOT EXISTS provisional_filed_on DATE;
COMMENT ON COLUMN tax_years.confirmation_document_id IS
    'v1.90.0 — the URA acknowledgement / confirmation of the filed return (uploaded). When a Director approves it, every month of the year is LOCKED.';

-- ------------------------------------------------------------
-- 4. Pardoned pledges, waived fines, system-generated pledges
-- ------------------------------------------------------------
ALTER TABLE capital_goal_pledges ADD COLUMN IF NOT EXISTS is_system_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE capital_goal_pledges ADD COLUMN IF NOT EXISTS pardoned_at TIMESTAMPTZ;
ALTER TABLE capital_goal_pledges ADD COLUMN IF NOT EXISTS pardoned_by INTEGER REFERENCES users(id);
ALTER TABLE capital_goal_pledges ADD COLUMN IF NOT EXISTS pardon_reason TEXT;
ALTER TABLE capital_goal_pledges ADD COLUMN IF NOT EXISTS pardoned_amount NUMERIC(20, 4);
ALTER TABLE capital_goal_pledges ADD COLUMN IF NOT EXISTS pardon_waived_penalties BOOLEAN;
ALTER TABLE capital_goal_pledges DROP CONSTRAINT IF EXISTS capital_goal_pledges_status_check;
ALTER TABLE capital_goal_pledges ADD CONSTRAINT capital_goal_pledges_status_check
    CHECK (status IN ('PENDING', 'PARTIAL', 'FULFILLED', 'REJECTED', 'PARDONED'));
COMMENT ON COLUMN capital_goal_pledges.is_system_generated IS
    'v1.90.0 — a pledge the system created by itself from a contribution made without a pledge (before v1.90.0). Shown as "without a pledge"; no new ones are created.';

-- The pledges the system made up from a direct contribution (their audit
-- line says so).
UPDATE capital_goal_pledges p SET is_system_generated = TRUE
FROM   references_registry rr
WHERE  rr.id = p.reference_id AND p.is_system_generated = FALSE
AND    EXISTS (SELECT 1 FROM audit_log a
               WHERE a.description = 'System-generated pledge from a direct contribution: ' || rr.reference_code
                  OR a.description LIKE 'System-generated pledge from a direct contribution: ' || rr.reference_code || ' (%');

ALTER TABLE fines ADD COLUMN IF NOT EXISTS waived_at TIMESTAMPTZ;
ALTER TABLE fines ADD COLUMN IF NOT EXISTS waived_by INTEGER REFERENCES users(id);
ALTER TABLE fines ADD COLUMN IF NOT EXISTS waive_reason TEXT;
ALTER TABLE fines DROP CONSTRAINT IF EXISTS fines_status_check;
ALTER TABLE fines ADD CONSTRAINT fines_status_check CHECK (status IN ('OUTSTANDING', 'PAID', 'WAIVED'));

-- ------------------------------------------------------------
-- 5. The one goal a contribution belongs to
-- ------------------------------------------------------------
ALTER TABLE shareholder_contributions ADD COLUMN IF NOT EXISTS capital_goal_id INTEGER REFERENCES capital_goals(id);
ALTER TABLE shareholder_contributions ADD COLUMN IF NOT EXISTS goal_assigned_by INTEGER REFERENCES users(id);
ALTER TABLE shareholder_contributions ADD COLUMN IF NOT EXISTS goal_assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_shareholder_contributions_goal ON shareholder_contributions (capital_goal_id);
COMMENT ON COLUMN shareholder_contributions.capital_goal_id IS
    'v1.90.0 — the one capital goal this contribution counts towards (NULL = not in any goal). A goal counts only its own contributions.';

-- (a) paid against a pledge → that pledge's goal
UPDATE shareholder_contributions sc SET capital_goal_id = mc.capital_goal_id
FROM   capital_goal_pledge_payments pp
JOIN   capital_goal_pledges p ON p.id = pp.pledge_id
JOIN   capital_goal_monthly_calls mc ON mc.id = p.monthly_call_id
WHERE  pp.shareholder_contribution_id = sc.id AND sc.capital_goal_id IS NULL;

-- (b) otherwise: the only goal whose dates cover the contribution (any
--     goal that is not cancelled); where two or more goals overlap, the
--     contribution is left for the Treasurer to assign.
UPDATE shareholder_contributions sc SET capital_goal_id = g.id
FROM   capital_goals g
WHERE  sc.capital_goal_id IS NULL AND sc.status = 'APPROVED'
AND    g.status <> 'CANCELLED' AND sc.contribution_date BETWEEN g.start_date AND g.end_date
AND    (g.goal_type IS NOT NULL OR g.currency_id = sc.currency_id)
AND    (SELECT COUNT(*) FROM capital_goals g2
         WHERE g2.status <> 'CANCELLED' AND sc.contribution_date BETWEEN g2.start_date AND g2.end_date
         AND (g2.goal_type IS NOT NULL OR g2.currency_id = sc.currency_id)) = 1;

COMMIT;
