---
name: deploy-fresh-instance
description: Bootstrap a fresh hosted a-drive deployment with Cloudflare Workers, Postgres through Hyperdrive, R2, KV, Queues, WorkOS, and optional paid billing. Use for a new account or target domain. Routine releases use bun release and the maintained release runbook.
---

# Deploy a fresh hosted a-drive instance

Follow [release setup](../../../docs/release.md) for provisioning, exact
commands, migration compatibility, and rollback. This skill identifies the
bootstrap decisions and acceptance gates; historical single-tenant deploys
are not proof of the hosted architecture.

## Establish the target

- Confirm the intended Cloudflare account, database provider, dashboard
  origin, content domain, resource names, and existing authorization. Keep
  credentials out of command output, source, and reports.
- Use a separate, empty hosted Postgres target. Migration 0004 rejects
  populated single-tenant data; do not bypass it with resets. Preserve the
  original drive and backups. An existing-data import/cutover is separate
  work described in the release runbook, not implicit in fresh bootstrap.
- Content lives under `https://<slug>.<CONTENT_DOMAIN>`; the dashboard must
  be outside that domain. Configure the wildcard Worker route, proxied DNS,
  and a certificate covering actual tenant hosts. A certificate for the
  bare content host does not cover its subdomains.
- Inspect both `apps/web/wrangler.jsonc` and `apps/site/wrangler.jsonc`:
  `bun release` deploys the app and landing-site Workers. Replace the example
  routes and resource IDs with this target's values before releasing.

## Provision and configure

Use the release runbook's sequence and current CLI/provider interfaces:

1. Provision Postgres with required extensions and run hosted migrations
   using schema-admin credentials. Create a separate non-owner runtime
   login with `adrive_app` privileges, no superuser/BYPASSRLS, and no schema
   ownership. Hyperdrive uses that login with query caching disabled;
   `DATABASE_URL` for migrations uses the schema administrator.
2. Provision the target R2 bucket and `AUTH_GUARD` KV namespace. Configure
   `HYPERDRIVE`, `BUCKET`, `AUTH_GUARD`, `BROWSER`, rate limits, and scheduled
   maintenance in the target environment. Environment bindings do not
   inherit from local defaults. Semantic search stores vectors in Postgres;
   supply the Workers AI binding when `SEMANTIC_SEARCH=required`.
3. Create the main, dead-letter, and parked queues exactly as described in
   [Queues](../../../docs/release.md#queues). Bind the producer and both
   consumers; the parked queue has no automatic consumer and retains
   messages for 14 days. Configure monitoring and recovery before launch.
4. Configure real WorkOS authentication, the dashboard callback, and signed
   webhook endpoint. Set `MAINTENANCE_SECRET`, `WORKOS_API_KEY`,
   `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_WEBHOOK_SECRET`, and
   intended `ADMIN_USER_IDS` via the provider's secret/configuration path.
   Use [the launch checklist](../../../docs/launch-checklist.md) for current
   requirements. Development fake auth/provider keys must remain disabled.
5. For paid launch, publish the plans and set `AUTUMN_SECRET_KEY` and
   `AUTUMN_WEBHOOK_SECRET`; validate the integration in its sandbox using
   [billing](../../../docs/billing.md). Configure URL scanning and cache
   purge using [abuse operations](../../../docs/abuse.md), or record the
   limitations of disabled optional providers. Enable zone image
   transformations when required for content thumbnails.

## Release and acceptance

- Commit the target's nonsecret resource IDs/routes and confirm the release
  checkout is clean. Preserve unrelated work; do not discard it to satisfy
  the clean-tree gate.
- Run `bun release` from the repository root with `DATABASE_URL` pointing at
  the intended hosted target. Read `scripts/release.sh` before execution:
  it validates, builds, dry-runs, migrates Postgres, deploys both Workers,
  and records the app revision. A partial deployment requires the runbook's
  rollback/recovery decision; do not repeatedly deploy without diagnosis.
- Confirm live DNS, TLS, deployed resources, and revision. Investigate
  errors from actual logs; do not assume 500 responses are normal warm-up.
- Run [verify-deployment](../verify-deployment/SKILL.md) with real WorkOS
  access and disposable tenant data. Live provider and tenant-isolation
  checks must not be replaced by fake/local test results.
- Complete [independent backups and an isolated restore drill](../../../docs/backup-restore.md),
  [observability](../../../docs/observability.md), and the remaining launch
  checklist. Return the reachable deployment URLs, deployed revision,
  verification evidence, and any outstanding launch gates. A successful
  deploy command alone does not complete the hosted launch.
