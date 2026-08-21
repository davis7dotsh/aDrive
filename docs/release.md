# Releases, deployment, and rollback

## First-time setup (once)

Wrangler commands run from `apps/web`; `bun release` and the backup
installer run from the repository root.

1. From `apps/web`: `wrangler d1 create adrive-production` — paste the id
   into `wrangler.jsonc` `env.production.d1_databases[0].database_id`.
2. From `apps/web`: `wrangler r2 bucket create adrive-production`
3. From `apps/web`: `wrangler kv namespace create AUTH_GUARD --env production`
   — paste the id into `env.production.kv_namespaces[0].id`.
4. From `apps/web`: create the semantic-search index (the production env
   sets `SEMANTIC_SEARCH=required`, so the deploy fails without it):

   ```
   wrangler vectorize create adrive-production --dimensions=384 --metric=cosine
   wrangler vectorize create-metadata-index adrive-production --property-name=deleted --type=boolean
   wrangler vectorize create-metadata-index adrive-production --property-name=kind --type=string
   wrangler vectorize create-metadata-index adrive-production --property-name=visibility --type=string
   ```

   The Workers AI binding needs no provisioning — it activates with the
   `ai` binding already declared in `wrangler.jsonc`. Both services sit
   inside the Workers Paid plan's included allocation at personal scale
   (50M queried + 10M stored vector dimensions per month ≈ 26k chunks at
   384 dims; embeddings run within the 10k neurons/day allocation).

5. In the Cloudflare dashboard, open **Images → Transformations**, select
   the zone that owns `CONTENT_ORIGIN` (`davis7.space` for
   `files.davis7.space`), and enable transformations. Dashboard thumbnails
   require this zone-level setting.
6. From `apps/web`: `wrangler secret put PASSCODE --env production`
   (12+ characters).
7. The `davis7.space` zone must be active in Cloudflare. Remove existing
   CNAME records for `drive.davis7.space` and `files.davis7.space` before
   deployment; the custom-domain routes in `wrangler.jsonc` create the
   required DNS records automatically.
8. From the repo root: `bun release`
9. From the repo root: set up backups on your backup host
   (`scripts/backup/install-backup-host.sh`) and complete the restore drill
   in `docs/backup-restore.md`.

Semantic search notes for the first deploy:

- Files uploaded before the index existed (or while bindings were absent)
  sit in `index_state = 'disabled'` and are backfilled by the maintenance
  cron at 5 files per 5 minutes. A large pre-existing corpus takes hours;
  the settings page's "indexed chunks" count shows progress.
- Vectorize contents are derived state (like the FTS tables): after a D1
  restore, vectors for purged files are orphaned but harmless, and
  missing vectors regenerate on reindex. They are deliberately not part
  of the backup set.

## Releasing

```
bun release
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
column until the release _after_ the last code that used it is gone.

## Rollback

### Worker

```
cd apps/web
bun x wrangler deployments list --env production   # find the previous version
bun x wrangler rollback --env production           # interactive picker
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
