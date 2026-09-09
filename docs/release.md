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

5. From `apps/web`: create the job, dead-letter, and parked queues:

   ```
   wrangler queues create adrive-jobs-production
   wrangler queues create adrive-jobs-production-dlq
   wrangler queues create adrive-jobs-production-parked --message-retention-period-secs 1209600
   ```

6. In the Cloudflare dashboard, open **Images → Transformations**, select
   the zone that owns `CONTENT_DOMAIN` (`davis7.space` for
   `files.davis7.space`), and enable transformations. Dashboard thumbnails
   require this zone-level setting.
7. From `apps/web`, set each secret with `wrangler secret put <NAME> --env production`:
   `MAINTENANCE_SECRET` (12+ characters), `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
   `WORKOS_COOKIE_PASSWORD` (32+ characters), `WORKOS_WEBHOOK_SECRET`. Point the
   WorkOS redirect URI at `<DASHBOARD_ORIGIN>/auth/callback` and the webhook at
   `<DASHBOARD_ORIGIN>/api/webhooks/workos` (events `user.deleted`,
   `organization_membership.deleted`). For billing, set `AUTUMN_SECRET_KEY`
   and `AUTUMN_WEBHOOK_SECRET` (the Svix signing secret of an Autumn
   webhook endpoint at `<DASHBOARD_ORIGIN>/api/webhooks/autumn` subscribed
   to `billing.updated`), and deploy the plans with
   `bun --filter @adrive/web billing:push`. Without the key every plan gate
   fails open and nothing is metered.
8. Activate the zones for the hosted target's dashboard and content domains
   in Cloudflare. The `custom_domain` routes create DNS records for their
   exact hostnames; they do not create the tenant wildcard. Create a proxied
   `AAAA *.<CONTENT_DOMAIN> 100::` record and configure its matching Worker
   route. With the checked-in example, those are `*.files.davis7.space` and
   `*.files.davis7.space/*` in the `davis7.space` zone.

   Confirm the edge certificate covers `*.<CONTENT_DOMAIN>`. Universal SSL
   covers the zone apex and first-level hosts, so its `*.davis7.space`
   certificate does not cover `example.files.davis7.space`. Provision
   explicit coverage for `*.files.davis7.space` (for example, through
   Advanced Certificate Manager), or use a separate content-domain zone's
   apex as `CONTENT_DOMAIN`. Update the domain and Worker routes together.
   Verify DNS and HTTPS for an actual tenant hostname before cutover.

   Use temporary origins for the separate hosted target described above;
   preserve existing production records until cutover. Resolve conflicting
   records when assigning the intended custom domains. The checked-in
   `adrive.davis7.space` custom domain serves the static landing page
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
wrangler queues create adrive-jobs-production-parked --message-retention-period-secs 1209600
```

- The consumer retries a failed message up to `max_retries` (5) times,
  then moves it to `adrive-jobs-production-dlq`. Messages whose body does
  not decode as a job are acked and logged, never retried.
- The Worker also consumes the dead-letter queue: each message is
  written to the `failed_jobs` table (org, kind, payload, error,
  attempts) and acked. Owners see their org's rows at
  `GET /api/admin/failed-jobs`. Set the optional `ALERT_WEBHOOK_URL`
  secret to have a JSON summary POSTed whenever a batch dead-letters.
  Re-send a job only after fixing the cause, since it will otherwise
  fail again.
- If Postgres remains unavailable through the DLQ consumer's three retries,
  Cloudflare moves the message to `adrive-jobs-production-parked`. This queue
  deliberately has no automatic consumer, so an outage cannot exhaust another
  retry chain. Its retention is 14 days, not indefinite: alert on nonzero backlog
  and recover before expiry. Once Postgres is healthy, use the Queues HTTP pull
  API to pull parked messages and republish their original bodies to
  `adrive-jobs-production-dlq`; acknowledge parked messages only after successful
  publication. The DLQ consumer records them in `failed_jobs` for review.
- Emptying trash records every requested deletion in Postgres but sends at most
  20 immediate queue messages within a five-second budget. Cron reconciliation
  continues the rest in bounded batches.
- Local development uses the `adrive-jobs` / `adrive-jobs-dlq` / `adrive-jobs-parked` names and
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
