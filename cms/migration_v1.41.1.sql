-- ============================================================
-- MIGRATION v1.41.1 — Notification link backfill, and reconciling
-- Side Fund / Savings transactions that were reversed BEFORE
-- v1.41.0's reverseTransaction fix existed.
--
-- Two independent, unrelated fixes bundled together because both were
-- reported in the same message right after v1.41.0 shipped:
--
-- "this is still going to the dashboard instead of requisitions.
--  please let all notifications link to their dedicated pages" —
-- v1.41.0 fixed the CODE that decides a notification's `link` going
-- forward, but a notification's `link` is written once, into the row,
-- at the moment it's created (see notificationService.js) — it is
-- never recomputed later. So every notification already sitting in
-- the `notifications` table before this migration runs still carries
-- whatever broken link it was created with, and will keep bouncing to
-- the Dashboard forever no matter how correct the code becomes. This
-- migration is the one-time data fix for those already-existing rows.
--
-- "the latest migration does not affect the reversals in the past
--  which is a problem because this value is important to have
--  accurately" — correct: v1.41.0's reverseTransaction fix only runs
-- when a NEW reversal happens. Any Side Fund or Savings transaction
-- that was ALREADY reversed at some point in the past (before this
-- feature existed) never had its side_fund_dues/side_fund_config/
-- savings_balances effect rolled back at the time, and nothing in
-- v1.41.0 goes back and fixes that after the fact — it only prevents
-- the SAME gap from happening again on future reversals. This
-- migration does that one-time backfill, to the fullest extent the
-- data actually allows.
--
-- IMPORTANT — read this before running, and read the NOTICEs this
-- migration prints when you run it:
--
-- Side Fund's ENVELOPE BALANCE (side_fund_config.current_balance) can
-- always be corrected exactly and safely — it's one aggregate number,
-- and the ledger/account balance already correctly excludes every
-- reversed contribution, so the envelope should too.
--
-- Side Fund's PER-DUE detail (which specific due(s) a reversed payment
-- applied to, and how much of a banked credit came from it) generally
-- CANNOT be recovered automatically for a transaction that predates
-- v1.41.0 — before that version, side_fund_dues.transaction_id was
-- "last write wins" (a due settled across several separate payments
-- only remembers the most recent one) and side_fund_member_credit has
-- no per-transaction history at all. This migration does NOT guess at
-- per-due corrections — it only prints a NOTICE naming any due whose
-- transaction_id happens to still point at the reversed transaction
-- (the closest thing to a lead), for a human to review and correct by
-- hand if that member's standing looks wrong. Silently "fixing" this
-- automatically would risk being confidently wrong, which is worse
-- than leaving it flagged for a person to check.
--
-- Savings via the approval flow (approveSavingsDeposit),
-- fixed-term savings, and handouts were already linked to their
-- transaction via `transaction_id` even before v1.41.0, so those ARE
-- fully and precisely recoverable — this migration corrects them.
--
-- Savings credited directly from Record Contribution's "Savings
-- Portion" field (creditSavingsContribution), before v1.41.0, wrote
-- NO per-entry record at all — only the aggregate balance was
-- touched, and the transaction row itself has no column identifying
-- which member it was for. These are NOT recoverable automatically;
-- this migration prints each one's amount/date/description so a
-- human can look up the member from context and correct their
-- savings balance by hand if needed.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- PART 1 — Notification link backfill
-- Same corrected destinations chosen in v1.41.0's code fix. Safe to
-- run more than once (a row that's already correct simply won't match
-- any WHERE clause below a second time).
-- ------------------------------------------------------------
UPDATE notifications SET link = '/'             WHERE link = '/dashboard';
UPDATE notifications SET link = '/portfolio'    WHERE link = '/reports/me';
UPDATE notifications SET link = '/profile'      WHERE link = '/certificates';
UPDATE notifications SET link = '/grants'       WHERE link ~ '^/grants/[0-9]+$';
UPDATE notifications SET link = '/events'       WHERE link ~ '^/events/[0-9]+$';
UPDATE notifications SET link = '/requisitions' WHERE link ~ '^/requisitions/[0-9]+$';
UPDATE notifications SET link = '/transactions' WHERE link ~ '^/transactions/[0-9]+$';
UPDATE notifications SET link = '/transfers'    WHERE link ~ '^/transfers/[0-9]+$';

