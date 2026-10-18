# Updating to v1.84.0 + v1.85.0 — step by step

This covers **your computer (local)** first, then **both online companies**. Do the local part first: if something goes wrong there, nothing online is affected.

The two versions:
- **v1.84.0**
  - Shares are allotted inside the company; certificates and meetings show only URSB-registered shares.
  - Correction of the share register (contributions that were valued at 4,000 instead of the rate of the day).
- **v1.85.0**
  - Projects can be on their own, inside an investment, or added to one later.
  - Documents can be uploaded on project and investment pages.

> Safety rules
> - Paste the Render database URL only into your own terminal. Never paste it into a chat or a document.
> - Every script below has a **dry run** first. Read what it prints before saving.
> - Each migration and script runs as one database transaction. If it stops with an error, nothing from it is saved, and you can run it again.

---

## Part A — Your computer (local)

### A1. Stop what is running
In the terminal windows running the backend (`cms`) and the frontend (`cms-frontend`), press **Ctrl + C**.

### A2. Open a terminal in the `cms` folder
In File Explorer, open `company management system\cms`, click the address bar, type `powershell`, and press Enter.

### A3. Check which updates are missing (read-only)
```
node update_live_database.js
```
- With no `--url`, it uses the database in `cms\.env` (your local one).
- It prints the **database name** it reached, then a list of versions. Expect **1.84.0** and **1.85.0** to show as *missing*.
- Write down the database name.

### A4. Apply the missing updates
```
node update_live_database.js --apply --confirm=<the database name from A3>
```
It should end with **"Database is now at 1.85.0."** Running it again only says "up to date".

#### A4a. If it stops with "must be owner of table …" (local only)
**Why:** some tables or functions in your local database were created by the PostgreSQL administrator account (`postgres`), for example when a file was run in pgAdmin. The system connects as the user in `cms\.env` (`DB_USER`), and PostgreSQL only lets a table's owner change it. Nothing was saved by the failed step.

**Fix, once:**
1. Look first. This changes nothing:
   ```
   node fix_local_table_owner.js
   ```
   - It asks for the password of the PostgreSQL administrator `postgres`: the one you chose when you installed PostgreSQL on this computer.
   - It lists what belongs to someone else (for example `share_certificates`, and the functions `fx_rate_on`, `recompute_transfer_fx`, `set_transaction_functional_amount`).
2. Change the owner. This changes ownership only; no data and no figures are touched:
   ```
   node fix_local_table_owner.js --apply
   ```
   It must end with "✅ Done — <your DB_USER> now owns them."
3. Run A4 again:
   ```
   node update_live_database.js --apply --confirm=<the database name from A3>
   ```
   It carries on from where it stopped, and must end with "Database is now at 1.85.0."

If your administrator account is not called `postgres`, add `--admin=<its name>` to both commands. The online (Render) databases do not need this step.

### A5. Fixed rate (only if the yellow "Not yet applied … apply_fixed_rates_v1.76.0.js" banner still shows)
```
node update_live_database.js --script apply_fixed_rates_v1.76.0.js --dry-run
```
- If the dry run ends OK, run the same command **without** `--dry-run`.
- If it stops because a contribution "would change value", skip this step. The share-register correction in A6 handles that case.

### A6. Share register: check, then correct
1. Check (read-only):
   ```
   node update_live_database.js --script check_fixed_rate_share_impact_v1.83.1.js
   ```
   Look at **section 0**.
   - "No mismatches" → go to A7.
   - Contributions are listed → continue with step 2.
2. Dry run of the correction:
   ```
   node update_live_database.js --script rebuild_share_register_v1.84.0.js --dry-run
   ```
   Read the report:
   - **1) Each member:** shares now → new, and credit now → new.
   - **2) Correction allotments:** the extra shares, each dated on its contribution.
   - Every check must say ✅. It must end with "DRY RUN — rolled back, nothing was saved".
3. Save:
   ```
   node update_live_database.js --script rebuild_share_register_v1.84.0.js
   ```
   It must end with **"✅ Saved."**

If either step says "nothing to correct" or "the opening share conversion has not run", this database needs nothing. That is fine.

### A7. Frontend packages
In a terminal in the `cms-frontend` folder:
```
npm install
```
This also fixes the earlier "Can't resolve 'pdfjs-dist…'" error.

### A8. Start everything again
Start the backend and frontend the way you normally do (for example `npm run dev` in `cms` and `npm start` in `cms-frontend`).

### A9. Check in the app (log in as Admin)
1. **Members' funds › Share capital › Registered (URSB):**
   - Click **Issue certificates for registered shares** once.
   - It answers how many were issued. A second click issues nothing new.
