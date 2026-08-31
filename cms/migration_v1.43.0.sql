-- ============================================================
-- MIGRATION v1.43.0 — Capital Goal Calls ("call on shares")
--
-- Requested directly: a Treasurer sets one yearly PRIMARY capital
-- goal (plus any number of SECONDARY goals) which the system splits
-- into equal monthly installments automatically. Each month opens as
-- its own pledge round: shareholders enter what they want to
-- contribute (a suggested equal-split baseline is shown, but they can
-- enter less, more, zero, or exactly that). A Treasurer approving a
-- pledge IS the moment the money is recorded — same "approval =
-- posting" pattern Requisitions/Fines already use — which immediately
-- issues shares exactly like an ordinary contribution. Late
-- settlement of an iteration-1 pledge earns an automatic fine (5%
-- within 7 days of the deadline, 10% after), computed once, only at
-- the moment that late piece is actually settled, and only on the
-- unpaid portion — never guessed at, never applied to iteration 2.
--
-- If a month's own target isn't fully met by its deadline, iteration
-- 2 opens automatically for 7 more days, offered only to shareholders
-- who pledged ABOVE the baseline in iteration 1 (their surplus
-- willingness) — no fines ever apply in iteration 2. Any leftover
-- shortfall keeps rolling forward, stacked onto every subsequent
-- month's iteration 2, until it's actually covered.
--
-- This entirely replaces how NEW capital goals are created going
-- forward — existing capital_goals rows are untouched, historical,
-- legacy records (goal_type/fiscal_year stay NULL for them).
--
-- See docs/CMS_BIBLE.md (Capital Goal Calls section) for the full
-- design writeup and every calculation this drives.
-- ============================================================

BEGIN;

-- --------------------------------------------------------------
-- 1. Extend capital_goals — new goals are PRIMARY/SECONDARY, tied to
--    a fiscal year, with a configurable monthly call deadline day.
--    NULL on every existing row (legacy, free-form goals, untouched).
-- --------------------------------------------------------------
ALTER TABLE capital_goals ADD COLUMN IF NOT EXISTS goal_type VARCHAR(20);
ALTER TABLE capital_goals ADD COLUMN IF NOT EXISTS fiscal_year INTEGER;
ALTER TABLE capital_goals ADD COLUMN IF NOT EXISTS call_deadline_day SMALLINT;

DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'capital_goals'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%goal_type%';
    IF con_name IS NULL THEN
        ALTER TABLE capital_goals ADD CONSTRAINT capital_goals_goal_type_check
            CHECK (goal_type IS NULL OR goal_type IN ('PRIMARY', 'SECONDARY'));
    END IF;

    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'capital_goals'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%call_deadline_day%';
    IF con_name IS NULL THEN
        ALTER TABLE capital_goals ADD CONSTRAINT capital_goals_call_deadline_day_check
            CHECK (call_deadline_day IS NULL OR (call_deadline_day BETWEEN 1 AND 28));
    END IF;
END $$;

-- Exactly one PRIMARY goal per fiscal year (partial index — legacy
-- rows with goal_type NULL are entirely unaffected). Same technique
-- already used for "one active treasury stamp per document type"
-- (v1.24.0, Section 4.30).
CREATE UNIQUE INDEX IF NOT EXISTS one_primary_capital_goal_per_year
    ON capital_goals (fiscal_year) WHERE goal_type = 'PRIMARY';

-- --------------------------------------------------------------
-- 2. One row per calendar month a goal covers — the actual, fixed
--    pledge round shareholders interact with (never the yearly goal
--    directly). Pre-generated in full at goal-creation time, since a
--    goal's own duration is short (rarely more than ~12-24 rows).
-- --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_goal_monthly_calls (
    id                SERIAL PRIMARY KEY,
    capital_goal_id   INTEGER       NOT NULL REFERENCES capital_goals(id),
    period            CHAR(7)       NOT NULL,  -- 'YYYY-MM'
    monthly_target    NUMERIC(20,4) NOT NULL,  -- goal.target_amount / total_months, fixed at generation
    iteration1_deadline DATE        NOT NULL,
    iteration2_deadline DATE,                  -- set only once iteration 2 actually opens
    status            VARCHAR(20)   NOT NULL DEFAULT 'ITERATION_1'
                      CHECK (status IN ('ITERATION_1', 'ITERATION_2', 'CLOSED')),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_monthly_target CHECK (monthly_target > 0),
    CONSTRAINT unique_goal_period UNIQUE (capital_goal_id, period)
);

CREATE INDEX IF NOT EXISTS idx_capital_goal_monthly_calls_goal   ON capital_goal_monthly_calls (capital_goal_id);
CREATE INDEX IF NOT EXISTS idx_capital_goal_monthly_calls_status ON capital_goal_monthly_calls (status);

