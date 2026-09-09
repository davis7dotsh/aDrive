# adrive

adrive is a Cloudflare-backed file spine with a dashboard, tags, hybrid
search, static-site publishing, deployment-based authentication, and
scheduled storage lifecycle management. It is becoming a hosted product:
one deployment serving many organisations, each with its own files, keys,
and usage (`docs/plans/hosted-product.md`). Self-hosting a single-tenant
copy keeps working and is what the setup below describes.
Uploads stream directly to R2, metadata and append-only version history live in
Postgres (PlanetScale via Hyperdrive), and file/site bytes are served from a
separate cookie-less content origin. Search combines weighted keyword
results, a filename trigram index, and an optional Workers AI + pgvector
semantic source with reciprocal rank fusion, then applies deletion, expiry,
visibility, and tag filters. The CLI supports file transfer and safe, staged
directory publishing.

## Install the CLI

Single-file build, no repo checkout needed (requires Node 20+):

```bash
curl -fsSL https://raw.githubusercontent.com/davis7dotsh/aDrive/main/scripts/install-cli.sh | bash
```

This installs to `~/.adrive/bin` (no sudo), verifies the download against
the release's SHA-256 checksums, and prints PATH guidance. Pin a version
with `ADRIVE_CLI_VERSION=cli-v0.1.0`, update later with `adrive upgrade`
or `adrive update`, then connect with `adrive login <your-drive-url>`.

## Connect MCP

The dashboard origin serves a streamable HTTP MCP endpoint at `/mcp`. Mint
an API key in the dashboard, then point the client at that URL with a Bearer
token:

```
https://<dashboard-host>/mcp
Authorization: Bearer adr_…
```

Read-only keys can list, search, and read metadata. Read-write keys can
upload, tag, and publish sites. MCP uploads are capped at 2 MiB; use the
CLI for larger files.

The marketing landing page lives in `apps/site` — a static assets-only
Worker (no build step) deployed by `bun release` to
`https://adrive.davis7.space`. Preview it locally with
`cd apps/site && bunx wrangler dev`.

## Local setup

Requirements: Node 26+ and Bun 1.4+.

```bash
bun install
bun db:pg:up              # local Postgres via docker compose
bun db:pg:migrate:local
cp apps/web/.dev.vars.example apps/web/.dev.vars
bun key:create:local
```

Local development runs against the docker compose Postgres through the
Hyperdrive binding; the route test suite needs it running too. Production
uses PlanetScale Postgres (`docs/release.md`).

Route tests reset their Postgres database before each suite run. They use
`adrive_test` by default; `ADRIVE_TEST_DATABASE_URL` may point to another
host, but must name either `adrive_test` or `adrive_review`. Reserve those
databases for disposable test data. Other database names and malformed URLs
are rejected before test setup connects or resets state. Manual migration
commands, including an explicitly requested `--reset`, keep their existing
database selection behavior. Migration runs serialize through a Postgres
advisory lock and wait at most 30 seconds to acquire it.

Set `WORKOS_DEV_FAKE=true` and leave `WORKOS_API_KEY` empty to use the
in-memory WorkOS fake in the SvelteKit development server, as configured by
`.dev.vars.example`. The sign-in button then signs you in as `user_local`
with no credentials. Production requires real WorkOS credentials even when
the fake flag is set. Copy the API key printed by the final command, then
start both local origins:

```bash
bun --filter @adrive/web dev
```

The dashboard/API is at `http://localhost:5173/`. Each org's file bytes are
served from its own host under `CONTENT_DOMAIN`: `http://<org
slug>.localhost:5174/` locally (browsers resolve `*.localhost` to loopback,
so nothing needs configuring). The second port is a small streaming proxy
into the same SvelteKit process so both origins share one local state
while the Worker still sees and enforces the tenant host. The settings
page shows your org's content origin.

### Developing over Tailscale (or another network hostname)

The dev server binds `0.0.0.0`, so other devices on your tailnet can reach
it. MagicDNS resolves the dashboard's machine name, but does not resolve
tenant subdomains beneath that name. For Siva, set these values in
`apps/web/.dev.vars`:

```bash
DASHBOARD_ORIGIN="http://siva.otter-hawksbill.ts.net:5173"
CONTENT_DOMAIN="100.100.40.20.nip.io:5174"
```

`CONTENT_DOMAIN` has no scheme; it follows the dashboard. An org's content
URL is then `http://<slug>.100.100.40.20.nip.io:5174/`. The `nip.io` service
resolves these tenant hosts to Siva's Tailscale IP while each tenant keeps
its own hostname. For another machine, use its MagicDNS name and Tailscale
IP (`tailscale ip -4`). Alternatively, use a domain whose wildcard DNS
record points to that IP. Verify a sample tenant hostname resolves on the
device running the browser; its resolver may block public DNS answers
that point to private networks.

Sign-in stores the sealed WorkOS session in a thirty-day, `HttpOnly`,
`SameSite=Lax` cookie. On an HTTPS dashboard origin it is the `Secure`,
host-only `__Host-adrive-wos` cookie; on a plain-HTTP dev origin (a LAN or
Tailscale hostname) it drops the prefix and the `Secure` flag so browsers
will keep it.

Vite also needs to allow the dashboard hostname and content-domain suffix.
Set this in the shell when starting development, separately from
`.dev.vars`, and adjust both entries if you changed the domains:

```bash
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="siva.otter-hawksbill.ts.net,.100.100.40.20.nip.io" bun --filter @adrive/web dev
```

