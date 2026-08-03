---
name: verify-deployment
description: Verify a live a-drive deployment end to end through its real browser, HTTP, CLI, D1, and R2 boundaries. Use after deploying, after storage/auth/upload/routing changes, after migrations, and before trusting a-drive following Cloudflare configuration changes. Creates only uniquely-prefixed disposable files, purges them afterward, and produces a pass/fail report.
---

# Verify an a-drive deployment

You are verifying a real, live deployment. Use whatever browser,
HTTP, and shell tooling you have; nothing here assumes a specific
framework. Work through every section, record each check as PASS,
FAIL, or SKIPPED (with reason), and finish with the report.

Checks marked **[M]** are mandatory: the deployment cannot PASS if any
of them failed **or was skipped**. Unmarked checks are optional; they
may be SKIPPED with a documented reason.

## Inputs (ask if not provided)

- Dashboard origin (e.g. `https://drive.davis7.space`)
- Content origin (e.g. `https://files.davis7.space`)
- CLI path (repo checkout: `pnpm adrive`, needs Node 26+)
- Access method: the passcode (full run), or an existing read-write API
  key (reduced run — see below)
- Whether destructive checks may run (default: **yes** — they touch only
  files this run creates)

**Access-mode branching:** passcode access enables the full run. With
only an API key, record as SKIPPED (reason: no passcode) every check
that needs a browser session or key management: browser sign-in,
wrong-passcode, dashboard uploads and previews, disposable key creation
(read-write, read-only, and short-expiry), the read-only-scope 403
checks, the key-listing check, cookie-attribute checks, and
cookie-origin forgery checks. Because several of those are mandatory, a
key-only run can conclude at best INCONCLUSIVE — never PASS.

## Safety boundaries (non-negotiable)

- Generate a collision-resistant run prefix first:
  `verify-<UTC timestamp>-<UUID or 16+ random hex chars>`. Before
  creating anything, search for the prefix and confirm nothing matches.
  Every file, site, tag, and API key you create must carry it.
- Never modify, trash, rename, or purge anything without the prefix.
- Never print passcodes, API keys, session cookies, or signed URLs in
  the report. Refer to them as `<redacted>`; show only HTTP statuses,
  header names/values that aren't credentials, and file ids.
- Purge only objects created during this run, and always attempt cleanup
  even after failures.

## 1. Preflight

- **[M]** Both configured origins use `https://` and are different hosts.
- **[M]** Both origins resolve and respond (any status).
- Request `http://` on both hostnames: assert a redirect to HTTPS or a
  refusal, and that no authenticated data or file content is served
  over plain HTTP.
- Record the deployed commit if available (`.release-history` in the
  repo, or `wrangler deployments list --env production` when wrangler
  is authenticated) plus the current UTC time.
- **[M]** If wrangler is available: confirm the production env lists DB
  (D1), BUCKET (R2), AUTH_GUARD (KV), AI (Workers AI), and VECTORIZE
  bindings (`wrangler deploy --dry-run --env production` output). Without
  wrangler this mandatory check is SKIPPED and the run cannot PASS.

## 2. Authentication

Run every negative check in a fresh browser context (or cookie-less
curl) so no prior session can mask a failure.

- **[M]** Dashboard sign-in with the passcode succeeds in a real
  browser.
- **[M]** In a fresh context: a wrong passcode fails with an error and
  sets no session cookie.
- **[M]** In a fresh context: unauthenticated `GET <dashboard>/api/files`
  returns 401.
- **[M]** Create a disposable **read-write** API key named with the run
  prefix (dashboard settings), or complete CLI device authorization
  (`pnpm adrive login <dashboard-origin>`).
- **[M]** Create a disposable **read-only** key; verify `GET /api/files`
  succeeds while each of these mutations returns 403: an upload, a
  rename, a tag creation, a trash, and a version upload.
- **[M]** With the read-only key, `GET /api/auth/keys` must return 403
  (key inventory requires write scope).
- Create a key with a short expiry (e.g. two minutes), wait for it to
  lapse, and confirm requests with it return 401.
- If the run may rotate the passcode (scratch deployment only — ask
  first): create a session and a pending device authorization, change
  the PASSCODE secret, wait for the maintenance cron, and confirm both
  are revoked. On the production deployment SKIP with reason.

## 3. Upload coverage

Create small local test files: text (.txt), image (.png), PDF (.pdf),
and binary (a few hundred random bytes, .bin). Record each one's
SHA-256 before upload.

- **[M]** Upload the text and image through the dashboard.
- **[M]** Upload the PDF and binary through the CLI (`pnpm adrive put`).
- **[M]** After each upload, verify via `GET /api/files/<id>`: display
  name, size, content type match the source.
- **[M]** Download each file and compare checksums with the source.
- Negative cases (verify the documented rejection status and that no
  partial file, version, or R2 object is left behind):
  - An upload whose declared size exceeds the per-file limit.
  - A chunked upload with no Content-Length whose streamed bytes exceed
    the per-file limit (the streaming reader must cut it off).
  - A burst of uploads beyond the configured upload rate (429).
  - If a scratch quota configuration is available, an upload beyond
    `MAX_TOTAL_BYTES` (413); otherwise SKIP with reason.

## 4. File lifecycle (on prefixed files only)

- **[M]** List files via dashboard and CLI; all uploads appear.
- Create enough prefixed files (or use a page-size override) to force at
  least two pages; confirm both clients follow the cursor and the
  combined listing has no gaps or duplicates.
