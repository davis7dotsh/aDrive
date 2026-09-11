# Backup and restore

Application version history is not a backup. This document covers the
independent backup that runs on a machine outside Cloudflare (an
always-on box on your own network — referred to as the backup host
below) and how to restore from it. Until the restore drill below has
been performed at least once, a-drive must not be the only copy of
anything important.

## Layers

Metadata and object bytes need separate recovery paths:

- **PlanetScale backups** provide database recovery. Verify the selected
  database's automatic-backup schedule, point-in-time restore availability,
  and retention in its Backups page; do not assume defaults satisfy the
  recovery requirement. These backups do not survive loss of that account.
- **The home-host `pg_dump`** below is the independent copy: a different
  machine, a different credential, outside Cloudflare and PlanetScale.
- **R2** is the primary object store. Its S3 API does not support bucket
  versioning ([compatibility reference](https://developers.cloudflare.com/r2/api/s3/api/)).
  The home-host mirror below preserves deleted and overwritten objects
  with `--backup-dir`. An additional account copy must also retain changes;
  a plain `rclone sync` propagates deletions and is not a retained backup.

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

The twelve monthly database dumps do not imply twelve months of recoverable
file bytes: deleted-object retention is only 30 days. Objects created and
deleted between nightly runs may never reach the mirror. The R2 copy and
Postgres dump are separate snapshots while the application is running;
before restoring, verify that every object referenced by the selected dump
exists in the mirror or retained deleted-object directories. A successful
backup status alone does not establish cross-store consistency.

Build that reference list from ordinary files' `file_versions.r2_key`,
non-null `file_versions.thumbnail_r2_key`, and `site_assets.r2_key`. Site
versions use synthetic `site-version/...` markers in `file_versions.r2_key`;
those markers are not R2 objects. Use the stored keys exactly, including
imported keys, rather than assuming every object has a `v/<file-id>/` prefix.

Failures and suspicious shrinkage post to `ALERT_WEBHOOK_URL` from
`backup.env`. The verification skill also checks `last-run.json` age.

## Credentials involved

- rclone uses an R2 API token scoped **read-only** to the production
  bucket — it cannot delete or overwrite anything upstream.
- The Postgres dump uses a read-only database role (`DATABASE_URL` in
  `backup.env`) authorized to export every tenant despite forced RLS.
  Provision a separate provider-supported backup role with `SELECT` on
  current and future application tables and permission to bypass RLS for
  the dump. The restricted Worker runtime login is not a backup login:
  `pg_dump` normally disables row security and fails when the role cannot
  bypass it. Verify a real dump and scratch restore before installing cron;
  do not turn on row filtering just to make a partial dump succeed.
- Neither the Worker secrets (WorkOS, maintenance), session cookies, nor deploy-capable tokens exist
  on the backup host. `backup.env` is `chmod 600` and gitignored.

## Restore procedures

Restores need a machine with rclone/wrangler and a Cloudflare token with
write access (deliberately _not_ stored on the backup host).

### One file

1. From a scratch restoration of the matching database dump, find ordinary
   files' `file_versions.r2_key` and any `thumbnail_r2_key`; for sites use
   `site_assets.r2_key`, excluding synthetic site-version markers. Locate
   those exact keys in the object manifest, which contains paths and hashes,
   not display names.
2. Copy it back: `rclone copyto ~/Backups/a-drive/r2-mirror/<key> adrive-r2-rw:<bucket>/<key>`
   (or from `r2-deleted/<date>/<key>` if it was deleted).
3. If the database row was also lost, restore metadata via the full-database
   procedure or reinsert the `files`/`file_versions` rows from the daily
   export.

### All versions of one file

Repeat for each stored key in the selected file's `file_versions` rows and
its thumbnails, or the site's `site_assets` rows. Preserve the exact keys
from the dump, including imported paths; do not infer them from a prefix.

### Metadata and tags only

1. `gunzip -k postgres/daily/adrive-<date>.sql.gz`
2. Restore the dump into a scratch database first. Prepare and review a
   tenant-scoped metadata patch, including foreign keys and any affected
   usage/search state; validate it on the scratch copy before applying it
   to the explicitly selected target with `psql -X -v ON_ERROR_STOP=1
--single-transaction "$ADRIVE_RESTORE_DATABASE_URL" -f <patch>.sql`.

### Complete Postgres database

Use the provider's verified backup/PITR configuration as the first option.
The nightly `pg_dump` here is the independent
copy for when the account itself is unavailable. Always restore into a
fresh database and cut over — never import over the production database,
so it stays untouched for rollback.

The dump includes keyword search documents and semantic vectors, preserving
the search state of files already marked ready. No reindex is required for
a complete restore.

1. Create a new empty Postgres database with compatible `vector` and
   `pg_trgm` extensions (or a disposable local database for a drill).
   Set `ADRIVE_RESTORE_DATABASE_URL` to its schema-admin connection string
   and confirm it identifies the new target.
2. `gunzip -k postgres/daily/adrive-<date>.sql.gz`
3. `psql -X -v ON_ERROR_STOP=1 --single-transaction "$ADRIVE_RESTORE_DATABASE_URL" -f postgres/daily/adrive-<date>.sql`
4. Recreate and verify the restricted runtime role and application grants
   using [Database roles](release.md#database-roles). Dumps use `--no-owner
--no-privileges`, so restoring the schema does not restore those grants.
   The migration ledger is restored too; do not expect already-applied
   migrations to recreate missing roles or grants.
5. Validate schema and tenant row counts against the selected source
   snapshot or drill evidence, and verify all referenced R2 objects and
   their hashes. The object manifest contains no Postgres table row counts.
   Exercise authentication, downloads, search, and background work on the
   isolated target before cutover.
6. Point the Hyperdrive config at the restored database (or create a new
   one and update `wrangler.jsonc` `env.production.hyperdrive[0].id`) and
   redeploy. Keep the previous database until the deployment is verified.

### Whole application in a clean Cloudflare account

1. Follow only the resource-provisioning portions of
   [first-time setup](release.md#first-time-setup-once) for separate Worker,
   database, Hyperdrive, R2, KV, all three queues, AI and browser bindings,
   and tenant wildcard DNS/TLS. Skip that procedure's migration and deployment
   commands until the dump and objects are restored below. Use temporary
   origins; preserve the existing deployment and its data for rollback.
2. Restore the selected Postgres dump into the empty target before running
   migrations against it, then restore runtime roles/grants as above.
3. Copy the selected objects into the new, empty bucket. Reconstruct any
   referenced deleted objects from the retained directories. Use `rclone
copy`, not a destructive sync against an existing bucket, and check
   every database reference before allowing cleanup jobs to run.
4. Set all intended provider and operational credentials from the
   [launch checklist](launch-checklist.md), configure callback/webhook URLs,
   and point Hyperdrive at the restricted runtime login with caching disabled.
5. Set `DATABASE_URL` to the restored target's migration-admin connection
   string and run `bun release` from the repository root to apply any newer
   migrations and deploy the app and landing site.
6. Run `.agents/skills/verify-deployment` against this isolated deployment;
   cut over the intended routes only after verification. A restore drill
   never requires replacing the existing production routes.

KV contains disposable lookup caches and needs no restore. Browser sessions
use WorkOS; restoring Postgres or rotating `MAINTENANCE_SECRET` does not
revoke them. Restore the intended WorkOS configuration and explicitly revoke
sessions through WorkOS when incident recovery requires it. API key rows and
content-grant secrets are part of the database dump and need their own
incident response decision.

## Restore drill (required before trusting a-drive with sole copies)

Use backups of the real deployment, restoring into separate scratch
resources. Record the source snapshot, destination, date, checks, and outcome
below; do not overwrite live objects or metadata to perform a drill:

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
