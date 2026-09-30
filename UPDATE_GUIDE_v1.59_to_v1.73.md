# Updating the live system from v1.59.0 to v1.73.0 — step by step

The online system (both companies) runs **v1.59.0**. Your computer has
**v1.73.0**. This guide brings the live system up to date without
losing or contradicting a single figure. Follow it top to bottom, once
per company where it says so. Nothing here needs PostgreSQL tools
installed: every database step uses the small helper
`cms/update_live_database.js`, run from your own computer.

**How long:** plan about 1½ hours, including about 45 minutes when
members should not use the system (the maintenance pause).

**When:** on a weekday between **10:00 and 16:00 Kampala time**.
Nightly jobs run between 00:00 and 00:35 and reminders between 07:00
and 09:00 (Kampala), so this avoids them.

**Golden rules**
- Update the **databases first**, then push the code. The new code
  needs the new tables, and Render redeploys as soon as the code is
  pushed.
- Never paste a database connection string into a chat, email or
  document. It contains the database password. The helper never
  prints it.
- If any step shows ❌, **stop** and send me the message. Do not push
  the code while a database step has failed.

---

## What changes (v1.60 → v1.73), in one screen

| Version | What it brings | Database change? |
|---|---|---|
| 1.60 | Bond term (2–25 years) on every bond | yes |
| 1.61 | Savings kept in several currencies + currency conversion | yes |
| 1.62 | Balances checked **as of the transaction's own date** | yes (index) |
| 1.63 | Online events with automatic Google Meet (optional) | yes |
| 1.64 | Share certificates "as of" a date | yes |
| 1.65 | Various fixes | no |
| 1.66 | FX: every entry gets a UGX value; FX revaluation | yes + rates to load |
| 1.67 | Share receipts in one currency | yes + script |
| 1.68 | Various fixes | no |
| 1.69 | Whole shares + share credit, nominal value, registered shares | yes + **opening conversion** |
| 1.70 | Tax: withholding tax, corporate tax years, URA payments | yes + tax settings |
| 1.71 | New look ("Harbour") | no |
| 1.72 | Reversals unwind investments/MMF; past ones repaired; four-eyes rule | yes (repairs + logs) |
| 1.73 | Money entries by anyone not Treasurer/Admin wait for approval | yes |

---

## Part A — The day before (checks and a rehearsal, about 45 minutes)

### A1. Note today's balances (your "before" snapshot)
Log in to each company's live system. On **Accounts**, note (or
screenshot) every account's balance, and write down the number of
shareholders and each member's savings balance if you can. After the
update these must be **exactly the same**. The update moves no money.

### A2. Get each database's connection string
1. Open [dashboard.render.com](https://dashboard.render.com).
2. Open the database **cms-db** (Company A) → **Connect** → copy the
   **External Database URL** (it starts with `postgresql://`).
3. Do the same for **cms-b-db** (Company B), if you run the second company.

Keep them somewhere private (a password manager) for tomorrow.

> If the helper later says it cannot connect, open the database →
> **Networking / Access Control** and make sure your computer's IP
> address is allowed (by default Render allows connections from anywhere).

### A3. Run the check (changes nothing)
Open **PowerShell** and run:

```
cd "C:\Users\artsl\Documents\Planner#\PERSONAL\Self Learning and Research\Proposals and projects\company management system\cms"
node update_live_database.js --url "PASTE_COMPANY_A_URL_HERE"
```

You'll see the company name, the **database name** (you'll need it
tomorrow) and a table. For a v1.59.0 database it should read
**1.58.0 applied, 1.59.0 applied**, and **MISSING** for every version
from 1.60.0 to 1.73.0 that has a database change. Repeat with the
Company B URL.

**Send me both tables** (they contain no password). If anything looks
different from the above, we sort it out before the update day.

### A4. Rehearse on a copy of the live data (strongly recommended, ~30 minutes)
This follows the standing rule in the CMS Bible (Section 5.10): *test
every migration on a copy before the real database.* Render can make
the copy for you, and it never touches the real database:

1. Render → **cms-db** → **Recovery** → **Point-in-Time Recovery** →
   **Restore Database**. Name it `cms-db-rehearsal`, pick a time at
   least 10 minutes ago, and click **Start Recovery**. It creates a
   **new, separate** database (a small paid instance, billed only
   while it exists).
2. When it's ready, copy **its** External Database URL (not the real
   one!).
3. Run the update against the copy:
   ```
   node update_live_database.js --url "REHEARSAL_URL"
   node update_live_database.js --url "REHEARSAL_URL" --apply --confirm=DATABASE_NAME_IT_PRINTS
   node update_live_database.js --url "REHEARSAL_URL" --script backfill_v1.66.0_fx_rates.js fx_rates.csv --dry-run
   ```
