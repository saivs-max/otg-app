# Deploying Caper CostWise to Fly.io

This deploys the app **as-is** — SQLite + on-disk receipts — onto one small
machine with a **persistent volume**, so your data survives restarts, deploys,
and idle sleep. Three files make it work: `Dockerfile`, `.dockerignore`, and
`fly.toml` (already in this folder).

Total hands-on time: ~15 minutes.

---

## What it costs

Fly has no permanent free tier for new accounts, but new accounts get **$5 in
trial credit**. This setup is a `shared-cpu-1x` / 512 MB machine + a 1 GB volume:

- **~$2–3 / month** if always-on, **less** because `fly.toml` is set to scale to
  zero when idle (you only pay while it's awake + ~$0.15/mo for the volume).
- The $5 credit covers roughly the first 2 months.

You'll add a payment card during signup (required even on trial).

---

## 1. Install the Fly CLI (`flyctl`)

**macOS:**
```bash
brew install flyctl
```
(or `curl -L https://fly.io/install.sh | sh`)

**Windows (PowerShell):**
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Verify:
```bash
fly version
```

## 2. Sign up / log in

```bash
fly auth signup     # first time — opens the browser, add a payment card
# or
fly auth login
```

## 3. Create the app from the existing config

From this folder (`otg-app`):
```bash
fly launch --copy-config --no-deploy
```
- When it asks to **tweak settings / use existing fly.toml**, keep it.
- If the app name `otg-fieldcost` is taken, it'll pick a new one and rewrite the
  `app =` line — that's fine. Note the final name.
- Say **No** to adding Postgres / Redis / any database (you don't need them).
- `--no-deploy` lets us create the volume first (next step).

## 4. Create the persistent volume

Match the region you launched in (default `iad`):
```bash
fly volume create otg_data --size 1 --region iad
```
This 1 GB disk holds `data/otg.db` and every uploaded receipt/PDF. The name
`otg_data` must match `[mounts] source` in `fly.toml`.

## 5. Deploy

```bash
fly deploy
```
First build takes a couple of minutes. When it finishes:
```bash
fly open          # opens https://<your-app>.fly.dev
```
You'll see the login screen, but you can't log in yet — seed accounts first.

## 6. Seed the database once (creates login accounts)

The volume starts empty, so create the initial users **one time**:
```bash
fly ssh console        # opens a shell on the machine
# then, inside that shell:
cd /app && npm run seed
exit
```
Then log in at your `.fly.dev` URL:

| Username   | Role         | Password      |
|------------|--------------|---------------|
| `sai`      | PM (admin)   | `password123` |
| `reshmi`   | Sr Manager   | `password123` |
| `maitland` | Ops Manager  | `password123` |
| `priya`    | Technician   | `password123` |

**Change these passwords immediately** after logging in (Profile → password).

> ⚠️ Run the seed **only once**. `seed.js` wipes and recreates the core tables,
> so re-running it later destroys real data you've entered. After the first
> seed, you never need it again. (`npm run seed:demo` loads a richer demo set —
> also destructive; use only on a throwaway instance.)

---

## Optional: bring your existing local data instead of seeding

If you want the data currently in your local `data/` folder (your `otg.db` plus
the receipt files) to be the live data, skip the seed in step 6 and copy it up:

```bash
# 1) stop the machine so SQLite isn't open while we overwrite the file
fly machine list                      # note the machine ID
fly machine stop <machine-id>

# 2) bundle receipts locally, then push both up over SFTP
tar czf receipts.tgz -C data receipts
fly ssh sftp shell                    # opens an interactive prompt:
  put data/otg.db /app/data/otg.db
  put receipts.tgz /app/data/receipts.tgz
  exit

# 3) unpack receipts on the volume and restart
fly ssh console -C "tar xzf /app/data/receipts.tgz -C /app/data && rm /app/data/receipts.tgz"
fly machine start <machine-id>
```
Do this **before** entering new data in the hosted app so nothing is lost.

---

## Optional: enable the integrations

The app runs fine without these. To turn on Freshdesk / MaintainX / Google
Sheets export, set them as secrets (encrypted env vars) — never commit them:
```bash
fly secrets set FRESHDESK_DOMAIN=acme FRESHDESK_API_KEY=xxxx
fly secrets set MAINTAINX_API_KEY=xxxx
fly secrets set GOOGLE_SHEET_ID=xxxx
# Google service account JSON (whole file as one secret):
fly secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat data/google-service-account.json)"
```
Each `fly secrets set` triggers a quick redeploy. See `DEPLOY-GOOGLE.md` for the
Google setup details.

## Optional: custom domain

```bash
fly certs add app.yourdomain.com
```
Then add the DNS records it prints (an A/AAAA or CNAME) at your registrar. Fly
provisions HTTPS automatically.

---

## Shipping updates later

Whenever you change the code:
```bash
fly deploy
```
Your volume (database + receipts) is untouched by deploys. The config replaces
the machine in place (`strategy = "immediate"`), so there's a few seconds of
downtime per deploy — fine for this app.

Handy commands:
```bash
fly logs            # live logs
fly status          # machine + health-check state
fly ssh console     # shell into the running machine
fly scale count 1   # keep it at exactly ONE machine (important — see below)
```

---

## Important constraints (don't break these)

- **One machine only.** The app keeps sessions and the login throttle in memory
  and writes to a single SQLite file on one volume. Never `fly scale count` above
  1, and don't add a second region — they can't share the volume or the session
  state.
- **Node 22 required.** `db.js` uses the built-in `node:sqlite` module, which
  needs the `--experimental-sqlite` flag (already in the Dockerfile `CMD`).
- **Back up your data.** It lives only on the Fly volume. Periodically:
  ```bash
  fly ssh console -C "cat /app/data/otg.db" > backup-$(date +%F).db
  ```
  Fly also takes daily volume snapshots (5-day retention) by default.

## Cost control

- Default config **scales to zero** when idle (`min_machines_running = 0`), so an
  unused app costs almost nothing. The trade-off is a few-second cold start on
  the first request after a quiet period.
- Want no cold starts? Edit `fly.toml`: set `min_machines_running = 1` and
  redeploy (this keeps it always-on, ~$2–3/mo).
- Watch spend at <https://fly.io/dashboard> → Billing.

## Troubleshooting

- **`fly deploy` build fails on `npm ci`** — your `package-lock.json` is out of
  sync. Run `npm install` locally, commit the updated lockfile, redeploy.
- **App boots but login fails / "no user"** — you haven't seeded (step 6).
- **502 / health check failing** — check `fly logs`. Usually the volume didn't
  mount; confirm `fly volume list` shows `otg_data` in your app's region.
- **Receipts upload but won't open after a redeploy** — they're on the volume and
  should persist; if they vanished, the volume isn't mounted at `/app/data`
  (check `[mounts]` in `fly.toml`).

---

## A note on the data

This app holds internal Instacart cost/invoice data. A personal Fly.io account is
fine for a **demo or prototype with synthetic/seeded data**. Before putting
**real** financial records or anything sensitive on it, check with your team on
data-handling policy — internal infra or an approved hosting path may be required.
```
