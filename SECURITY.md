# Security model — Caper CostWise

Invoices, technician PII, and receipt attachments are sensitive. This document
records what's already in place to protect that data and what remains for a
production deployment to handle outside the app.

## What the app does today

### Authentication
- **Passwords**: hashed with Node's built-in `crypto.scrypt` (N=16384, r=8,
  p=1, 64-byte key, 16-byte random salt). Hash format `scrypt$N$r$p$salt$key`
  so we can detect old parameters and upgrade in place. Verification uses
  `crypto.timingSafeEqual` to defeat timing attacks. See `lib/auth.js`.
- **Sessions**: 32-byte random tokens (`crypto.randomBytes`), stored
  server-side in the `sessions` table with a 30-day TTL and the
  user_agent that created them. Expired sessions are purged on server
  start. Tokens travel in the `Authorization: Bearer …` header.
- **Download tokens**: file-download links can't carry an `Authorization`
  header, so `lib/download_tokens.js` mints single-use `?dt=…` tokens
  bound to the exact path + query string. They self-expire after 5
  minutes and are deleted on first redemption.

### Authorization
- Every API route reads `x-user-id` (injected by `attachUserFromToken`
  from the bearer token) and validates the caller against the row being
  accessed:
  - **Invoices**: `canActOnInvoice()` allows the owner, Sr Mgr/PM, or
    an Ops Mgr whose `manager_team` row links them to the tech.
  - **Time entries / expenses**: PATCH/DELETE re-checks the same scope.
  - **Custom rules / settings / dashboard**: `requireManager()` allows
    only `ops_manager | sr_manager | pm`.
  - **Attachments** (v0.57): owner, Sr Mgr/PM, Ops Mgr-on-team, or the
    owner of the invoice the attachment is linked to. Replaces the
    earlier owner-only check that locked managers out of receipts.

### Audit trail
- Every state-changing API writes to `audit_log` (`entity_type, entity_id,
  user_id, action, details_json, timestamp`) via `logAudit()`. Approvals,
  rejections, edits, deletions, send-to-AP, and (v0.57) attachment
  downloads are all captured. Audit rows are never edited or deleted.

### Data at rest
- SQLite DB and its `-wal` / `-shm` siblings are `chmod 600` after
  creation; `data/` is `chmod 700` (v0.57). Prevents other local users
  (or leaked container mounts) from reading the file directly.
- Attachments live under `data/receipts/` keyed by a random UUID, never
  by user-controllable filename. The originating filename is stored as a
  separate column for display only.
- **Not yet encrypted at rest**. For deployments handling real production
  data we recommend either filesystem-level encryption (LUKS, FileVault,
  EBS-encrypted volumes) or upgrading to SQLCipher. See "Production
  checklist" below.

### Data in transit
- The app emits security headers on every response (v0.57):
  - `X-Content-Type-Options: nosniff` — defeats MIME-confusion on
    user-uploaded PDFs/images.
  - `Referrer-Policy: strict-origin-when-cross-origin` — invoice URLs
    aren't leaked to external sites.
  - `X-Frame-Options: DENY` — no embedding in third-party iframes.
  - `Strict-Transport-Security: max-age=15552000` (when the request
    arrived over TLS) — forces HTTPS for six months.
  - `Cache-Control: no-store` on every `/api/*` response — financial data
    is never cached at browser, proxy, or CDN.
  - `Content-Security-Policy` on the HTML shell — locks scripts to
    `'self'` plus the two pinned CDNs (Leaflet from unpkg, libraries
    from cdnjs) and disallows `frame-ancestors`.
- **The Node server itself does not terminate TLS**. Deploy behind a
  reverse proxy (nginx, Caddy, ALB, Cloud Run, App Service) that does
  TLS termination and sets `X-Forwarded-Proto: https`. Set
  `TRUST_PROXY=1` so HSTS kicks in.

### Input handling
- All routes use parameterized SQL via `better-sqlite3`-style
  `db.prepare(...).run(…)` — no string concatenation, so SQL injection
  is not a viable vector.
- Body-parser is capped at 20 MB; oversized requests return 413, not 500.
- Free-text fields (vendor name, invoice number, notes) are length-capped
  at write time.
- File uploads are restricted by MIME allowlist (`image/jpeg, image/png,
  image/heic, image/webp, image/gif, application/pdf`) and 15 MB per
  attachment.
- The frontend escapes user-supplied strings via `escapeHTML()` before
  inserting them into the DOM.

## Production checklist (not in this build)

These are the changes most teams will want before exposing the app
beyond a single user's laptop:

1. **TLS termination** — put the Node server behind nginx / Caddy / ALB
   with a real certificate. The app already emits HSTS when it sees TLS.
2. **At-rest encryption** for the SQLite file. Either filesystem-level
   (LUKS / EBS encryption / Cloud Run secrets) or swap `node:sqlite` for
   SQLCipher with a key loaded from a secrets manager.
3. **Secrets rotation** — DB path, Freshdesk/MaintainX API keys, AP email,
   Google service-account JSON are stored as plain rows in `settings` or
   files under `data/`. Wire those to your secrets manager (AWS SM,
   GCP Secret Manager, Vault) and read them at startup instead of
   committing them.
4. **Backup encryption** — ensure SQLite backups are encrypted and
   access-controlled (S3 bucket with KMS, restricted IAM).
5. **Rate limiting** — add `express-rate-limit` (or proxy-level limits)
   for the `/api/auth/login` and `/api/attachments` endpoints.
6. **CSRF** — the app uses bearer tokens (no cookies), so traditional
   CSRF is mitigated by default. If you add cookie-based sessions later,
   add a CSRF token check on state-changing routes.
7. **Dependency scanning** — `npm audit` on every CI build; bump the
   `pdf-parse` and `pdfkit` versions on advisories.
8. **Access logs** — pipe the server's stdout request log to your SIEM.
   Combine with `audit_log` for full reconstruction of any invoice's
   history.
9. **2FA / SSO** — replace the password login with your IdP (Okta SAML
   or OIDC). The `users` table already has `username` / `email`
   columns; replace `password_hash` with an `external_subject` column
   and you're most of the way there.
10. **Penetration test** — before any external exposure.

## How to audit a single invoice's history

```sql
-- Every state change touching invoice 42:
SELECT timestamp, user_id, action, details
FROM audit_log
WHERE entity_type = 'invoices' AND entity_id = 42
ORDER BY id;

-- Plus every attachment download:
SELECT timestamp, user_id, action, details
FROM audit_log
WHERE entity_type = 'attachments'
  AND entity_id IN (SELECT id FROM attachments WHERE invoice_id = 42)
ORDER BY id;
```

## How to revoke a session

```sql
-- All sessions for user 4:
DELETE FROM sessions WHERE user_id = 4;
-- A single token (e.g. lost laptop):
DELETE FROM sessions WHERE token = '<token>';
```

## How to disable a user without losing audit history

```sql
UPDATE users SET status = 'disabled' WHERE id = 4;
-- The auth middleware refuses to issue a session-user for status='disabled'
-- accounts, but their historical rows in invoices / audit_log are preserved.
```
