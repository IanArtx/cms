-- ============================================================
-- MIGRATION v1.29.0 — Capital Goals (Section 4.33)
--
-- Adds a new capital_goals table so a Treasurer/Director can set a
-- target amount of shareholder capital to raise over a date range
-- (e.g. EUR 100,000 from Jan 2026 to Dec 2026). Nothing is posted
-- anywhere by this feature — a goal never moves money or touches any
-- account balance; it only measures actual shareholder_contributions
-- against an auto-computed even monthly distribution of the target.
-- New permissions CAPITAL_GOAL_VIEW/CAPITAL_GOAL_MANAGE (ungranted by
-- default, per this system's standard role_permissions convention —
-- an Admin must grant them via Settings > Roles & Permissions).
--
-- Mirrors schema.sql's GROUP 25 exactly. Safe to run once; CREATE
-- TABLE/INDEX will error harmlessly if already applied (same as every
-- other migration in this repo — this is the first-time application
-- of this table, not a repeatable idempotent patch).
-- ============================================================

BEGIN;

CREATE TABLE capital_goals (
    id             SERIAL PRIMARY KEY,
    reference_id   INTEGER       NOT NULL REFERENCES references_registry(id),
    title          VARCHAR(255)  NOT NULL,
    description    TEXT,
    target_amount  NUMERIC(20,4) NOT NULL,
    currency_id    INTEGER       NOT NULL REFERENCES currencies(id),
    start_date     DATE          NOT NULL,
    end_date       DATE          NOT NULL,
    status         VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by     INTEGER       NOT NULL REFERENCES users(id),
    updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT positive_goal_target CHECK (target_amount > 0),
    CONSTRAINT valid_goal_range CHECK (end_date >= start_date)
);

CREATE INDEX idx_capital_goals_status ON capital_goals (status);

INSERT INTO permissions (code, module, description) VALUES
    ('CAPITAL_GOAL_VIEW',   'FINANCE', 'View capital fundraising goals and their progress'),
    ('CAPITAL_GOAL_MANAGE', 'FINANCE', 'Create, edit, and cancel capital fundraising goals')
ON CONFLICT (code) DO NOTHING;

COMMIT;
