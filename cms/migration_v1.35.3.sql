-- ============================================================
-- MIGRATION v1.35.3 -- FIX: A ROLE COULD NEVER BE RE-ASSIGNED TO
-- SOMEONE WHO HAD PREVIOUSLY HELD, THEN LOST, THAT EXACT ROLE
--
-- SYMPTOM: "A record with this value already exists" when using
-- Assign Role, even though the target member's "Current Roles"
-- correctly showed "No roles assigned."
--
-- ROOT CAUSE: user_roles had a plain table-wide
-- UNIQUE (user_id, role_id) constraint from the very first schema.
-- The Assign Role screen's own "already holds this role?" check only
-- looks at ACTIVE rows (revoked_at IS NULL) -- so it correctly says
-- yes, go ahead -- but the INSERT that follows then collides with the
-- constraint anyway, because the constraint counts a REVOKED row for
-- that same (user_id, role_id) pair too. Once any one role was ever
-- assigned and later revoked for a given member, that exact role
-- could never be assigned to them again, ever -- the database itself
-- was blocking it, not any application logic, which is why the error
-- was the generic PostgreSQL duplicate-key message rather than
-- anything Assign Role's own code produces.
--
-- This was a latent bug in the schema from day one -- not something
-- the permanent-deletion feature (v1.35.0) introduced. It surfaced
-- now because deleting an account that had been holding a role (e.g.
-- Secretary) naturally leads to reassigning that same role to someone
-- who happens to have held -- and had revoked -- that exact role at
-- some point in the past.
--
-- FIX: drop the table-wide UNIQUE constraint and replace it with a
-- PARTIAL unique index that only applies to active rows
-- (WHERE revoked_at IS NULL). This keeps the real rule intact -- a
-- member still can't hold the same role twice at once -- while
-- allowing the same role to be assigned, revoked, and re-assigned to
-- the same person any number of times over their membership, which is
-- exactly what the application code already assumed was possible.
--
-- Nothing is deleted or rewritten -- every existing user_roles row,
-- active or revoked, is left exactly as it is. Only the constraint
-- that governs future INSERTs changes.
--
-- Safe to run more than once.
-- ============================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname  = 'user_roles_user_id_role_id_key'
          AND conrelid = 'user_roles'::regclass
    ) THEN
        ALTER TABLE user_roles DROP CONSTRAINT user_roles_user_id_role_id_key;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_active_role_unique
    ON user_roles (user_id, role_id)
    WHERE revoked_at IS NULL;

COMMIT;

-- ------------------------------------------------------------
-- After running this migration:
--   1. Restart the backend (no code change needed for this fix to
--      take effect -- it's purely a database constraint change --
--      but restart anyway if you're deploying this alongside other
--      code changes in the same push).
--   2. Assign Role will now work for a member being given back a
--      role they held and lost at some point in the past. Every
--      other Assign Role scenario (a role they've never held, a role
--      someone else holds) already worked and is unaffected.
--   3. If you'd like to double-check the fix landed, run:
--        SELECT conname FROM pg_constraint
--        WHERE conrelid = 'user_roles'::regclass AND contype = 'u';
--      -- should return zero rows (the old constraint is gone).
--        SELECT indexname FROM pg_indexes
--        WHERE tablename = 'user_roles';
--      -- should include user_roles_active_role_unique.
-- ------------------------------------------------------------