2. **Reports › Certificate Signing Rounds:**
   - The signatories sign the new "Registration" round.
   - The certificates are emailed once it is fully signed.
3. **Members' funds › Share capital › Allotments & Returns:** allotments marked **"Rate correction"** (if A6 saved any) are waiting for their return of allotment.
4. **Investments › Projects** is in the menu. Try **New project**, open it, and upload a document.
5. **Open an investment:**
   - The Projects card has **New project**.
   - There is an **Investment documents** card.
6. **Reports › Records check:** money market funds, investments and the new **Projects** section should show no differences.
7. **Profile:** a shareholder sees **Download Latest Registration Certificate**.

If all of that works, go online.

---

## Part B — Online (do B1–B6 for company 1, then again for company 2)

The share register problem was first seen on one company, but **the other company may have the same problem**, so both get the full check.

### B1. Maintenance on
In that company's online system, go to **Settings › Maintenance**, turn it on, and optionally email the members.

### B2. Copy that company's database URL
1. In the Render dashboard, open that company's **database** (for example `cms-db`, then later `cms-b-db`).
2. Go to **Connect › External Database URL** and click copy.

Use that URL in place of `"…"` below. Keep the quotes.

### B3. Check, then apply the updates
```
node update_live_database.js --url "…"
node update_live_database.js --url "…" --apply --confirm=<database name it printed>
```
It must end with "Database is now at 1.85.0."

### B4. Fixed rate (only if that company still shows the yellow banner)
```
node update_live_database.js --url "…" --script apply_fixed_rates_v1.76.0.js --dry-run
node update_live_database.js --url "…" --script apply_fixed_rates_v1.76.0.js
```
Run the second line only if the dry run was OK.

### B5. Share register: check, dry run, save
```
node update_live_database.js --url "…" --script check_fixed_rate_share_impact_v1.83.1.js
node update_live_database.js --url "…" --script rebuild_share_register_v1.84.0.js --dry-run
node update_live_database.js --url "…" --script rebuild_share_register_v1.84.0.js
```
- For the company that failed before, expect about **736 → 759 shares** in total.
- Save (the third line) only if every check in the dry run said ✅.
- "Nothing to correct" means that company is fine.

### B6. Repeat B1–B5 for the other company
Use the **other** database's URL.

---

## Part C — Publish the new code (once, for both companies)

### C1. Push to GitHub
With **GitHub Desktop**:
1. Open the repository.
2. Check the list of changed files.
3. Write the summary `v1.84.0 + v1.85.0 — registered shares, projects`.
4. Click **Commit to main**, then **Push origin**.

Or in a terminal at the project folder:
```
git add -A
git commit -m "v1.84.0 + v1.85.0 — registered shares, projects"
git push
```

### C2. Wait for Render
Every service (both backends and both frontends) redeploys by itself. Wait until each one shows **Live** in the Render dashboard. The version shown at the bottom of the menu becomes **1.85.0**.

## Part D — In each online company
1. **Share capital › Registered (URSB) › Issue certificates for registered shares**, once.
2. The signatories sign the Registration round under **Reports › Certificate Signing Rounds**.
3. **Reports › Records check:** no differences expected.
4. **Settings › Maintenance:** turn it off.

## Part E — Afterwards, with URSB
1. For every allotment marked **"Rate correction"**, file the return of allotment with URSB.
2. In **Allotments & Returns**, tick those allotments and **mark them filed** with the URSB reference.
3. The system then counts them as registered and issues each member a **Registration certificate** showing the increase and the effective date. They are emailed after signing.

Some of these returns may show as **overdue**, because the allotments are dated on the original contributions. This is expected. File them as soon as you can.

---

## If something goes wrong
| What you see | What to do |
|---|---|
| `That --url is not a valid connection string` | Copy the **External** Database URL again (it starts with `postgresql://`) and keep the quotes around it. |
| `--confirm` refused | Type the database name exactly as the check printed it. |
| A migration stops with an error | Nothing from that file was saved. Copy the error message (not the URL) to me. |
| Rebuild says "split/consolidation" or "dividend declared on or after …" | Nothing was saved. Send me the message; a person has to decide about those first. |
| Rebuild check fails ("A check failed, so nothing was saved") | Send me the printed lines (not the URL). |
| A page is blank after the update | Refresh with Ctrl + F5. Locally, run `npm install` in `cms-frontend` again. |
| Records check shows a project difference | Open the project. The page shows both figures. Send me the project reference. |
