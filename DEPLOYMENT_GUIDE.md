# Deploying the Company Management System — Step by Step

This guide walks you through putting the CMS live on the internet, from
"nothing is online yet" to "I can log in from my phone." It assumes no
prior deployment experience — every step says exactly what to click.

**What we're using:** [Render](https://render.com) to host both the
backend (the Node.js server) and the frontend (the React website), plus
a managed PostgreSQL database. Render was chosen because it runs a
long-lived server process (this app has a real Express server plus
scheduled nightly jobs — things like Vercel aren't built for that), and
its free/low tiers are enough to get started without deep DevOps
knowledge.

**What it costs:** the backend runs on Render's Starter web service plan
(~$7/month) and the database runs on the Basic-256mb plan (~$6/month for
the instance). Render's Blueprint deploy screen also attaches a 15 GB
disk to the database by default, billed separately at $0.30/GB/month
(~$4.50/month) — so the database line item is actually ~$10.50/month
total, not just the $6/month instance price. Add it up and one company's
full stack (backend + database + disk) runs about **$17.50/month**; the
frontend (a static website) is free. Check
[render.com/pricing](https://render.com/pricing) for the current rate,
since Render occasionally renames/retires tiers or changes disk pricing
(the database plan used to be called "Starter" too, but Render retired
that name for new databases in mid-2026 in favor of Basic/Pro/Accelerated
tiers — this project's `render.yaml` files already use the current
name). Free-tier alternatives exist but they spin your server down
after 15 minutes of inactivity, which would silently break the nightly
scheduled jobs (interest accrual, overdue checks, monthly reports) —
not worth the savings for a system tracking real money.

---

## Before you start — a checklist

- A GitHub account (free) — [github.com](https://github.com)
- A Render account (free to create) — [render.com](https://render.com)
- [Git](https://git-scm.com/downloads) installed on your computer
- A card on file for Render's paid plans (Starter tier, not free)

---

## Step 1 — Put the code on GitHub

Render deploys from a Git repository, not from files on your computer
directly. Right now the project only exists on your machine, so we
need to put it on GitHub first.

1. Go to [github.com/new](https://github.com/new) and create a new
   **private** repository (call it something like `cms`). Don't add a
   README, .gitignore, or license — leave it empty.
2. Open a terminal (Command Prompt or PowerShell) in your project
   folder — the one containing the `cms` and `cms-frontend` folders
   and this guide.
3. Run these commands one at a time:

   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/cms.git
   git push -u origin main
   ```

   Replace `YOUR_USERNAME` with your actual GitHub username. GitHub
   will prompt you to sign in the first time.

4. A `.gitignore` is already in place at the project root and inside
   `cms/` and `cms-frontend/`, so `node_modules/` and your real
   `.env` file (with live database/JWT secrets) are automatically
   excluded from the push — you don't need to do anything extra here,
   just don't remove those files.

---

## Step 2 — Connect Render to your GitHub repo

1. Log into [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account if you haven't already, then select
   the `cms` repository you just pushed.
4. Render will detect the `render.yaml` file at the root of the repo
   (already created for you — it defines the backend, frontend, and
   database all at once) and show you a preview of three resources:
   `cms-backend`, `cms-frontend`, and `cms-db`.
5. Click **Apply**. Render will start creating the database first,
   then building both services. The first build can take 5–10
   minutes (it's installing dependencies from scratch).

---

## Step 3 — Fill in the secrets Render couldn't guess

`render.yaml` auto-generates safe things like JWT signing secrets, but
a few values are company-specific or genuinely secret, and were left
blank on purpose (marked `sync: false` in the file). Set these now:

1. In the Render dashboard, open the **cms-backend** service →
   **Environment** tab.
2. Add values for:
   - `GMAIL_USER` — the Gmail address the system sends emails from
   - `GMAIL_APP_PASSWORD` — a Gmail
     [App Password](https://myaccount.google.com/apppasswords) (not
     your normal Gmail password — Google requires this separate kind
     of password for apps like this one)
   - `COMPANY_EMAIL` — matches what's in your local `.env` file today
   - `COMPANY_ADDRESS` — the company's full registered address, for
     the letterhead on generated documents
3. Open the **cms-frontend** service → **Environment** tab and set:
   - `REACT_APP_COMPANY_ADDRESS` — same address as above
4. Click **Save Changes** on each — this triggers a redeploy
   automatically with the new values baked in.

---

## Step 3b — File storage (Cloudflare R2)

**Why this step exists:** Render's disk is wiped every time the backend
redeploys or restarts. Without this step, every uploaded file — profile
photos, signatures, Documents, Audit report files, expense receipts,
the company logo, stamps — would silently vanish the next time you push
a code change. `storageService.js` (v1.29.1) sends every upload to an
external, persistent bucket instead, so files survive redeploys forever.
This guide uses **Cloudflare R2** because it has a generous free tier
(10 GB storage, no charge for the bandwidth this app uses) and no
surprise egress bill — but the code works identically with AWS S3,
Backblaze B2, or DigitalOcean Spaces if you'd rather use one of those;
only the env var values below would change, not the app.

1. **Create a Cloudflare account** (free) at
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) if
   you don't already have one.
2. In the Cloudflare dashboard, find **R2 Object Storage** in the left
   sidebar (under "Storage" — Cloudflare sometimes calls it just "R2").
   The first time you open it, Cloudflare asks you to "activate" R2 —
   this requires adding a card, but the free tier below normal usage
   costs nothing.
3. Click **Create bucket**. Give it a name like `cms-uploads` (Company
   B, if you're running a second company, should get its own separate
   bucket — e.g. `cms-b-uploads` — so the two companies' files never
   mix). Leave the default region/location setting as-is. Click
   **Create bucket**.
4. Now generate API credentials so the backend can write to that
   bucket:
   - Still inside R2, click **Manage R2 API Tokens** (or **API** in the
     sidebar, depending on Cloudflare's current layout).
   - Click **Create API token**.
   - Give it **Object Read & Write** permission, and scope it to the
     one bucket you just created (not "all buckets") — that way, even
     if this token ever leaked, it couldn't touch anything else in your
     Cloudflare account.
   - Click **Create API Token**. Cloudflare shows you an **Access Key
     ID** and a **Secret Access Key** exactly once — copy both
     somewhere safe immediately (a password manager, not a plain text
     file). If you lose them, you'll just delete the token and make a
     new one; there's no way to view the secret again later.
   - Cloudflare also shows a **jurisdiction-specific endpoint URL** on
     this same screen, something like
     `https://<a long account id>.r2.cloudflarestorage.com`. Copy that
     too — it's the value the app calls `S3_ENDPOINT`.
5. Back in the Render dashboard, open the **cms-backend** service
   (or **cms-b-backend** for Company B) → **Environment** tab, and fill
   in the four blank values `render.yaml` already left waiting for you:
   - `S3_ENDPOINT` — the endpoint URL from step 4
   - `S3_BUCKET` — the bucket name from step 3 (e.g. `cms-uploads`)
   - `S3_ACCESS_KEY_ID` — the Access Key ID from step 4
   - `S3_SECRET_ACCESS_KEY` — the Secret Access Key from step 4
   - (`S3_REGION` is already set to `auto` for you — R2 always uses
     that exact value, so there's nothing to change here.)
6. Click **Save Changes** — Render redeploys the backend automatically
   with the new values. From this point on, every new upload goes to
   R2 instead of the backend's local disk.

**A note on files uploaded before this step:** anything uploaded while
the app was still using local disk only survives until the next
redeploy/restart — this step only makes *future* uploads persistent. If
you already have real photos/signatures/documents in production that
predate setting this up, they may already be gone by the time you read
this (that's the exact problem this step fixes going forward). There is
no automatic migration of old local-disk files into R2, since Render's
disk being wiped on redeploy means those old files are typically already
unrecoverable by the time you're reading this section.

---

## Step 4 — Load the database schema (one-time)

The database exists now, but it's empty — no tables yet. This is a
one-time manual step (not something the Blueprint automates, since
`schema.sql` is meant to run exactly once against a brand-new
database).

1. In the Render dashboard, open the **cms-db** database → click
   **Connect** → copy the **External Connection String** (it looks
   like `postgresql://cms:...@....render.com/cms`).
2. On your own computer, open a terminal in your project folder and
   run:

   ```
   psql "PASTE_THE_CONNECTION_STRING_HERE" -f cms/schema.sql
   ```

   (If `psql` isn't installed, install
   [PostgreSQL's command-line tools](https://www.postgresql.org/download/)
   — you only need the client, not a full server.)
3. You should see a long stream of `CREATE TABLE`, `CREATE INDEX`, and
   `INSERT` messages with no errors. That's the whole schema —
   tables, indexes, permissions, seed roles/categories/currencies —
   loaded in one shot.

**If you already had a database running an older version** (v1.1.0
through v1.3.0) instead of setting up fresh, run the matching
`migration_vX.X.0.sql` file(s) from the `cms/` folder in order instead
of `schema.sql` — each one is safe to run even if you're not sure
whether it already ran (they check before making changes).

---

## Step 5 — Verify it's actually live

1. Open the **cms-backend** service page in Render and copy its URL
   (something like `https://cms-backend-xxxx.onrender.com`). Visit
   `https://cms-backend-xxxx.onrender.com/health` in your browser —
   you should see a small JSON response with `"status": "OK"`. If you
   get an error instead, check the **Logs** tab on that service for
   what went wrong (most often: a typo in an environment variable, or
   Step 4 wasn't completed yet).
2. Open the **cms-frontend** service's URL — you should see the login
   page, complete with the company logo.
3. Try logging in. A fresh database has no Admin account yet — there's
   no seeded default login. Register your own account through the app,
   then follow **Step 4 — Bootstrap your first real Admin user** in
   `GOING_LIVE_GUIDE.md` (one SQL command against this same database)
   to promote yourself. Every other user after that gets their role
   assigned normally, through Users → Assign Role.

---

## Running this for a second, separate company

If you need to run this same system for a second, unrelated company with
completely separate books (separate users, accounts, transactions —
nothing shared), don't reuse the steps above against the same services.
Instead:

1. `render.company-b.yaml` (in this same folder) is a ready-to-use second
   Blueprint — same codebase, different service names
   (`cms-b-backend`/`cms-b-frontend`/`cms-b-db`), so it deploys as a
   totally independent set of resources instead of colliding with
   Company A's.
2. Before pushing, open it and replace the two `COMPANY_B_NAME_HERE`
   placeholders (and the `CB` initials placeholder) with the real second
   company's name — everything else can be changed later through
   Settings → Company, same as Company A.
3. In the Render dashboard: **New +** → **Blueprint** → connect this
   same GitHub repo again → in the **Blueprint Path** field, type
   `render.company-b.yaml` instead of leaving it on the default. Render
   creates a brand new, separate `cms-b-backend`/`cms-b-frontend`/
   `cms-b-db`.
4. Repeat Steps 3–5 above exactly, just pointed at these new services
   and this new database — fill in secrets, run `cms/schema.sql`
   against `cms-b-db`, verify `/health`, and bootstrap Company B's own
   first Admin (register + the same one-time SQL promotion from
   `GOING_LIVE_GUIDE.md` Step 4, run against `cms-b-db` this time).

Both companies now run from the exact same code, so a future bug fix or
feature only ever needs to be written once — see the note on schema
changes just below for the one thing that does need doing twice.

---

## Step 6 — Custom domain (optional)

By default your site lives at an address like
`https://cms-b-frontend-xxxx.onrender.com` — that works, but it's not
memorable and doesn't look professional. If you already own a domain
(bought through Squarespace, GoDaddy, Namecheap, etc.), you can point a
part of it at your CMS instead.

**Worked example used below:** Company B (INVESTABO GLOBAL INVESTMENTS
LIMITED) owns `iamininvest.com` through Squarespace, and wants the CMS
reachable at `cms.iamininvest.com` — a *subdomain*, leaving the bare
domain (`iamininvest.com`) and `www.iamininvest.com` free for a future
separate marketing website. The same steps work for Company A
(`render.yaml` / `cms-frontend`) with a different address later — just
swap the domain and service name.

As of v1.32.2, `render.company-b.yaml` already declares
`cms.iamininvest.com` under the `cms-b-frontend` service's `domains:`
list, and the backend's `FRONTEND_URL`/`EXTRA_ORIGINS` are already set up
to trust it (see the comments in that file). That covers the *code* side
— what's left is telling Render's Blueprint to actually apply that
change, and telling Squarespace where to send traffic for that
subdomain. Three steps:

### 6a. Let Render pick up the domain

1. Push this updated `render.company-b.yaml` to GitHub (`git add`,
   `git commit`, `git push`) if you haven't already — Render Blueprints
   only pick up changes from what's actually on GitHub, not from files
   sitting on your computer.
2. In the [Render Dashboard](https://dashboard.render.com), open your
   Blueprint (or the `cms-b-frontend` service directly) and confirm it
   syncs the new `render.company-b.yaml`. If your Blueprint isn't set to
   auto-sync, open it and click **Manual Sync** → **Sync now**.
3. Once synced, open the **cms-b-frontend** service → **Settings** →
   scroll to **Custom Domains**. You should see `cms.iamininvest.com`
   listed with a status saying DNS still needs to be configured — that's
   expected, that's the next step.

### 6b. Point Squarespace's DNS at Render

1. Log into your Squarespace account and open **Domains** →
   `iamininvest.com` → **DNS Settings** (Squarespace sometimes calls this
   "Advanced DNS Settings").
2. Add a new DNS record:
   - **Type:** `CNAME`
   - **Host / Name:** `cms` (just the subdomain part, not the whole
     `cms.iamininvest.com` — Squarespace appends the rest of the domain
     automatically)
   - **Value / Points to:** the exact `onrender.com` address shown for
     `cms-b-frontend` on that same Custom Domains screen in Render (something
     like `cms-b-frontend-xxxx.onrender.com`) — copy it exactly as shown,
     don't type it from memory.
   - **TTL:** leave whatever Squarespace defaults to (usually fine — an
     hour or less).
3. **Remove any `AAAA` record** Squarespace may have set up by default
   for `cms` if one exists — `AAAA` records are for IPv6 addresses, and
   they can conflict with Render's setup. A plain `CNAME` is all this
   needs.
4. Save the DNS changes.

### 6c. Verify in Render and go live

1. Back in the Render dashboard's **Custom Domains** screen (from 6a),
   click **Verify** next to `cms.iamininvest.com`.
2. DNS changes can take anywhere from a few minutes to a few hours to
   spread across the internet ("propagate"). If verification fails the
   first time, wait 15–30 minutes and click **Verify** again — this is
   normal and not a sign anything is wrong.
3. Once verified, Render automatically issues a free SSL certificate for
   `cms.iamininvest.com` — no extra step needed for this. Visiting
   `https://cms.iamininvest.com` should now show your CMS login page. If
   you briefly see a "502 Bad Gateway," wait a few more minutes — Render
   is still updating its routing.
4. The old `cms-b-frontend-xxxx.onrender.com` address keeps working too
   (both as a plain fallback, and because `EXTRA_ORIGINS` in
   `render.company-b.yaml` explicitly keeps the backend trusting it) —
   you don't have to tell anyone the new address until you're ready.

**Repeating this for Company A later:** duplicate steps 6a–6c against
`render.yaml` / `cms-frontend` with whatever address you choose then
(e.g. `app.zwecktukula.com`) — the same `domains:` / `FRONTEND_URL` /
`EXTRA_ORIGINS` pattern shown in `render.company-b.yaml` applies
unchanged, just add the equivalent lines to `render.yaml` and
`cms-backend`'s `startCommand` first.

---

## Ongoing maintenance

- **Every future code change**: push to the `main` branch on GitHub —
  Render redeploys every service watching that branch automatically
  (both companies' backends/frontends, if you've set up a second one).
- **Every future schema change**: a new `migration_vX.X.0.sql` file
  gets added to `cms/` (matching the pattern already established this
  session) — run it against **every** live database you have (`cms-db`,
  and `cms-b-db` too if a second company is set up), the same way as
  Step 4, once each, after deploying the matching code. The code only
  needs writing once; the migration needs running once per database.
- **Custom domain**: see Step 6 above — as of v1.32.2 this is a
  code-and-DNS setup (`domains:` + `FRONTEND_URL`/`EXTRA_ORIGINS` in the
  relevant `render.company-b.yaml`/`render.yaml`), not something you can
  do purely from the dashboard.
- **Uploaded files**: as of v1.29.1, this is resolved — file uploads
  go to Cloudflare R2 (Step 3b above) instead of the backend's local
  disk, so they survive every future redeploy. If `S3_ENDPOINT` etc.
  are ever left blank, the app quietly falls back to local disk (fine
  for local development, **not** safe for production — go back and
  complete Step 3b).

---

## Deployment flow at a glance

```mermaid
flowchart TD
    A[Step 1: Push code to GitHub] --> B[Step 2: Connect Render Blueprint]
    B --> C[Render builds cms-db, cms-backend, cms-frontend]
    C --> D[Step 3: Enter secrets in Render dashboard]
    D --> D2[Step 3b: Set up Cloudflare R2 for file storage]
    D2 --> E[Step 4: Run schema.sql once against cms-db]
    E --> F[Step 5: Check /health and log in]
    F --> G{Working?}
    G -- Yes --> H[Live. Future pushes to main auto-redeploy]
    G -- No --> I[Check Logs tab on the failing service]
    I --> D
    H --> J[Step 6, optional: point a custom domain via DNS]
```

(This code block renders as a diagram automatically on GitHub. If you
open this file in a plain text editor instead, the steps above in
Step 1 through Step 5 are the same information written out in full.)

