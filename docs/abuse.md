# Abuse controls

One bad tenant must not take the content domain down, and an operator
must be able to stop one in under a minute. This is what the code does,
what the Cloudflare zone must be set to by hand, and how to run the
controls.

## Zone checklist (not code)

Do these once on the zone that owns `CONTENT_DOMAIN`, and again whenever
the content domain moves. Tenant content is only ever served from
`<slug>.<CONTENT_DOMAIN>`; the dashboard origin is a separate host.

- **WAF managed rules** on the content zone: enable the Cloudflare
  Managed Ruleset and the OWASP Core Ruleset in blocking mode. Content
  responses are static files, so false positives are rare; if one appears
  add a skip rule scoped to `/f/*`, never to the whole zone.
- **Bot Fight Mode** (or Super Bot Fight Mode on a paid plan): on. Scraper
  traffic against tenant hosts otherwise counts against the per-IP rate
  limit and R2 egress.
- **Hotlink protection: off.** Serving files from elsewhere is the product.
- **Rate limiting rules** at the zone level are a second layer over the
  Worker bindings below; a rule of the shape "more than 1000 requests per
  minute from one IP to `*.<CONTENT_DOMAIN>/*` → managed challenge" is
  enough.
- **Cache**: leave the default cache level. The Worker sets `Cache-Control`
  per file (immutable for pinned versions, revalidate for sites) and
  purges by URL and by host when a verdict changes (below), so no zone
  cache rule is needed.
- **Netcraft**: register the content domain as a hosting provider in the
  Netcraft takedown feed so phishing reports arrive at `abuse@` instead
  of the registrar.
- **DMCA agent**: register a designated agent with the US Copyright Office
  for the operating entity and publish the contact on the landing site.
- **abuse@ mailbox**: create it, route it to the same people who watch
  `/admin`, and list it on the landing site next to the DMCA agent.
- **Reports**: every tenant host answers `GET /report?f=<file id>` with a
  form; link it from the landing site's abuse page so a reporter who
  lands on the bare domain finds it.

## Trust levels

`orgs.trust` (`apps/web/src/lib/server/trust-policy.ts`):

| Level         | Reached by                                                                    | May publish     | Scan             |
| ------------- | ----------------------------------------------------------------------------- | --------------- | ---------------- |
| `new`         | Sign-up                                                                       | No (403)        | n/a              |
| `verified`    | A sign-in with a verified email                                               | Yes             | Before it's live |
| `established` | Org over 14 days old and currently paid (maintenance sweep), or an admin bump | Yes             | After it's live  |
| `suspended`   | The kill switch                                                               | No; host is 404 | n/a              |

"Publish" is anything that makes content public: an upload that lands
public (including HTML, which is always public), a visibility change, a
rename to `.html`, a site session or commit. A `new` org gets 403 "Verify
your email to share publicly". The free plan can share publicly once
verified; every publish by a verified org is scanned first.

Bumping trust is an admin action on `/admin` (or `PATCH
/api/admin/orgs/<id>` with `{ "action": "trust", "trust": "established" }`).

## Scan pipeline

`apps/web/src/lib/server/services/scanner.ts`. Every version that becomes
public gets a `scan` job on the queue. For a verified org the row stays
private with `files.publish_pending = true` until the scan clears it; for
an established org it is public at once and scanned after.

Each version write records its scan obligation in Postgres before enqueueing.
The lifecycle sweep requeues overdue obligations in bounded batches, so a queue
outage cannot silently lose the initial scan. A completed suspicious verdict
ends automatic scanning and leaves the file for review. When only some URL
submissions succeed, their results are still collected; failed submissions
keep a suspicious minimum verdict, and any malicious result quarantines.

Publishing the current version does not expose unscanned older bytes. Older
versions need their own completed clean scan or operator clearance for anonymous
access. Owners can still request signed links for pending/private versions;
a malicious version stays blocked even with an existing grant. Clearing the
current version does not clear older versions. Admin actions include the
displayed current version and reject an outdated overview with a
refresh-required response.

Checks, in order, each writing one `scan_verdicts` row per
`(file, version, source)`:

1. `hash`: the object's SHA-256 (objects up to 32 MiB; larger ones are
   recorded as skipped) against `blocked_hashes`. A hit is `malicious`.
   The hash is also stored on `file_versions.sha256`.
2. `sniff`: the first 512 bytes against the declared content type
   (`mime-sniff.ts`). HTML, SVG, PE/ELF/Mach-O, or a shell script served
   under a type that does not admit it is `suspicious`.
3. `urlscan`: for HTML files and sites, `<a href>`, `<script src>`, and
   `<form action>` targets (up to 10 per publish, own host excluded)
   are submitted to the Cloudflare URL Scanner. The job re-sends itself
   every 30 seconds to collect the verdicts (up to 20 times; a scan that
   never finishes is `suspicious`). Without `URLSCAN_API_KEY` the check is
   recorded as skipped and treated as clean.

The worst verdict decides:

