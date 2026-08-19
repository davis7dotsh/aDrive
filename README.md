# adrive

adrive is a Cloudflare-backed file spine with a dashboard, tags, hybrid
search, static-site publishing, deployment-based authentication, and
scheduled storage lifecycle management.
Uploads stream directly to R2, metadata and append-only version history live in
D1, and file/site bytes are served from a separate cookie-less content origin.
Search combines weighted FTS5 BM25 results, a filename trigram index, and an
optional Workers AI + Vectorize semantic source with reciprocal rank fusion.
Canonical D1 hydration still applies deletion, expiry, visibility, and tag
filters. The CLI supports file transfer and safe, staged directory publishing.

## Install the CLI

Single-file build, no repo checkout needed (requires Node 20+):

```bash
curl -fsSL https://raw.githubusercontent.com/davis7dotsh/aDrive/main/scripts/install-cli.sh | bash
```

This installs to `~/.adrive/bin` (no sudo), verifies the download against
the release's SHA-256 checksums, and prints PATH guidance. Pin a version
with `ADRIVE_CLI_VERSION=cli-v0.1.0`, update later with `adrive upgrade`,
then connect with `adrive login <your-drive-url>`.

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

## Local setup

Requirements: Node 26+ and pnpm 11+.

```bash
pnpm install
pnpm db:migrate:local
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm key:create:local
```

Replace the example `PASSCODE` with a long local-only value. Copy the API key
printed by the final command, then start both local origins:

```bash
pnpm --filter @adrive/web dev
```

The dashboard/API is at `http://localhost:5173/`. Public file bytes are
served from `http://localhost:5174/`. The second port is a small streaming
proxy into the same SvelteKit process so both origins share one local D1/R2
state while the Worker still sees and enforces the content host.

### Developing over Tailscale (or another network hostname)

The dev server binds `0.0.0.0`, so other devices can use it — phones,
tablets, or a laptop pointed at a beefier dev box. Set both origins in
`apps/web/.dev.vars` to the hostname the _browser_ will use. With
Tailscale MagicDNS that's your machine name plus tailnet domain (see
`tailscale status`):

```bash
DASHBOARD_ORIGIN="http://<machine>.<tailnet>.ts.net:5173"
CONTENT_ORIGIN="http://<machine>.<tailnet>.ts.net:5174"
```

Any LAN hostname or IP works the same way; the origins just have to match
how the browser addresses the machine, since the Worker enforces its
host-routing rules even in dev.

Production passcode login creates a seven-day, host-only
`__Host-adrive-session` cookie. That cookie is always `Secure`, `HttpOnly`, and
`SameSite=Strict`, so browsers correctly refuse it on plain-HTTP non-localhost
dev URLs (like a Tailscale hostname). Use the generated API key in the
dashboard's “Local HTTP fallback” there. Passcode login works on
`http://localhost` and on any HTTPS dashboard origin.

Authentication bootstrap endpoints are protected by the `AUTH_GUARD` Workers
KV namespace. Login is limited to ten attempts per client every five minutes,
and five incorrect passcodes within fifteen minutes lock that client out for
thirty minutes. Device authorization creation is limited to five requests per
client every ten minutes, while device polling permits 150 requests per client
every ten minutes so the documented five-second polling interval remains valid.
Rate-limit and lockout responses use HTTP 429 with `Retry-After`. KV is
eventually consistent, so these controls are abuse mitigation rather than an
atomic global security boundary.

In another shell, configure and exercise the CLI:

```bash
pnpm adrive login http://localhost:5173 --headless
pnpm adrive list
pnpm adrive put ./path/to/file.pdf
pnpm adrive put ./path/to/private.bin --private
printf 'from stdin' | pnpm adrive put - --name note.txt
pnpm adrive put ./report.csv --expires 2026-08-31T00:00:00Z
pnpm adrive get <file-uuid> --output ./downloaded-file
pnpm adrive get <file-uuid> --output - > downloaded-file
pnpm adrive site put ./dist
pnpm adrive site put ./dist --id <existing-site-uuid>
pnpm adrive --json tag list
pnpm adrive tag create reports --color '#2563eb'
pnpm adrive tag set <file-uuid> reports important
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
pnpm format:check
pnpm check
pnpm test
```

Run `pnpm --filter @adrive/web types:worker` after changing Wrangler bindings.
The checked-in `worker-configuration.d.ts` is generated from `wrangler.jsonc`.
The Cloudflare adapter wrapper emits a standard module Worker with both `fetch`
and `scheduled` exports. Its signed internal maintenance request is authenticated
with a short-lived HMAC derived from `PASSCODE`; the endpoint cannot be invoked
with a static or public header.

The FTS5 tables are derived state so canonical tables can be backed up one table
at a time even though D1 whole-database export does not support virtual tables.
After restoring the canonical tables, rebuild local search state with:

```bash
pnpm search:rebuild:local
```

The rebuild reads `files`, `file_versions`, `tags`, and `file_tags`; it does not
modify those source tables.

## Cloudflare resources

The checked-in Wrangler D1 and R2 resource names are placeholders. The
`AUTH_GUARD` KV namespace is already provisioned and bound. Before deployment,
create one D1 database and one private R2 bucket, replace the D1 database ID,
apply the migration remotely, set production dashboard/content origins, and set
the passcode as a secret:

```bash
pnpm --filter @adrive/web exec wrangler secret put PASSCODE
```

No remote resource is created or modified by the local setup above.

File expiration is enforced immediately by API, search, file, and site reads.
The scheduled Worker runs every five minutes. It re-drives interrupted indexing,
physically deletes expired/trash bytes before removing canonical D1 rows, expires
dashboard/device/site-upload sessions, and retries deferred R2/site/vector
deletes. Work is bounded per invocation and every retryable transition is stored
in D1. Download counts increment for full downloads and the initial
`bytes=0-…` request only, so follow-up range requests do not inflate the count.

### Optional semantic search

Keyword, typo-tolerant, tag, and extracted-text search work without AI bindings.
`SEMANTIC_SEARCH` defaults to `auto`: both `AI` and `VECTORIZE` must be present
before the semantic layer activates. Set it to `off` to force the null-object
layer, or `required` to make a missing binding a startup error.

Provision the optional resources once, before the first vector insert:

```bash
pnpm --filter @adrive/web exec wrangler vectorize create adrive \
  --dimensions=384 --metric=cosine
pnpm --filter @adrive/web exec wrangler vectorize create-metadata-index adrive \
  --propertyName=deleted --type=boolean
pnpm --filter @adrive/web exec wrangler vectorize create-metadata-index adrive \
  --propertyName=kind --type=string
pnpm --filter @adrive/web exec wrangler vectorize create-metadata-index adrive \
  --propertyName=visibility --type=string
```

Then add these bindings to `apps/web/wrangler.jsonc` and regenerate types:

```jsonc
"ai": { "binding": "AI" },
"vectorize": [{ "binding": "VECTORIZE", "index_name": "adrive" }]
```

```bash
pnpm --filter @adrive/web types:worker
```

The embedding contract is pinned in Wrangler config to
`@cf/baai/bge-small-en-v1.5`, `pooling: "cls"`, and 384 dimensions. Changing any
of those values requires a new Vectorize index and a full reindex. The dashboard
shows the indexed chunk count and warns that Vectorize queries are billed against
stored vectors multiplied by dimensions. Failed files retry with exponential
backoff up to five attempts and can be queued again with **Reindex**.
