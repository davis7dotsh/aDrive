# Hosted product: build status

Written 2026-09-09 after the overnight build. Everything below is local and
unpushed. Nothing has run against real WorkOS, Autumn, PlanetScale,
Hyperdrive, Queues, URL Scanner, or rate limit namespaces; every external
service has a fake or a fail-open null used by local dev and tests.

## What exists

One linear chain of 37 commits on top of `main`, grouped as the stacks in
`hosted-product.md`. Each branch tip below is the last commit of its stack;
every commit was green on `bun run check`, `bun run test`, and `test:routes`
when it landed, and the final tip passes all three plus `format:check` and
`check:forbidden`.

| Branch                | Stack                                                                                                           | Commits        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | -------------- |
| `hosted/a0-plan-docs` | plan docs                                                                                                       | 1              |
| `hosted/a1-pg-infra`  | A1: Hyperdrive + `@effect/sql-pg`, migrations runner, docker Postgres, test harness                             | 3              |
| `hosted/a4-files`     | A4: files, tags, purge on Postgres                                                                              | 1              |
| `hosted/a2-auth`      | A2+A3: auth and grant secrets on Postgres                                                                       | 1              |
| `hosted/a7-sites`     | A7: sites on Postgres                                                                                           | 1              |
| `hosted/a5-search`    | A5+A6: tsvector/pg_trgm keyword search, pgvector semantic search                                                | 1              |
| `hosted/a8-cutover`   | A8: D1 removed, `d1-to-postgres.mjs` one-off move, backups on `pg_dump`                                         | 2              |
| `hosted/d1-queues`    | D1: Queues binding, `Job` schema, consumer facade                                                               | 2              |
| `hosted/b-tenancy`    | B1-B8: orgs/users/memberships + RLS, identity hook, WorkOS AuthKit, per-org keys, scoped queries, per-org quota | 6 (+1 dev fix) |
| `hosted/c-content`    | C1+C2: `<slug>.<CONTENT_DOMAIN>` hosts, KV slug cache, slug changes with 30-day history                         | 2              |
| `hosted/d-queues`     | D2-D4: indexing, purges, site cleanup through Queues; DLQ into `failed_jobs`                                    | 4              |
| `hosted/e-abuse`      | E1-E6: rate limit bindings, trust levels, scan pipeline, reports + kill switch, `/admin`, `docs/abuse.md`       | 6              |
| `hosted/f-billing`    | F1-F4: `autumn.config.ts`, storage and AI metering, `/settings/billing`, Svix webhook                           | 4              |
| `hosted/g-ops`        | G1+G3: backups doc, launch checklist (+ the vite allowedHosts fix)                                              | 3              |

Final tip: `hosted/g-ops`. Final counts on it: 217 unit tests, 73 route
tests, 0 type or svelte errors. The only failing check anywhere is
`check:wrangler-drift`, which correctly reports the Hyperdrive placeholder id.

G2 (structured logs + Analytics Engine dataset) was built but dropped from the
chain because it conflicted with every later stack; it lives in the reflog of
`hosted/g-ops` (commit `6ee7f95` on the pre-rebase branch) and is a small
follow-up to redo on top.

## Verified by hand on the final tip

A dev server on the `hosted/g-ops` worktree, with the fake WorkOS client and
the local Postgres:

- Sign-in redirect, callback, personal org bootstrap (`orgs`, `users`,
  `memberships`, `org_usage` rows appear).
- Upload as that org, `org_usage.stored_bytes` increments, file serves from
  `http://<slug>.100.100.40.20.nip.io:5174/f/<id>`.
- The same file id on another org's host is 404; a second org cannot list or
  fetch it through the API.
- `/api/billing` returns the free plan with usage; `/api/admin/overview`
  answers for a user in `ADMIN_USER_IDS`.
- The D1 export move script was run against the local D1 state of the main
  checkout and produced correct booleans, timestamps, search documents, and
  API keys.

Not verified by hand: the browser dashboard itself (only the API and content
routes were exercised), the queue consumer through the real facade (the route
tests drive it in-process), and anything behind a real credential.

## Bringing it up tomorrow

```sh
cd /home/davis/.t3/worktrees/a-drive/hosted-g-ops
docker compose up -d                        # already running on this box
bun install
bun db:pg:migrate:local                     # already applied locally
bun --filter @adrive/web dev                # binds 0.0.0.0, allowedHosts on
```

