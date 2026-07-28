# adrive

The first five phases are working: a Cloudflare-backed file spine, responsive
dashboard, tags, typo-tolerant keyword search, static-site publishing, and
deployment-based authentication.
Uploads stream directly to R2, metadata and append-only version history live in
D1, and file/site bytes are served from a separate cookie-less content origin.
Search combines weighted FTS5 BM25 results with a filename trigram index, then
applies tag filters against canonical D1 rows. The CLI supports file transfer and
safe, staged directory publishing.

## Local setup

Requirements: Node 26+, pnpm 11+, and access to this machine over Tailscale.

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

The dashboard/API is at
`http://siva.otter-hawksbill.ts.net:5173/`. Public file bytes are served from
`http://siva.otter-hawksbill.ts.net:5174/`. The second port is a small streaming
proxy into the same SvelteKit process so both origins share one local D1/R2 state
while the Worker still sees and enforces the content host.

Production passcode login creates a seven-day, host-only
`__Host-adrive-session` cookie. That cookie is always `Secure`, `HttpOnly`, and
`SameSite=Strict`, so browsers correctly refuse it on the plain-HTTP local
Tailscale URL. Use the generated API key in the dashboard's “Local HTTP
fallback” there. Passcode login works when the dashboard origin is HTTPS.

In another shell, configure and exercise the CLI:

```bash
pnpm adrive login http://siva.otter-hawksbill.ts.net:5173 --headless
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
stdout and cannot be combined with `--json`; diagnostics remain on stderr.

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

The FTS5 tables are derived state so canonical tables can be backed up one table
at a time even though D1 whole-database export does not support virtual tables.
After restoring the canonical tables, rebuild local search state with:

```bash
pnpm search:rebuild:local
```

The rebuild reads `files`, `file_versions`, `tags`, and `file_tags`; it does not
modify those source tables.

## Cloudflare resources

The checked-in Wrangler resource names are placeholders. Before deployment,
create one D1 database and one private R2 bucket, replace the D1 database ID,
apply the migration remotely, set production dashboard/content origins, and set
the passcode as a secret:

```bash
pnpm --filter @adrive/web exec wrangler secret put PASSCODE
```

No remote resource is created or modified by the local setup above.

File expiration is enforced immediately by API, search, file, and site reads.
The Phase 6 scheduled worker owns physical deletion of expired/trash bytes and
expired dashboard/device-session rows; the indexed D1 fields and query behavior
needed by that sweep are already in place. Download counts increment for full
downloads and the initial `bytes=0-…` request only, so follow-up range requests
do not inflate the count.