- **[M]** Search for the run prefix; results contain the uploads.
- Semantic search: settings shows semantic enabled with a nonzero
  indexed-chunk count once the disposable text upload has been indexed
  (wait out one or two 5-minute cron ticks); a conceptual query for the
  text file's _content_ (words related to, but not literally in, its
  text) surfaces it. SKIP with reason if indexing hasn't caught up
  within a reasonable wait.
- **[M]** Rename one file (dashboard or CLI) and confirm the new name.
- **[M]** Create a prefixed tag, add it to a file, filter by it, remove
  it.
- **[M]** Upload a replacement version to one file; version history
  shows both versions; download the current and the older version and
  verify each checksum against the right source bytes.
- Upload enough versions to one file (or use `versionsLimit=1`) to force
  version-history pagination; follow the cursor and confirm no gaps or
  duplicates across pages.
- **[M]** Trash a file, confirm it lists under trash, restore it,
  confirm it's back.
- **[M]** Purge one file and confirm it is gone from list and trash.

## 5. Public/private behavior

- **[M]** A public file's content URL (`<content>/f/<id>`) loads with
  **no** credentials (fresh private browser context or plain curl).
- **[M]** A private file's content URL without a grant returns 404.
- **[M]** A private file downloads through the dashboard (grant flow
  works).
- **[M]** Grant integrity — three separate checks, each rejected:
  - a grant past its expiry (wait out a short-lived grant, or note the
    TTL makes this impractical and SKIP with reason),
  - a granted URL with the expiry parameter altered,
  - a granted URL with the signature parameter altered.
- **[M]** Upload a small prefixed HTML file: it must be forced public
  and must render only on the content origin.
- **[M]** `GET <content>/api/files` returns 421 (dashboard APIs rejected
  on the content origin).
- **[M]** `GET <dashboard>/f/<id>` returns 421 (content rejected on the
  dashboard origin).

## 6. Content and preview validation

- **[M]** Markdown preview renders for a prefixed .md upload; a link
  like `[x](javascript:alert(1))` in it must not produce a clickable
  javascript: link, and raw `<script>` in the markdown must not execute.
- Image, PDF, and HTML previews render in the dashboard.
- **[M]** Served HTML responses from the content origin carry a
  Content-Security-Policy and `X-Content-Type-Options: nosniff`, and
  script injected into the page cannot reach the dashboard origin
  (frame-ancestors/connect restrictions hold).

## 7. Security checks

Compare header **values**, not just presence, against
`apps/web/src/lib/server/security-headers.ts`:

- **[M]** Session cookie attributes: `HttpOnly`, `Secure`,
  `SameSite=Strict`, host-only (no `Domain=`).
- **[M]** Dashboard HTML headers match the source policy: CSP contains
  `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`,
  and frame/img/media/connect limited to self plus the content origin;
  `Strict-Transport-Security` has a max-age of at least a year;
  `X-Content-Type-Options: nosniff`; a restrictive `Referrer-Policy`;
  `Permissions-Policy` disabling camera, microphone, and geolocation.
- **[M]** Authenticated API responses return
  `Cache-Control: private, no-store` — check `/api/files`, a search, a
  tags listing, a file detail (versions), `/api/auth/keys`, and a
  mutation response.
- **[M]** A cookie-authenticated mutation with a forged
  `Origin: https://evil.example.com` header is rejected.
- **[M]** CLI transport trust:
  - `pnpm adrive login http://<dashboard-host>` (plain http, non-localhost)
    is refused.
  - With a config whose trusted origins are the real deployment, verify
    a download link pointing at an untrusted HTTPS origin is refused
    without any request to that origin (use a local mock server as the
    endpoint if needed, or SKIP with reason if no mock is practical).

## 8. Operational checks

- **[M]** The scheduled cron is configured (wrangler dry-run output
  shows the trigger, or Cloudflare dashboard).
- If backups are installed on the backup host: `~/Backups/a-drive/last-run.json`
  reports `"status":"ok"` within the last ~26 hours. Otherwise SKIPPED.
- D1/R2 agreement for the disposable corpus: with wrangler/D1 access,
  confirm each live prefixed file id has a matching `v/<id>/...` object
  and no orphaned prefixed objects remain. Downloads succeeding is NOT
  evidence for this check — without enumeration access, record it as
  SKIPPED (inconclusive), never PASS.
- Note any Worker errors observed during the run (`wrangler tail` if
  available).

## 9. Cleanup — mandatory in full

- **[M]** Purge every remaining prefixed file (trash then purge, or
  purge directly) and confirm none remain in list, trash, or search.
- **[M]** Revoke every API key created this run; confirm a revoked key
  gets 401.
- **[M]** Delete prefixed tags.
- **[M]** Cancel or consume any device authorization the run started,
  and sign out of any browser session the run created.

## 10. Report

Produce a final report containing:

- Deployment identity (origins, commit if known) and UTC timestamp.
- Every check above marked PASS / FAIL / SKIPPED-with-reason, with
  mandatory checks flagged.
- For failures: the exact reproduction steps, sanitized
  request/response evidence (statuses and non-credential headers only),
  and a judgment of whether it is a **product defect** or an
  **environment issue** (credentials, DNS, browser, Cloudflare
  configuration).
- Confirmation that cleanup completed (or exactly what was left behind).

Verdict rules:

- **PASS** — every mandatory check passed, optional checks are PASS or
  SKIPPED with reasons, and cleanup completed.
- **FAIL** — any check failed.
- **INCONCLUSIVE** — no failures, but one or more mandatory checks were
  skipped (e.g. key-only access, no wrangler). An INCONCLUSIVE run does
  not clear the deployment.