-- ------------------------------------------------------------
-- PART 2 — widen side_fund_payment_applications so this migration can
-- leave its own permanent marker on a legacy transaction it has
-- corrected (application_type = 'LEGACY_BACKFILL'), the same way
-- applySideFundPayment leaves a row for every payment going forward —
-- this is what makes re-running this migration safe (a transaction
-- with any row here at all, of any type, is treated as already
-- accounted for). user_id is relaxed to nullable because a
-- LEGACY_BACKFILL row sometimes cannot identify a member at all (see
-- Part 3) — every other application_type still always provides one.
-- ------------------------------------------------------------
DO $$
DECLARE
    con_name text;
BEGIN
    SELECT conname INTO con_name
    FROM   pg_constraint
    WHERE  conrelid = 'side_fund_payment_applications'::regclass
    AND    pg_get_constraintdef(oid) LIKE '%DUE_PAYMENT%CREDIT_BANKED%';
    IF con_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE side_fund_payment_applications DROP CONSTRAINT ' || quote_ident(con_name);
    END IF;
    ALTER TABLE side_fund_payment_applications ADD CONSTRAINT side_fund_payment_applications_application_type_check
        CHECK (application_type IN ('DUE_PAYMENT', 'CREDIT_BANKED', 'LEGACY_BACKFILL'));
END $$;

ALTER TABLE side_fund_payment_applications ALTER COLUMN user_id DROP NOT NULL;

-- ------------------------------------------------------------
-- PART 3 — Side Fund: correct the envelope balance for every
-- already-reversed contribution that predates v1.41.0's tracking
-- (identified by having zero side_fund_payment_applications rows at
-- all — applySideFundPayment has written at least one row per payment
-- since v1.41.0, so zero rows means this transaction is older than
-- that). Reports (does not touch) any due that still shows this
-- transaction as its most recent payment, as a lead for manual review.
-- ------------------------------------------------------------
DO $$
DECLARE
    r               RECORD;
    d               RECORD;
    current_env     NUMERIC;
    would_be        NUMERIC;
    total_corrected NUMERIC := 0;
    legacy_count    INTEGER := 0;
BEGIN
    FOR r IN
        SELECT t.id, t.amount, t.value_date, rr.reference_code
        FROM   transactions t
        LEFT JOIN references_registry rr ON rr.id = t.reference_id
        WHERE  t.inflow_type = 'SIDE_FUND_CONTRIBUTION_IN'
        AND    t.is_reversed = TRUE
        AND    NOT EXISTS (
                   SELECT 1 FROM side_fund_payment_applications spa
                   WHERE  spa.transaction_id = t.id
               )
        ORDER BY t.value_date
    LOOP
        legacy_count := legacy_count + 1;

        SELECT current_balance INTO current_env FROM side_fund_config WHERE id = 1 FOR UPDATE;
        would_be := COALESCE(current_env, 0) - r.amount;

        IF would_be < 0 THEN
            RAISE NOTICE '[MANUAL REVIEW NEEDED] Side Fund envelope: transaction % (% dated %) reversed amount % could NOT be fully backed out — the envelope only holds % today, less than the amount being corrected. Envelope clamped to 0 instead of going negative; please review side_fund_config/side_fund_expenses by hand, this likely means money was spent against a balance that was never really there.',
                r.id, r.reference_code, r.value_date, r.amount, COALESCE(current_env, 0);
            UPDATE side_fund_config SET current_balance = 0, updated_at = NOW() WHERE id = 1;
        ELSE
            UPDATE side_fund_config SET current_balance = would_be, updated_at = NOW() WHERE id = 1;
        END IF;
        total_corrected := total_corrected + r.amount;

        -- Leave a permanent marker so re-running this migration (or
        -- any future code) recognizes this transaction as already
        -- accounted for.
        INSERT INTO side_fund_payment_applications
            (transaction_id, user_id, due_id, application_type, amount, is_reversed, reversed_at)
        VALUES
            (r.id, (SELECT user_id FROM side_fund_dues WHERE transaction_id = r.id LIMIT 1),
             NULL, 'LEGACY_BACKFILL', r.amount, TRUE, NOW());

        -- Report (never auto-correct) any due that still shows this
        -- transaction as its most recent touch.
        SELECT * INTO d FROM side_fund_dues WHERE transaction_id = r.id LIMIT 1;
        IF FOUND THEN
            RAISE NOTICE '[MANUAL REVIEW — lead only, NOT auto-corrected] Side Fund due: transaction % (%) still shows as the last payment on side_fund_dues.id=% — user_id=%, period=%, amount_paid=%, status=%. Review this member''s standing by hand; this due''s amount_paid may still include money from the reversed transaction.',
                r.id, r.reference_code, d.id, d.user_id, d.period, d.amount_paid, d.status;
        ELSE
            RAISE NOTICE '[UNRECOVERABLE — banked credit or overwritten due] Side Fund: transaction % (% dated %, amount %) — no due currently points back to it (either it only banked credit, which has no per-transaction history at all, or a later payment already overwrote which due it last touched). Envelope balance was corrected; per-member due/credit standing for this specific transaction could not be.',
                r.id, r.reference_code, r.value_date, r.amount;
        END IF;
    END LOOP;

    IF legacy_count > 0 THEN
        RAISE NOTICE 'SIDE FUND SUMMARY: % pre-v1.41.0 reversed contribution(s) found; envelope balance corrected by a total of %. See individual notices above for what could/could not be recovered at the due level.',
            legacy_count, total_corrected;
    ELSE
        RAISE NOTICE 'SIDE FUND SUMMARY: no pre-v1.41.0 reversed contributions found — nothing to backfill.';
    END IF;
