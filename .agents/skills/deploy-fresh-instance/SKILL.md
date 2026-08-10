---
name: deploy-fresh-instance
description: Deploy a fresh a-drive instance to Cloudflare Workers — provision D1, R2, KV, and Vectorize plus Workers AI, set the PASSCODE secret, attach the two custom domains, and cut the first release. Use for the first-ever deploy to a new Cloudflare account or a new operator domain (not for routine redeploys, which are just `pnpm release`).
---

# Deploy a fresh a-drive instance to Cloudflare

This is the proven first-deploy sequence, executed successfully for
`davis7.space` (Aug 2026). It complements `docs/release.md` (the canonical
first-time-setup + release + rollback doc) — read that alongside this; the
steps here add the exact commands, the paste-the-id-yourself reality, and
the post-deploy gotchas that actually bit us. It does not repeat the
rollback or migration-rule sections — see `docs/release.md` for those.

Reference example throughout: dashboard `drive.davis7.space`, content
`files.davis7.space`, resource name stem `adrive-production`. Substitute
the operator's own domain, hostnames, and names.

## 1. Prerequisites

- `wrangler whoami` succeeds and points at the intended Cloudflare account.
- The operator's domain is already added as a **Cloudflare zone** (the
  custom-domain routes attach automatically on deploy only if the zone
  exists). Remove conflicting CNAME records for the two application
  hostnames; the deploy creates their DNS records, but not the zone.
- Node 26 + pnpm installed; run `pnpm install` once at the repo root.
- Decide the **two hostnames** now — a dashboard origin and a content
  origin. They must be **distinct hosts** (e.g. `drive.` and `files.`);
  the app rejects cross-origin serving and several checks depend on the
  split.

## 2. Provisioning (run from `apps/web`)

Wrangler runs **non-interactively** here: each create prints an id and
exits. It does **not** edit `wrangler.jsonc` for you — you paste each id
into `env.production` by hand.

1. `wrangler d1 create adrive-production`
   → paste the printed id into `env.production.d1_databases[0].database_id`.
2. `wrangler r2 bucket create adrive-production`
   (no id to paste — the bucket is bound by name.)
3. `wrangler kv namespace create AUTH_GUARD --env production`
   → paste the printed id into `env.production.kv_namespaces[0].id`.
4. Create the Vectorize index and its three metadata indexes:

   ```
   wrangler vectorize create adrive-production --dimensions=384 --metric=cosine
   wrangler vectorize create-metadata-index adrive-production --property-name=deleted --type=boolean
   wrangler vectorize create-metadata-index adrive-production --property-name=kind --type=string
   wrangler vectorize create-metadata-index adrive-production --property-name=visibility --type=string
   ```

   **Gotcha (expected, safe):** metadata-index creation is async — each
   command returns "enqueued", and `wrangler vectorize list-metadata-index
adrive-production` shows them appearing one at a time over a minute or
   two. That is propagation lag, not a failure. It is harmless because no
   vectors are written until after the first deploy, so you don't need to
   wait for all three before continuing.

   **Workers AI needs no provisioning** — it activates from the `ai`
   binding already declared in `wrangler.jsonc` `env.production`.

   Note: `env.production` sets `SEMANTIC_SEARCH=required` (not `auto`), so a
   missing `AI` or `VECTORIZE` binding fails the deploy **loudly** instead
   of silently degrading to keyword search. That is intended — if the
   Vectorize/AI setup above is incomplete, the deploy in step 5 will stop.

5. In the Cloudflare dashboard, open **Images → Transformations**, select
   the zone that owns `CONTENT_ORIGIN` (`davis7.space` for
   `files.davis7.space`), and enable transformations. Dashboard thumbnails
   require this zone-level setting.

## 3. Set the passcode secret (from `apps/web`)

```
wrangler secret put PASSCODE --env production
```

12+ characters, typed by the operator at the prompt — never put the
passcode in chat, a command argument, or a log.

**Gotcha (expected):** on a first-ever setup the Worker shell doesn't
exist yet, so wrangler prompts _"There doesn't seem to be a Worker called
adrive-production. Do you want to create it?"_ — answer **yes**. This is
normal; it stages an empty Worker so the secret has somewhere to live
before the first deploy.

## 4. Commit the provisioned ids

The D1 `database_id` and KV `id` are **configuration, not secrets** —
commit the edited `wrangler.jsonc`. Two `pnpm release` preflight gates
depend on it:

- **clean-tree gate** — the release refuses a dirty working tree, so the
  pasted ids must be committed.
- **no-placeholder gate** — the release greps for `replace-with-<env>-*`
  placeholders (e.g. `replace-with-production-...`) and refuses while any
  remain. Pasting the real ids clears this.

## 5. Deploy

From the **repo root**:

```
pnpm release
```

`scripts/release.sh` runs the full gate → format check → type/lint →
tests → audit → build → deploy dry-run → D1 migrations → deploy → append
the commit to `.release-history`. The two custom domains attach from the
`routes` in `env.production` automatically, provided the zone from step 1
exists.

## 6. Post-deploy verification gotchas (both hit on the davis7.space run)

- **Transient 500s right after deploy.** The very first requests can 500
  for a few seconds while D1 migrations settle against the first live
  request. Recheck once things settle — it clears on its own.
- **The second (content) custom domain lags the first.** The content
  origin's DNS record and edge certificate propagate minutes behind the
  dashboard origin. Worse, a **local DNS negative cache** can pin it as
  broken _only on the operator's machine_: if you resolved the host before
  the record existed, an NXDOMAIN is cached locally while public resolvers
  already serve the new record. Fix by flushing local DNS —
  `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder` on macOS
  — or wait out the negative TTL. To confirm the edge is actually up while
  bypassing local DNS, resolve against Cloudflare directly:
  `curl --resolve <content-host>:443:<cloudflare-ip> https://<content-host>/`.

Expected live checks once both origins are up:

- dashboard root → **200**
- unauth `GET <dashboard>/api/files` → **401**
- `GET <content>/api/files` → **421** (dashboard API rejected on content origin)
- `GET <dashboard>/f/<uuid>` → **421** (content rejected on dashboard origin)
- missing file → **404**
- a known non-empty public file without a `Range` header → **200** with no
  `Content-Range`
- the same file with `Range: bytes=0-99` → **206** with a valid `Content-Range`

## 7. Backfill note (semantic search)

Any files uploaded before the Vectorize index existed sit in
`index_state = 'disabled'` and are backfilled by the maintenance cron at
about **5 files per 5 minutes**. The settings page's indexed-chunk count
shows progress. On a truly fresh instance there's usually nothing to
backfill; this matters when seeding a pre-existing corpus.

## 8. Then

- Run the **verify-deployment** skill (`.agents/skills/verify-deployment`)
  as the acceptance gate — the release is not complete until it reports
  PASS against the live deployment.
- Set up **independent backups** on a machine outside Cloudflare and
  complete the restore drill (`docs/backup-restore.md`) before treating
  the drive as the sole copy of anything.
