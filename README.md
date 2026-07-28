# adrive

Phase 1 is a working Cloudflare-backed file spine: authenticated streaming uploads,
D1 metadata, R2 bytes, a cookie-less public content origin, version-aware file URLs,
and a minimal `login` / `put` / `get` CLI.

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

## Cloudflare resources

The checked-in Wrangler resource names are placeholders. Before deployment,
create one D1 database and one private R2 bucket, replace the D1 database ID,
apply the migration remotely, and set production dashboard/content origins.
No remote resource is created or modified by the local setup above.