The content proxy preserves the tenant Host header, so the Worker still
enforces its host-routing rules in development.

The dashboard signs in through WorkOS. Device authorization creation and token
polling share the `RL_AUTH` Workers rate limit: 30 requests per client address
in a 60-second window. A device polls every five seconds, leaving room for
creation and another device behind the same address. Refused token polls return
HTTP 429 with `{ "status": "slow_down" }` and `Retry-After: 60`; the CLI waits
for that delay before polling again. Creation remains rate limited and returns
the usual error response. These counters are approximate and scoped to each
Cloudflare location. `AUTH_GUARD` KV now supports caches, not auth counters.

In another shell, configure and exercise the CLI:

```bash
bun adrive login http://localhost:5173 --headless
bun adrive list
bun adrive put ./path/to/file.pdf
bun adrive put ./path/to/private.bin --private
printf 'from stdin' | bun adrive put - --name note.txt
bun adrive put ./report.csv --expires 2026-08-31T00:00:00Z
bun adrive get <file-uuid> --output ./downloaded-file
bun adrive get <file-uuid> --output - > downloaded-file
bun adrive site put ./dist
bun adrive site put ./dist --id <existing-site-uuid>
bun adrive --json tag list
bun adrive tag create reports --color '#2563eb'
bun adrive tag set <file-uuid> reports important
```

`login` starts a device flow. Normal mode tries to open the approval URL;
`--headless` prints the same complete URL so it can be opened on another
machine. Approval mints one full-access API key and saves it at mode `0600`
under `$XDG_CONFIG_HOME/adrive/config.json` (or
`~/.config/adrive/config.json`). Device codes are stored only as SHA-256 hashes
and expire after ten minutes.

Uploads default public; HTML is always made public. Human-mode upload and site
success output keeps the public URL alone on its own line. Put `--json` before a
command for JSON stdout. Downloading with `--output -` writes only file bytes to
stdout and cannot be combined with `--json`; diagnostics remain on stderr. The
CLI first requests a typed content link from the authenticated dashboard API,
then downloads directly from the cookie-less content origin without forwarding
its API key. Public links are stable. Private file links are scoped to one exact
version, signed with a deployment-only HMAC, and expire after 15 minutes; the
dashboard clearly labels these expiring links when copying them.

`site put` walks regular files without following symlinks, declares the complete
manifest, streams assets with four uploads at a time, and atomically publishes
only after every asset is present. A republish records a new audit version,
switches the stable `/s/<uuid>/` URL to it, and removes the prior R2 asset set.
Site versions are intentionally not addressable with `?v=`.

## Checks

These commands do not start or build the app:

```bash
bun format:check
bun check
bun run test
```

Run `bun --filter @adrive/web types:worker` after changing Wrangler bindings.
The checked-in `worker-configuration.d.ts` is generated from `wrangler.jsonc`.
The Cloudflare adapter wrapper emits a standard module Worker with both `fetch`
and `scheduled` exports. Its signed internal maintenance request is authenticated
with a short-lived HMAC derived from `MAINTENANCE_SECRET`; the endpoint cannot be invoked
with a static or public header.

The `search_documents` table is derived keyword-search state. After restoring
the canonical tables, rebuild local search state with:

```bash
bun search:rebuild:local
```

The rebuild reads `files`, `file_versions`, `tags`, and `file_tags`; it does not
modify those source tables.

## Cloudflare resources

The checked-in Wrangler D1 and R2 resource names are placeholders. The
`AUTH_GUARD` KV namespace is already provisioned and bound. Before deployment,
create one D1 database and one private R2 bucket, replace the D1 database ID,
apply the migration remotely, set the production dashboard origin and
content domain, and set
the secrets (`MAINTENANCE_SECRET`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_COOKIE_PASSWORD`, `WORKOS_WEBHOOK_SECRET`, `AUTUMN_SECRET_KEY`,
`AUTUMN_WEBHOOK_SECRET`):

```bash
cd apps/web && bun x wrangler secret put MAINTENANCE_SECRET
```

No remote resource is created or modified by the local setup above.

File expiration is enforced immediately by API, search, file, and site reads.
The scheduled Worker runs every five minutes. It re-drives interrupted indexing,
physically deletes expired/trash bytes before removing canonical D1 rows, expires
dashboard/device/site-upload sessions, and retries deferred R2/site
deletes. Work is bounded per invocation and every retryable transition is stored
in D1. Download counts increment for full downloads and the initial
`bytes=0-…` request only, so follow-up range requests do not inflate the count.

### Optional semantic search

Keyword, typo-tolerant, tag, and extracted-text search work without AI bindings.
`SEMANTIC_SEARCH` defaults to `auto`: the `AI` binding must be present before
the semantic layer activates. Set it to `off` to force the null-object layer,
or `required` to make a missing binding a startup error. Embeddings are stored
in Postgres (`file_chunks.embedding`, pgvector), so no separate vector service
is provisioned.

To enable semantic search locally, add the binding to `apps/web/wrangler.jsonc`
and regenerate types:

```jsonc
"ai": { "binding": "AI" }
```

```bash
bun --filter @adrive/web types:worker
```

The embedding contract is pinned in Wrangler config to
`@cf/baai/bge-small-en-v1.5`, `pooling: "cls"`, and 384 dimensions. Changing any
of those values requires a full reindex. The dashboard shows the indexed chunk
count. Failed files retry with exponential
backoff up to five attempts and can be queued again with **Reindex**.
