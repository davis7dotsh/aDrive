# adrive hosted on Railway: comparison

Companion to `hosted-product.md`. Same product, same external services (WorkOS, Autumn), built as Railway services on private networking instead of Cloudflare Workers. Written 2026-09-08 from Railway docs and pricing pages as served that day.

## Service layout

```
railway project: adrive
├─ web            SvelteKit Node server, 2-3 replicas, public domain + wildcard content domain
├─ worker         queue consumer: indexing, purges, scans (pg-boss on Postgres, or BullMQ on Redis)
├─ screenshots    Playwright, serverless sleep, called over private network
├─ postgres       pgvector template image on a volume, pg_trgm included
├─ redis          only if BullMQ is chosen over pg-boss
└─ bucket         Railway Buckets (S3 on Tigris), file bytes
external: Workers AI over HTTP for embeddings, WorkOS, Autumn, Stripe
```

Everything except the bucket talks over `<service>.railway.internal`. Internal traffic is free. Buckets are on the public network, so uploads from the service to the bucket count as service egress.

## What gets simpler

- **One runtime.** Plain Node. No adapter facade, no `nodejs_compat` flags, no per-request layer construction. Effect's Postgres client and `pg` pool are module-scope singletons. This deletes the trickiest parts of stack A in the Cloudflare plan.
- **One database for everything.** Same Postgres plan as the Cloudflare version: `tsvector`, `pg_trgm`, `pgvector`. Nothing changes in stacks A and B except the connection layer.
- **Queue is just Postgres.** pg-boss on the same database replaces Cloudflare Queues. Transactional enqueue: the index job is inserted in the same transaction as the file row, so the "never send inside waitUntil" class of bugs cannot happen. Cron is a Railway cron on the worker service.
- **Wildcards without a second product.** Railway issues Let's Encrypt wildcard certs itself. Per-tenant subdomains are a wildcard CNAME plus two ACME records.
- **PR environments.** Every PR gets a full stack including its own bucket instance. Good for the stacked PR workflow, though you pay for each one while it is up.
- **Config as code** via `.railway/railway.ts` with plan/apply and drift detection. The old `railway.json` is deprecated with a hard cutoff on 2026-12-01.

## What gets harder

- **Public file serving.** Railway Buckets are private only. No public buckets, no custom domain on the bucket. Two options:
  - 302 from `/f/<id>` to a presigned `*.storageapi.dev` URL. Egress is free. Users see a Tigris URL, range requests work, but every download is a redirect hop and the URL leaks the storage provider.
  - Proxy bytes through the web service. Clean URLs, but $0.05 per GB egress. The free Fastly-backed Railway CDN caches objects under 512 MB and cache hits cost nothing, so real cost is roughly $0.05 per GB times the miss rate.
  - Third option: keep R2 with a custom domain for the content origin, even though the app runs on Railway. R2 supports public buckets and free egress. This is the best fit for a clean public content domain and is what I would do.
- **Uploads.** Railway's edge caps request bodies at 5 minutes and requests at 15 minutes. Large uploads must go direct to the bucket via presigned PUT from the browser and the CLI. The current streaming upload path through the server would need to become a presign-then-confirm flow. This is a real change to `services/files/upload.ts` and the CLI.
- **Postgres is a container, not a service.** It runs on a volume. Daily snapshots, PITR via pgBackRest to a bucket, and one-click HA all exist in 2026, but the pgvector template image is not eligible for the one-click HA conversion. HA with pgvector means building the Patroni cluster yourself or picking PlanetScale from Railway.
- **No GPUs.** Embeddings stay on Workers AI over HTTP at $0.02 per million tokens, or an equivalent API. This is fine, just noted.
- **No scale to zero for the web tier.** Serverless sleep triggers on outbound silence, and a Postgres pool keeps it awake. Idle web replicas cost roughly $3 to $4 a month each, so this is a rounding error, but there is no "pay nothing at zero users" like Workers.
- **Reliability.** Five or more public incidents from November 2025 to July 2026, including an 8 hour platform-wide outage on 2026-05-19 when Google Cloud suspended Railway's account, and a 52 minute CDN bug on 2026-03-30 that served authenticated responses to the wrong users. Status page shows about 99.8 percent over 90 days for US regions. Cloudflare has its own incidents, but nothing in that class recently.

## Latency and feel

- **Dashboard and API.** Single region, so a user in Europe hitting US East sees 80 to 120 ms per request before any work. Workers plus Hyperdrive puts the compute at the edge but still crosses to the database region for every query, so the difference on database-bound requests is smaller than it looks. Multi-region replicas exist on Railway but volumes do not replicate, so the database stays in one region either way.
- **Public content.** Presigned bucket URLs are served from Tigris, which is globally distributed. Proxied content through the Railway CDN is served from Fastly POPs. R2 with a custom domain is served from Cloudflare's edge. All three are fine. The redirect hop on the presigned option is the only thing a user might notice.
- **Background work.** Always-on worker with a pool. No 30 second CPU limit, no 128 KB message cap, no consumer wall clock. Indexing a 50 MB text file in one job is fine on Railway and needs chunked jobs on Workers.
- **Local dev.** `docker compose` with Postgres and MinIO mirrors production almost exactly. On Cloudflare, local dev runs through miniflare and the Hyperdrive local connection string, which works but is a second world.

## Cost

Railway list prices, Pro plan, single region. Storage line assumes Railway Buckets. R2 would be the same $0.015 per GB plus a few dollars in request fees.

