# adrive

The first three phases are working: a Cloudflare-backed file spine, responsive
dashboard, tags, and typo-tolerant keyword search. Uploads stream directly to R2,
metadata and append-only version history live in D1, and file bytes are served
from a separate cookie-less content origin. Search combines weighted FTS5 BM25
results with a filename trigram index, then applies tag filters against canonical
D1 rows. A minimal `login` / `put` / `get` CLI uses the same API.

## Local setup

Requirements: Node 26+, pnpm 11+, and access to this machine over Tailscale.

```bash
pnpm install
pnpm db:migrate:local
pnpm key:create:local
```

Copy the API key printed by the final command. Start both local origins:

```bash
pnpm --filter @adrive/web dev
```

The dashboard/API is at
`http://siva.otter-hawksbill.ts.net:5173/`. Public file bytes are served from
`http://siva.otter-hawksbill.ts.net:5174/`. The second port is a small streaming
proxy into the same SvelteKit process so both origins share one local D1/R2 state
while the Worker still sees and enforces the content host.

Paste the generated API key into the dashboard connection screen. The key stays
in the current browser tab's session storage. Passcode login and browser-side key
minting arrive in Phase 5; the dashboard currently connects with an existing key.

In another shell, configure and exercise the CLI:

```bash
pnpm adrive login http://siva.otter-hawksbill.ts.net:5173
pnpm adrive put ./path/to/file.pdf
pnpm adrive put ./path/to/private.bin --private
pnpm adrive get <file-uuid> --output ./downloaded-file
```

`login` prompts for the key without echoing it and saves credentials at mode
`0600` under `$XDG_CONFIG_HOME/adrive/config.json` (or
`~/.config/adrive/config.json`). Uploads default public; HTML is always made
public. Public URLs come back on their own line.

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
apply the migration remotely, and set production dashboard/content origins.
No remote resource is created or modified by the local setup above.
