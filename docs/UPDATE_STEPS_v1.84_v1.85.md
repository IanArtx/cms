# Updating to v1.84.0 + v1.85.0 + v1.85.1 + v1.85.2 + v1.86.0 + v1.86.1 + v1.86.2 + v1.87.0 — step by step

This covers **your computer (local)** first, then **both online companies**. Do the local part first: if something goes wrong there, nothing online is affected.

The versions:
- **v1.84.0**
  - Shares are allotted inside the company; certificates and meetings show only URSB-registered shares.
  - Correction of the share register (contributions that were valued at 4,000 instead of the rate of the day).
- **v1.85.0**
  - Projects can be on their own, inside an investment, or added to one later.
  - Documents can be uploaded on project and investment pages.
- **v1.85.1** (no database change)
  - Every person involved signs receipts in their own position (recorder, approver, requesting/pledging member).
  - Settle Fines With Savings shows the savings in every currency instead of "NaN".
- **v1.85.2** (no database change)
  - The investments page shows what is held in investments now (including money market fund interest and withdrawals), not the money put in over time.
  - Closed investments count nothing; their gain or loss is listed under "Closed investments", and anything booked after closing is flagged.
- **v1.86.0** (database change)
  - New accounts are **by invitation only**: you invite people from **Members › Invitations**, and the Register page refuses anyone without an invitation link.
  - **Members › Access Requests** lists every account that never got a role, with warnings. You can **decline** the ones you don't recognise (one or many at once), block their email address, and remove them completely if they have no activity.
  - Addresses that cannot receive email (like `…@blockaid-scan.invalid`) can no longer register at all. Each night, accounts left unverified for 3 days are declined automatically.
- **v1.86.1** (no database change; one new backend package)
  - **Members › Register:** the register of members and officers, always up to date. Download it as Excel, CSV or PDF.
- **v1.86.2** (no database change)
  - The daily Bank of Uganda rate check tries again (3 times) when BoU's website has a passing problem such as "status 502", and its message says which address failed and why.
- **v1.87.0** (database change)
  - **Requisitions** go through four steps: *requested › approved › released › received*. Approving no longer pays. A **different** person (Treasurer, Assistant Treasurer or Admin) releases the money, with the account, date, method and payment reference. The person who asked then confirms receipt with their signature, and a **Requisition Form** showing every person and what they did is filed in Documents. Requisitions that were approved and paid before become *Released*, so their requesters can still confirm receipt.
  - **Meetings:** the notice date is the date the notice was actually given, not the day it was typed in. It can be corrected (with a reason) on meetings that are not closed.
  - **Proxy forms** are filled in and signed in the system by members who cannot attend (a person in the system or a typed name). They close 48 hours before the meeting; the Secretary can record a paper or late one.
  - **Accounts without a role** no longer appear in any list to pick from, cannot sign in unless invited, and are removed after 7 days. Invited people waiting for their role are kept; an account with records is declined instead.
  - **Deleting an account** no longer fails with "Something went wrong".

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
- It prints the **database name** it reached, then a list of versions. Expect **1.84.0**, **1.85.0**, **1.86.0** and **1.87.0** to show as *missing* (only the ones you have not done yet).
- Write down the database name.

### A4. Apply the missing updates
```
node update_live_database.js --apply --confirm=<the database name from A3>
```
It should end with **"Database is now at 1.87.0."** Running it again only says "up to date".

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
   It carries on from where it stopped, and must end with "Database is now at 1.87.0."

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

### A6b. Signatories on receipts already issued (v1.85.1)
```
node update_live_database.js --script backfill_v1.85.1_receipt_signatories.js --dry-run
node update_live_database.js --script backfill_v1.85.1_receipt_signatories.js
```
- The dry run lists every share purchase receipt with who will appear on it, for example "Recorded by Amy (Assistant Treasurer); Approved by Salomon (Treasurer)".
- If the list looks right, run the second line. It must end with "✅ Saved — N receipt(s) now list everyone involved."
- Only the signatories are added; amounts, shares and dates stay as issued. Running it again changes nothing.

### A7. Packages (backend and frontend)
1. In the terminal in the `cms` folder (the one from A2):
   ```
   npm install
   ```
   This adds `exceljs`, which makes the Excel register of members (v1.86.1). Without it, only the Excel download fails (with "Cannot find module 'exceljs'"); everything else works.
2. In a terminal in the `cms-frontend` folder:
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
8. **Documents › a share purchase receipt › Preview:** the bottom shows one signature block per person, each with their position.
9. **Investments › Portfolio:** the first tile is **Held in Investments Now**. Its money market fund part equals the sum of the funds' balances. The chart shows "Held now (running balance)". If any investment is closed, a **Closed investments** card lists it with its result.
10. **Members' funds › Fines › Settle With Savings:** choose a member. Their savings show in each currency (no "NaN"). Fines in another currency than the ones chosen are greyed out with the reason.
11. **Office › Members** has two new tabs, **Access Requests** and **Invitations**:
    - **Access Requests › Waiting for access** lists accounts that never got a role. Fake addresses are flagged in red.
    - **Access settings** (below the list) shows *By invitation only (recommended)*.
    - Sign out, open the Register page: it says accounts are by invitation only.
    - Sign in again, go to **Invitations**, invite your own second email address, open the email and register from the link. The email is filled in for you, and you can sign in straight away. The role then waits under **Role Requests**.
