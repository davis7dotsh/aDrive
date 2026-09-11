---
name: verify-deployment
description: Verify a hosted a-drive deployment through real WorkOS browser sessions, tenant-scoped HTTP and CLI access, Postgres, R2, and background jobs. Use after deployment or changes to authentication, storage, routing, migrations, or provider configuration. Report evidence and clean up disposable verification data.
---

# Verify an a-drive deployment

Read [release setup](../../../docs/release.md) and the
[launch checklist](../../../docs/launch-checklist.md) for the target's
configuration. Use the actual deployed revision when comparing behavior
with source. Local tests, fake providers, and deploy dry runs do not prove
live behavior.

## Scope and access

- Resolve the dashboard origin, `CONTENT_DOMAIN`, deployed revision, CLI
  checkout, and available access from the task and configuration. Content
  URLs use `https://<org-slug>.<CONTENT_DOMAIN>`, not the bare content host.
- Full verification needs real WorkOS browser access, two disposable
  verification tenants for isolation, and read access to deployed settings,
  Postgres, and R2. With API-key-only access, continue supported checks and
  record browser, role, and other inaccessible checks as skipped.
- Generate `verify-<UTC timestamp>-<UUID>` and confirm it is unused. Prefix
  every created file, site, tag, and key; keep a ledger of their IDs and
  exact storage keys. Mutate and purge only this run's recorded resources.
- Use a dedicated test tenant for trust/moderation changes. Billing changes
  and provider-failure drills belong in an authorized sandbox; do not charge
  a card or interrupt a shared live service as an incidental check.
- Keep credentials, sealed cookies, authorization codes, and signed grants
  out of reports and screenshots. Always attempt cleanup after failures.

## Required live checks

Record each item as pass, fail, or skipped with a reason. A skipped required
check leaves the full deployment verdict inconclusive.

1. **Deployment and routing.** Verify HTTPS for the dashboard and a real
   tenant hostname, including wildcard DNS/certificate coverage. Public
   production content and authenticated data must not be served over plain
   HTTP. Dashboard APIs on a content host and content paths on the dashboard
   return 421; an unknown tenant's content returns 404. Check deployed
   bindings/settings against `apps/web/wrangler.jsonc`: `HYPERDRIVE`,
   `BUCKET`, `AUTH_GUARD`, `JOBS`, `BROWSER`, rate limits, cron, and `AI` when
   semantic search is required. A dry run describes the candidate bundle;
   inspect the actual deployment separately.
2. **WorkOS sessions.** Complete browser sign-in and sign-out; verify that
   invalid callback state creates no session and unauthenticated
   `/api/files` returns 401. On production HTTPS, session/state cookies use
   `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, and no Domain.
   Check refresh and deletion behavior against
   `apps/web/src/lib/server/auth-policy.ts`. HTTP development uses different
   cookie names/options and must be reported as development-only proof.
3. **Keys, roles, and tenancy.** Complete disposable CLI device authorization
   and create read-write/read-only keys. Confirm read-only reads succeed
   while upload, rename, tag, trash, version, and key-management mutations
   are rejected; key inventory also requires write scope. A revoked key
   returns 401. From the other tenant, verify file detail, versions, search,
   tags, grants, and mutations do not expose private data or alter it.
   Verify member billing/slug changes and non-admin moderation are denied.
4. **Files and UI.** Upload small text/image files through the dashboard and
   PDF/binary files through the CLI; compare metadata and downloaded SHA-256
   with the originals. Exercise previews, search, tags, rename, version
   upload/history/download, trash/restore, and purge. Exercise pagination
   when relevant to the change. Observe loading, errors/retry, layout
   stability, and desktop/mobile behavior in the actual browser.
5. **Public content and grants.** Private files return 404 without a grant;
   authorized downloads succeed. Altered signatures/expiry and expired
   grants are rejected. Verify anonymous public file and site delivery,
   range responses, and cache behavior after privacy changes. Benign HTML
   follows current trust/publication policy; it is not unconditionally
   public. Verified tenants' held publications become public only after
   scan clearance; pending site previews use owner grants. Check moderation
   and suspended-tenant access on disposable resources using
   [abuse operations](../../../docs/abuse.md).
6. **Headers and origin boundaries.** Compare exact values with
   `security-headers.ts`, `content-headers.ts`, and `content-cache.ts` under
   `apps/web/src/lib/server`. Verify authenticated API responses are private
   and not stored, forged cross-origin cookie mutations fail, content has
   the expected CSP/nosniff, and Markdown does not execute raw script or
   unsafe links. Verify CLI origin/transport restrictions against the
   deployed API and CLI policy; do not send credentials to untrusted hosts.
7. **Durable background work.** Observe actual queued indexing, scanning,
   and purge completion for the corpus, plus the configured maintenance
   schedule. For required semantic search, demonstrate indexed chunks and
   a relevant conceptual query. Inspect failures and the main/DLQ/parked
   queue configuration without injecting failures into shared production.
   Reconcile exact ordinary-file `file_versions.r2_key`,
   `file_versions.thumbnail_r2_key`, and `site_assets.r2_key` references with
   R2. A site's version row contains a synthetic marker, not an R2 object.
   Successful downloads alone do not establish cleanup or absence of
   orphaned objects. Verify runtime database role privileges and tenant
   access as described in the release runbook.
8. **Billing and operations.** Compare billing UI and `org_usage` counters
   with the local plan limits; bounded negative quota checks belong in a
   disposable environment, not by filling production storage. For paid
   launch or billing changes, follow [billing validation](../../../docs/billing.md)
   through real sandbox checkout, signed webhooks, current plan, and usage
   reconciliation. Disabled or fake billing does not prove the live
   integration. Review backup freshness, restore-drill evidence, and alerts
   using [backup/restore](../../../docs/backup-restore.md) and
   [observability](../../../docs/observability.md).

## Cleanup and report

- Purge remaining recorded files/sites; verify removal from list, trash,
  search, Postgres references, and R2 after background work settles.
- Delete created tags, revoke created keys, consume or let pending device
  attempts expire, and sign out sessions created for the run. Restore any
  test-tenant/provider state changed within the authorized scope.
- Report target origins/revision/time, each check's evidence and result,
  product failures versus environment/access limitations, and exact
  remaining cleanup. Redact secrets from request/response evidence.
- **Pass** requires all required live checks and cleanup to pass. **Fail**
  means a checked behavior failed. **Inconclusive** means required evidence
  or cleanup could not be completed. Clearly label any narrower verification
  scope; it does not clear the full hosted launch gate.
