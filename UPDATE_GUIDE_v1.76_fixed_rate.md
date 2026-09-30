# Putting the fixed rate live — 1 EUR = UGX 4,000 before 20 Aug 2025

**For:** both companies (Investabo — `cms-…` services, and Zweck Tukula — `cms-b-…` services)
**Code version you push:** 1.77.0 (it contains the fixed-rate change from 1.76.0, plus the dashboard and phone fixes)
**Time needed:** about 45 minutes for both companies, most of it waiting for Render
**Where you start from:** the rates from `fx_rates.csv` were already loaded online (update guide step **C1**), and the opening share conversion (step **C2**) has **not** run yet.

> Do this **before** the opening share conversion (C2). The script refuses to run once shares have been allotted. That is deliberate: shares are worked out from the shilling values this step corrects.

---

## What will change, in plain words

| | Before | After |
|---|---|---|
| Rate for any date **before 20 Aug 2025** | the monthly rates from `fx_rates.csv` (3,800.96 … 4,244.16) | **4,000** for every date — including dates before 2025 that had no rate at all |
| Rate from **20 Aug 2025 onwards** | 4,154.70 for August, then the monthly rates | **unchanged** (4,154.70 now simply starts on 20 Aug) |
| A euro entry dated before 20 Aug 2025 | EUR amount × that month's rate | EUR amount × **4,000** |
| Transfers from the Euro account to a UGX account | own recorded rate | **unchanged** — the shillings that actually arrived stay the same |
| Anything already in shillings | — | **unchanged** |
| Entries an Admin gave a manual rate | own manual rate | **unchanged** unless you add `--include-manual` (step 8) |
| Month-end FX revaluations already closed | stored | reopened from the first affected month; you **run them again** (step 11) |
| Setting a different rate before 20 Aug 2025 later | allowed | **refused** everywhere (Set rate, manual rate, rates file) |

No money is moved and no account balance (in its own currency) changes. What changes is the **UGX value** that the financial statements show for those euro entries.

---

## What you need

