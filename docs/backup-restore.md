# Backup and restore

Application version history is not a backup. This document covers the
independent backup that runs on a machine outside Cloudflare (an
always-on box on your own network — referred to as the backup host
below) and how to restore from it. Until the restore drill below has
been performed at least once, a-drive must not be the only copy of
anything important.

## What is backed up, where

Nightly cron on the backup host (02:17 local, `scripts/backup/backup.sh`) writes to
`~/Backups/a-drive`:

| Path                     | Contents                                        | Retention   |
| ------------------------ | ----------------------------------------------- | ----------- |
| `r2-mirror/`             | Full mirror of the production R2 bucket         | Live mirror |
| `r2-deleted/<date>/`     | Objects deleted/overwritten upstream that day   | 30 days     |
| `postgres/daily/`        | Nightly gzipped `pg_dump`                       | 30 days     |
| `postgres/monthly/`      | First dump of each month                        | 12 months   |
| `manifests/`             | Object keys, sizes, hashes, dump digest per run | 30 days     |
| `logs/`, `last-run.json` | Run logs and machine-readable status            | 30 days     |

Deletions are **not** mirrored immediately: `rclone sync --backup-dir`
moves upstream-deleted objects into the dated trash directory, so an
erroneous purge (or a compromised credential deleting everything) leaves
30 days to recover.

Failures and suspicious shrinkage post to `ALERT_WEBHOOK_URL` from
`backup.env`. The verification skill also checks `last-run.json` age.

## Credentials involved

- rclone uses an R2 API token scoped **read-only** to the production
  bucket — it cannot delete or overwrite anything upstream.
- The Postgres dump uses a read-only database role (`DATABASE_URL` in
  `backup.env`).
- Neither the Worker secrets (WorkOS, maintenance), session cookies, nor deploy-capable tokens exist
  on the backup host. `backup.env` is `chmod 600` and gitignored.

## Restore procedures

Restores need a machine with rclone/wrangler and a Cloudflare token with
write access (deliberately _not_ stored on the backup host).

### One file

1. Find the object key: `grep <displayName or file id> manifests/manifest-<date>.json`
   (keys look like `v/<file-id>/<version-uuid>`).
2. Copy it back: `rclone copyto ~/Backups/a-drive/r2-mirror/<key> adrive-r2-rw:<bucket>/<key>`
   (or from `r2-deleted/<date>/<key>` if it was deleted).
3. If the database row was also lost, restore metadata via the full-database
   procedure or reinsert the `files`/`file_versions` rows from the daily
   export.

### All versions of one file

Same as above for every `v/<file-id>/*` key in the manifest; the daily
dump holds the matching `file_versions` rows.

### Metadata and tags only

1. `gunzip -k postgres/daily/adrive-<date>.sql.gz`
2. Extract the rows you need (`files`, `file_versions`, `tags`,
   `file_tags`) and apply them with `psql "$DATABASE_URL" -f <patch>.sql`.

### Complete Postgres database

PlanetScale keeps its own automatic backups with point-in-time restore;
that is the first option. The nightly `pg_dump` here is the independent
copy for when the account itself is unavailable. Always restore into a
fresh database and cut over — never import over the production database,
so it stays untouched for rollback.

The dump includes keyword search documents and semantic vectors, preserving
the search state of files already marked ready. No reindex is required for
a complete restore.

1. Create a new PlanetScale Postgres database (or a local one for a drill).
2. `gunzip -k postgres/daily/adrive-<date>.sql.gz`
3. `psql "<new database url>" -f adrive-<date>.sql`
4. Validate before cutover: spot-check table row counts and schema
   (`psql ... -c "SELECT COUNT(*) FROM files"`, same for `file_versions`,
   `tags`) against expectations from the manifest.
5. Point the Hyperdrive config at the restored database (or create a new
   one and update `wrangler.jsonc` `env.production.hyperdrive[0].id`) and
   redeploy. Keep the previous database until the deployment is verified.

### Whole application in a clean Cloudflare account

1. Create the Postgres database, its Hyperdrive config, the R2 bucket, and
   the KV namespace; paste the ids into `apps/web/wrangler.jsonc` under
   `env.production`.
2. Restore Postgres from the latest dump (above).
3. Restore R2: `rclone sync ~/Backups/a-drive/r2-mirror adrive-r2-rw:<bucket>`
4. Set the secrets: `wrangler secret put <NAME> --env production` for
   `MAINTENANCE_SECRET` and the four `WORKOS_*` values.
5. Deploy: `bun release` (or `wrangler deploy --env production`).
6. DNS: point `drive.davis7.space` and `files.davis7.space` at the new
   Worker (custom domains attach from the routes in wrangler.jsonc).
7. Run the verification skill (`.agents/skills/verify-deployment`).

Note: KV only holds rate-limit counters and needs no restore. Sessions
are revoked by the passcode-rotation detector on the first maintenance
run in a new environment — sign in again afterwards.

## Restore drill (required before trusting a-drive with sole copies)

Perform each of these once against the real deployment, recording the
date and outcome at the bottom of this file:

1. Restore one file and verify its checksum matches the manifest.
2. Restore all versions of one multi-version file.
3. Restore metadata and tags for one file into a scratch Postgres database.
4. Restore the complete Postgres dump into a scratch database and spot-check
   row counts against production.
5. Reconstruct the application in a clean environment (separate Worker
   name or account) end to end, including one download through the
   dashboard.

## Drill log

| Date      | Drill | Outcome |
| --------- | ----- | ------- |
| _pending_ | —     | —       |