Dashboard: `http://siva.otter-hawksbill.ts.net:5173/`. Content hosts:
`http://<slug>.100.100.40.20.nip.io:5174/`. Wildcard subdomains of a
Tailscale MagicDNS name do not resolve on other devices, so `CONTENT_DOMAIN`
in `.dev.vars` points at nip.io, which resolves any `*.100.100.40.20.nip.io`
name to the Tailscale address from anywhere on the tailnet.

The session cookie drops its `__Host-` prefix and `Secure` flag when the
dashboard origin is plain http, so sign-in works from a Tailscale hostname.
On https it is the `Secure`, host-only cookie as before.

`apps/web/.dev.vars` in that worktree has placeholder values for every
secret. With `WORKOS_API_KEY` empty the fake signs you in as `user_local`;
set `ADMIN_USER_IDS="user_local"` (already set) to see `/admin`.

## What needs real credentials

| Secret or id                                                                            | Used by                           | Without it                  |
| --------------------------------------------------------------------------------------- | --------------------------------- | --------------------------- |
| Hyperdrive id in `wrangler.jsonc` `env.production`                                      | deploy                            | release preflight refuses   |
| `DATABASE_URL` (PlanetScale direct port)                                                | `bun release` migrations, backups | none locally                |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_WEBHOOK_SECRET` | sign-in                           | fake client                 |
| `MAINTENANCE_SECRET`                                                                    | cron and queue HMAC               | placeholder in `.dev.vars`  |
| `AUTUMN_SECRET_KEY`, `AUTUMN_WEBHOOK_SECRET`                                            | billing                           | fail-open null              |
| `ADMIN_USER_IDS`                                                                        | `/admin`                          | nobody is admin             |
| `URLSCAN_API_KEY` + `CF_ACCOUNT_ID`                                                     | HTML/site scanning                | verdict recorded as skipped |
| `CF_API_TOKEN` + `CF_ZONE_ID`                                                           | edge cache purge on kill switch   | logged and skipped          |
| `ALERT_WEBHOOK_URL`                                                                     | DLQ alerts                        | none                        |
| Queues `adrive-jobs-production` and `-dlq`, rate limit namespaces 2001-2004             | production bindings               | local equivalents only      |

## Known gaps and decisions to make

- `BillingGates.canShare` is not yet consulted by `canPublish`. The rebase
  agent flagged a real design question: `canShare` fails open when Autumn is
  unconfigured, so "canShare OR verified" would let brand-new orgs publish in
  every environment without Autumn. Suggested shape: trust allows, OR plan is
  paid AND `canShare`. Read `orgs.plan` locally first.
- `org_usage.file_count` is never incremented. Harmless today; either wire it
  in the upload/purge transactions or drop the column.
- The dashboard does not render `notifications` rows (quarantine notices);
  they are written and visible through `/admin` only.
- `RL_PUBLISH` is bound but unused; publishes are gated by trust and the
  scanner instead.
- Indexing retry cadence is the larger of the queue backoff and the row's own
  `index_next_run_at`; the 15-minute reconciliation sweep covers gaps.
- A 30-day trash purge is delivered early about 60 times because of the
  12-hour queue delay cap; each delivery is a cheap re-send.
- `hosted-product.md`'s "Where the code is today" table still describes the
  D1 era; it is historical.
- The `apps/site` marketing app is untouched.

## Opening the stacked PRs

Branch protection's "dismiss stale approvals" should be off for `gh stack`
merges. From the `hosted-g-ops` worktree:

```sh
gh stack init hosted/a0-plan-docs hosted/a1-pg-infra hosted/a4-files \
  hosted/a2-auth hosted/a7-sites hosted/a5-search hosted/a8-cutover \
  hosted/d1-queues hosted/b-tenancy hosted/c-content hosted/d-queues \
  hosted/e-abuse hosted/f-billing hosted/g-ops
gh stack submit --auto      # drafts, one PR per branch, bottom targets main
```

Stack B is six commits on one branch; split it with `gh stack modify` if
six separate PRs are wanted, the commits are already one-per-substep.

## Worktrees and databases

Worktrees live under `/home/davis/.t3/worktrees/a-drive/hosted-*`, one per
branch. They are safe to remove with `git worktree remove` once the PRs
exist; the branches stay. The docker Postgres holds `adrive` (dev, migrated
to `0008`), `adrive_test`, and one `adrive_test_<stack>` database per agent;
all but `adrive` and `adrive_test` can be dropped.
