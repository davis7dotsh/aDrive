---
name: verify-deployment
description: Verify a live a-drive deployment end to end through its real browser, HTTP, CLI, D1, and R2 boundaries. Use after deploying, after storage/auth/upload/routing changes, after migrations, and before trusting a-drive following Cloudflare configuration changes. Creates only uniquely-prefixed disposable files, purges them afterward, and produces a pass/fail report.
---

# Verify an a-drive deployment

You are verifying a real, live deployment. Use whatever browser,
HTTP, and shell tooling you have; nothing here assumes a specific
framework. Work through every section, record each check as PASS,
FAIL, or SKIPPED (with reason), and finish with the report.

## Inputs (ask if not provided)

- Dashboard origin (e.g. `https://drive.davis7.space`)
- Content origin (e.g. `https://files.davis7.space`)
- CLI path (repo checkout: `pnpm adrive`, needs Node 26+)
- Access method: the passcode, or an existing read-write API key
- Whether destructive checks may run (default: **yes** — they touch only
  files this run creates)

## Safety boundaries (non-negotiable)

- Generate a run prefix first: `verify-<UTC timestamp>-<4 random hex>`.
  Every file, site, tag, and API key you create must carry it.
- Never modify, trash, rename, or purge anything without the prefix.
- Never print passcodes, API keys, session cookies, or signed URLs in
  the report. Refer to them as `<redacted>`; show only HTTP statuses,
  header names/values that aren't credentials, and file ids.
- Purge only objects created during this run, and always attempt cleanup
  even after failures.

## 1. Preflight

- Both origins use `https://` and are different hosts.
- Both origins resolve and respond (any status).
- Record the deployed commit if available (`.release-history` in the
  repo, or `wrangler deployments list --env production` when wrangler
  is authenticated) plus the current UTC time.
- If wrangler is available: confirm the production env lists DB (D1),
  BUCKET (R2), and AUTH_GUARD (KV) bindings (`wrangler deploy --dry-run
--env production` output). Otherwise mark SKIPPED.

## 2. Authentication

- Dashboard sign-in with the passcode succeeds in a real browser.
- A wrong passcode fails with an error and no session.
- Unauthenticated `GET <dashboard>/api/files` returns 401.
- Create a disposable **read-write** API key named with the run prefix
  (dashboard settings), or complete CLI device authorization
  (`adrive login <dashboard-origin>`).
- Create a disposable **read-only** key; verify a mutation with it
  (e.g. rename) returns 403 while `GET /api/files` succeeds.

## 3. Upload coverage

Create small local test files: text (.txt), image (.png), PDF (.pdf),
and binary (a few hundred random bytes, .bin). Record each one's
SHA-256 before upload.

- Upload the text and image through the dashboard.
- Upload the PDF and binary through the CLI (`adrive put`).
- After each upload, verify via `GET /api/files/<id>`: display name,
  size, content type match the source.
- Download each file and compare checksums with the source.

## 4. File lifecycle (on prefixed files only)

- List files via dashboard and CLI; all uploads appear.
- Search for the run prefix; results contain the uploads.
- Rename one file (dashboard or CLI) and confirm the new name.
- Create a prefixed tag, add it to a file, filter by it, remove it.
- Upload a replacement version to one file; version history shows both
  versions; download the current and the older version and verify each
  checksum against the right source bytes.
- Trash a file, confirm it lists under trash, restore it, confirm it's
  back.
- Purge one file and confirm it is gone from list and trash.

## 5. Public/private behavior

- A public file's content URL (`<content>/f/<id>`) loads with **no**
  credentials (fresh private browser context or plain curl).
- A private file's content URL without a grant returns 404.
- A private file downloads through the dashboard (grant flow works).
- Take a private file's granted URL, tamper with the expiry or
  signature parameter, and confirm rejection.
- Upload a small prefixed HTML file: it must be forced public and must
  render only on the content origin.
- `GET <content>/api/files` returns 421 (dashboard APIs rejected on the
  content origin).
- `GET <dashboard>/f/<id>` returns 421 (content rejected on the
  dashboard origin).

## 6. Content and preview validation

- Markdown preview renders for a prefixed .md upload; a link like
  `[x](javascript:alert(1))` in it must not produce a clickable
  javascript: link, and raw `<script>` in the markdown must not execute.
- Image, PDF, and HTML previews render in the dashboard.
- Served HTML responses from the content origin carry a
  Content-Security-Policy and `X-Content-Type-Options: nosniff`.

## 7. Security checks

- Session cookie attributes: `HttpOnly`, `Secure`, `SameSite=Strict`,
  host-only (no `Domain=`).
- Dashboard HTML response headers include: CSP with `frame-ancestors
'none'`, `Strict-Transport-Security`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- `GET <dashboard>/api/files` (authenticated) returns
  `Cache-Control: private, no-store`.
- A cookie-authenticated mutation with a forged `Origin:
https://evil.example.com` header is rejected.
- CLI: `adrive login http://<dashboard-host-without-tls>` is refused
  (https required).

## 8. Operational checks

- The scheduled cron is configured (wrangler dry-run output shows the
  trigger, or Cloudflare dashboard).
- If backups are installed on nexus: `~/Backups/a-drive/last-run.json`
  reports `"status":"ok"` within the last ~26 hours. Otherwise SKIPPED.
- If wrangler/D1 access is available: for the disposable corpus, D1
  `files` rows and R2 objects agree (each live file id has a matching
  `v/<id>/...` object). Otherwise verify indirectly via downloads.
- Note any Worker errors observed during the run (`wrangler tail` if
  available).

## 9. Cleanup

- Purge every remaining prefixed file (trash then purge, or purge
  directly) and confirm none remain in list, trash, or search.
- Revoke every API key created this run; confirm a revoked key gets 401.
- Delete prefixed tags.
- Sign out of any browser session the run created.

## 10. Report

Produce a final report containing:

- Deployment identity (origins, commit if known) and UTC timestamp.
- Every check above marked PASS / FAIL / SKIPPED-with-reason.
- For failures: the exact reproduction steps, sanitized request/response
  evidence (statuses and non-credential headers only), and a judgment of
  whether it is a **product defect** or an **environment issue**
  (credentials, DNS, browser, Cloudflare configuration).
- Confirmation that cleanup completed (or exactly what was left behind).

A deployment passes only if every non-skipped check passes and cleanup
completed.
