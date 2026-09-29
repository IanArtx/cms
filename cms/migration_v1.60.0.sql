-- ============================================================
-- MIGRATION v1.60.0 — Bond Term Identifier + Investments/MMF
-- Unification (frontend/reporting only — no schema change needed for
-- the unification itself, see below)
--
-- Requested directly: "the bonds now haven't gotten their period
-- identifiers which they need (including already entered records)...
-- each bond identifies it running period categorically since this is
-- how they are already categorised as such when buying them i.e.
-- 2yr, 3yr, 5yr, 10yr, 15yr, 20yr and 25yr bond... the investments
-- remain separate but the terms (duration) are clearly known and the
-- company can tell how much has been invested in a certain bond [term]."
--
-- New nullable investments.bond_term_years column (BOND-only, CHECK
-- constrained to the fixed 7-value list per the confirmed answer to a
-- clarifying question). Required going forward for every NEW bond —
-- enforced in investmentsController.js, not here, so this migration's
-- own backfill step below can leave a genuinely ambiguous legacy bond
-- at NULL rather than forcing it into the nearest wrong bucket.
--
-- Backfill (per the confirmed answer to a clarifying question:
-- "auto-compute, then you review"): every existing BOND investment
-- with both a start_date (issue) and expected_end_date (maturity) has
-- its actual duration compared against the 7 standard terms; the
-- nearest one is filled in automatically ONLY when it's within 6
-- months of that bucket — a bond whose duration doesn't cleanly match
-- any of the 7 (or is missing a date) is left NULL, to be assigned by
-- hand via the "Set Term" action on its own page.
--
-- Investments/MMF are unified at the UI/reporting layer only this
-- version (light unification, per the confirmed answer to a
-- clarifying question) — mmf_accounts/mmf_transactions keep their own
-- tables and mechanics unchanged, so there is nothing else to migrate
-- here for that half of the request.
--
-- Idempotent — safe to run against a database that already has some
-- or all of this applied.
-- ============================================================

-- Add the column only if it doesn't already exist.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'investments' AND column_name = 'bond_term_years'
    ) THEN
        ALTER TABLE investments ADD COLUMN bond_term_years INTEGER;
    END IF;
END $$;

-- Add the CHECK constraint only if it doesn't already exist (matches
-- the guarded-constraint pattern used elsewhere in this file set,
-- since Postgres has no native "ADD CONSTRAINT IF NOT EXISTS").
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'investments'::regclass
        AND   conname = 'investments_bond_term_years_check'
    ) THEN
        ALTER TABLE investments ADD CONSTRAINT investments_bond_term_years_check
            CHECK (bond_term_years IS NULL OR bond_term_years IN (2, 3, 5, 10, 15, 20, 25));
    END IF;
END $$;

-- Backfill: nearest-bucket match within a 6-month tolerance, leaving
-- anything ambiguous (or missing a date) untouched at NULL. Safe to
-- run repeatedly — only ever touches rows still sitting at NULL.
WITH buckets(term) AS (
    VALUES (2), (3), (5), (10), (15), (20), (25)
),
candidates AS (
    SELECT
        i.id,
        b.term,
        ABS(
            EXTRACT(EPOCH FROM (i.expected_end_date::timestamp - i.start_date::timestamp))
            / (365.25 * 86400)
            - b.term
        ) AS diff_years
    FROM   investments i
    CROSS JOIN buckets b
    WHERE  i.investment_type = 'BOND'
    AND    i.bond_term_years IS NULL
    AND    i.start_date IS NOT NULL
    AND    i.expected_end_date IS NOT NULL
),
best_match AS (
    SELECT DISTINCT ON (id) id, term, diff_years
    FROM   candidates
    ORDER  BY id, diff_years ASC
)
UPDATE investments i
SET    bond_term_years = best_match.term
FROM   best_match
WHERE  i.id = best_match.id
AND    best_match.diff_years <= 0.5;

-- Anything left NULL after the above is a genuine "needs manual
-- review" case — surfaced on the Investments page (a flagged "Set
-- Term" action on any BOND row with no term) rather than silently
-- mismatched. This SELECT is informational only, safe to ignore, and
-- intended for whoever runs this migration to glance at the output:
SELECT
    id, name,
    (SELECT reference_code FROM references_registry r WHERE r.id = investments.reference_id) AS reference_code,
    start_date, expected_end_date
FROM investments
WHERE investment_type = 'BOND' AND bond_term_years IS NULL;
