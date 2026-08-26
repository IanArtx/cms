-- ============================================================
-- MIGRATION v1.41.2 — Reconcile Deposit balances for reversals that
-- happened BEFORE v1.40.1's reverseTransaction fix existed.
--
-- Reported directly: "this is good but i was first focused on the
-- deposit amount (security), the amount that is spendable through its
-- parent account, this amount need to have a way of ammending
-- historical reversals since the current one doesn't change the
-- amount despite the reversal. money leaves the account but the
-- member still holds the figure amount of the reversal."
--
-- v1.40.1 fixed reverseTransaction so that reversing a deposit's
-- transaction FROM NOW ON correctly decrements deposit_balances.
-- balance and marks the deposit_entries row reversed. It does nothing
-- for a deposit that was already reversed at some point in the past,
-- before that fix existed — for those, the ledger and the parent
-- account's real balance already correctly reflect the money having
-- left (the reversal itself posted the opposite ledger entry and
-- adjusted accounts.current_balance from day one, since that part was
-- never broken), but deposit_balances.balance — the "how much this
-- member holds as deposit" figure shown on their own Portfolio/
-- Deposits page — was never told about it, so the member still shows
-- as holding money that, in reality, is gone.
--
-- Unlike Side Fund/Savings (migration_v1.41.1.sql), this one is fully
-- recoverable with no unrecoverable class of case: every deposit has
-- always been its own permanent row in deposit_entries, linked to its
-- transaction via `transaction_id` since the feature's very first
-- version (v1.38.0) — never a shared, overwritten, "last write wins"
-- row the way side_fund_dues is. So every historical reversal can be
-- traced back to the exact entry and exact amount it affected.
--
-- Safe to run more than once — a deposit_entries row already marked
-- is_reversed = TRUE (whether by this migration or by the live
-- reverseTransaction code) is excluded from the WHERE clause below,
-- so re-running finds nothing left to do.
-- ============================================================

BEGIN;

DO $$
DECLARE
    r               RECORD;
    current_balance NUMERIC;
    would_be        NUMERIC;
    count_ok        INTEGER := 0;
    count_clamped   INTEGER := 0;
BEGIN
    FOR r IN
        SELECT de.id AS entry_id, de.user_id, de.normalized_amount,
               t.id AS tx_id, t.value_date, rr.reference_code
        FROM   deposit_entries de
        JOIN   transactions t ON t.id = de.transaction_id
        LEFT JOIN references_registry rr ON rr.id = t.reference_id
        WHERE  t.inflow_type = 'DEPOSIT_CONTRIBUTION_IN'
        AND    t.is_reversed = TRUE
        AND    de.is_reversed = FALSE
        ORDER BY t.value_date
    LOOP
        SELECT balance INTO current_balance FROM deposit_balances WHERE user_id = r.user_id FOR UPDATE;
        would_be := COALESCE(current_balance, 0) - r.normalized_amount;

        IF would_be < 0 THEN
            RAISE NOTICE '[MANUAL REVIEW NEEDED] Deposit: user_id=%''s current deposit balance (%) is lower than the reversed entry amount (%) for deposit_entries.id=% / transaction % (% dated %) — likely already partly paid out via an exit refund since the reversal. Balance clamped to 0 instead of going negative; please review deposit_exit_events for this member by hand.',
                r.user_id, COALESCE(current_balance, 0), r.normalized_amount, r.entry_id, r.tx_id, r.reference_code, r.value_date;
            UPDATE deposit_balances SET balance = 0, updated_at = NOW() WHERE user_id = r.user_id;
            count_clamped := count_clamped + 1;
        ELSE
            UPDATE deposit_balances SET balance = would_be, updated_at = NOW() WHERE user_id = r.user_id;
        END IF;

        UPDATE deposit_entries
        SET    is_reversed = TRUE, reversed_at = NOW(), reversed_by = NULL
        WHERE  id = r.entry_id;

        RAISE NOTICE '[CORRECTED] Deposit: user_id=%''s balance reduced by % for deposit_entries.id=% / transaction % (% dated %), now marked reversed.',
            r.user_id, r.normalized_amount, r.entry_id, r.tx_id, r.reference_code, r.value_date;
        count_ok := count_ok + 1;
    END LOOP;

    IF count_ok > 0 THEN
        RAISE NOTICE 'DEPOSITS SUMMARY: % historical reversal(s) corrected (% of which had to be clamped to 0 — see individual notices above for manual review).', count_ok, count_clamped;
    ELSE
        RAISE NOTICE 'DEPOSITS SUMMARY: no pre-v1.40.1 reversed deposits found — nothing to backfill.';
    END IF;
END $$;

COMMIT;
