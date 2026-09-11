# Hosted product status

The hosted implementation is organized as a reviewed PR stack. This document
describes the code and the remaining launch work; it does not certify a live
deployment. Use the individual PRs for their current base, review state, and
validation results. A ready PR is not a production rollout or a merge approval.

## Implemented in the stack

- Postgres metadata and pgvector search through Hyperdrive, with a separate
  migration-admin role and restricted application runtime role.
- WorkOS sign-in, organizations, tenant-scoped keys, database isolation,
  and per-organization storage accounting.
- Tenant content hosts, slug changes, and independent dashboard/content
  origins. Remote development supports configured Tailscale origins.
- Durable indexing, purge, scan, and usage recovery, backed by Cloudflare
  Queues, Postgres state, dead letters, and a parked queue.
- Trust-based publication, version-specific scanning and operator verdicts,
  quarantine, abuse reports, and organization suspension.
- Free and Pro plan limits, local AI reservations, absolute UTC-month
  billing synchronization, signed subscription reconciliation, and
  owner-authorized checkout and portal access.
- Backup scripts, release/restore instructions, an operational visibility
  inventory, and the launch checklist.

Verified free organizations can share publicly. The reviewed code does not
have a separate paid-only `canShare` gate. Publication is governed by trust
and scanning as documented in [abuse controls](../abuse.md).

## Evidence boundary

The original September 9 build reported local API/content checks and local
tests using development providers. Its branch tips, commit counts, test
counts, and worktree/database inventory predate the subsequent review fixes
and are not current validation evidence.

Current repository checks establish only the boundaries they exercise.
Production WorkOS, Autumn/Stripe/Svix, PlanetScale, Hyperdrive, Cloudflare
Queues, URL Scanner, DNS/TLS, account alerts, and backup restoration still
need recorded verification against the intended deployment. A local fake,
intercepted SDK response, or deployment dry run is not that evidence.

## Before launch

1. Provision a separate hosted database and deployment using
   [release setup](../release.md). Preserve existing production data and
   routes; a populated single-tenant Postgres database has no in-place
   hosted migration in this stack.
2. Configure real authentication, billing, scanner, and operational
   credentials. Verify provider sandbox behavior according to
   [billing](../billing.md) and [abuse operations](../abuse.md).
3. Verify tenant wildcard DNS and certificate coverage, the restricted
   runtime role, queues and parked-message recovery, and the actual
   dashboard/content flows through the live verification skill.
4. Complete an isolated [restore drill](../backup-restore.md), including
   all object references, and test [operational alerts](../observability.md).
5. Complete public pages, support/abuse contacts, and the remaining
   [launch checklist](../launch-checklist.md). Record the deployed commit,
   dates, outcomes, and unresolved checks before cutover.

The code writes durable quarantine/publication notification rows and shows
file status after refresh. It does not provide an owner notification inbox,
email delivery, or automatic status polling in this layer. The existing
`RL_PUBLISH` binding remains reserved rather than enforced; do not describe
it as an active publication-rate guarantee. A unified request-log schema
and Analytics Engine dataset remain follow-up work.

## Development and preservation

Follow [README local setup](../../README.md#local-setup) and its Tailscale
section for a new local environment. Historical worktree paths, active
ports, and database names are not a safe basis for restarting services or
removing resources. Inventory the current machine and obtain any required
service-change authorization before changing an existing preview. Keep
the original worktrees and databases until their owners have explicitly
chosen what to retain or remove.
