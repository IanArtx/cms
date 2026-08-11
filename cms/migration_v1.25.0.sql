-- ============================================================
-- MIGRATION v1.25.0 — SIDE FUND: PER-MEMBER AMOUNTS & OVERPAYMENT
-- CREDIT, PLUS CUSTOM FISCAL QUARTERS
--
-- Three related additions:
--
-- 1. PER-MEMBER MONTHLY AMOUNT OVERRIDES. side_fund_config.
--    monthly_amount stays the company-wide default, but an Admin/
--    Treasurer can now set a different fixed amount for an
--    individual shareholder (e.g. a reduced due for a hardship
--    case) via side_fund_member_overrides. The monthly due-
--    generation job checks for an override first, falling back to
--    the company default when none exists — opt-in per member,
--    same "nothing configured = original behaviour" shape as every
--    other opt-in feature in this system.
--
-- 2. OVERPAYMENT CREDIT. Previously a due payment was hard-capped at
--    that due's own outstanding balance (overpayment was rejected
--    outright). Now a payment can exceed the due it's recorded
--    against — the excess first clears any other outstanding dues
--    for that member, oldest period first (including DEFAULTED
--    ones), and whatever's left after that is banked in
--    side_fund_member_credit as a running credit balance. The
--    monthly due-generation job automatically draws down a member's
--    banked credit against each newly created due, before it's ever
--    shown as PENDING — this is what "the balance is distributed to
--    cater for the following months" means in practice.
--    side_fund_credit_ledger keeps an auditable log of every credit
--    banked or applied, the same "what happened stays recorded"
--    principle used elsewhere in this system (e.g. signature
--    snapshots, stamp application records).
--
-- 3. CUSTOM FISCAL QUARTERS. fiscal_quarters lets an Admin define
--    the company's own financial-year quarters with fully custom
--    date ranges (not necessarily equal 3-month blocks) — e.g. a
--    financial year that doesn't follow the calendar year. Purely a
--    labelling/lookup table for now: reports and generated documents
--    can look up which configured quarter a given date falls into
--    and show its label, without changing any of the underlying
--    calendar-based figures.
--
-- Safe to run on a database that already has these objects (all
-- statements are idempotent).
-- ============================================================

BEGIN;

-- ----------------------------------------------------------
-- 1. side_fund_dues — track whether a due was settled with real
--    money (a payment, dual-posted like always) or drawn down from a
--    member's previously-banked credit (no new transaction — the
--    money already moved when the credit was originally banked).
-- ----------------------------------------------------------
ALTER TABLE side_fund_dues ADD COLUMN IF NOT EXISTS paid_from_credit BOOLEAN NOT NULL DEFAULT FALSE;

-- ----------------------------------------------------------
-- 2. side_fund_member_overrides — one row per member who has a
--    custom monthly amount instead of the company-wide default
--    (side_fund_config.monthly_amount). No row = uses the default.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS side_fund_member_overrides (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    monthly_amount NUMERIC(20,4) NOT NULL CHECK (monthly_amount >= 0),
    set_by         INTEGER REFERENCES users(id),
    set_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------
-- 3. side_fund_member_credit — one row per member, the running
--    balance of overpayment that hasn't been applied to a due yet.
--    Drawn down automatically as new monthly dues are generated.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS side_fund_member_credit (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id),
    credit_balance NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------
-- 4. side_fund_credit_ledger — an auditable log of every time a
--    member's credit balance changed: banked (positive delta, from
--    an overpayment with nothing left to apply it to) or applied
--    (negative delta, drawn down against a specific due).
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS side_fund_credit_ledger (
    id             SERIAL PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    delta          NUMERIC(20,4) NOT NULL,  -- positive = banked, negative = applied
    reason         TEXT NOT NULL,
    related_due_id INTEGER REFERENCES side_fund_dues(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_side_fund_credit_ledger_user ON side_fund_credit_ledger (user_id, created_at DESC);

-- ----------------------------------------------------------
-- 5. fiscal_quarters — Admin-defined custom financial-year quarters,
--    fully custom start/end dates (not required to be equal
--    3-month blocks or to tile the calendar without gaps).
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS fiscal_quarters (
    id         SERIAL PRIMARY KEY,
    label      VARCHAR(50) NOT NULL,   -- e.g. "FY2025/26 — Q1"
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fiscal_quarter_valid_range CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_quarters_range ON fiscal_quarters (start_date, end_date);

COMMIT;

-- ============================================================
-- After running this migration:
--   1. Restart the backend so the new side-fund override/credit
--      endpoints and the fiscal-quarters endpoints are picked up.
--   2. Nothing changes for existing members automatically — no
--      overrides or banked credit exist until an Admin/Treasurer
--      creates them, and no fiscal quarters are defined until an
--      Admin adds them in Settings.
--   3. The monthly side-fund due-generation job (jobs/scheduler.js)
--      now checks side_fund_member_overrides and auto-applies
--      side_fund_member_credit for each member as it creates that
--      month's dues — this takes effect on the very next scheduled
--      run, no separate backfill needed for existing PENDING dues.
-- ============================================================