4. **Send me the output.** If everything is ✅, the real run will
   behave the same.
5. Delete `cms-db-rehearsal` afterwards (the database → **Settings** →
   **Delete Database**). Double-check the name first.

Do the same for **cms-b-db** if you like. Its structure is identical,
so one successful rehearsal already proves the migrations; a second
one also proves Company B's own data.

### A5. Tell the members
Send a short notice: *"The system will be updated on <date> between
<time> and <time> (Kampala). Please don't record anything during that
time."*

---

## Part B — Update day (the maintenance pause starts here)

### B1. Make a backup of each database (5 minutes)
Render dashboard → **cms-db** → **Recovery** → **Create export**. Wait
until it appears in the list, then **download** it and keep it. Do the
same for **cms-b-db**.

Render can also restore a database to any moment in the last few days
("Point-in-Time Recovery" on the same page). It restores into a new
database and never overwrites the old one. Note the time you start,
so you know the "before update" moment if it's ever needed.

### B2. Update Company A's database (2 minutes)

```
node update_live_database.js --url "PASTE_COMPANY_A_URL_HERE" --apply --confirm=DATABASE_NAME_FROM_A3
```

It runs the missing migrations **oldest first**
(1.60 → 1.61 → … → 1.73), each one completely or not at all, and ends
with **✅ Database is now at 1.73.0.** and the number of automatic
corrections logged by the v1.72 repair.

If a line says **FAILED**: stop, send me the message, and don't push.
Everything before that file is safely saved; running the same command
again later carries on from where it stopped.

### B3. Update Company B's database
Same command with the Company B URL and its own database name.

### B4. Push the code (Render redeploys both companies)
In PowerShell, from the project folder (one level up from `cms`):

```
cd ..
git status
```

Check that **no `.env` file** appears in the list (they're excluded
on purpose, and should never be pushed). Then:

```
git add -A
git commit -m "v1.60.0 - v1.73.0"
git push
```

In the Render dashboard, **cms-backend**, **cms-frontend**,
**cms-b-backend** and **cms-b-frontend** each start a new deploy. Wait
until all four show **Live** (usually 5–10 minutes; the frontends take
longest).

> The version number shown in the app comes from `render.yaml` /
> `render.company-b.yaml` (now 1.73.0). If the sidebar still shows an
> old number after deploying, open the Blueprint → **Manual Sync** →
> **Sync now**.

### B5. Quick health check
- Open `https://<your-backend>.onrender.com/health` → it should show `"status": "OK"`.
- Log in. The sidebar (bottom) should show **Version 1.73.0** and the new layout.
- **Accounts**: every balance must match your A1 snapshot exactly.
- **Reports & ledger → Financial Statements → Balance Sheet**: it should say balanced.

If a balance differs or a page shows an error: **stop**, keep the
pause going and send me a screenshot. Render keeps the previous
deploy; your backups from B1 are there if ever needed.

---

## Part C — One-time setup in the app (per company, ~30 minutes)

Do these **in this order**. Several steps depend on the one before.

### C1. Exchange rates first (needed by everything that values EUR in UGX)
Your `cms/fx_rates.csv` already holds the EUR→UGX rates from Jan 2025
to Sep 2026. Load them, trying a dry run first:

```
node update_live_database.js --url "PASTE_URL" --script backfill_v1.66.0_fx_rates.js fx_rates.csv --dry-run
node update_live_database.js --url "PASTE_URL" --script backfill_v1.66.0_fx_rates.js fx_rates.csv
```

It must end with **✅ Every posted transaction now has a UGX value.**
If it lists entries still missing a value (e.g. something dated
before Jan 2025), add a row for that month to `fx_rates.csv` and run
it again. It never overwrites a rate that's already there.

(Single rates can also be added in **Settings → Exchange Rates**.)

### C1b. Fixed rate before 20 Aug 2025 (v1.76.0) — before C2
**Full step-by-step (with what each output should look like): `UPDATE_GUIDE_v1.76_fixed_rate.md`.** In short:
By company decision, 1 EUR = UGX 4,000 for every date before 20 August 2025.
Push the v1.76.0 code, apply its migration (`node update_live_database.js --url "PASTE_URL" --apply --confirm=<database name>`),
then put the rule into the books, dry run first:

```
node update_live_database.js --url "PASTE_URL" --script apply_fixed_rates_v1.76.0.js --dry-run
node update_live_database.js --url "PASTE_URL" --script apply_fixed_rates_v1.76.0.js
```

