# Hosted launch checklist

Everything here happens once, before the first paying user. Tick each
item off in order; the last one is the gate.

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
- Universal SSL with the wildcard, so `*.<content domain>` is covered
  when per-tenant hostnames land.
- Notifications: the two alerts in `docs/observability.md` (DLQ depth,
  5xx rate).

## Secrets before the first deploy

Worker secrets, set with `wrangler secret put <NAME> --env production`
from `apps/web`:

- `PASSCODE` (`apps/web/src/env.d.ts`, `.dev.vars.example`), 12+
  characters.

Local-only values from `.dev.vars.example` that must not be set in
production:

- `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, used by
  `wrangler dev` to point the Hyperdrive binding at docker Postgres.

Shell environment for `bun release`:

- `DATABASE_URL`, the production Postgres connection string
  `scripts/release.sh` migrates against.

Add every new secret to this list when it is introduced; the release
script does not check for them.

## Final gate

Run `.agents/skills/verify-deployment` against the live deployment with
the passcode. The launch is done when it reports PASS; INCONCLUSIVE or
FAIL means it is not.
