-- ============================================================
-- MIGRATION v1.42.0 — Bond investment fixes:
--   1. Fixed the first-coupon-date schedule-collapse bug (code-only,
--      see cms/src/utils/bondSchedule.js — no schema change).
--   2. Bond face value is now repaid alongside the final coupon
--      (investment_returns gains a new return_type: 'PRINCIPAL').
--   3. Coupon frequency can now be changed after creation, the same
--      way first coupon date already could (code-only — reuses the
--      existing coupon_frequency column).
--   4. Settlement value is auto-funded (guarded, no negatives) the
--      moment a bond is approved, if already known; if not, it can
--      now be recorded once ACTIVE too, via a new endpoint (code-only
--      — reuses the existing settlement_value column).
--
-- Reported directly: "the date recalculation failed when i set the
-- first coupon date and now only shows one date of the final coupon
-- payment and amount. Plus generally all bond investments payout the
-- facevalue amount together with the last coupon wasn't included
-- before which it should. I would also like to be able to change the
-- frequency as well after creation ... I would like that once the
-- bond is approved the settlement value is recorded and deducted from
-- the holding account automatically (no negatives allowed of course)
-- ... I would like that these changes affects even previously created
-- investments."
--
-- After running this file, ALSO run the retroactive backfill for
-- previously created bonds:
--
--     cd cms
--     node backfill_v1.42.0_bonds.js
--
-- That script credits face value for any bond whose final coupon was
-- already paid before this version existed, and auto-funds any
-- already-approved bond whose settlement value was recorded but never
-- funded — see the comment block at the top of that file for exactly
-- what it does and doesn't touch (it never re-funds an investment
-- that's already been funded by any means, so it's safe to run more
-- than once).
-- ============================================================

BEGIN;

DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'investment_returns'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%DIVIDEND%INTEREST%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE investment_returns DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE investment_returns ADD CONSTRAINT investment_returns_return_type_check
        CHECK (return_type IN (
            'DIVIDEND','PROFIT_SHARE','CAPITAL_GAIN',
            'INTEREST','RENTAL','OTHER','PRINCIPAL'
        ));
END $$;

COMMIT;
