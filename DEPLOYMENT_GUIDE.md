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
(~$7/month) and the database runs on the Basic-256mb plan (~$6-7/month) —
check [render.com/pricing](https://render.com/pricing) for the current
rate, since Render occasionally renames/retires tiers (the database plan
used to be called "Starter" too, but Render retired that name for new
databases in mid-2026 in favor of Basic/Pro/Accelerated tiers — this
project's `render.yaml` files already use the current name).
The frontend (a static website) is free. Free-tier alternatives exist
but they spin your server down after 15 minutes of inactivity, which
would silently break the nightly scheduled jobs (interest accrual,
overdue checks, monthly reports) — not worth the savings for a system
tracking real money.

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
- **Custom domain**: once you're ready to point your own domain (e.g.
  `app.zwecktukula.com`) at this instead of the onrender.com URLs,
  Render's **Settings → Custom Domains** tab on the `cms-frontend`
  service walks you through it — you'll also need to update
  `FRONTEND_URL` handling if you want the backend's CORS check to
  trust the custom domain too (currently it trusts whatever
  `cms-frontend`'s Render URL resolves to automatically).
- **Uploaded files warning**: the backend currently stores uploaded
  documents on local disk (`UPLOAD_DIR`). Render's Starter plan disk
  is **not persistent** across deploys — files uploaded between
  deploys can disappear on the next one. For a production system that
  keeps real documents long-term, add a
  [Render Persistent Disk](https://render.com/docs/disks) to
  `cms-backend` (a small monthly add-on), or move uploads to an
  external store like S3 — flag this to me if you want it built out.

---

## Deployment flow at a glance

```mermaid
flowchart TD
    A[Step 1: Push code to GitHub] --> B[Step 2: Connect Render Blueprint]
    B --> C[Render builds cms-db, cms-backend, cms-frontend]
    C --> D[Step 3: Enter secrets in Render dashboard]
    D --> E[Step 4: Run schema.sql once against cms-db]
    E --> F[Step 5: Check /health and log in]
    F --> G{Working?}
    G -- Yes --> H[Live. Future pushes to main auto-redeploy]
    G -- No --> I[Check Logs tab on the failing service]
    I --> D
```

(This code block renders as a diagram automatically on GitHub. If you
open this file in a plain text editor instead, the steps above in
Step 1 through Step 5 are the same information written out in full.)