| Line                               | 100 users     | 1,000 users       |
| ---------------------------------- | ------------- | ----------------- |
| Pro subscription                   | $20           | $20               |
| Web replicas                       | $40           | $120              |
| Workers                            | $40           | $160              |
| Screenshots                        | $10           | $30               |
| Postgres single node with pgvector | $130          | $270 to $430      |
| Postgres HA instead                | n/a           | $900 to $1,350    |
| Embeddings via API                 | $1            | $10               |
| Bucket storage                     | $24           | $240              |
| Egress, presigned                  | $0            | $0                |
| Egress, proxied no cache           | $100          | $1,000            |
| Egress, proxied with 70% CDN hit   | $30           | $300              |
| Total, presigned, single node DB   | ~$265         | ~$850 to $1,010   |
| Total, proxied no cache, HA DB     | not estimated | ~$2,480 to $2,930 |

Same scenarios on the Cloudflare plan from `hosted-product.md`:

| Line                                    | 100 users | 1,000 users                        |
| --------------------------------------- | --------- | ---------------------------------- |
| Workers Paid                            | $5        | $5                                 |
| PlanetScale                             | $30       | $30 to $190, more storage at scale |
| R2 storage                              | $24       | $246                               |
| Egress                                  | $0        | $0                                 |
| Workers AI, Queues, Browser Run, Images | ~$1       | ~$50                               |
| Total                                   | ~$60      | ~$350 to $550                      |

Where the gap comes from:

- **Compute.** Workers charge per request and are nearly free at this scale. Railway charges for always-on replicas and a worker. Roughly $100 to $300 a month of the gap.
- **Postgres.** Railway's container at 4 vCPU and 32 GB is about $400. PlanetScale PS-320 single node is $190 and HA is $570, and it is managed. At low load, PlanetScale PS-10 at $30 has no Railway equivalent since a pgvector container with enough RAM for the index is the floor.
- **Egress.** Identical at $0 only if you accept the presigned redirect or keep R2. Proxying through Railway is the single largest possible line at scale.

The presigned, single-node Railway estimate is about $265 versus $60 a month at 100 users, and $850 to $1,010 versus $350 to $550 at 1,000 users. These estimates imply a gap of about $205 and $300 to $660 a month, respectively.

## Recommendation

Cloudflare for the product as scoped. The reasons in order:

1. Public file serving with clean URLs, range requests, and free egress is the core of the product. R2 with a custom domain does this natively. Railway needs R2 anyway or a redirect hop.
2. At 100 users, the estimated monthly cost is about $60 versus $265 for Railway's presigned, single-node setup, which matters during experimentation.
3. The reliability record over the last ten months is materially worse on Railway, and the May 2026 outage was the kind that no architecture on their platform could route around.

Railway wins if the shape changes toward:

- Heavy server-side processing per file, such as video transcoding, OCR, or running larger models, where the Workers CPU and memory limits bite.
- Wanting a boring Node process with a pool and a debugger rather than the Workers runtime.
- Multi-region being off the table anyway and local dev fidelity mattering more than edge latency.

A hybrid is reasonable and not weird: Railway for web and workers, R2 for bytes, PlanetScale for the database. That keeps the Node runtime and PR environments, drops the egress and public-bucket problems, and drops the unmanaged Postgres problem. Its bill lands around $150 at 100 users and $500 to $700 at 1,000, so between the two pure options.

## Sources

- Railway [pricing](https://railway.com/pricing), [plans](https://docs.railway.com/pricing/plans), [pricing FAQs](https://docs.railway.com/pricing/faqs), [cost control](https://docs.railway.com/pricing/cost-control)
- Railway [storage buckets](https://docs.railway.com/storage-buckets), [bucket billing](https://docs.railway.com/storage-buckets/billing), [uploading and serving files](https://docs.railway.com/storage-buckets/uploading-serving)
- Railway [PostgreSQL](https://docs.railway.com/databases/postgresql), [PostgreSQL HA](https://docs.railway.com/databases/postgresql-ha), [volumes](https://docs.railway.com/volumes/reference), [point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery)
- Railway [scaling](https://docs.railway.com/deployments/scaling), [regions](https://docs.railway.com/deployments/regions), [serverless](https://docs.railway.com/deployments/serverless)
- Railway [private networking](https://docs.railway.com/networking/private-networking/how-it-works), [domains](https://docs.railway.com/networking/domains/working-with-domains), [public networking limits](https://docs.railway.com/networking/public-networking/specs-and-limits), [CDN](https://docs.railway.com/networking/cdn), [WAF](https://docs.railway.com/networking/waf)
- Railway [cron jobs, workers, and queues](https://docs.railway.com/guides/cron-workers-queues), [Playwright](https://docs.railway.com/guides/playwright), [cron jobs](https://docs.railway.com/cron-jobs)
- Railway [infrastructure as code](https://docs.railway.com/infrastructure-as-code), [environments](https://docs.railway.com/environments), [observability](https://docs.railway.com/observability)
- Railway incident reports: [2026-05-19 GCP account outage](https://blog.railway.com/p/incident-report-may-19-2026-gcp-account-outage), [2026-03-30 cached authenticated responses](https://blog.railway.com/p/incident-report-march-30-2026-authenticated-user-data-cached), [2026-02-11](https://blog.railway.com/p/incident-report-february-11-2026), [2026-07-02](https://blog.railway.com/p/incident-report-july-2-2026-us-east-services-outage)
- [Railway status](https://status.railway.com)
- Cloudflare [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [PlanetScale Postgres pricing](https://planetscale.com/docs/postgres/pricing)
