# Releases, deployment, and rollback

## Hosted bootstrap and existing data

The hosted product starts with a **separate, empty Postgres database**.
Migration `0004_tenancy.sql` rejects any populated single-tenant database
before changing its tables. Keep the existing drive and its backups;
do not use `--reset` to get past that guard.

The supported import below copies D1 metadata into the new hosted target
after the owner signs up with WorkOS. An existing single-tenant Postgres
drive needs a separate migration with explicit owner/org mapping; this
release does not provide that importer or an in-place backfill. Keep using
that drive until its migration is prepared and verified. A Postgres dump
alone restores the old schema, so it cannot replace the tenancy import.

Use a separate Worker and temporary dashboard/content origins to verify
the hosted target before moving production routes. Keep source writes
paused from the final export through verification and cutover. Imports
retain R2 keys: for an isolated rehearsal copy the referenced objects to
the target bucket; using the source bucket allows hosted cleanup to affect
the old drive. Before cutover, verify imported counts, owner access, file
downloads, search, and cleanup ownership. Retain the source deployment and
database for rollback; a hosted Worker rollback does not migrate data back
into the old schema.

## First-time setup (once)

App Worker commands run from `apps/web`. Landing-site commands run from
`apps/site` (no `--env`). `bun release` and the backup installer run from
the repository root.

1. Create a new PlanetScale Postgres 17+ database (region close to most users)
   with `vector` 0.8 or newer and the `pg_trgm` extension available. Set
   `DATABASE_URL` to its migration-admin connection string and apply the
   schema from `apps/web`:

   ```
   bun scripts/pg-migrate.mjs --url "$DATABASE_URL"
   ```

   Provision and verify the restricted runtime login under **Database roles**
   below. Set `ADRIVE_RUNTIME_DATABASE_URL` to that login's connection string
   for the same database, then create Hyperdrive on the direct port 5432
   with caching disabled:

   ```
   wrangler hyperdrive create adrive-production --connection-string="$ADRIVE_RUNTIME_DATABASE_URL" --caching-disabled
   ```

   Paste the id into `wrangler.jsonc` `env.production.hyperdrive[0].id`.
   Keep `DATABASE_URL` on the separate migration-admin credentials when
   releasing; `bun release` applies migrations with that role.

2. From `apps/web`: `wrangler r2 bucket create adrive-production`
3. From `apps/web`: `wrangler kv namespace create AUTH_GUARD --env production`
   — paste the id into `env.production.kv_namespaces[0].id`.
4. Semantic search needs no extra provisioning: embeddings come from the
   Workers AI `ai` binding already declared in `wrangler.jsonc`, and the
   vectors live in the Postgres `file_chunks` table (pgvector). The
   production env sets `SEMANTIC_SEARCH=required`, so the deploy fails
   loudly if the `AI` binding is missing. Embeddings run within the
   Workers Paid plan's included neuron allocation at personal scale.

5. From `apps/web`: create the job queue and its dead-letter queue:

   ```
   wrangler queues create adrive-jobs-production
   wrangler queues create adrive-jobs-production-dlq
   ```

6. In the Cloudflare dashboard, open **Images → Transformations**, select
   the zone that owns `CONTENT_ORIGIN` (`davis7.space` for
   `files.davis7.space`), and enable transformations. Dashboard thumbnails
   require this zone-level setting.
