-- ============================================================
-- MIGRATION v1.33.0
-- Seeds the "founding" share price and EUR->UGX exchange rate that
-- the new unit-price shareholding calculation (Section 14.7 of
-- CMS_BIBLE.md) needs to correctly value every EXISTING contribution,
-- not just future ones.
--
-- WHY THIS MIGRATION EXISTS: share_price_history and
-- currency_exchange_rates have never had a seeded starting row —
-- neither ships with schema.sql, so the very first real row in each
-- table only exists from whenever someone first set one by hand
-- through Settings > Shares / Settings > Exchange Rates. If that
-- happened well after this company's first contributions were already
-- recorded, those early contributions would otherwise have no valid
-- historical price/rate to divide by once the new calculation is
-- turned on.
--
-- ⚠️  BEFORE RUNNING — SET THE TWO COMPANY-SPECIFIC VALUES BELOW  ⚠️
-- This migration is shared between BOTH companies' databases but each
-- one has its OWN founding share price:
--   - ZWECK TUKULA (Company A):        100000  (UGX)
--   - INVESTABO GLOBAL INVESTMENTS (Company B):  50000  (UGX)
-- Edit v_founding_price below to match whichever database you are
-- about to run this against, THEN run it. The founding EUR->UGX rate
-- (4000) is the same for both companies, per your own figures — no
-- edit needed there.
--
-- WHAT IT DOES NOT DO: it does not touch shareholding_registry itself.
-- Seeding this data is a separate, safe, read-only-in-effect step from
-- actually recomputing anyone's shares_held — that recompute runs
-- through the app (Settings > Shares > Recalculate, Admin only), which
-- shows a full before/after preview for every member before anything
-- is overwritten. Run THIS migration first, then use that screen.
--
-- SAFE TO RE-RUN: both inserts are guarded by IF NOT EXISTS checks, so
-- running this twice (or running it after an Admin has already set a
-- real historical price/rate predating the earliest contribution) does
-- nothing the second time — it will never overwrite or duplicate real
-- data someone already entered.
-- ============================================================

DO $$
DECLARE
    -- ⚠️ EDIT THIS ONE LINE per database — see the comment block above.
    v_founding_price   NUMERIC(20,4) := 100000;   -- Company A: 100000 | Company B: 50000
    v_founding_rate    NUMERIC(20,6) := 4000;      -- 1 EUR = 4000 UGX, same for both companies

    v_earliest_date    DATE;
    v_ugx_id           INTEGER;
    v_eur_id           INTEGER;
    v_founding_user_id INTEGER;
BEGIN
    -- The earliest APPROVED contribution on file — everything before
    -- this date is, by definition, before any real contribution
    -- existed, so it's a safe "effective from the beginning of time"
    -- anchor. Falls back to today if this database genuinely has no
    -- approved contributions yet (a brand-new install).
    SELECT MIN(contribution_date) INTO v_earliest_date
    FROM   shareholder_contributions
    WHERE  status = 'APPROVED';

    IF v_earliest_date IS NULL THEN
        v_earliest_date := CURRENT_DATE;
    END IF;

    SELECT id INTO v_ugx_id FROM currencies WHERE code = 'UGX';
    SELECT id INTO v_eur_id FROM currencies WHERE code = 'EUR';

    IF v_ugx_id IS NULL OR v_eur_id IS NULL THEN
        RAISE EXCEPTION 'Expected currencies UGX and EUR to already exist — check the currencies table before re-running this migration.';
    END IF;

    -- Attribute both seed rows to whichever user account was created
    -- first in this database — in practice, the original bootstrapped
    -- Admin (see GOING_LIVE_GUIDE.md Step 4). Purely an audit-trail
    -- attribution; doesn't affect the calculation itself.
    SELECT id INTO v_founding_user_id FROM users ORDER BY created_at ASC LIMIT 1;

    IF v_founding_user_id IS NULL THEN
        RAISE EXCEPTION 'No users exist in this database yet — bootstrap your first Admin (GOING_LIVE_GUIDE.md Step 4) before running this migration.';
    END IF;

    -- Seed the founding share price, only if nothing already covers
    -- this early a date (i.e. don't clobber a real historical price
    -- someone already entered by hand).
    IF NOT EXISTS (
        SELECT 1 FROM share_price_history WHERE effective_from <= v_earliest_date
    ) THEN
        INSERT INTO share_price_history
            (price_per_share, currency_id, effective_from, set_by, notes)
        VALUES
            (v_founding_price, v_ugx_id, v_earliest_date, v_founding_user_id,
             'Founding share price, backfilled by migration_v1.33.0 to cover pre-existing contributions');
    END IF;

    -- Seed the founding EUR->UGX rate, same guard.
    IF NOT EXISTS (
        SELECT 1 FROM currency_exchange_rates
        WHERE  base_currency_id = v_eur_id AND target_currency_id = v_ugx_id
        AND    effective_from <= v_earliest_date
    ) THEN
        INSERT INTO currency_exchange_rates
            (base_currency_id, target_currency_id, rate, effective_from, set_by, notes)
        VALUES
            (v_eur_id, v_ugx_id, v_founding_rate, v_earliest_date, v_founding_user_id,
             'Founding EUR->UGX rate, backfilled by migration_v1.33.0 to cover pre-existing contributions');
    END IF;
END $$;