12. **Office › Members › Register:**
    - It lists every member with roles, details and shares.
    - **Download Excel** gives a file with four sheets (Members, Roles, Former members, About). Open it and check it.
    - **Print / Save as PDF** shows the register on the company letterhead.
    - Where details are missing (phone, address, ID number), the page says how many; ask those members to complete *My profile*.
13. **Money › Requisitions (v1.87.0)** — you need three people for this test (or three test accounts):
    - As a member, make a small **Money Request** with a document attached.
    - As the Treasurer, **Approve** it. Check that no money left the account yet (Accounts page).
    - Still as the Treasurer: the **Release money** form says you cannot release what you approved. As the Assistant Treasurer (or Admin), **Release money**: account, date, method, reference. The payment now shows under Transactions.
    - As the member, **My Requests › Acknowledge receipt**. Then open **Documents** and preview the new **Requisition Form**: four steps with names, dates and signatures.
    - Older requisitions that were paid before show **Released** with the note "approved and paid in one step"; their requesters can acknowledge them.
14. **Office › Meetings (v1.87.0):**
    - On a meeting at *Notice issued*, click **Correct the notice date**, choose the real date, give a reason, save. The days of notice change.
    - On a general meeting more than 48 hours away, as a shareholder, **Proxies › Appoint a proxy**. Pick a person or type a name, tick, lodge. The form appears in Documents and the register shows "By proxy". **Withdraw my proxy** undoes it.
    - As the Secretary, **Record a proxy for a member**.
    - **Rules & company details** has *Proxy forms close before the meeting: 48 hours*.
15. **Office › Members (v1.87.0):**
    - **Access Requests › Access settings** shows *Remove accounts with no role after (days): 7*.
    - Pick lists elsewhere (for example Deposits › choose a member, or a meeting's chairperson) show only people with a role.
    - Try **Delete Permanently** on a test account: it is removed, or the message says which records stop it — never "Something went wrong".

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
It must end with "Database is now at 1.87.0."

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

### B5b. Signatories on receipts already issued (v1.85.1)
```
node update_live_database.js --url "…" --script backfill_v1.85.1_receipt_signatories.js --dry-run
node update_live_database.js --url "…" --script backfill_v1.85.1_receipt_signatories.js
```
Save (the second line) only if the people listed in the dry run look right.

### B6. Repeat B1–B5b for the other company
Use the **other** database's URL.

---

## Part C — Publish the new code (once, for both companies)

### C1. Push to GitHub
With **GitHub Desktop**:
1. Open the repository.
2. Check the list of changed files.
3. Write the summary `v1.84.0 – v1.87.0 — registered shares, projects, access control, requisition steps, proxies`.
4. Click **Commit to main**, then **Push origin**.

Or in a terminal at the project folder:
```
git add -A
git commit -m "v1.84.0 - v1.87.0 — registered shares, projects, access control, requisition steps, proxies"
git push
```

### C2. Wait for Render
Every service (both backends and both frontends) redeploys by itself. Wait until each one shows **Live** in the Render dashboard. The version shown at the bottom of the menu becomes **1.87.0**.

## Part D — In each online company
1. **Share capital › Registered (URSB) › Issue certificates for registered shares**, once.
2. The signatories sign the Registration round under **Reports › Certificate Signing Rounds**.
3. **Reports › Records check:** no differences expected.
4. **Remove the accounts you don't recognise (v1.86.0):**
   1. Open **Office › Members › Access Requests**. *Waiting for access* lists every account that never got a role.
   2. Read each row: the warnings (red = fake address or scanner), when it registered, from which internet address, and which role it asked for.
   3. Click **Select the … flagged in red**. This picks the `scan-…@blockaid-scan.invalid` accounts. Also tick anyone else you don't know, for example "Monica Smith".
   4. Click **Decline selected**. Choose the reason "Not known to the company" (or type your own). Keep both boxes ticked:
      - **Block the email address**;
      - **Remove the account completely if it has no activity**.
   5. Click **Decline access**. The message says how many were declined and how many removed.
   6. An account that has any record is kept but inactive. It shows under **Declined**, where **Restore** undoes it.
   7. If you declined someone by mistake: **Declined › Restore** (or **Blocked addresses › Unblock** if it was removed). Then send them an invitation.
5. **Invite** any real member who has not registered yet: **Members › Invitations**. Enter their email, name and role, then **Send invitation**.
   - From v1.87.0, anyone without a role is removed by the system 7 days after registering, and cannot sign in meanwhile unless invited. Give a role (Members › Manage Roles) to every real member who still has none **before the first night after the update**.
6. **Requisitions (v1.87.0):** in **Money › Requisitions › All Requests**, requisitions paid before the update show **Released**. Tell the members concerned to open *My Requests* and click **Acknowledge receipt** — that files their Requisition Form.
7. **Meetings (v1.87.0):** for any meeting not yet closed whose notice date is wrong, click **Correct the notice date**.
8. **Settings › Maintenance:** turn it off.

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
| A member says "Accounts are by invitation only" | Send them an invitation (Members › Invitations). If the email doesn't arrive, copy the link shown after sending and give it to them yourself. |
| "This invitation was sent to a different email address" | They must register with the exact address you invited. Invite the address they actually use. |
| "Access for this account was declined" when someone signs in | Members › Access Requests › Declined › Restore, then give them a role. |