END $$;

-- ------------------------------------------------------------
-- PART 4 — Savings: correct every ACTIVE/PENDING_APPROVAL
-- member_savings row still linked to an already-reversed transaction
-- (covers approveSavingsDeposit, createFixedTermSavings, AND — since
-- v1.41.0 — creditSavingsContribution's own newly-added linking row;
-- any that predate v1.41.0's addition of that link are handled
-- separately in Part 6, since they have no row here at all).
-- ------------------------------------------------------------
DO $$
DECLARE
    r         RECORD;
    principal NUMERIC;
    count_ok  INTEGER := 0;
    count_skip INTEGER := 0;
BEGIN
    FOR r IN
        SELECT ms.id AS entry_id, ms.user_id, ms.principal_amount, ms.entry_type, ms.status,
               t.id AS tx_id, rr.reference_code
        FROM   member_savings ms
        JOIN   transactions t ON t.id = ms.transaction_id
        LEFT JOIN references_registry rr ON rr.id = t.reference_id
        WHERE  t.inflow_type = 'SAVINGS_DEPOSIT_IN'
        AND    t.is_reversed = TRUE
        AND    ms.status <> 'REVERSED'
    LOOP
        IF r.status NOT IN ('ACTIVE', 'PENDING_APPROVAL') THEN
            RAISE NOTICE '[MANUAL REVIEW NEEDED] Savings: member_savings.id=% (user_id=%) is linked to reversed transaction % (%) but its own status is % — not auto-corrected, please review by hand.',
                r.entry_id, r.user_id, r.tx_id, r.reference_code, r.status;
            count_skip := count_skip + 1;
            CONTINUE;
        END IF;

        IF r.entry_type = 'FLEXIBLE' THEN
            SELECT principal_balance INTO principal FROM savings_balances WHERE user_id = r.user_id FOR UPDATE;
            IF principal IS NULL OR principal < r.principal_amount THEN
                RAISE NOTICE '[MANUAL REVIEW NEEDED] Savings: user_id=%''s current savings principal (%) is lower than the reversed deposit amount (%) for transaction % (%) — likely already partly paid out via a handout since. NOT auto-corrected.',
                    r.user_id, COALESCE(principal, 0), r.principal_amount, r.tx_id, r.reference_code;
                count_skip := count_skip + 1;
                CONTINUE;
            END IF;
            UPDATE savings_balances SET principal_balance = principal_balance - r.principal_amount, updated_at = NOW() WHERE user_id = r.user_id;
        END IF;
        -- FIXED_TERM never touched savings_balances, so only its own status needs to flip.

        UPDATE member_savings SET status = 'REVERSED', reversed_at = NOW(), reversed_by = NULL WHERE id = r.entry_id;
        RAISE NOTICE '[CORRECTED] Savings: member_savings.id=% (user_id=%) marked REVERSED and balance adjusted for reversed transaction % (%).',
            r.entry_id, r.user_id, r.tx_id, r.reference_code;
        count_ok := count_ok + 1;
    END LOOP;

    RAISE NOTICE 'SAVINGS DEPOSITS SUMMARY: % entr(y/ies) corrected, % skipped for manual review.', count_ok, count_skip;