- `clean`: a held row is published (`public = true`,
  `publish_pending = false`), the edge cache for its URLs is purged, and
  a `published` record is written to `notifications`.
- `suspicious`: a held row stays held and a `held` notification record is
  written; a scan-after file stays as it was. Either way the file
  appears under "Held and quarantined files" on `/admin` for a person to
  mark clean or malicious.
- `malicious`: `public = false`, `quarantined = true`, the edge is purged,
  and a `quarantined` notification record is written. Every content route
  reaching the Worker answers 404 for a quarantined file, the owner cannot republish it, and
  it stays visible in their dashboard so they can delete it.

Verdicts and notification rows are durable database records. Owners see
"Pending review" or "Quarantined" in their dashboard after refreshing;
there is no notification inbox, email delivery, or automatic status polling
in this layer. Quarantined files retain their metadata and deletion controls,
while preview, sharing, rename, and new-version actions are unavailable.
Notify owners through the operator's support process when direct outreach
is needed.

Secrets: `URLSCAN_API_KEY` (an API token with the URL Scanner scope) and
`CF_ACCOUNT_ID` (the account that owns it). Locally, `URLSCAN_API_KEY=fake:malicious`
(or `fake:clean`, `fake:suspicious`) exercises the pipeline without the
network.

## Reports

`POST /report` on a tenant host with `{ "fileId", "reason", "details?" }`
(reasons: `malware`, `phishing`, `copyright`, `illegal`, `spam`, `other`),
or the form at `GET /report?f=<file id>`. Rate limited by client address
(the `RL_ANON` binding); the address is stored as a salted hash. Reports
land in `reports` and show on `/admin` until resolved.

## Kill switch

Suspending an org (`/admin` → Suspend, or `PATCH /api/admin/orgs/<id>`
with `{ "action": "suspend" }`) does, in one request:

1. `orgs.trust = 'suspended'`.
2. Attempts to drop the org's slug from the KV host cache. Host requests
   reaching the Worker check current trust in Postgres, even when the slug
   mapping is cached, and return 404 for a suspended org. A failed KV delete
   is logged and does not undo suspension.
3. Refuses every API key and browser session for the org with 401 on
   their next request. Nothing is revoked; restoring the org brings them
   back.
4. Purges the host from the edge cache through the Cloudflare API when
   `CF_API_TOKEN` (Cache Purge permission on the content zone) and
   `CF_ZONE_ID` are set. When they are not, the purge is logged as
   skipped: purge the host by hand in the dashboard (Caching → Purge
   Cache → Hostname) or wait for the entries to expire (up to a year for
   pinned file versions, minutes for sites).

Bytes already cached by a browser cannot be revoked. CDN responses that
bypass the Worker remain available until the purge succeeds or they expire;
suspension is not instant global revocation.

Restore (`{ "action": "restore" }`) sets the org back to `verified` and
attempts to drop the cache entry again. Suspending is reversible and touches no
files, so it is the right first move when in doubt.

## Rate limits

Workers rate limit bindings (`wrangler.jsonc` `ratelimits`, per colo,
approximate, 60 second windows): `RL_UPLOAD` 60/min per org (uploads,
site sessions), `RL_PUBLISH` 10/min per org (reserved for publish
counting), `RL_AUTH` 30/min per client address (shared device creation and
token polling), `RL_ANON`
300/min per client address (content fetches past the edge cache, and
reports). A refused request is 429 with `Retry-After: 60`. A binding that
errors lets the request through and logs. The auth budget accommodates the
advertised five-second polling interval. Refused token polls return
`{ "status": "slow_down" }`; the CLI honors `Retry-After` before polling
again. Device creation still consumes the shared limit and returns a normal
error response when refused.

## Operating

- Who: `ADMIN_USER_IDS` is a comma-separated list of WorkOS user ids.
  Admin routes accept only a browser session for one of them; an API key
  never qualifies. The header shows "Admin" for those users.
- Where: `/admin` on the dashboard origin. Reports, held and quarantined
  files with their verdicts, dead-lettered jobs, recent orgs with trust,
  plan, and usage, and a form to add a hash to `blocked_hashes`.
- A report about live content: open the file on its host, decide. Mark
  the file malicious to quarantine it, then close the report with the
  `quarantined` outcome; or choose `dismissed`. Suspend the org when the
  account is the problem and choose `suspended`. Closing a report records
  the selected outcome; it does not perform the quarantine or suspension.
- A held file (`suspicious`): read the verdict details on `/admin`. Mark
  clean to publish it, malicious to quarantine it.
- A takedown notice: quarantine the file, resolve any report as `removed`,
  keep the notice with the file id and the `scan_verdicts` row. The owner
  sees "Quarantined" after refreshing the dashboard; contact them separately
  with the reason and dispute instructions.
- A quarantined file the owner disputes: mark clean. The file goes back
  to private and the owner decides again; the `admin` verdict row records
  who cleared it.
- Watching: `scan finished`, `org suspended`, and `edge cache purge`
  lines in the Worker logs carry the org and file ids. Dead-lettered
  scan jobs appear under failed jobs on `/admin`.