-- --------------------------------------------------------------
-- 3. One row per shareholder per monthly call per iteration — the
--    pledge itself. amount_settled is a running total (in the
--    pledge's OWN currency) of everything approved against it so
--    far, since a pledge can be settled across more than one
--    payment/tranche.
-- --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_goal_pledges (
    id                     SERIAL PRIMARY KEY,
    reference_id           INTEGER       NOT NULL REFERENCES references_registry(id),
    monthly_call_id        INTEGER       NOT NULL REFERENCES capital_goal_monthly_calls(id),
    user_id                INTEGER       NOT NULL REFERENCES users(id),
    iteration              SMALLINT      NOT NULL CHECK (iteration IN (1, 2)),
    currency_id            INTEGER       NOT NULL REFERENCES currencies(id),
    pledged_amount         NUMERIC(20,4) NOT NULL CHECK (pledged_amount >= 0),
    baseline_amount_snapshot NUMERIC(20,4) NOT NULL, -- the suggested equal-split shown at entry time
    status                 VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'PARTIAL', 'FULFILLED', 'REJECTED')),
    amount_settled         NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (amount_settled >= 0),
    submitted_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    reviewed_by            INTEGER REFERENCES users(id),
    reviewed_at            TIMESTAMPTZ,
    review_notes           TEXT,
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_pledge_per_iteration UNIQUE (monthly_call_id, user_id, iteration),
    CONSTRAINT settled_not_over_pledged CHECK (amount_settled <= pledged_amount)
);

CREATE INDEX IF NOT EXISTS idx_capital_goal_pledges_call   ON capital_goal_pledges (monthly_call_id);
CREATE INDEX IF NOT EXISTS idx_capital_goal_pledges_user   ON capital_goal_pledges (user_id);
CREATE INDEX IF NOT EXISTS idx_capital_goal_pledges_status ON capital_goal_pledges (status);

-- --------------------------------------------------------------
-- 4. One row per approved/settled tranche against a pledge — a
--    pledge can be paid in more than one piece, each with its own
--    date (so lateness, and any fine, is judged per piece, never on
--    the pledge as a whole). Every tranche always issues real shares
--    via the same shareholder_contributions core every other
--    contribution uses.
-- --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_goal_pledge_payments (
    id                             SERIAL PRIMARY KEY,
    pledge_id                      INTEGER       NOT NULL REFERENCES capital_goal_pledges(id),
    amount                         NUMERIC(20,4) NOT NULL CHECK (amount > 0), -- in the pledge's own currency
    account_id                     INTEGER       NOT NULL REFERENCES accounts(id),
    transaction_id                 INTEGER       NOT NULL REFERENCES transactions(id),
    shareholder_contribution_id    INTEGER       NOT NULL REFERENCES shareholder_contributions(id),
    converted_amount_goal_currency NUMERIC(20,4) NOT NULL, -- frozen conversion into the capital goal's own currency, for progress tracking
    exchange_rate_to_goal_currency NUMERIC(20,8) NOT NULL,
    is_late                        BOOLEAN       NOT NULL DEFAULT FALSE,
    days_late                      INTEGER,
    fine_id                        INTEGER REFERENCES fines(id), -- only ever set for a late ITERATION 1 tranche
    approved_by                    INTEGER       NOT NULL REFERENCES users(id),
    approved_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    notes                          TEXT
);

CREATE INDEX IF NOT EXISTS idx_capital_goal_pledge_payments_pledge ON capital_goal_pledge_payments (pledge_id);

-- --------------------------------------------------------------
-- 5. Which monthly call(s) one payment actually counted toward — an
--    iteration-1 payment always produces exactly one row (its own
--    month); an iteration-2 payment can span several months, applied
--    oldest-unpaid-period-first (identical pattern to
--    side_fund_payment_applications, v1.41.0). This is what lets
--    "how much has period P actually collected" always be a simple
--    SUM over this table, regardless of which month's iteration 2 a
--    backlog-covering payment actually came through.
-- --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_goal_payment_applications (
    id              SERIAL PRIMARY KEY,
    payment_id      INTEGER       NOT NULL REFERENCES capital_goal_pledge_payments(id),
    monthly_call_id INTEGER       NOT NULL REFERENCES capital_goal_monthly_calls(id),
    amount          NUMERIC(20,4) NOT NULL CHECK (amount > 0) -- always in the capital goal's own currency
);

CREATE INDEX IF NOT EXISTS idx_capital_goal_payment_applications_payment ON capital_goal_payment_applications (payment_id);
CREATE INDEX IF NOT EXISTS idx_capital_goal_payment_applications_call   ON capital_goal_payment_applications (monthly_call_id);

COMMIT;
