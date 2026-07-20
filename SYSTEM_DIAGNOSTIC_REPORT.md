# System Diagnostic Report

**Scope:** Full read-only audit of the backend (`cms/`) and frontend (`cms-frontend/`) for bugs, logic inconsistencies, and integrity risks, ahead of moving from test data to real data.

**Date:** 19 July 2026

**Method:** Two independent, read-only passes — one over the backend (controllers, routes, schema, services), one over the frontend (pages, components, API layer) — each cross-checking code against the architectural patterns already established elsewhere in this codebase (transaction safety, dual-post accounting, permission gating, shared formatting/avatar helpers). Every finding below has been re-verified against the current source before being included in this report.

Findings are grouped by severity. **Critical** means a code path is broken or will error/misbehave when a real user hits it. **Moderate** means it works today but is inconsistent, fragile, or produces subtly wrong output. **Minor** means cosmetic, dead code, or a small maintainability smell.

**Update:** all 6 Critical items (#1–#6 below) have since been fixed, along with two same-family bugs found while fixing #3 (see "Fixed" markers below and the addendum at the bottom of this report). Moderate and Minor items are still open.

---

## Critical

### Backend

**1. [FIXED] Savings handout confirmation will crash.**
`cms/src/controllers/savingsController.js:499` — `confirmSavingsHandout` calls `postTransaction` with `categoryId: null`. But `transactions.category_id` is `NOT NULL` in `schema.sql:439`, and `savings_handouts` has no `category_id` column to draw from. Every time a member's savings handout is confirmed, this will throw a database error and roll back — the feature is currently unusable.
*Fix:* add a `category_id` column to `savings_handouts` (set at handout-creation time) and pass it through, or use a fixed system category for handouts.

**2. [FIXED] Floor-limit button 403s for non-Treasurer roles with the right permission.**
`cms/src/routes/accounts.js:202` gates the floor-limit update route with `requireRoles(['Treasurer', 'Assistant Treasurer'])`, while the frontend button (`AccountsPage.jsx:1504`) checks `hasPermission('FINANCE_FLOOR_LIMIT_UPDATE')`. Anyone granted that permission under a role not literally named "Treasurer" or "Assistant Treasurer" sees the button, clicks it, and gets rejected.
*Fix:* switch the backend route to `requirePermissions(['FINANCE_FLOOR_LIMIT_UPDATE'])` to match the frontend gate.

**3. [FIXED] Reference codes silently mislabeled on six code paths.**
`cms/src/controllers/loansController.js:398,550,1086,1223`, `grantsController.js:387`, and `dividendsController.js:188` all derive the transaction's reference-code module via `account.account_id === 1 ? PRIMARY : SECONDARY` instead of the `resolveModuleCode(account)` helper used everywhere else in the codebase. This breaks if the Primary account's row id is ever not literally `1` (e.g. after a data reseed), and it always ignores any custom `reference_prefix` set on an account — a feature the schema explicitly supports.
*Fix:* replace all six sites with `resolveModuleCode(account)` (already imported and used correctly elsewhere).

### Frontend

**4. [FIXED] No way to reset a forgotten password.**
`LoginPage.jsx:127` links to `/forgot-password`, but no such route exists in `App.js` and no `ForgotPasswordPage` component exists anywhere. `authAPI.forgotPassword`/`resetPassword` are only reachable from inside `ProfilePage.jsx` — which requires already being logged in. A locked-out member has no self-service way back in.
*Fix:* add a public `/forgot-password` route and page wired to the existing `authAPI` calls (the backend endpoints already exist and work).

**5. [FIXED] No UI to reverse a transaction.**
`transactionsAPI.reverse` is defined but never called from any page. The backend restricts it to Treasurer-only (`cms/src/routes/transactions.js:123-124`), confirming it's a real, deliberately gated control — it just has no button anywhere.
*Fix:* add a Treasurer-gated "Reverse" action to `TransactionsPage.jsx`'s table.

**6. [FIXED] No UI to amend a loan's penalty rate.**
`loansAPI.amendRate`/`amendGivenRate` are defined and Treasurer-restricted on the backend, but `LoanDetailPage.jsx` only *displays* past rate amendments — there's no form to create a new one.
*Fix:* add an "Amend Rate" modal to `LoanDetailPage`, wired to the existing endpoint.

---

## Moderate

### Backend

**7. Role-vs-permission gating has no consistent rule.** The same category of action (money-moving, approvals) is gated by `requireRoles` in some routes and `requirePermissions` in others, with no discernible pattern: `transactions.js:57,79,101,124`, `loans.js:143,264`, `requisitions.js:83`, and all of `savings.js`, `dividends.js`, `shares.js`, `certificates.js`, `exchangeRates.js`, `settings.js` are role-based, while sibling routes in the same files are permission-based. Any future role rename, or granting a permission to a differently-named role, will silently break access somewhere without a corresponding backend change.
*Fix:* standardize on `requirePermissions` everywhere (it already matches the frontend's `hasPermission` pattern), retire `requireRoles` for financial actions.

**8. Audit log hardcodes "EUR" for floor-limit changes.** `accountsController.js:594` — the audit description reads `` `Floor limit updated to ${floor_amount} EUR` `` regardless of the account's actual currency, even though floor limits were generalized to all currencies this session. Non-EUR changes get a misleading audit trail.
*Fix:* interpolate the account's real currency code.

**9. Two known-unreachable backend endpoints, confirmed still true:** `POST /accounts/primary` (`createPrimaryAccount`) and the loan rate-amendment endpoints have no frontend entry point (see Critical #6 above for the loan one). Both are logically sound on the backend — this is a missing-UI gap, not a backend defect.

### Frontend

**10. `formatCurrency`/`formatNumber` are dead code — every page hand-rolls formatting instead.** Despite being imported in 5 files, neither is actually called anywhere; ~100+ call sites use `parseFloat(x).toLocaleString('en-US', { maximumFractionDigits: 2 })` directly. Unlike the shared helpers, this pattern has no `minimumFractionDigits` (inconsistent decimal places in the same table) and no null-guard — a null value (e.g. an account with no floor limit) renders the literal string `"NaN"` instead of `formatCurrency`'s `—`.
*Fix:* either adopt the shared helpers codebase-wide, or delete them if the manual pattern is now the intended convention — right now they're misleading dead code that looks load-bearing.

**11. One stale initials-avatar spot survived the Avatar rollout.** `AboutPage.jsx:407` — the Directors list still hand-builds `{d.first_name?.[0]}{d.last_name?.[0]}` instead of using the shared `Avatar` component (which correctly handles photo → chosen avatar → initials everywhere else now).
*Fix:* replace with `<Avatar user={d} size={40} />`.

**12. Investment projects/milestones are backend-only.** `investmentsAPI.createProject`, `addMilestone`, `updateMilestone`, `updateStatus` are never called. `InvestmentDetailPage.jsx` renders "No projects yet" with no way to add one — once seed data is cleared, this feature becomes permanently empty from the UI.
*Fix:* add creation/edit UI, or confirm this was meant to be admin/backend-only.

**13. Duplicated API-base-URL fallback in three places.** `api/axios.js`, `contexts/BrandingContext.js`, and `utils/helpers.js` each independently hardcode the same `http://localhost:5000/api` fallback if the env var isn't set at build time — three copies that can silently drift apart.
*Fix:* centralize into one exported constant.

**14. The 401-refresh interceptor bypasses the API layer.** `api/axios.js:51-53` makes a raw `axios.post()` call to the refresh endpoint instead of using `authAPI.refreshToken` from `endpoints.js`, which is consequently unused dead code.
*Fix:* route the interceptor through the existing endpoint function.

---

## Minor

- **`transactionsController.js:269-270`** — `creditShareholderContribution` passes a `contributedBy` field into `postTransaction` that the function doesn't accept (silently dropped); a separate `UPDATE` statement immediately after actually sets it. Harmless today, but confusing — remove the dead parameter.
- **`requisitionsController.js` (~line 315)** — the expense-approval path resolves module code via a manual `account_type === 'PRIMARY' ? ... : ...` check instead of `resolveModuleCode(account)`, ignoring custom `reference_prefix` values (same family of issue as Critical #3, lower impact).
- **`ShareholderDashboard.jsx:194,197`** — uses raw `.toFixed(2)` for share value instead of `formatCurrency`, losing thousands separators that the rest of the page has.
- **`Sidebar.jsx:117-120`** — the company-logo `onError` handler mutates `e.target.parentElement.innerHTML` directly instead of going through React state; works today but is a foot-gun if that subtree is ever re-rendered by React.
- **`AuthContext.js:60-61`** — two `console.log` statements print the full user object and permissions list to the browser console on every login. Should be removed before going live.
- **A handful of backend endpoints have no confirmed UI surface** (certificate history list, price-history charts for shares/exchange rates, audit log viewer, document template creation, grant-condition updates) — lower confidence these are bugs vs. intentionally deferred; worth a quick pass to confirm intent.

---

## Verified clean — no action needed

The dual-post accounting pattern (every real transaction paired with its envelope-balance update, inside one atomic `withTransaction`) is correct and race-safe across Side Fund dues/direct-inflow/expense, Savings deposit approve/reject/withdrawal/pool-inflow, and Transfers (both legs plus bank charges). No SQL-injection risk was found anywhere — all dynamic query fragments are built from static column names with values bound as parameters. Every controller function is wrapped in `asyncHandler`. The "only one Primary/Savings account" rule is properly enforced by a database-level partial unique index, not just application logic, so it can't race.

---

## Addendum — what was actually fixed

All 6 Critical items were fixed the same day this report was written. Details:

- **#1 (savings handout crash):** Added `savings_handouts.category_id` (schema.sql + `migration_v1.17.0.sql`, with a backfill of existing rows to FINANCE > Expense and a Treasurer category dropdown added to the "Record Handout" form). Run the migration before restarting the backend.
- **#2 (floor-limit permission mismatch):** `accounts.js`'s floor-limit route now uses `requirePermissions(['FINANCE_FLOOR_LIMIT_UPDATE'])` instead of `requireRoles`.
  **Action needed on your end:** `role_permissions` in this system is populated only through Settings > Permissions Management (there's no seed data for it) — if no one has explicitly granted `FINANCE_FLOOR_LIMIT_UPDATE` to the Treasurer/Assistant Treasurer roles yet, this change will actually *block* floor-limit updates for everyone until an Admin grants it there. Check this before/right after deploying.
- **#3 (mislabeled reference codes):** Fixed all 6 flagged sites plus 2 more in the same family found while fixing it (`dividendsController.js`'s authority-payment path, `requisitionsController.js`'s expense-approval path) — 8 sites total now use `resolveModuleCode(account)` consistently.
- **#4 (no password reset):** Added `ForgotPasswordPage.jsx` and `ResetPasswordPage.jsx`, wired to the existing (already-working) backend endpoints. Also found and fixed a related bug while here: `VerifyEmailPage` was nested inside the login-protected route group, meaning a brand-new user clicking their verification email link got bounced to `/login` before ever reaching it — moved it to the public route group alongside the two new pages.
- **#5 (no transaction reversal UI):** Added a Treasurer-gated "Reverse" button to `TransactionsPage.jsx`'s table (hidden on rows that are already a reversal or have already been reversed).
- **#6 (no loan rate-amendment UI):** Added an "Amend Rate" button + modal to `LoanDetailPage.jsx`, Treasurer-gated, matching the backend's own restriction.

## What's still open

Everything in Moderate and Minor above (findings #7–#19-ish) is unfixed and can be scheduled at your own pace — none of it blocks going live with real data. The two flagged-but-lower-confidence items (investment projects/milestones UI, and the handful of endpoints with no confirmed UI surface) are worth a quick product decision on whether they were meant to ship with a UI at all.