END $$;

-- ------------------------------------------------------------
-- PART 5 — Savings handouts: savings_handouts.transaction_id already
-- existed before v1.41.0, so every reversed handout is fully
-- recoverable.
-- ------------------------------------------------------------
DO $$
DECLARE
    r          RECORD;
    count_ok   INTEGER := 0;
    count_skip INTEGER := 0;
BEGIN
    FOR r IN
        SELECT sh.id AS handout_id, sh.user_id, sh.principal_amount, sh.interest_amount, sh.status,
               t.id AS tx_id, rr.reference_code
        FROM   savings_handouts sh
        JOIN   transactions t ON t.id = sh.transaction_id
        LEFT JOIN references_registry rr ON rr.id = t.reference_id
        WHERE  t.inflow_type = 'SAVINGS_HANDOUT_OUT'
        AND    t.is_reversed = TRUE
        AND    sh.status <> 'REVERSED'
    LOOP
        IF r.status <> 'CONFIRMED' THEN
            RAISE NOTICE '[MANUAL REVIEW NEEDED] Savings handout: savings_handouts.id=% (user_id=%) linked to reversed transaction % (%) has status=% — not auto-corrected.',
                r.handout_id, r.user_id, r.tx_id, r.reference_code, r.status;
            count_skip := count_skip + 1;
            CONTINUE;
        END IF;

        UPDATE savings_balances
        SET    principal_balance   = principal_balance + r.principal_amount,
               accrued_interest    = accrued_interest + r.interest_amount,
               total_interest_paid = GREATEST(0, total_interest_paid - r.interest_amount),
               updated_at = NOW()
        WHERE  user_id = r.user_id;

        UPDATE savings_handouts SET status = 'REVERSED', reversed_at = NOW(), reversed_by = NULL WHERE id = r.handout_id;

        RAISE NOTICE '[CORRECTED] Savings handout: savings_handouts.id=% (user_id=%) marked REVERSED and balance restored for reversed transaction % (%).',
            r.handout_id, r.user_id, r.tx_id, r.reference_code;
        count_ok := count_ok + 1;
    END LOOP;

    RAISE NOTICE 'SAVINGS HANDOUTS SUMMARY: % handout(s) corrected, % skipped for manual review.', count_ok, count_skip;
END $$;

-- ------------------------------------------------------------
-- PART 6 — Savings deposits with NO recoverable link at all: reversed
-- SAVINGS_DEPOSIT_IN transactions from before v1.41.0's
-- creditSavingsContribution fix, which wrote no member_savings row
-- and left no user-identifying column on `transactions` itself.
-- Genuinely unrecoverable automatically — reported for manual lookup
-- by amount/date/description only.
-- ------------------------------------------------------------
DO $$
DECLARE
    r     RECORD;
    count_unrecoverable INTEGER := 0;
BEGIN
    FOR r IN
        SELECT t.id, t.amount, t.value_date, t.description, rr.reference_code
        FROM   transactions t
        LEFT JOIN references_registry rr ON rr.id = t.reference_id
        WHERE  t.inflow_type = 'SAVINGS_DEPOSIT_IN'
        AND    t.is_reversed = TRUE
        AND    NOT EXISTS (SELECT 1 FROM member_savings ms WHERE ms.transaction_id = t.id)
    LOOP
        count_unrecoverable := count_unrecoverable + 1;
        RAISE NOTICE '[UNRECOVERABLE] Savings: transaction % (%), amount %, dated %, description "%" — a reversed Savings Portion contribution recorded before v1.41.0 tracked which member it belonged to. No automatic way to identify the member; please locate them from the description/date/amount and adjust savings_balances.principal_balance by hand if their standing looks wrong.',
            r.id, r.reference_code, r.amount, r.value_date, r.description;
    END LOOP;

    IF count_unrecoverable > 0 THEN
        RAISE NOTICE 'SAVINGS UNRECOVERABLE SUMMARY: % reversed deposit(s) could not be automatically reconciled — see individual notices above.', count_unrecoverable;
    ELSE
        RAISE NOTICE 'SAVINGS UNRECOVERABLE SUMMARY: none found.';
    END IF;
END $$;

COMMIT;