It must end with **✅ Every date before the cut-off uses the fixed rate; transfers unchanged; every posted transaction has a UGX value.**
If it lists entries that keep a MANUAL rate and those should be 4,000 too, run it again with `--include-manual`.
If it says it reopened FX revaluation months, run them again on Financial Statements › FX & Revaluation.
(A new database needs none of this: `fx_rates.csv` already starts with the 4,000 rate.)

### C2. Registered share values → opening share conversion
Since v1.69 the system works in **whole shares plus share credit**,
and **refuses new contributions until the opening conversion has run.**
1. As a **Director or the Treasurer**, go to **Share capital →
   Overview → Registered values**, and enter the nominal value per
   share, its currency and the number of registered shares (from your
   notes: Investabo UGX 50,000 × 98; Zweck Tukula UGX 100,000 × 600).
2. Then, as the **Treasurer or an Admin**, go back to **Share capital →
   Overview → Opening conversion — required once** and click **Preview
   the conversion**. Read the table (each member's old shares, whole
   shares, share credit and new %). If it matches your records, click
   **Run the opening conversion** and confirm. It can only ever run once.

### C3. Share receipts in one currency

```
node update_live_database.js --url "PASTE_URL" --script backfill_v1.67.0_share_receipts.js --dry-run
node update_live_database.js --url "PASTE_URL" --script backfill_v1.67.0_share_receipts.js
```

This only adds the currency and rate to receipts already issued. It
changes no shares or amounts.

### C4. Tax settings (v1.70)
**Tax → Settings** (or **Settings → Registration & Tax**): enter the
company TIN (10 digits), registration number, incorporation date and
tax office. Check the tax rates listed, and set the **WHT agent**
switch: off unless URA has designated the company. Then, under
**Settings → Categories**, check each expense category's **tax
treatment** (deductible, not deductible or capital).

### C5. Roles and permissions
**Settings → Roles**:
- Grant the new permission **SAVINGS_CURRENCY_CONVERT_CREATE**
  (convert a member's savings between currencies) to the roles that
  should have it, e.g. Treasurer.
- Check what the **Assistant Treasurer** may record. From v1.73, all
  their money entries wait in **Money → Awaiting approval** for the
  Treasurer or an Admin.

### C6. Things to glance at
- **Investments → Portfolio**: open each **bond**. If it shows the
  amber note *"This bond has no term assigned yet"* (the v1.60 update
  fills most automatically), click **Set Bond Term** and choose it.
- **Reports & ledger → Records check**: should show **0 differences**.
  The corrections list shows anything the v1.72 repair fixed. Rows
  marked **Needs a look** tell you what a person should decide.
- **Settings → Integrations** (optional): connect Google Calendar for
  automatic Meet links. It needs `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` in Render first; see `DEPLOYMENT_GUIDE.md`
  Step 3c. Skip it if you don't need it.

### C7. End the pause
Tell the members the system is back. Mention the new look, **Money →
Awaiting approval**, and that reversals now need a second person.

---

## If something goes wrong

| Situation | What to do |
|---|---|
| The check (A3) shows something other than "1.58/1.59 applied, rest missing" | Don't continue. Send me the table. |
| A migration says FAILED (B2/B3) | Don't push. Send me the message. Re-running later continues from there. |
| A page errors after the push | Keep the pause, send a screenshot. Render → the service → **Events/Deploys** keeps the previous deploy. |
| A balance differs from your snapshot | Stop and send me both figures. |
| The worst case | Render → database → **Recovery** → Point-in-Time Recovery to the moment noted in B1 (creates a new database), or restore the export you downloaded. We do this together. |

---

## Checklist (tick as you go)

- [ ] A1 balances noted (both companies)
- [ ] A2 connection strings copied (kept private)
- [ ] A3 check run on both → tables sent to Claude
- [ ] A4 rehearsal on a copy ✅ → output sent to Claude, copy deleted
- [ ] A5 members told
- [ ] B1 exports downloaded (both)
- [ ] B2 Company A database → 1.73.0 ✅
- [ ] B3 Company B database → 1.73.0 ✅
- [ ] B4 pushed; four services Live
- [ ] B5 health, version, balances, balance sheet ✅ (both)
- [ ] C1 exchange rates ✅ (both)
- [ ] C1b fixed 4,000 rate before 20 Aug 2025 applied (both) — v1.76.0
- [ ] C2 registered values + opening conversion (both)
- [ ] C3 share receipts (both)
- [ ] C4 tax settings (both)
- [ ] C5 permissions (both)
- [ ] C6 bonds / Records check / (Google)
- [ ] C7 members told the system is back
