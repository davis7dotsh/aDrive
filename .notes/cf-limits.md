# Cloudflare Workers / R2 / D1 limits — a-drive upload path

Researched 2026-07-27 against developers.cloudflare.com (docs pages dated Apr–Jul 2026).
Anything not verifiable in official docs is marked **UNCONFIRMED**.

Primary sources:
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- R2 limits: https://developers.cloudflare.com/r2/platform/limits/
- R2 Workers API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- R2 upload objects: https://developers.cloudflare.com/r2/objects/upload-objects/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/

---

## 1. Request / response body size

| Limit | Value | Plan | Source |
|---|---|---|---|
| Max request body | **100 MB** | Cloudflare **Free** | [workers/platform/limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Max request body | **100 MB** | Cloudflare **Pro** | same |
| Max request body | **200 MB** | Cloudflare **Business** | same |
| Max request body | **500 MB** (default, raisable) | Cloudflare **Enterprise** | same |
| Response body size | **No enforced limit** | all | same |
| URL size | 16 KB | all | same |
| Request/response header size | 128 KB total each | all | same |

**Critical gotcha:** the request body limit is keyed off your **Cloudflare account/zone plan (Free/Pro/Business/Enterprise)**, *not* your Workers plan. Buying Workers Paid ($5/mo) does **not** raise you from 100 MB to 500 MB — that requires Business (200 MB) or Enterprise (500 MB). The old "100 MB free / 500 MB paid" framing is wrong for Workers Paid.

- Over-limit requests return **HTTP 413** (`Request entity too large`) — rejected at the edge, your Worker never runs.
- **Streamed vs buffered:** no documented difference. The limit is on the *inbound HTTP request body*, enforced before/independently of how your Worker consumes it. Streaming to R2 does not let you exceed 100 MB.
- Response body is uncapped by Workers; CDN *cache* limits are 512 MB (Free/Pro/Business), 5 GB (Enterprise) — only relevant if the response is cached.

**Design implication:** hard per-file cap for single-shot upload-through-Worker is **100 MB** for the realistic self-hoster (Free/Pro zone). Set the app cap slightly under (e.g. 95 MB) to leave headroom for multipart/form-data envelope overhead if you use FormData. Anything above that *requires* client-driven multipart (client splits the file, each part is its own sub-100-MB request).

---

## 2. CPU time, wall clock, and `waitUntil`

| Limit | Workers Free | Workers Paid | Source |
|---|---|---|---|
| CPU time per HTTP request | **10 ms** | **30 s default**, configurable to **5 min (300,000 ms)** via `limits.cpu_ms` | [limits#cpu-time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) |
| CPU time per Cron Trigger | 10 ms | 30 s (<1 h interval) / 15 min (>=1 h interval) | same |
| Wall clock, HTTP request | **Unlimited** while client connected | Unlimited | [limits#duration](https://developers.cloudflare.com/workers/platform/limits/#duration) |
| Wall clock, Cron / Queue consumer / DO alarm | 15 min | 15 min | same |
| **`waitUntil` extension** | **up to 30 s** after response sent or client disconnect | **up to 30 s** | [limits#duration](https://developers.cloudflare.com/workers/platform/limits/#duration), [runtime-apis/context#waituntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil) |
| Included CPU (billing) | n/a | 30 M CPU-ms/month, then $0.02/M | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) |

**CPU vs wall clock — the distinction that matters:**
- **CPU time** = time the CPU actively executes your JS/WASM. Waiting on `fetch()`, R2, D1, Workers AI does **not** count. Docs: average Worker ~2.2 ms; heavy parse/SSR workloads 10–20 ms.
- **Wall clock / duration** = total elapsed. Unlimited for HTTP-triggered Workers as long as the client stays connected. Not billed.
- Exceeding CPU → **Error 1102** `Worker exceeded resource limits`, invocation outcome `exceededCpu`.

**`waitUntil` CPU budget — this is the answer you need:**
- The **30 s figure for `waitUntil` is a WALL-CLOCK extension, not a CPU budget.** The docs consistently phrase it as "extends execution for up to 30 seconds after the response is sent or the client disconnects."
- Cloudflare documents **no separate CPU budget for `waitUntil` work.** `waitUntil` promises run in the same invocation and same isolate, so they draw from the **same per-invocation CPU allowance** (10 ms Free / 30 s–5 min Paid). **UNCONFIRMED** as an explicit doc statement — Cloudflare never says "waitUntil shares the CPU budget" in so many words — but there is no documented second budget, `limits.cpu_ms` is per-invocation, and CPU/wall time are reported once per invocation in Workers Logs / Trace Events. Treat it as shared.
- Net effect for a-drive's text-extraction + embedding in `waitUntil`:
  - **Free plan: this is effectively unusable.** 10 ms of CPU total for the entire invocation (upload handling *plus* extraction *plus* embedding). Text extraction of anything non-trivial will blow it. Embedding calls themselves are I/O (don't count), but chunking, decoding, JSON serialization do.
  - **Paid plan: you get 30 s CPU by default, raisable to 5 min** — plenty of CPU. But you are capped by the **30 s wall clock** on `waitUntil`. Extraction + N embedding round-trips must complete within 30 s of the response being sent, and network waits *do* count against that 30 s.
  - If extraction/embedding can exceed 30 s wall clock, `waitUntil` is the wrong primitive. Move to **Queues** (15 min wall clock per consumer invocation) or **Workflows** (unlimited wall clock per step, CPU-limited only). This is the single most likely thing to force an architecture change.

Raise CPU on Paid:
```jsonc
{ "limits": { "cpu_ms": 300000 } }  // default 30000
```

---

## 3. Memory

| Limit | Value | Plan | Source |
|---|---|---|---|
| Memory per isolate | **128 MB** | Free **and** Paid (identical) | [limits#memory](https://developers.cloudflare.com/workers/platform/limits/#memory) |

- Includes JS heap **and** WebAssembly allocations.
- **Per-isolate, not per-invocation.** One isolate serves many concurrent requests, so concurrent uploads share the same 128 MB.
- Exceeding → Error 1102, outcome `exceededMemory`. Buffering a body that's too large yields the runtime error `Memory limit would be exceeded before EOF`.

**Does it constrain buffering an upload?** Yes, severely — and worse than the raw numbers suggest. A single 100 MB `await request.arrayBuffer()` uses ~100 MB of the 128 MB isolate budget, leaving almost nothing, and **two concurrent 100 MB uploads on the same isolate will OOM**. Never buffer.

**Does streaming to R2 avoid it?** Yes. Cloudflare's own remediation list leads with "Stream request and response bodies — use `TransformStream` … instead of buffering entire payloads in memory" and "Avoid large in-memory objects — store large data in KV, R2, or D1." Passing `request.body` (a `ReadableStream`) straight to `env.BUCKET.put()` keeps memory flat regardless of file size. This is the load-bearing reason to stream, more than the 100 MB cap.

---

## 4. Subrequests

| Limit | Workers Free | Workers Paid | Source |
|---|---|---|---|
| Subrequests per invocation (**external**, `fetch()` to Internet) | **50** | **10,000** default, configurable to **10,000,000** | [limits#subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests) |
| Subrequests to **internal Cloudflare services** (R2, KV, D1, Queues, service bindings) | **1,000** | matches configured limit (default 10,000) | same |
| Simultaneous open connections (awaiting response headers) | **6** | **6** | [limits#simultaneous-open-connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections) |
| Cache API calls/request | 50 | 1,000 (shares the subrequest quota) | [limits#cache-api-limits](https://developers.cloudflare.com/workers/platform/limits/#cache-api-limits) |

**The Free-plan split is the key finding, and it's much better news than the headline "50" suggests.** Per the [Feb 11 2026 changelog](https://developers.cloudflare.com/changelog/2026-02-11-subrequests-limit/): *"Workers on the free plan remain limited to **50 external subrequests and 1000 subrequests to Cloudflare services** per invocation."* So R2/D1/KV binding calls draw from the 1,000 internal pool, not the 50.

**Does each count as a subrequest?**

| Call | Counts? | Which pool | Source |
|---|---|---|---|
| R2 binding (`get`/`put`/`list`/`delete`/`head`) | **Yes** | internal (1,000 free) | [limits#subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests) — "any request a Worker makes … to Cloudflare services like R2, KV, or D1" |
| D1 query | **Yes** | internal | same; D1 docs cap "Queries per Worker invocation" at **1000 Paid / 50 Free** ([d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/)) |
| Workers AI (`env.AI.run`) | **Almost certainly yes** — **UNCONFIRMED** | presumed internal | Not named in the subrequest list nor in [workers-ai/platform/limits](https://developers.cloudflare.com/workers-ai/platform/limits/). The glossary definition ("requests to other Cloudflare services") plainly covers it, but Cloudflare never states it explicitly. Assume it counts. |
| Service binding (Worker→Worker) | Yes | internal | [service-bindings#limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) |
| Redirect hops | Yes, each hop | external | [limits#subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests) |

**Note the D1 conflict:** the D1 limits page still says "Queries per Worker invocation … 1000 (Workers Paid) / **50 (Free)**", which contradicts the newer 1,000-internal-subrequest allowance in the Feb 2026 changelog. The D1 page was last updated Apr 21 2026 (after the changelog), so it may be an independent D1-side cap rather than staleness. **Plan against 50 D1 queries/invocation on Free** — the conservative reading.

**Your two scenarios:**
- **Uploading a site with 50 assets** — 50 R2 `put()` calls = 50 internal subrequests. Fine on Free (1,000 internal budget) and Paid. But you'll also want ≥50 D1 row inserts — **use one `batch()`**, since 50 individual D1 queries hits the Free D1 cap exactly. Also mind the **6 simultaneous open connections** limit: don't `Promise.all()` 50 R2 puts unthrottled; they'll queue at 6 (works, just serializes). A concurrency pool of ~6 is the natural shape.
- **Embedding 30 chunks of a file** — 30 separate `AI.run()` calls is wasteful and risks the (unconfirmed) AI subrequest accounting. **Workers AI embedding models accept an array of strings in one call** (`{ text: [chunk1, chunk2, ...] }` — see [bge-base-en-v1.5](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/), "Batch: Yes"). Send all 30 chunks in **one** `AI.run()`. Collapses 30 subrequests to 1 and 30 network waits to 1 — also the fix for the 30 s `waitUntil` wall clock.

Configure per-Worker (Paid):
```jsonc
{ "limits": { "cpu_ms": 300000, "subrequests": 50000 } }
```

---

## 5. R2 limits

| Limit | Value | Source |
|---|---|---|
| Max object size | **5 TiB** per object (precisely 4.995 TiB) | [r2/platform/limits](https://developers.cloudflare.com/r2/platform/limits/) |
| **Max single-part upload (PUT)** | **5 GiB** (precisely 4.995 GiB = 5 GiB − 5 MiB) | same |
| Max multipart object | 4.995 TiB | same |
| Max upload parts | **10,000** | same |
| Min part size | **5 MiB** (last part exempt) | [r2/objects/upload-objects](https://developers.cloudflare.com/r2/objects/upload-objects/) |
| Max part size | **5 GiB** | same |
| Part uniformity | **All parts except the last must be the same size** | same |
| Max object key length | **1,024 bytes** | [r2/platform/limits](https://developers.cloudflare.com/r2/platform/limits/) |
| Max custom metadata size | 8,192 bytes | same |
| Storage per bucket / objects per bucket | Unlimited | same |
| Buckets per account | 1,000,000 | same |
| Max concurrent writes to same key | **1 per second** (else HTTP 429) | same |
| Incomplete multipart auto-abort | 7 days (configurable via lifecycle) | [upload-objects](https://developers.cloudflare.com/r2/objects/upload-objects/) |
| `delete()` keys per call | up to 1,000 | [workers-api-reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| `list()` results per call | up to 1,000 (may return fewer) | same |
| Bucket management ops | 50/sec per bucket (does *not* apply to object reads/writes) | [r2/platform/limits](https://developers.cloudflare.com/r2/platform/limits/) |

**Does the Workers R2 binding have a different PUT size limit than S3?** **No — the 5 GiB single-part limit is the same for both.** The R2 limits page footnote 3 is explicit: *"Max upload size applies to uploading a file via one request, uploading a part of a multipart upload, or copying into a part of a multipart upload. **If you have a Worker, its inbound request size is constrained by Workers request limits.** The max upload size limit does not apply to subrequests."*

So the binding itself allows 5 GiB, but a proxy-through-Worker upload is bottlenecked by the **100 MB inbound Workers request limit**, not by R2. R2 is never your binding constraint for this project — Workers request size is, by a factor of 50.

That last sentence ("does not apply to subrequests") also means: if your Worker *generates* data internally (not from an inbound body) — e.g. concatenating, transforming, fetching from elsewhere — it can `put()` up to the full 5 GiB.

**Multipart becomes mandatory at:** >100 MB (Workers request cap forces client-side chunking), long before R2's 5 GiB single-part limit is relevant.

**Schema note for future multipart:** you need to persist `uploadId` (string), `key`, and per-part `{partNumber, etag}` between requests, since each part arrives as a separate HTTP request. Also record part size, because R2 enforces uniform part sizes and a 5 MiB minimum — a resumed upload with mismatched part sizes fails at `complete()`. 10,000 parts × your chosen part size sets your true max file size (e.g. 10 MiB parts → 100 GB max).

---

## 6. R2 `put()` with a `ReadableStream` — the content-length problem

**Type signature** ([workers-api-reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)):
```
put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions): Promise<R2Object | null>
```

**Does it require a known length?** **Yes.** R2 needs a known content length; a stream of indeterminate length is rejected with:
```
TypeError: Provided readable stream must have a known length
            (request/response body or readable half of FixedLengthStream)
```
The error text itself enumerates exactly the two accepted sources: a **request/response body**, or the readable half of a **`FixedLengthStream`**.

**Current state (verified 2026-07-27):**
- **In production, `env.BUCKET.put(key, request.body)` works** when the inbound request carries a `Content-Length` header — the runtime propagates the length from the request body. This is the pattern in Cloudflare's own tutorial ([upload-assets-with-r2](https://developers.cloudflare.com/workers/tutorials/upload-assets-with-r2/)) and the upload-objects docs.
- **It fails when the inbound request has no `Content-Length`** (chunked/`Transfer-Encoding: chunked` clients). Confirmed by the Cloudflare maintainer on [workers-sdk#4373](https://github.com/cloudflare/workers-sdk/issues/4373): *"I think this may only be a problem when the incoming request doesn't have a `Content-Length` header."*
- **The local-dev divergence is real and still open.** Three issues, all **OPEN** as of last check (updated Mar 2026):
  - [workers-sdk#4373](https://github.com/cloudflare/workers-sdk/issues/4373) — "[Miniflare] Consider buffering all requests" — `put(key, request.body)` fails locally, works deployed
  - [workers-sdk#6504](https://github.com/cloudflare/workers-sdk/issues/6504) — `getPlatformProxy()` does not accept Node `ReadableStream`s
  - [workers-sdk#6425](https://github.com/cloudflare/workers-sdk/issues/6425) — `R2ObjectBody.body` (a `ReadableStream`) rejected as a `put()` value, even R2→R2 copy
- The `FixedLengthStream` workaround is the documented, still-current fix. `FixedLengthStream` is a specialization of `IdentityTransformStream` that caps total bytes and **sets `Content-Length` instead of using chunked encoding**; it errors if too many or too few bytes are written. Max length `2^53 − 1`. ([transformstream#fixedlengthstream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream), [request#set-the-content-length-header](https://developers.cloudflare.com/workers/runtime-apis/request/))

**Correct pattern — stream the request body straight into R2, no buffering:**

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "PUT" || !request.body) {
      return new Response("Expected PUT with body", { status: 400 });
    }

    const key = new URL(request.url).pathname.slice(1);
    const lenHeader = request.headers.get("content-length");

    // Require an explicit length: lets you reject oversize uploads BEFORE
    // streaming a single byte, and guarantees R2 gets a known length.
    if (!lenHeader) {
      return new Response("Content-Length required", { status: 411 });
    }
    const size = Number(lenHeader);
    if (!Number.isSafeInteger(size) || size < 0) {
      return new Response("Bad Content-Length", { status: 400 });
    }
    if (size > MAX_UPLOAD_BYTES) {          // your cap, <= ~95 MB
      return new Response("Too large", { status: 413 });
    }

    // FixedLengthStream normalizes the length so R2 always sees a known size,
    // and makes local `wrangler dev` behave like production.
    const { readable, writable } = new FixedLengthStream(size);
    // Do NOT await this — pipe concurrently with the put() below.
    const pumped = request.body.pipeTo(writable);

    const [object] = await Promise.all([
      env.BUCKET.put(key, readable, {
        httpMetadata: {
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
        },
      }),
      pumped,
    ]);

    if (object === null) return new Response("Precondition failed", { status: 412 });
    return Response.json({ key: object.key, size: object.size, etag: object.httpEtag });
  },
};
```

Key points:
1. **Never `await request.arrayBuffer()`** — that's the 128 MB memory trap from §3.
2. **Require `Content-Length`** and validate it *before* streaming. This is your enforcement point for the per-file cap; rejecting on the header avoids consuming the body at all. (The edge still independently rejects >100 MB with a 413.)
3. **`FixedLengthStream` is belt-and-braces**: `put(key, request.body)` alone works in prod with a `Content-Length`, but breaks in `wrangler dev` and on chunked clients. Wrapping makes both paths identical. If you'd rather keep it simple, `put(key, request.body)` + a 411 on missing `Content-Length` is defensible in prod — you'll just hit the local-dev issue.
4. **Don't `await pipeTo()` before `put()`** — that deadlocks (the stream has no reader until `put()` starts consuming). Kick off the pipe, then `Promise.all`.
5. Trust `object.size` from the returned `R2Object` as the authoritative stored size for your D1 row, not the client-supplied header.

---

## 7. D1 limits

| Limit | Value | Source |
|---|---|---|
| **Max database size** | **10 GB** (Paid) / **500 MB** (Free) — 10 GB is a hard ceiling, cannot be raised | [d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Max storage per account | 1 TB (Paid, raisable) / 5 GB (Free) | same |
| Databases per account | 50,000 (Paid, raisable) / 10 (Free) | same |
| **Max SQL query duration** | **30 s** (also applies to the entire `batch()` call) | same, footnote 4 |
| **Max rows returned per query** | **No documented row-count cap** — bounded by the 2 MB row limit, Worker memory (128 MB), and the 30 s duration | same |
| **Max bound parameters per statement** | **100** | same |
| **Max statements per `batch()`** | **Not documented — UNCONFIRMED** | see below |
| **Max single TEXT/BLOB value (and max row size)** | **2,000,000 bytes (2 MB)** | same |
| Max SQL statement length | 100,000 bytes (100 KB) | same |
| Max columns per table | 100 | same |
| Max rows per table | Unlimited (subject to DB size) | same |
| Max args per SQL function | 32 | same |
| Max chars in `LIKE`/`GLOB` pattern | 50 bytes | same |
| D1 bindings per Worker script | ~5,000 | same, footnote 3 |
| Simultaneous D1 connections per invocation | 6 | same (FAQ) |
| Time Travel (PITR) | 30 days (Paid) / 7 days (Free) | same |

**Write throughput:** no hard TPS limit, but each D1 database is **single-threaded, backed by one Durable Object, processing queries one at a time.** Throughput ≈ 1/query-duration: *"If your average query takes 1 ms, you can run approximately 1,000 queries per second. If your average query takes 100 ms, you can run 10 queries per second."* Excess concurrency queues; a full queue returns an **"overloaded" error**. Writes take several ms each (durable replication). Docs warn that a single `UPDATE`/`DELETE` touching hundreds of thousands of rows will exceed execution limits — chunk to ~1,000 rows.

Daily/monthly usage caps (from [d1/platform/pricing](https://developers.cloudflare.com/d1/platform/pricing/)):

| | Free | Paid |
|---|---|---|
| Rows read | **5 M/day** | 25 B/month included, then $0.001/M |
| Rows written | **100,000/day** | 50 M/month included, then $1.00/M |
| Storage | 5 GB total | 5 GB included, then $0.75/GB-mo |

Free limits reset 00:00 UTC; exceeding them makes queries **fail outright** until reset.

**`batch()` semantics** ([d1/worker-api/d1-database#batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)): sends multiple statements in one call, executed sequentially and non-concurrently; it **is** a SQL transaction — any statement failing aborts/rolls back the whole sequence. Per-statement limits (100 KB statement length, 100 bound params) apply to **each statement inside the batch**, per the doc's "Batch limits" callout. The 30 s duration limit applies to the **whole batch**. No documented cap on statement count — **UNCONFIRMED**; practical ceiling is the 30 s budget and the 100 KB-per-statement rule. Whether one `batch()` counts as one subrequest or N is also **UNCONFIRMED**, though the round-trip framing ("reduces latency from network round trips to D1") strongly implies one.

**For storing extracted text for FTS — this is your real constraint:** a single TEXT value **cannot exceed 2 MB**, and that 2 MB is also the **whole-row** limit. A 100 MB PDF's extracted text will routinely exceed 2 MB. You must **chunk extracted text across multiple rows** (which you're doing anyway for embeddings) rather than storing one blob per file. Budget the row overhead: with a `chunk_text` column you're safe if chunks stay well under 2 MB, which any sane embedding chunk size (a few KB) does. If you also want a full-document text column, store the full text in **R2** and keep only chunks in D1.

Also note **100 bound parameters per statement**: a bulk insert of 30 chunks × 4 columns = 120 params **exceeds it**. Chunk your inserts (e.g. 20 rows × 4 cols = 80 params) or use `batch()` with one statement per row.

---

## 8. Free-plan viability for self-hosters

| Resource | Free allowance | Wall they hit | Source |
|---|---|---|---|
| **Workers requests** | **100,000/day** (resets 00:00 UTC; Error 1027 after) | Generous for personal drive use | [limits#daily-requests](https://developers.cloudflare.com/workers/platform/limits/#daily-requests) |
| **Workers CPU** | **10 ms/invocation** | **The single hardest wall.** Kills server-side text extraction. | [limits#cpu-time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) |
| Workers memory | 128 MB (same as Paid) | Not a differentiator | same |
| Subrequests | 50 external + 1,000 internal | Fine | [changelog 2026-02-11](https://developers.cloudflare.com/changelog/2026-02-11-subrequests-limit/) |
| Request body | 100 MB (zone plan) | Same as Pro; per-file cap | [limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker bundle size | 3 MB gzipped (vs 10 MB Paid) | Watch if bundling a PDF/text-extraction lib | same |
| **R2 storage** | **10 GB-month** | Real, usable free tier | [r2/pricing](https://developers.cloudflare.com/r2/pricing/) |
| **R2 Class A ops** (writes: `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `ListObjects`) | **1 M/month** | Plenty | same |
| **R2 Class B ops** (reads: `GetObject`, `HeadObject`) | **10 M/month** | Plenty | same |
| **R2 egress** | **Free, unlimited** | Big win vs S3 | same |
| **D1 storage** | **500 MB/database, 5 GB/account, 10 databases** | Fine for metadata + FTS chunks | [d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/) |
| **D1 rows read** | **5 M/day** | Fine with indexes; a few unindexed full scans can burn it | [d1/pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| **D1 rows written** | **100,000/day** | Fine; note indexed columns cost 2 writes/row | same |
| **Workers AI** | **10,000 Neurons/day** (same allocation on Paid; Paid just lets you exceed it at $0.011/1k) | Embeddings are cheap in Neurons; see below | [workers-ai/pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| **Vectorize** | **Free plan: 30 M queried + 5 M stored vector dimensions**/month | Note: the Workers pricing page also states *"Vectorize is currently only available on the Workers paid plan"* while listing Free-plan allowances in the same table — **contradictory, UNCONFIRMED**. Verify before depending on Vectorize for free self-hosters. | [workers/pricing#vectorize](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers Logs | 200,000 events/day, 3-day retention | Fine | [workers/pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Queues | 10,000 ops/day | Available on Free — viable `waitUntil` escape hatch | same |
| Durable Objects | SQLite-backed only on Free; 100k req/day, 13,000 GB-s/day | Available | same |

**R2 + D1 both have genuinely usable free tiers** — 10 GB object storage with free egress and 500 MB of D1 is a real self-hosted drive. Workers Paid is $5/month minimum.

**Where a free-plan self-hoster actually hits the wall, in order:**

1. **10 ms CPU per invocation.** This is the blocker, and it's a 3,000× gap vs Paid's 30 s default. Text extraction (PDF parsing, DOCX unzip+XML parse), chunking, and JSON serialization of embeddings are all pure CPU. Uploading and streaming to R2 is nearly free (I/O), so **plain upload/download works fine on Free** — it's the *enrichment pipeline* that dies. Design the extraction/embedding path as **optional and independently disableable**, so a free-plan install degrades to a working plain file drive rather than erroring on every upload.
2. **Concurrent large uploads sharing one 128 MB isolate** — only if you buffer. Streaming makes this a non-issue on both plans.
3. **D1 500 MB/database** — only if storing lots of extracted text. Mitigate by keeping full text in R2 and only chunks in D1.
4. **10 GB R2** — the natural growth ceiling for a real drive; at $0.015/GB-month, going past it is cheap.
5. **10,000 Neurons/day for AI.** bge-m3 is 1,075 neurons per **million** input tokens, so 10k neurons ≈ 9.3 M tokens/day of embedding — effectively not a constraint for a personal drive. The CPU limit will stop you long before the Neuron limit does.

**Recommended posture for the self-hosted README:** document Free as "fully functional file drive; search/AI features require Workers Paid ($5/mo)." Gate the extraction/embedding pipeline behind a config flag that defaults off when no Paid indicators are present.

---

## Summary: decisions for the a-drive upload path

1. **Per-file cap: 100 MB hard ceiling** (Cloudflare Free/Pro zone), enforce ~95 MB in-app. Not raisable by buying Workers Paid — needs Business (200 MB) / Enterprise (500 MB).
2. **Multipart becomes mandatory above 100 MB**, driven by the Workers *request* limit, not by R2 (which allows 5 GiB single-part). Schema needs `uploadId`, `key`, and per-part `{partNumber, etag, size}`; parts must be uniform and ≥5 MiB except the last; max 10,000 parts.
3. **Stream, never buffer.** `FixedLengthStream(size)` + `pipeTo` + `put()` under `Promise.all`. Require `Content-Length` (411 otherwise) so you can reject oversize before reading a byte. This also sidesteps the still-open `wrangler dev` stream-length bugs.
4. **Move extraction/embedding off `waitUntil` if it can exceed 30 s wall clock** — that 30 s is wall clock (network waits count), not CPU. Queues (15 min) or Workflows (unlimited wall clock/step) are the escape hatches, both available on Free.
5. **Batch the embedding call**: one `AI.run()` with an array of 30 chunks, not 30 calls.
6. **Chunk extracted text into rows** — 2 MB is the max for any single D1 TEXT value *and* for the whole row. Full document text belongs in R2.
7. **Watch the 100-bound-parameter D1 limit** on bulk chunk inserts — 30 chunks × 4 columns overflows it.
8. **Keep the AI pipeline optional** so Free-plan self-hosters get a working drive under the 10 ms CPU limit.

## Unconfirmed items (do not design against these without verifying)

- Whether `waitUntil` work has a **separate** CPU budget. No doc says so; no second budget is documented. Treated as shared with the invocation.
- Whether **Workers AI (`env.AI.run`) counts as a subrequest**, and against which pool. Not stated anywhere in Workers AI or Workers limits docs.
- **Max statements per D1 `batch()`**, and whether a `batch()` is 1 subrequest or N.
- **D1 Free "queries per Worker invocation = 50"** vs the Feb 2026 "1,000 internal subrequests on Free" — the two docs disagree; plan against 50.
- **Vectorize on the Free plan** — Workers pricing page both lists Free-plan dimension allowances and says Vectorize is Paid-only.
- **Streamed vs buffered request bodies** having different size limits — no evidence of a difference; assume the 100 MB applies to both.