7. From `apps/web`, set each secret with `wrangler secret put <NAME> --env production`:
   `MAINTENANCE_SECRET` (12+ characters), `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
   `WORKOS_COOKIE_PASSWORD` (32+ characters), `WORKOS_WEBHOOK_SECRET`. Point the
   WorkOS redirect URI at `<DASHBOARD_ORIGIN>/auth/callback` and the webhook at
   `<DASHBOARD_ORIGIN>/api/webhooks/workos` (events `user.deleted`,
   `organization_membership.deleted`).
8. The `davis7.space` zone must be active in Cloudflare. Remove existing
   CNAME records for `drive.davis7.space`, `files.davis7.space`, and
   `adrive.davis7.space` before deployment; the custom-domain routes in
   the `wrangler.jsonc` files create the required DNS records
   automatically. `adrive.davis7.space` serves the static landing page
   (`apps/site`, an assets-only Worker with no build step).
9. From the repo root: `bun release`
10. From the repo root: set up backups on your backup host
    (`scripts/backup/install-backup-host.sh`) and complete the restore drill
    in `docs/backup-restore.md`.

Semantic search notes for the first deploy:

- Files uploaded before the index existed (or while bindings were absent)
  sit in `index_state = 'disabled'` and are backfilled by the maintenance
  cron at 5 files per 5 minutes. A large pre-existing corpus takes hours;
  the settings page's "indexed chunks" count shows progress.
- Embeddings live in Postgres beside the file rows, so they are restored
  with the database. Files whose embeddings are missing after a partial
  restore regenerate on reindex.

## Database roles

Migrations run with the schema-owning administrator. The Worker connects
through Hyperdrive with a separate, non-owner login that is neither a
superuser nor allowed to bypass row-level security. Migration 0004 creates
the `adrive_app` permission role without login and grants it application
table access. If the provider prevents role creation and the migration
prints an insufficient-privilege notice, have the database administrator
create `adrive_app` and apply the grants at the end of that migration before
continuing.

As the database administrator, provision a login using the provider's role
tools or equivalent SQL:

```sql
CREATE ROLE adrive_runtime LOGIN INHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT adrive_app TO adrive_runtime;
```

Set its password through the provider or `\password adrive_runtime` in
`psql`. Connect using `ADRIVE_RUNTIME_DATABASE_URL` and verify:

```sql
SELECT current_user, rolsuper, rolbypassrls,
       pg_has_role(current_user, 'adrive_app', 'USAGE') AS inherits_app
FROM pg_roles WHERE rolname = current_user;

SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tableowner = current_user;
```

Require `rolsuper = false`, `rolbypassrls = false`, `inherits_app = true`,
and no owned application tables. Do not grant the migration-admin role to
this login. Tenant-pinned transactions enforce RLS; ordinary statements
still rely on their explicit tenant predicates. Role setup alone is not a
live tenant-isolation test.

## Queues

The `JOBS` binding provides one Cloudflare Queue per environment for
background indexing, purges, and site cleanup. `wrangler.jsonc` declares
the Worker as its consumer; the queue itself is created once:

```
wrangler queues create adrive-jobs-production
wrangler queues create adrive-jobs-production-dlq
```

- The consumer retries a failed message up to `max_retries` (5) times,
  then moves it to `adrive-jobs-production-dlq`. Messages whose body does
  not decode as a job are acked and logged, never retried.
- Inspect the dead-letter queue with
  `wrangler queues consumer` tooling or the dashboard; nothing drains it
  automatically. Re-send a message from the DLQ only after fixing the
  cause, since the same job will otherwise fail again.
- Local development uses the `adrive-jobs` / `adrive-jobs-dlq` names and
  needs no provisioning; `wrangler dev` simulates the queue.

## Releasing

```
bun release
```

The script refuses a dirty tree or placeholder ids in the target env,
then runs format check → type/lint checks → tests → audit → build →
app deploy dry run → landing-site dry run → Postgres migrations → app deploy →
landing-site deploy, and appends the deployed commit to
`.release-history`. If the landing site fails after the app Worker is
live, the script still records the app commit and prints rollback
commands for `apps/site`.

A release is **complete** only after the production verification skill
passes against the live deployment (the script prints the reminder).
Run it before the first deployment is considered done, and after any
storage, authentication, upload, routing, or migration change.

## Migration compatibility rule

For later releases of an existing hosted instance, migrations apply before
the new Worker deploys, and rollback re-runs the previous hosted Worker
against the migrated schema. Therefore every subsequent migration
must be backwards-compatible for at least one release: additive tables
and columns (with defaults) only; never drop, rename, or repurpose a
column until the release _after_ the last code that used it is gone.

The initial tenancy bootstrap replaces the old authentication schema and
adds mandatory tenant columns. It therefore runs only on the fresh target
described above. Do not apply it to the database serving an older Worker.

## Rollback

### Worker

```
cd apps/web
bun x wrangler deployments list --env production   # find the previous version
bun x wrangler rollback --env production           # interactive picker
```

Rollback redeploys the previous Worker bundle. It does not touch
Postgres, R2, KV, or secrets — which is why the migration rule above matters.

### Landing site

The landing page is a separate assets-only Worker (`apps/site`). Roll it
back the same way:

```
cd apps/site
bun x wrangler deployments list
bun x wrangler rollback
```

### Postgres

There is no in-place downgrade. Recovery options, in order of blast
radius:

1. **PlanetScale backups** (automatic daily, plus point-in-time):
   PlanetScale point-in-time restore from the database's Backups page.
   This rewinds the whole database — anything written after the
   timestamp is lost.
2. **Nightly export**: restore per `docs/backup-restore.md` (full
   database or targeted rows).

### Secrets

Rotate `MAINTENANCE_SECRET` with `wrangler secret put` any time; only the
Worker's own cron and queue self-requests use it. Browser sessions live in
WorkOS: revoke them from the WorkOS dashboard (API keys stay).

## Deployment records

`.release-history` in the repo root accumulates
`<timestamp> <env> <commit>` lines locally. The deployed commit is also
visible via `wrangler deployments list --env production`.

## One-off move from D1

The existing D1 instance copies its metadata into the separate hosted
Postgres target once. R2 keys are preserved; configure the verified target
bucket as described above. Sessions, device codes, and the passcode hash are not
carried over; sign in again afterwards. Semantic vectors are not carried
over either; every file is left `pending` and re-embeds through the
indexing sweep.

`wrangler d1 export` refuses databases that contain FTS5 virtual tables,
so export one table at a time from a checkout that still has the D1
binding (a checkout from before the Postgres port):

```
cd apps/web
mkdir -p /tmp/adrive-d1
for t in files file_versions tags file_tags site_assets api_keys \
         pending_site_asset_deletes instance_secrets \
         site_upload_sessions staged_site_assets; do
  bun x wrangler d1 export DB --env production --remote --table $t --output /tmp/adrive-d1/$t.sql
done
```

First finish hosted bootstrap on the separate target and sign in once
with the real owner's WorkOS account. Read that account's user and personal
org IDs from WorkOS or the target's `users`, `memberships`, and `orgs`
tables. Confirm the mapping before copying the old owner's files and API
keys. The target should contain only those identity rows, with no uploaded
content or unrelated tenants.

Then from this checkout, with `DATABASE_URL` pointing at the target using
migration-admin credentials:

```
cd apps/web
bun scripts/pg-migrate.mjs --url "$DATABASE_URL"
bun scripts/d1-to-postgres.mjs --dump /tmp/adrive-d1 --url "$DATABASE_URL" \
  --org org_WORKOS_OWNER_ORG --user user_WORKOS_OWNER \
  --email owner@example.com --slug owner-slug
```

The script prints per-table counts and the Postgres totals at the end.
Compare them with the row counts in the exports before cutover. If a
rehearsal needs to restart, recreate only its disposable target and repeat
bootstrap/import. Never use `--wipe` against the source drive or a hosted
database containing other users' data. Local importer checks do not prove
the live WorkOS identity mapping or production cutover.

All listed tables must be exported, including empty ones. Unfinished site
uploads are not resumed: their stored assets enter the cleanup queue unless
the key is referenced by a published site asset. Export while writes to the
old drive are paused so the table snapshots describe the same state.
