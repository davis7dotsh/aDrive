# Hosted launch checklist

Complete and record these checks before public launch or accepting payment.
This is an outstanding checklist, not evidence of a deployed or verified
service. Follow [release setup](release.md) for the actual provisioning
sequence, using a separate hosted target and preserving the existing drive.

## Public pages

- Status page (an external host such as Better Stack or Instatus, so it
  stays up when Cloudflare or the Worker is the outage). Link it from
  the landing site footer.
- Terms of service page.
- Privacy policy page, covering what is logged (`docs/observability.md`),
  where data lives (Cloudflare R2, PlanetScale), and the backup copy on
  the home host (`docs/backup-restore.md`).
- DMCA policy page naming the designated agent below.

## Abuse and legal contacts

- Register a DMCA designated agent with the US Copyright Office and put
  the same details on the DMCA page.
- Create an `abuse@` mailbox on the content domain and watch it.
- Put that address in the content domain's WHOIS abuse contact.
- Sign up for the Netcraft hosting-provider feed for the content domain
  so phishing reports arrive before takedown requests do.

## Cloudflare zone settings (content domain)

- WAF managed rules on.
- Bot fight mode on.
- Hotlink protection off (public file links are the product).
- Verify DNS, Worker routing, and HTTPS for a real tenant hostname under
  `*.<CONTENT_DOMAIN>`. Universal SSL covers the zone apex and first-level
  hosts; it does not cover `*.files.davis7.space` on the `davis7.space` zone.
  Follow the explicit wildcard-certificate setup in [release setup](release.md).
- Configure and test notifications for dead-letter and parked queues,
  Worker failures, and backup freshness as described in [observability](observability.md).

## Secrets before the first deploy

Worker secrets, set with `wrangler secret put <NAME> --env production`
from `apps/web`:

- `MAINTENANCE_SECRET` (12+ random characters).
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`
  (32+ random characters), and `WORKOS_WEBHOOK_SECRET`.
- For a paid launch: `AUTUMN_SECRET_KEY` and `AUTUMN_WEBHOOK_SECRET`.
  Publish the plans and verify checkout, cancellation, signed webhooks,
  and usage in the provider sandbox using [the billing contract](billing.md).
- `ADMIN_USER_IDS`: the intended operators' WorkOS user IDs.
- Configure the URL Scanner and cache-purge credentials described in
  [abuse operations](abuse.md), or record the limitations of leaving those
  providers disabled. Verify the quarantine and kill-switch paths.
- `ALERT_WEBHOOK_URL` if using Worker dead-letter webhook notifications;
  verify delivery. The backup host has its own separate alert configuration.

Configure the WorkOS callback and both providers' signed webhook endpoints
as documented in [release setup](release.md). Authentication uses WorkOS;
there is no hosted `PASSCODE` secret.

Development-only settings that must not be set in production:

- `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, exported in
  the dev server's shell to override the local Hyperdrive target. An entry
  in `.dev.vars` alone does not change that binding.
- `WORKOS_DEV_FAKE` and any credentials beginning with `fake:`. Production
  rejects development authentication and fake provider keys.

Shell environment for `bun release`:

- `DATABASE_URL`, the new hosted target's migration-admin connection string
  `scripts/release.sh` migrates against.

Hyperdrive must use the separate restricted runtime login, with caching
disabled. Provision all three queues, including the parked queue and its
14-day recovery window. Complete the [backup restore drill](backup-restore.md)
against isolated resources before relying on this deployment.

Add every new secret to this list when it is introduced; the release
script does not check for them.

## Final gate

Run `.agents/skills/verify-deployment` against the intended deployment with
real WorkOS browser access and disposable tenant data. Verify authenticated
UI behavior, tenant isolation, public and private content, background jobs,
billing, and cleanup through their real boundaries. Record the deployed
commit and each result. A local test pass or a deployment dry run does not
satisfy this gate; INCONCLUSIVE or FAIL leaves launch outstanding.