- The **Render dashboard** (https://dashboard.render.com), signed in.
- The way you normally push code to **GitHub** (the same as for every update).
- A login with the **Admin** role (for Maintenance mode and to check the Accounts page).
- A login with the **Treasurer** role (to run the month-end revaluation again).

You will **not** need any database connection string. Every command runs inside Render's own **Shell** for the backend service, which already knows its database. Never paste a connection string into a chat or a document.

---

## Step 1 — Back up both databases (5 minutes)

1. Render dashboard → click **cms-db** (Company A's database).
2. Left menu → **Recovery** → **Create export**.
3. Wait until the export appears in the list (a minute or two), then click it to **download** the file. Keep it somewhere safe.
4. Do the same for **cms-b-db** (Company B).
5. Write down the time now (for example "30 Sep, 19:40"). If anything ever had to be undone, Render's *Point-in-Time Recovery* on the same page can restore the database to just before this moment.

## Step 2 — Push the code (5–10 minutes of waiting)

1. Push your project folder to GitHub, exactly as you normally do. A commit message such as `v1.77.0 fixed EUR rate before 20 Aug 2025 + phone fixes` is fine.
2. In the Render dashboard, watch the four services: **cms-backend**, **cms-frontend**, **cms-b-backend**, **cms-b-frontend**. Each one shows *Deploy in progress* and then **Live**.
3. If one shows **Deploy failed**: open it → **Logs**, copy the red lines, send them to me and stop here. Nothing in the database has changed yet.

It is safe for the new code to run for a few minutes before the database steps below. Every new part checks whether its database change is there yet, and simply waits if it isn't.

---

## Company A (Investabo) — steps 3 to 12

### Step 3 — Open the Shell for Company A's backend
1. Render dashboard → **cms-backend** → left menu → **Shell**.
2. Wait for a line ending in `~/project/src/cms $`. You are **already** in the `cms` folder, so do **not** type `cd cms`.

> **Copying a command:** paste it into the Shell with **Ctrl+Shift+V** (or right-click → Paste), then press **Enter**. To copy output, select it with the mouse and press **Ctrl+Shift+C**. Taking a screenshot is fine too.

### Step 4 — Check the database (changes nothing)
```
node update_live_database.js
```
What you should see:
- A line saying `(no --url given — using the database in cms/.env)`. That is expected here: on Render it uses the settings Render gives the backend.
- The **database name** it reached, for example `investabo_db`. **Write it down** — you need it in step 5.
- A list of versions. The last ones should read something like:
  ```
  1.74.0   MISSING   maintenance mode                        (or "applied")
  1.75.0   MISSING   password & email changes                (or "applied")
  1.76.0   MISSING   fixed EUR rate before 20 Aug 2025 (then run apply_fixed_rates_v1.76.0.js)
  ```
  Versions already marked *applied* are fine. It ends with `This was a CHECK only — nothing was changed.`

### Step 5 — Apply the missing database changes
Replace `DATABASE_NAME` with the name you wrote down in step 4:
```
node update_live_database.js --apply --confirm=DATABASE_NAME
```
It must end with:
```
✅ Database is now at 1.76.0.
```
If a line says **FAILED**, stop and send me that message. Everything before it is safely saved, and running the same command again later carries on from where it stopped.

(This step only **adds** the rule and the new tables. No amount changes yet.)

### Step 6 — Turn on Maintenance mode (2 minutes)
In the website, as an **Admin**: **Settings → Maintenance** → optional message such as *"Updating exchange rates — back in 20 minutes"* → **Turn on**.
Members now see the maintenance page, and Admins keep working with an amber bar at the top. This stops anyone entering money while the rates are being corrected. Keep the Render Shell tab open.

### Step 7 — Dry run: see exactly what will change (changes nothing)
Back in the **cms-backend** Shell:
```
node update_live_database.js --script apply_fixed_rates_v1.76.0.js --dry-run
```
Read the report section by section.

**`Rule #1: 1 EUR = 4,000.00 UGX for every date before 2025-08-20`** — the rule being applied.

**`1) EXCHANGE-RATE TABLE`** — for your data, expect:
```
- removed  EUR→UGX   3,808.69   2025-01-01 → 2025-02-01
- removed  EUR→UGX   3,800.96   2025-02-01 → 2025-03-01
  … (January to July 2025 — 7 lines "removed")
~ moved    EUR→UGX   4,154.70   2025-08-01 → 2025-09-01  → now starts 2025-08-20
+ added    EUR→UGX   4,000.00   2000-01-01 → 2025-08-20
```
"Removed" rates are not lost. Their values are written into the audit log when you run it for real.

**`2) MONTH-END FX REVALUATIONS`** — either *"None stored … nothing to reopen"*, or *"Reopened N month(s): 2025-… … 2025-…"*. If months are reopened, **write down the last date**: you will close up to it again in step 10.

**`3) UGX VALUE OF TRANSACTIONS`** — how many entries get a new shilling value, the totals before and after, and a row-by-row list:
```
#   date        amount       old rate    new rate     old UGX      new UGX   description
12  2025-02-10  30.00 EUR    3,800.9600  4,000.0000   114,028.80   120,000.00  …
```
Check two or three rows yourself: **EUR amount × 4,000 = new UGX**. Every date in the list must be **before 20 Aug 2025** (a reversal made later of an early entry can appear too, because it follows the entry it reverses).
If the report lists entries that *"keep the MANUAL rate an Admin gave them"*, decide now whether those should also become 4,000 (see step 8).

**`4) TAX RECORDS`, `5) CAPITAL-GOAL PLEDGE PAYMENTS`** — usually *"None…"* for dates that early.

**`6) LEFT AS RECORDED`** — counts only, for your information. For example `Transfers EUR/UGX before 2025-08-20 (own rate kept)   3`: those transfers keep their real rate, as agreed.

**The check lines at the end** — these must be there:
```
Check: 1 EUR on 2025-08-19 = 4,000.00 UGX;  on 2025-08-20 = 4,154.70 UGX
✅ Every date before the cut-off uses the fixed rate; transfers unchanged; every posted transaction has a UGX value.

DRY RUN — rolled back, nothing was saved.
```
If instead you see a line starting with **❌**, nothing has been changed. Copy the message and send it to me. The ❌ messages you could meet:
- *"The opening share conversion has already run…"* — C2 was done after all. Stop; this needs a different correction.
- *"…withholding-tax record(s) … already paid over to URA…"* — a tax payment needs a decision first. Stop and send me the ids.
- *"A check failed…"* — send me the lines under it.

**Please send me the dry-run output (a copy or screenshots) before step 8**, so we can confirm the numbers together.

### Step 8 — Run it for real
If you want entries with a manual rate to become 4,000 as well, add `--include-manual` at the end. Otherwise use it exactly as shown:
```
node update_live_database.js --script apply_fixed_rates_v1.76.0.js
```
The report is the same as the dry run, but it ends with:
```
✅ Saved.
   Next: Financial Statements › FX & Revaluation › run the revaluation through 2025-… again.   (only if months were reopened)
   Then carry on with the opening share conversion (update guide step C2).
```
Everything happens in **one database transaction**: either all of it is saved, or none of it.

### Step 9 — Prove it's done: run it once more
```
node update_live_database.js --script apply_fixed_rates_v1.76.0.js --dry-run
```
Now section 1 should say `Already correct — nothing to change.`, section 3 `Already correct — no transaction changes value.`, and the ✅ check line should still be there.

### Step 10 — Close the reopened months again (only if step 7 reopened any)
In the website as the **Treasurer**: **Reports → Financial Statements** (the General ledger page) → tab **FX & Revaluation** → card *"Close months (month-end revaluation)"* → set **"Close every month end up to"** to the last date you wrote down in step 7 (or later) → **Run revaluation**.
When it finishes, the card should say the months are closed, and months before 20 Aug 2025 show a closing rate of **4,000**.

### Step 11 — Check it in the website (5 minutes)
1. **Money → Accounts**. Under *Currency Exchange Rates* there is an amber note: *"Fixed by company decision: 1 EUR = 4,000 UGX for every date before 20 Aug 2025…"*. It must **not** say *"Not yet applied to the books"*.
2. On the same card, press **Set Rate**, choose EUR → UGX, rate 4100, date 2025-05-01 and press **Set Rate**. It must be **refused** with *"By company decision the rate is fixed…"*. That is the guard working. Close the form.
3. **Reports → Financial Statements → Balance Sheet** tab, as of **19 Aug 2025** and again as of **today**: the green badge reads *"Assets = Liabilities + Equity"* both times. (On the **Trial Balance** tab: *"Debits = Credits"*.)
4. Same page → **General Ledger** tab → pick a euro contribution dated before 20 Aug 2025. Its UGX amount is the EUR amount × 4,000 (for example EUR 30 → UGX 120,000).

### Step 12 — Company A is done
Leave Maintenance mode **on** until Company B is finished, or turn it off now for Company A (**Settings → Maintenance → Turn off**). Either is fine.

---

## Company B (Zweck Tukula) — repeat steps 3 to 11

Do exactly the same, with these differences:
- Step 3: open the Shell of **cms-b-backend** (not cms-backend).
- Step 4: note **Company B's** database name. It is different from Company A's.
- Step 6: turn on Maintenance mode in **Company B's** website.
- Steps 7–11: Company B's own numbers will be different. Send me its dry-run output too.

---

## Step 13 — Finish
1. Turn **off** Maintenance mode in both websites (**Settings → Maintenance → Turn off**). Any nightly jobs skipped while it was on run automatically at that moment.
2. Tick **C1b** in the checklist of `UPDATE_GUIDE_v1.59_to_v1.73.md`, then carry on with **C2 — the opening share conversion**. Its preview now works from the corrected values: every contribution before 20 Aug 2025 counts at 4,000 per euro.

---

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `Deploy failed` on a Render service | the new code didn't build | send me the red lines from **Logs**; the database is untouched |
| `bash: cd: cms: No such file or directory` | you are already in `cms` | skip `cd cms` |
| `❌ The table fx_fixed_rate_periods is missing` | step 5 was skipped | do step 5, then step 7 again |
| `❌ The opening share conversion has already run` | C2 was done | stop — nothing was changed; tell me |
| `❌ … already paid over to URA …` | a WHT payment would change value | stop — nothing was changed; send me the ids |
| `❌ Failed, nothing was saved: …` | an unexpected error | copy the whole message to me; nothing was changed |
| The Accounts note says *"Not yet applied"* | step 8 wasn't run (or was a dry run) | run step 8 |
| Members still see the maintenance page | Maintenance mode is on | Settings → Maintenance → Turn off |
| You want to undo it all | — | Render → the database → **Recovery** → restore to the time written in step 1 (it creates a new database; ask me before switching to it) |

---

## Checklist

- [ ] 1. Both databases exported and downloaded; time noted
- [ ] 2. Code pushed; all 4 services **Live**
- [ ] Company A: 4 check · 5 apply (✅ 1.76.0) · 6 maintenance on · 7 dry run (sent to Claude) · 8 real run (✅ Saved) · 9 re-run says "Already correct" · 10 revaluations closed again · 11 checks OK
- [ ] Company B: the same, in **cms-b-backend**
- [ ] 13. Maintenance off in both · continue with C2
