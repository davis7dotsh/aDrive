# Releases, deployment, and rollback

## First-time setup (once)

From `apps/web` with an authenticated wrangler (`wrangler login`):

1. `wrangler d1 create adrive-production` — paste the id into
   `wrangler.jsonc` `env.production.d1_databases[0].database_id`.
2. `wrangler r2 bucket create adrive-production`
3. `wrangler kv namespace create AUTH_GUARD --env production` — paste the
   id into `env.production.kv_namespaces[0].id`.
4. `wrangler secret put PASSCODE --env production` (12+ characters).
5. DNS for `drive.davis7.space` and `files.davis7.space` must be on the
   Cloudflare zone for davis7.space; the custom-domain routes in
   `wrangler.jsonc` attach them on first deploy.
6. `pnpm release`
7. Set up backups on nexus (`scripts/backup/install-on-nexus.sh`) and
   complete the restore drill in `docs/backup-restore.md`.

## Releasing

```
pnpm release
```

The script refuses a dirty tree or placeholder ids, then runs format
check → type/lint checks → tests → audit → build → deploy dry run → D1
migrations → deploy, and appends the deployed commit to
`.release-history`.

A release is **complete** only after the production verification skill
passes against the live deployment (the script prints the reminder).
Run it before the first deployment is considered done, and after any
storage, authentication, upload, routing, or migration change.

## Migration compatibility rule

Migrations apply before the new Worker deploys, and rollback re-runs the
previous Worker against the migrated schema. Therefore every migration
must be backwards-compatible for at least one release: additive tables
and columns (with defaults) only; never drop, rename, or repurpose a
column until the release *after* the last code that used it is gone.

## Rollback

### Worker

```
cd apps/web
pnpm exec wrangler deployments list --env production   # find the previous version
pnpm exec wrangler rollback --env production           # interactive picker
```

Rollback redeploys the previous Worker bundle. It does not touch D1, R2,
KV, or secrets — which is why the migration rule above matters.

### D1

There is no in-place downgrade. Recovery options, in order of blast
radius:

1. **Cloudflare Time Travel** (point-in-time restore, 30-day window):
   `wrangler d1 time-travel info DB --env production` then
   `wrangler d1 time-travel restore DB --env production --timestamp <unix>`.
   This rewinds the whole database — anything written after the
   timestamp is lost.
2. **Nightly export**: restore per `docs/backup-restore.md` (full
   database or targeted rows).

### Secrets

`wrangler secret put PASSCODE --env production` any time. The scheduled
maintenance job detects the change and revokes all browser sessions and
pending device codes automatically (API keys stay).

## Deployment records

`.release-history` in the repo root accumulates
`<timestamp> <env> <commit>` lines locally. The deployed commit is also
visible via `wrangler deployments list --env production`.
