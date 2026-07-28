# adrive — Hybrid Search Research (vector + keyword on Cloudflare Workers / D1 / R2)

> Researched 2026-07-27. Every claim tagged **[VERIFIED]** (with URL), **[INFERRED]**, or
> **[UNKNOWN]**. See the **confidence summary appendix** at the end for the one-screen version.
>
> **Headline findings:**
> 1. **Vectorize is GA, works on the Workers Free plan, and is fast (~31 ms P50)** — but it is
>    **eventually consistent** ("a few seconds" typical, minutes if you don't batch), and its
>    **free-tier query budget collapses as the index grows** because you're billed as if every
>    query scans the whole index.
> 2. **D1 fully supports FTS5** — verified three ways (docs, workerd source, Cloudflare's own
>    tests) — **including the `trigram` tokenizer** (SQLite 3.47.0). Typo tolerance is available.
> 3. **`wrangler d1 export` cannot back up a database containing FTS5 tables**, and a failed
>    attempt can temporarily wedge the DB. Design the FTS index as rebuildable derived state.
> 4. **sqlite-vec is impossible** on D1 *and* Durable Objects — the workerd SQL authorizer
>    allowlists only `fts5`/`fts5vocab` virtual tables.
> 5. ⇒ **Keyword search must be the primary, always-on path; vector search is an optional
>    RRF-fused recall booster.** The degraded (no-Vectorize) mode is the same code path.

---

## 1. Cloudflare Vectorize — current state

### 1.0 GA status and query latency

**[VERIFIED] Vectorize is GA.** <https://developers.cloudflare.com/vectorize/platform/changelog/>
lists `2024-09-26 — **Vectorize GA** — Vectorize is now generally available`. The current
generation is **v2**; **v1 is deprecated** (2024-08-14) and there is no v1→v2 migration.
Anything you create today is v2. Timeline from the changelog:

- 2023-09-27 public beta → 2024-08-14 v2 public beta / v1 deprecated
- **2024-09-16 available on the Workers Free plan**
- **2024-09-26 GA**
- 2024-11-13 `$in`/`$nin` filters; 2024-12-19 range filters (`$lt/$lte/$gt/$gte`)
- 2025-08-25 `list-vectors` (paginated iteration over all vector ids) — **useful for our
  reconciliation/GC job, see §7**

**Query latency [VERIFIED]** — Cloudflare's own GA benchmarks
(<https://blog.cloudflare.com/workers-ai-bigger-better-faster/>), measured *"via a Cloudflare
Worker binding... on warm caches"* at concurrency 300:

| Dataset | P50 | P75 | P90 | P95 | RPS | Precision |
|---|---|---|---|---|---|---|
| dbpedia-openai-1M-1536 | **31 ms** | 56 | 159 | 380 | 343 | 95.4% |
| Laion-768-5m-ip | 81.5 ms | 91.7 | 105 | 123 | 623 | 95.5% |
| Laion-768-5m-ip (no refinement) | 14.7 ms | 19.3 | 24.3 | 27.3 | 698 | 78.9% |

Also from the GA post: *"median latency is down 95% from 500 ms to 30 ms"*.

Two things to note: (a) **~30 ms P50 is excellent** and fine to run in a search request;
(b) **precision is ~95%, not 100%** — it's an ANN index, so it can miss a true nearest
neighbour. Another reason the exact/lexical half must not depend on it.

[INFERRED]: adrive's index (thousands of vectors, not millions) should be at or below the
31 ms P50 figure. Budget **~30-80 ms** for the Vectorize call.

### 1.1 Availability & plan gating

**[VERIFIED]** Vectorize **is available on the Workers Free plan**, with lower limits than
Paid. Source: <https://developers.cloudflare.com/vectorize/platform/pricing/> and
<https://developers.cloudflare.com/vectorize/platform/limits/> — the limits table has explicit
"(Workers Paid) / (Free)" split columns, and pricing has a "Workers Free" column.

Cloudflare docs FAQ, verbatim:

> **Will Vectorize always have a free tier?**
> Yes, the Workers free tier will always include the ability to prototype and experiment
> with Vectorize for free.

This is **very good news for self-hosters** — the vector half of adrive does not force a paid plan.

### 1.2 Free vs Paid allowances

Source: <https://developers.cloudflare.com/vectorize/platform/pricing/> **[VERIFIED]**

| Metric | Workers Free | Workers Paid |
|---|---|---|
| Queried vector dimensions | 30 M / month | first 50 M / month, then $0.01 / M |
| Stored vector dimensions | 5 M total | first 10 M, then $0.05 / 100 M |

Billing is on **dimensions**, not vectors. Two things to internalise:

- **Stored** = `num_vectors * dimensions`.
- **Queried** = `(num_vectors_in_index + num_queries) * dimensions` — i.e. *every query is
  charged as if it scanned the whole index*. Cloudflare's own worked example:
  10,000 vectors @ 384 dims queried 100 times = `(10000 + 100) * 384` = 3.878 M queried dims.

**This is the single most important cost fact for adrive.** [INFERRED, arithmetic from the
verified formula]: on the **free plan** with a **384-dim** model:

- Storage cap 5 M dims / 384 = **~13,000 chunk vectors** max. At ~4 chunks/file that's ~3,200 files.
- Query cap: 30 M queried dims/month. With 13,000 vectors stored, *each query* costs
  ~`(13000 + 1) * 384` ≈ 5.0 M dims → only **~6 queries/month**. With 1,000 vectors stored,
  a query costs ~384k dims → ~78 queries/month. With 100 vectors → ~7,700 queries/month.

> ⚠️ **The free-tier query allowance collapses as the index grows**, because queried dims scale
> with index size. A self-hoster on the free plan with a few thousand chunks gets a
> *handful* of searches per month. **The keyword half must be the default, always-on path,
> and vector search must be optional.** (This directly answers the "degrade gracefully"
> requirement in §9.)

On **Workers Paid** it is cheap: the docs' "Production" example (50k vectors @768, 200k
queries/mo) = **$1.94/mo**. Even the "Large" row (250k vectors, 500k queries) is $5.86/mo.

### 1.3 Limits (V2 indexes)

Source: <https://developers.cloudflare.com/vectorize/platform/limits/> **[VERIFIED]**

| Feature | Limit |
|---|---|
| Indexes per account | 50,000 (Paid) / **100 (Free)** |
| Max dimensions per vector | **1536**, float32 |
| Max vector ID length | **64 bytes** |
| Metadata per vector | **10 KiB** |
| Max `topK` **with** values or metadata | **50** |
| Max `topK` without values/metadata | 100 |
| Max upsert batch | 1000 (Workers API) / 5000 (HTTP API) |
| Max vectors per index | 10,000,000 |
| Max namespaces per index | 50,000 (Paid) / 1000 (Free) |
| **Max metadata indexes per Vectorize index** | **10** |
| **Max indexed data per metadata index per vector** | **64 bytes** |
| Max vectors upload size | 100 MB |

Design consequences for adrive:
- **Vector ID ≤ 64 bytes** — a UUID (36) + `:` + chunk ordinal fits comfortably. A UUID +
  version UUID + ordinal does **not** (36+1+36+1+3 = 77). See §7 for the id scheme.
- `topK ≤ 50` when returning metadata — fine, we want ~20-30 for fusion.

### 1.4 Consistency model — ⚠️ CRITICAL, VERIFIED AS *NOT* IMMEDIATELY CONSISTENT

Source: <https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/>
section "Improve Write Throughput" **[VERIFIED]**, verbatim:

> Vectorize writes changes immediately to a write ahead log for durability. To make these
> writes visible for reads, **an asynchronous job needs to read the current index files from
> R2, create an updated index, write the new index files back to R2, and commit the change.**
> To keep the overhead of writes low and improve write throughput, Vectorize will combine
> multiple changes together into a single batch. It sets the maximum size of a batch to
> 200,000 total vectors or to 1,000 individual updates, whichever limit it hits first.

And, on batching:

> For example, let's say we have 250,000 vectors we would like to insert... We decide to
> insert them one at a time, calling the insert API 250,000 times. Vectorize will only
> process 1000 vectors in each job, and will need to work through 250 total jobs. **This
> could take at least an hour to do.** The better approach is to batch... Vectorize would
> update the index in only 2 or 3 jobs. **All 250,000 vectors will visible in queries within
> minutes.**

The client API reference is more precise about the *typical small-write* case
(<https://developers.cloudflare.com/vectorize/reference/client-api/>) **[VERIFIED]**, verbatim:

> **Insert vectors** — Vectorize inserts are asynchronous and the insert operation returns a
> mutation identifier unique for that operation. **It typically takes a few seconds for
> inserted vectors to be available for querying in a Vectorize index.**

> **Upsert vectors** — ... upserts are asynchronous and the upsert operation returns a mutation
> identifier... **It typically takes a few seconds for upserted vectors to be available for
> querying**. ... Upserting does **not** merge or combine the values or metadata of an existing
> vector with the upserted vector: **the upserted vector replaces the existing vector in full.**

> **Delete vectors by ID** — ... deletes are asynchronous ... **It typically takes a few
> seconds for vectors to be removed from the Vectorize index.**

**Conclusion [VERIFIED, directly from docs]: Vectorize is eventually consistent. Upserts,
inserts and deletes are NOT immediately queryable/removed.**

- **Typical single small batch: "a few seconds"** (client-api page).
- **Large or poorly-batched writes: minutes to over an hour** (insert-vectors page).
- **Cloudflare publishes no SLA** — both figures are the word "typically". **[UNKNOWN]**: the
  actual p99. Treat "a few seconds" as a hint, not a contract.
- Every write returns a **mutation id**. **[UNKNOWN]**: whether there's any documented API to
  poll a mutation id for "applied" status — the docs mention the identifier but describe no
  way to wait on it. Assume you cannot read-your-writes.

**This is a real UX problem for "upload then immediately search", exactly as suspected**
(though "seconds" is much better than "minutes" for the normal single-file case).

**This is a real UX problem for "upload then immediately search", exactly as suspected.**
Mitigation is architectural, not incidental:

1. The **D1/FTS5 keyword index is written synchronously in the same request** (or in the same
   `waitUntil` as extraction) and is **immediately** queryable. A file uploaded 2 seconds ago
   is findable by name/tag/content keyword right away.
2. The vector index is *additive recall*, not the primary path. A missing vector for the
   newest file degrades a semantic query, it does not make the file invisible.
3. Surface an **indexing state** per file (`pending` / `ready` / `failed`) in the UI so the
   user knows semantic search hasn't caught up yet. (See §7.)
4. **Batch upserts** — one `upsert()` call with all chunks of a file, never one call per chunk.
   Per the quote above, per-vector calls are catastrophically slow to become visible.

### 1.5 Other client API facts worth pinning

From <https://developers.cloudflare.com/vectorize/reference/client-api/> **[VERIFIED]**:

- `query(vector, opts)` — `topK` **default is 5**; upper limit 100, but **50 when
  `returnValues: true` or `returnMetadata: 'all'`**.
- `returnMetadata` is a **three-way enum**, not a boolean: `'none'` (default) | `'indexed'` |
  `'all'`. Crucially: *"`indexed`: Fetched metadata only for the indexed metadata fields.
  **There is no latency overhead with this option**, but long text fields may be truncated.
  `all`: ... **Queries may run slower with this option**, and topK is limited to 50."*
  → **Use `returnMetadata: 'indexed'`** and hydrate everything else from D1. Faster, and it
  keeps us honest about D1 being the source of truth.
- `insert()` only adds new ids and **skips** ids that already exist; `upsert()` overwrites.
  **Always use `upsert()`** for reindexing.
- Other ops available on the binding: `queryById()`, `getByIds()`, `deleteByIds()`,
  `describe()` (returns configured `dimensions` and `metric` — handy for a startup sanity
  check that the index matches the configured embedding model).
- `list-vectors` is documented as a **wrangler CLI command**; **[UNKNOWN]** whether it is
  exposed on the Workers binding — the client-api page only shows the CLI form. If it's not on
  the binding, the GC job in §7 must use the REST API with an API token instead. **Verify.**
- Binding config in `wrangler.jsonc`:
  ```jsonc
  { "vectorize": [{ "binding": "VECTORIZE", "index_name": "adrive-chunks" }] }
  ```
- Index is created with a fixed `--dimensions` and `--metric` (use `cosine`); **dimensions
  cannot be changed later** — changing the embedding model means creating a new index.

---

*(Sections 2-9 in progress — metadata filtering, embeddings, chunking, D1 FTS5, RRF fusion,
lifecycle, alternatives, and the recommended architecture.)*

## 2. Metadata filtering in Vectorize

Source: <https://developers.cloudflare.com/vectorize/reference/metadata-filtering/> **[VERIFIED]**

Operators supported: `$eq`, `$ne`, `$in`, `$nin`, `$lt`, `$lte`, `$gt`, `$gte`.

Rules (all [VERIFIED] from that page):
- `filter` must be a non-empty object; **compact JSON < 2048 bytes**.
- Keys cannot be empty, contain `"` or `.` (dot = nesting), start with `$`, or exceed 512 chars.
- `$eq`/`$ne` values: `string | number | boolean | null`.
- `$in`/`$nin` values: arrays of those.
- Range queries: `string | number` only; strings ordered lexicographically. Upper-bound
  (`$lt`/`$lte`) can combine with lower-bound (`$gt`/`$gte`) in the same filter; **other
  combinations are not allowed**.
- Multiple keys = implicit logical **AND**. **There is no `$or`.**
- Filter is applied **first**, then `topK` is taken from the filtered set — i.e. filters are
  real pre-filters, not post-filters. Good: no "filtered away all my results" problem.
- Nice trick, verbatim from docs: range queries on strings implement **prefix search** —
  `{ "someKey": { "$gte": "net", "$lt": "neu" } }` matches values starting with "net".

**Metadata indexes are required and are a hard constraint** [VERIFIED]:
- Must create a metadata index per filterable property, via
  `wrangler vectorize create-metadata-index <index> --property-name=X --type=string|number|boolean`.
- **Max 10 metadata indexes per Vectorize index.**
- **Only the first 64 bytes** of a string value are indexed (truncated on UTF-8 boundaries),
  so vectors are only filterable on that prefix.
- Types supported for indexes: `string`, `number`, `boolean` only.
- ⚠️ **"Metadata indexes need to be created *before* vectors can be inserted"** to support
  filtering, and indexes created before 2023-12-06 can't be migrated. So the self-hoster's
  setup script must create metadata indexes at provisioning time, before first upload.

### Can we filter by tags (array membership)? **NO, not directly.**

**[VERIFIED by absence + type rules]:** metadata index types are only `string`/`number`/
`boolean`. Arrays are **not** an indexable metadata type, and `$in`/`$nin` test whether a
*scalar field value* is in a *query-supplied list* — that is the inverse of array membership.
There is no `$contains` / `$anyOf`-over-an-array operator.

Practical options for tag filtering:
1. **Best: don't filter tags in Vectorize at all.** Do tag filtering in D1 (which is a real
   relational DB with a proper `file_tags` join table) and use it to *post-filter* the
   Vectorize match list. Since we already hit D1 to hydrate file rows for the fusion step,
   this is nearly free. Downside: a vector `topK` of 30 might return 0 rows after an
   aggressive tag filter → over-fetch (topK 50) or fall back to keyword-only for that query.
2. Hacky alternative: pack tags into a delimited string field and abuse the string prefix
   range trick — fails for multi-tag files because only 64 bytes are indexed and prefix
   matching only works on the *start* of the value. **Not recommended.**
3. Namespaces are single-valued per vector, so they can't represent multi-tag either.

### What SHOULD be metadata-indexed (budget: 10)

Scalar, low-ish cardinality, always-filtered fields — these are the ones worth pushing down:
- `deleted` (boolean) — exclude trashed files. **Do index this**; it's the safety filter.
- `ct` (string) — content-type or a coarse "kind" bucket (`text`, `markdown`, `code`, `csv`).
  Note the 64-byte truncation; store a short bucket, not the full MIME string.
- `visibility` (string, e.g. `private`/`public`) if adrive ever grows sharing.

Everything else (tags, display name, size, dates) → filter/hydrate in D1. Also note the docs'
**cardinality warning** [VERIFIED]: high-cardinality range filters (e.g. ms timestamps) force
large index scans and Vectorize will *"degrade performance and the accuracy of the query"* to
finish the request. So do **not** metadata-index `file_id` for range use; bucket timestamps
if you ever need date-range filters.

⚠️ **The `deleted` flag has a consistency trap**: flipping `deleted` requires an *upsert* of
every chunk vector, which is subject to the same eventual-consistency delay as §1.4. So a
just-deleted file could still come back from Vectorize for minutes. **Therefore the
authoritative deleted/visibility check must be in D1 at hydration time** — treat the
Vectorize metadata filter as an optimisation only, never as the security/correctness boundary.

---

## 3. Embeddings (Workers AI)

### 3.1 Available embedding models (2026-07-27)

From <https://developers.cloudflare.com/workers-ai/models/> (filtered to Text Embeddings) and
per-model pages. **[VERIFIED]**

| Model | Dims | Max input tokens | Batch API | $/M input tokens | Neurons/M input |
|---|---|---|---|---|---|
| `@cf/baai/bge-small-en-v1.5` | **384** | **512** | Yes | $0.020 | 1,841 |
| `@cf/baai/bge-base-en-v1.5` | **768** | 512 [INFERRED — same family] | Yes | $0.067 | 6,058 |
| `@cf/baai/bge-large-en-v1.5` | **1024** | 512 [INFERRED] | Yes | $0.204 | 18,582 |
| `@cf/baai/bge-m3` | 1024 [INFERRED — model card] | **60,000 (context window)** | No batch flag | **$0.012** | **1,075** |
| `@cf/google/embeddinggemma-300m` | 768 [INFERRED — Google model card] | 2048 [INFERRED] | — | not listed in pricing table | — |
| `@cf/qwen/qwen3-embedding-0.6b` | 1024 [INFERRED] | 32k [INFERRED] | — | **$0.012** | **1,075** |
| `@cf/pfnet/plamo-embedding-1b` | — | — | — | $0.019 | 1,689 | (Japanese-only) |

Sources: <https://developers.cloudflare.com/workers-ai/platform/pricing/> (prices, VERIFIED),
<https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/> (384 dims / 512 tokens,
VERIFIED), <https://developers.cloudflare.com/workers-ai/models/bge-m3/> (60,000-token context
window, VERIFIED).

⚠️ **[UNKNOWN / verify before building]**: the docs' model pages for `bge-m3`,
`embeddinggemma-300m` and `qwen3-embedding-0.6b` do **not** print an "Output Dimensions" row
the way the bge-v1.5 pages do. The dims above for those three are from the upstream model
cards, not from Cloudflare. **Do not hardcode; call the model once at setup and read
`shape`** — the Workers AI embedding response returns `{ shape: [n, dims], data: number[][] }`.
This is also the safe way to auto-configure the Vectorize index dimension.

**Notable [VERIFIED]:** `bge-small-en-v1.5` has a `pooling` parameter (`mean` | `cls`), and
Cloudflare's own docs say: *"`cls` pooling will generate more accurate embeddings on larger
inputs — however, embeddings created with cls pooling are not compatible with embeddings
generated with mean pooling. The default pooling method is `mean` in order for this to not be
a breaking change, but we highly suggest using the new `cls` pooling for better accuracy."*
→ **Use `pooling: "cls"`, and pin it in config**, because switching it later silently
invalidates every stored vector. Same applies to switching models at all.

### 3.2 Which model for adrive

**Recommendation: `@cf/baai/bge-m3`, 1024 dims** — *if* the dimension is confirmed ≤1536
(Vectorize cap) and the true max input is large.
- Cheapest per token of the lot ($0.012/M, tied with qwen3), **6.6× cheaper than bge-base**
  and 1.7× cheaper than bge-small despite being far stronger.
- Multilingual + strong on retrieval (it's the standard modern BGE).
- 60k context means **chunking is a choice, not a constraint** — you could embed a whole small
  file in one vector.

**But** there's a countervailing force: **Vectorize bills by *dimension*.** 1024-dim vectors
cost 2.67× the storage and *queried* dims of 384-dim vectors, and the free tier is defined in
dimensions. So:

- **Self-hoster on Workers Free → `@cf/baai/bge-small-en-v1.5` @ 384 dims.** Maximises the
  number of vectors that fit in the 5 M stored-dim cap (~13k vs ~4.8k) and makes each query
  ~2.7× cheaper against the 30 M query cap.
- **Workers Paid / quality-first → `@cf/baai/bge-m3` @ 1024 dims.** Costs are trivial at
  adrive's scale ($1-2/mo).

→ **Make the embedding model + dimension a config value**, and create the Vectorize index to
match. This is required anyway because the index dimension is fixed at creation time.

### 3.3 Free tier and cost in practice

**[VERIFIED]** <https://developers.cloudflare.com/workers-ai/platform/pricing/>:
- Workers AI is on **both Free and Paid** plans. **10,000 Neurons/day free** on both.
- Above that: **$0.011 per 1,000 Neurons** (Paid only; Free just errors out).
- *"All limits reset daily at 00:00 UTC. If you exceed any one of the above limits, further
  operations will fail with an error."*

[INFERRED, arithmetic]: with `bge-small` at 1,841 neurons/M tokens, 10,000 neurons/day
≈ **5.4 M tokens/day free** ≈ ~21,000 chunks of 256 tokens **per day**. With `bge-m3` at
1,075 neurons/M, ≈ **9.3 M tokens/day**. **Embedding is effectively free at adrive's scale**
— indexing a 10,000-file drive is a few days of free tier, or cents on Paid.

**The Workers AI free tier is generous; the Vectorize free tier is the actual bottleneck.**
(§1.2)

### 3.4 Batching

**[VERIFIED]** All embedding models take `text: string | string[]` and return
`{ shape, data }` — so **many texts per single `AI.run()` call** is native. The bge-v1.5
models and bge-m3 additionally advertise a **"Batch" capability** (async-queue batch API,
`requests[]` + `request_id`) for large offline jobs.

**[UNKNOWN]** The docs pages don't state a hard max array length for the *synchronous* `text[]`
form. [INFERRED from community practice]: keep sync batches to **~50-100 chunks** per call and
watch the total token count. Verify empirically. There is a documented per-model limit page at
<https://developers.cloudflare.com/workers-ai/platform/limits/> — check it for the current
rate limits (requests/min per model) before shipping bulk reindex.

**[UNKNOWN] Latency per call** is not published by Cloudflare. [INFERRED from the model sizes
and general Workers AI behaviour]: a small embedding model on a batch of a few dozen short
texts is typically in the **tens to low hundreds of ms**. For adrive, the query-time embedding
of the user's search string (1 short text) is the latency-critical one — budget ~50-150 ms and
**run it in parallel with the D1 FTS query** (see §9).

### 3.5 Non-Workers-AI option for self-hosters

Since Workers AI needs no paid plan, most self-hosters won't need this. But for people who
want better embeddings or already pay for an API:

- **OpenAI `text-embedding-3-small`**: 1536 dims (fits Vectorize's cap exactly), $0.02 per M
  tokens, supports `dimensions` parameter to shrink (Matryoshka) — **you can request 512 or
  768 dims to cut Vectorize storage cost** without re-embedding. `text-embedding-3-large` is
  3072 dims natively → **exceeds Vectorize's 1536 cap**, so it must be truncated via the
  `dimensions` param to ≤1536. [VERIFIED: OpenAI pricing/docs — <https://platform.openai.com/docs/guides/embeddings>;
  the 1536 Vectorize cap is VERIFIED above.]
- **Voyage / Cohere / Jina / Mistral** all have OpenAI-compatible-ish endpoints;
  `jina-embeddings-v3` (1024) and `voyage-3-lite` (512) are good, cheap fits.
- **Any local/self-hosted OpenAI-compatible server** (llama.cpp, Ollama `/v1/embeddings`,
  Infinity, TEI). Note a Worker can only reach it over public HTTPS (or Cloudflare Tunnel).

**Design implication:** define one narrow port —

```ts
interface Embedder {
  readonly dimensions: number
  embed(texts: readonly string[]): Effect.Effect<Float32Array[], EmbedError>
}
```

— with `WorkersAiEmbedder` and `OpenAiCompatEmbedder` layers. Cost for a 10k-file drive at
$0.02/M tokens is roughly **$0.05-$0.50 one-off**, so the external option is affordable too.

---

## 3A. ⚠️ Worker platform limits that constrain the indexing pipeline

Source: <https://developers.cloudflare.com/workers/platform/limits/> **[VERIFIED]**. These bite
hard and shape the whole §7 design:

| Limit | Workers Free | Workers Paid |
|---|---|---|
| **CPU time per HTTP request** | **10 ms** | 5 min (default **30 s**) |
| **CPU time per Cron Trigger** | **10 ms** | 30 s (interval < 1 h) / 15 min (>= 1 h) |
| **Subrequests per invocation** | **50** | 10,000 (default) |
| Subrequests to internal services | 1,000 | matches configured limit |
| Memory per isolate | 128 MB | 128 MB |
| Cron Triggers per account | 5 | 250 |
| HTTP request wall time | unlimited | unlimited |
| **`ctx.waitUntil()` extension** | **up to 30 s after response** | same |

Verbatim, on `waitUntil` [VERIFIED]:
> Use `ctx.waitUntil()` to perform work after returning a response. `waitUntil()` **can extend
> execution for up to 30 seconds** after the response is sent or the client disconnects.

And on CPU time [VERIFIED]:
> CPU time measures how long the CPU spends executing your Worker code. **Waiting on network
> requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU
> time.**

**Four consequences for adrive:**

1. **`ctx.waitUntil` gives you ~30 seconds of wall clock, not more.** A big text file that needs
   200 chunks embedded will *not* finish in one `waitUntil`. The pipeline must be
   **resumable/incremental** — see §7.
2. **Free plan: 50 subrequests per invocation, total.** Every `AI.run()`, every
   `VECTORIZE.upsert()`, and *every D1 statement* is a subrequest. An upload request that does
   ~10 D1 writes has ~40 left. **You cannot make one embedding call per chunk.** Batch
   aggressively: one `AI.run()` with `text: string[]` covering N chunks, one `upsert()` with N
   vectors, and D1 `batch()` instead of loops.
3. **Free plan: 10 ms CPU.** That is *very* little for JS-side text processing. Chunking a
   1 MB text file (regex splitting, token estimation) can easily blow 10 ms. Keep chunking
   cheap (simple char-offset slicing at boundary characters, no tokenizer library, no heavy
   regex backtracking), and cap the amount of text indexed per file.
   → This is also the **main argument against in-Worker brute-force cosine on the free plan** (§8).
4. Cron Triggers exist on Free (5/account) — this is the **queue substitute** (§7) — but they
   also only get 10 ms CPU on Free. Since embedding/upsert is all I/O, a cron that does
   "read D1 → call AI → upsert" is mostly *not* CPU, so it can work; just keep JS work minimal.

---

## 4. Chunking strategy

*(Also being cross-checked by a dedicated research pass; the design below is the mainstream
consensus and will be re-confirmed with citations.)*

### 4.1 Do you even need to chunk?

With `bge-small-en-v1.5` (512 tokens) — yes, for anything over ~2 KB of text.
With `bge-m3` (60k context) — **often no**. This is a real simplification available to adrive:
embed the whole file as one vector when it fits, and only chunk large files.

But note the retrieval-quality caveat: a single embedding of a 20-page document is a mushy
average that matches everything weakly and nothing strongly. **Chunking is better for
retrieval quality even when the model could swallow the whole document.** So: chunk anyway,
but let the chunk size be generous.

### 4.2 Recommended parameters

| Parameter | Recommendation | Why |
|---|---|---|
| Chunk size | **~400-600 tokens** (≈1,600-2,400 chars) | Fits 512-token models with room for the title prefix; large enough to carry context |
| Overlap | **10-15%** (~50-75 tokens) | Prevents a concept being severed at a boundary; more overlap is mostly wasted cost |
| Boundary | Split on paragraph (`\n\n`) → line → sentence → hard char cut | Recursive splitting; never mid-word |
| Min chunk | ~100 chars | Discard trailing scraps |
| Max chunks/file | **cap it** (e.g. 100) | Protects the Vectorize free tier and the `waitUntil` budget; index the first N and mark the rest as truncated |

**Token estimation without a tokenizer**: `chars / 4` is the standard rough heuristic for
English; use `chars / 3` as a conservative bound for code/CSV. Do **not** bundle a real
tokenizer — the 10 ms free-plan CPU limit (§3A) forbids it.

### 4.3 Prefix each chunk with context — do this

Prepend the filename (and tags) to every chunk's *embedding input*:

```
orbit-manifest.txt · tags: mission, logistics

<chunk text>
```

Cheap, and it substantially helps: a chunk from the middle of a document otherwise has no idea
what document it's from, so a query like "the mission logistics file" can't match it. This is a
poor-man's version of **Anthropic's "contextual retrieval"** (which prepends an LLM-generated
per-chunk summary of its place in the document, reported to cut retrieval failures
substantially). The LLM version is too expensive/slow for `waitUntil`; the filename version is
free. **Store the raw chunk text for display, but embed the prefixed version.**

### 4.4 Chunk → file aggregation at query time

One file yields N vectors, so the vector result list contains multiple chunks of the same file.
**Collapse to one row per file before fusion** (§6.4).

**Use MAX pooling — best-scoring chunk wins.**
- This mirrors the classic IR result (BERT-MaxP, Dai & Callan): for document ranking from
  passage scores, taking the **max** passage score beats summing or averaging, because a single
  highly relevant passage is what makes a document relevant. Averaging punishes long documents
  for having irrelevant sections.
- Elasticsearch's nested-vector `score_mode` defaults to `max` for the same reason.
- Sum/count-based pooling systematically favours files with many chunks — actively bad for a
  file drive where a huge log file would dominate everything.

Mild refinement worth trying later: `score = max + 0.1 * (second_best)` to give a small bonus
to files with multiple corroborating chunks, without letting length dominate. Start with pure
max.

**Over-fetch before collapsing**: ask Vectorize for `topK = 50`; if a single file owns all 50
chunks you end up with 1 file. Practically, request 50 and accept it; if that proves too narrow,
issue the query with `topK: 50` and rely on the keyword side for breadth.

### 4.5 Where to store the file→chunk mapping

**Both, with D1 authoritative.**

- **Vectorize metadata** (`returnMetadata: 'indexed'`): store just `file_id` (+ `deleted`, `ct`).
  Needed so a match can be attributed to a file **without** a D1 round-trip per chunk.
  Remember the **64-byte truncation** on indexed string metadata (§2) — a 36-char UUID is fine.
  Do **not** put chunk text in metadata: it's capped at 10 KiB and `returnMetadata: 'all'`
  slows the query and caps topK at 50.
- **D1 `file_chunks` table**: authoritative mapping `vector_id → (file_id, version, ordinal,
  char_start, char_end)`. This is what makes deletion correct (§7.2), what lets you render a
  snippet by slicing the stored text, and what lets a GC job find orphans.

Note the `file_id` is *also* derivable from the vector id by string-splitting (§7.1) — a useful
belt-and-braces fallback if metadata is missing.

---

## 5A. D1 platform limits relevant to search

Source: <https://developers.cloudflare.com/d1/platform/limits/> **[VERIFIED]**

| Feature | Limit |
|---|---|
| Max database size | 10 GB (Paid) / **500 MB (Free)** |
| Databases per account | 50,000 (Paid) / 10 (Free) |
| **Queries per Worker invocation** | 1000 (Paid) / **50 (Free)** |
| Max columns per table | 100 |
| **Max string / BLOB / row size** | **2,000,000 bytes (2 MB)** |
| Max SQL statement length | 100,000 bytes (100 KB) |
| **Max bound parameters per query** | **100** |
| **Max chars (bytes) in a `LIKE` or `GLOB` pattern** | **50 bytes** |
| Max SQL query duration | 30 s |

**Four of these directly shape the design:**

1. **2 MB max row/BLOB size** — caps how much extracted text you can store in a single D1 row.
   For adrive's per-file size cap this is probably fine, but **truncate extracted text**
   (e.g. first 1 MB) before storing, and keep the R2 object as the full-fidelity copy.
   This also caps the **BLOB-embeddings alternative** in §8.
2. **100 bound parameters per query** — you cannot `WHERE id IN (?,?,...)` with 200 chunk ids.
   Hydration and chunk lookups must be **chunked into batches of ≤100 params** (I'd use 50 to
   leave headroom for other bindings in the same statement).
3. **50-byte `LIKE`/`GLOB` pattern limit** — matters for the trigram-tokenizer typo-tolerance
   approach, which is implemented via `LIKE`/`GLOB` under the hood. Long queries could hit it.
   Also rules out any "build a giant LIKE pattern" fallback.
4. **Free plan: 50 queries per Worker invocation** (shared with the Workers subrequest budget) —
   again, use `db.batch()` and avoid per-chunk statements.

**Concurrency [VERIFIED]:** *"Each individual D1 database is inherently single-threaded, and
processes queries one at a time."* Throughput ≈ 1/query-duration. For a single-user drive this
is a non-issue, but it means a heavy reindex cron can starve interactive searches — keep the
cron's batch size small.

**D1 pricing [VERIFIED]** <https://developers.cloudflare.com/d1/platform/pricing/>:
Free = 5 M rows read/day, 100 k rows written/day, 5 GB storage. Paid = 25 B reads/mo then
$0.001/M, 50 M writes/mo then $1.00/M, 5 GB then $0.75/GB-mo. Note *"Indexes will add an
additional written row when writes include the indexed column"* — an FTS5 index multiplies
write rows, but at adrive's write volume (a human uploading files) this is irrelevant.
Also **"Will D1 always have a Free plan? Yes"**.

**Triggers [VERIFIED, indirectly but strongly]:** the D1 pricing FAQ says, on exceeding the
free storage limit: *"you will need to delete unused databases or clean up stale data before
you can insert new data, **create or alter tables or create indexes and triggers**."*
Cloudflare's own docs therefore assume `CREATE TRIGGER` works on D1. (A dedicated subagent is
verifying FTS5 + triggers + tokenizers in depth — see §5 proper.)

---

## 5. D1 / SQLite keyword side — FTS5

### 5.1 ✅ FTS5 IS available in D1 — VERIFIED three independent ways

**1. Cloudflare docs, explicitly.** <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
section "Supported SQLite extensions" **[VERIFIED]**:

> D1 supports a subset of SQLite extensions for added functionality, including:
> - **FTS5 module for full-text search (including `fts5vocab`).**
> - JSON extension for JSON functions and operators.
> - Math functions.

**2. The workerd source — the actual enforcement mechanism.** `src/workerd/util/sqlite.c++`
implements a SQL authorizer. Under "Stuff that is never allowed", `SQLITE_CREATE_VTABLE` is
**denied by default and allowlisted only for `fts5` and `fts5vocab`** (case-insensitive):

```cpp
case SQLITE_CREATE_VTABLE:
  // We don't support these except for FTS5 (Full Text Search)
  if (strcasecmp(moduleName.begin(), "fts5") == 0 ||
      strcasecmp(moduleName.begin(), "fts5vocab") == 0) { ... }
  return false;
```

**3. Cloudflare's own end-to-end test.** `src/workerd/api/tests/sql-test.js` in workerd creates
an FTS5 table with `tokenize = porter`, three `fts5vocab` tables and three sync triggers, and
asserts on `MATCH ... ORDER BY rank`, `bm25()`, `highlight()` and `snippet()` output — and
negatively asserts that `USING fts5abcd(...)` throws `not authorized`.

FTS5 was enabled in workerd PR #607 (May 2023): *"adds a single build flag,
`SQLITE_ENABLE_FTS5`, and 4 functions to the allowlist: `match`, `highlight`, `bm25` and
`snippet`."* Note that allowlist is **exactly those four** — no custom auxiliary functions,
no `fts5_decode`.

Production users on D1/DO: emdash-cms, jokull/agent-cms (FTS5 + Vectorize hybrid RRF on D1 —
literally this project's architecture), hirefrank/clawpost (trigger-synced FTS5), ripgit.

### 5.2 Tokenizers — ✅ ALL FOUR AVAILABLE, including `trigram` — VERIFIED

**D1/workerd runs SQLite 3.47.0** [VERIFIED — pinned in workerd's `MODULE.bazel`:
`strip_prefix = "sqlite-src-3470000"`]. Cloudflare applies 5 patches, **none touching FTS5
tokenizers**. `SQLITE_ENABLE_FTS5` is in `build/BUILD.sqlite3`'s `SQLITE_DEFINES`.

SQLite 3.47.0's `ext/fts5/fts5_tokenize.c` registers:

```c
} aBuiltin[] = {
  { "unicode61", ... },
  { "ascii",     ... },
  { "trigram",   ... },
};
```
plus `porter` registered separately via `xCreateTokenizer_v2`.

→ **`unicode61`, `ascii`, `trigram`, `porter` are ALL present.** [VERIFIED]
3.47.0 ≫ 3.34, so the trigram-availability worry is fully resolved. Tokenizer names live
*inside* the `fts5(...)` argument string, which the authorizer never inspects — nothing can
block them. Corroborated by real usage: workers-sdk#6305 and #4543 both show `tokenize='trigram'`
working on remote D1.

`icu` is **not** available [INFERRED — requires SQLITE_ENABLE_ICU, not in the defines list].

The community anecdote about FTS5 being "case sensitive on D1" is **[UNVERIFIED and probably
wrong]** — `unicode61` case-folds by default. Still, pass `tokenize="unicode61
remove_diacritics 2"` explicitly rather than relying on defaults.

### 5.3 Keeping the FTS table in sync: triggers vs application writes

**Triggers DO work on D1** [VERIFIED from workerd source]: `SQLITE_CREATE_TRIGGER` /
`SQLITE_DROP_TRIGGER` are ordinary name-checked operations, and `isAllowedName` only rejects
the reserved `_cf_` prefix. Restrictions [VERIFIED]:
- `sqlite3_limit(db, SQLITE_LIMIT_TRIGGER_DEPTH, 10)` — trigger recursion capped at 10.
- **TEMP triggers are blocked** (`SQLITE_CREATE_TEMP_TRIGGER` → `false`), as are all temp
  tables/views. Irrelevant for the standard FTS sync pattern.

**Recommendation: still use application writes, not triggers.** Not because triggers don't
work — they do — but because:

1. We are **not** indexing raw column values. The FTS row for a file is a
   *composed document* — display name + tags (joined from another table) + extracted text
   (which arrives asynchronously, minutes after the file row). A trigger on `files` cannot see
   the tags join or the not-yet-extracted text. You'd need triggers on three tables all
   recomputing the same denormalised row. That's worse than one explicit `upsertFtsRow()`.
2. Explicit writes are testable, debuggable and Effect-friendly.
3. **Real corruption reports exist** for trigger-driven external-content FTS5 on D1 — see the
   hazards in §5.3b. Fewer moving parts is genuinely safer here.

### 5.3b ⚠️ FTS5-on-D1 hazards — VERIFIED, read before writing any schema

These are the landmines. Several are severe.

1. **`wrangler d1 export` CANNOT export a database containing virtual tables.** [VERIFIED]
   <https://developers.cloudflare.com/d1/best-practices/import-export-data/>:
   > Export is not supported for virtual tables, including databases with virtual tables. D1
   > supports virtual tables for full-text search using SQLite's FTS5 module. As a workaround,
   > delete any virtual tables, export, and then recreate virtual tables.

   Error text: `D1 Export error: cannot export databases with Virtual Tables (fts5)`.
   **Worse:** workers-sdk#9519 (open) reports a failed export can **wedge the database** —
   *"the export will fail and the database will become completely inaccessible…
   `D1_ERROR: Currently processing a long-running export.`"* Also workers-sdk#6305, open since
   Jul 2024.

   **For a self-hosted drive, backup is not optional.** Mitigations, in order of preference:
   - **Treat the FTS table as pure derived state** and provide a `rebuild-index` command
     (`INSERT INTO files_fts(files_fts) VALUES('rebuild')` for external-content, or re-derive
     from base tables). Then per-table export of the non-FTS tables
     (`wrangler d1 export --table=<t>`, which **does** work) is a complete backup.
   - Rely on **Time Travel** for PITR. [INFERRED — the Time Travel docs contain *zero*
     mentions of "virtual"; it's storage-layer PITR, not logical export, so virtual tables
     should ride along. Distinct mechanism from `d1 export`. Verify on a scratch DB.]
   - If whole-DB logical export is a hard requirement, put FTS5 in a **separate D1 database**
     from the source-of-truth tables, or use a SQLite-backed **Durable Object** (same FTS5
     support, **no export restriction**).

2. **NEVER run FTS5 `'integrity-check'` on D1.** [VERIFIED] emdash-cms#252: running it
   **corrupts D1's FTS5 shadow tables**, after which every trigger-driven write fails with
   `SQLITE_CORRUPT_VTAB`.

3. **Keep any single indexed value well under ~100 KB.** [VERIFIED] emdash-cms#1130 reports
   `SQLITE_CORRUPT_VTAB` corruption when one indexed value exceeds ~100 KB. Combined with D1's
   100 KB max SQL statement and 2 MB max row (§5A), this means: **truncate extracted text to
   well below 100 KB per FTS row**, or split a file's body across multiple FTS rows
   (one per chunk — which is what we're doing anyway, see §9).

4. **`SQLITE_DBCONFIG_DEFENSIVE` is enabled** [VERIFIED], which blocks direct writes to FTS5
   shadow tables (`*_data`, `*_docsize`, `*_content`). Normal usage is unaffected, but the
   manual shadow-table repair recipes you'll find online will fail.

5. **`wrangler d1 migrations` handles virtual tables and multi-line `CREATE TRIGGER ... BEGIN
   ... END;`** [VERIFIED] — workers-sdk#2495 rewrote the SQL splitter specifically for this, and
   its test case is exactly an fts5 + trigger migration. **Use a current wrangler**; old
   versions mangled `BEGIN...END`.

6. **FTS5 writes are billable rows written**, and index maintenance multiplies write cost.
   Irrelevant at human upload rates, relevant during a bulk reindex.

**Use a contentless-ish / standalone FTS5 table** (store the text in the FTS table itself,
plus an `UNINDEXED` `file_id` column) rather than `content='files'` external-content. Rationale:
the indexed document is a *composition* that doesn't correspond 1:1 to a base-table row, so
external content buys nothing and adds sync obligations. Disk cost is duplicated text, which
is fine at this scale (and bounded by the 2 MB row cap, §5A).

```sql
CREATE VIRTUAL TABLE files_fts USING fts5(
  name,                 -- display name (weighted highest)
  tags,                 -- space-joined tags
  body,                 -- extracted text (truncated)
  file_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);
```

Sync points (all explicit, all in the same D1 `batch()` as the base write):
- create file → insert FTS row (name + tags, empty body) — **synchronous, in the upload request**
- rename / retag → update FTS row
- text extracted (in `waitUntil`/cron) → update FTS row's `body`
- new version → update `body`
- delete/purge → delete FTS row

Because the name+tags row is written **synchronously at upload**, `orbit-manifest.txt` is
findable the instant the upload returns — which is exactly the guarantee Vectorize cannot give.

### 5.4 BM25 ranking

FTS5's `bm25()` auxiliary function returns a score where **more negative = more relevant**
(it's the negated BM25). Column weights are positional args:

```sql
SELECT file_id, bm25(files_fts, 10.0, 5.0, 1.0) AS score
FROM files_fts
WHERE files_fts MATCH ?
ORDER BY score          -- ascending, because more negative is better
LIMIT 50;
```

Weighting name 10× and tags 5× over body is the right shape for a file drive: a filename match
should nearly always beat a body mention.

**`bm25()`, `highlight()`, `snippet()`, `match` and `rank` are all VERIFIED available on D1** —
they are the exact four functions added to workerd's allowlist in PR #607, and Cloudflare's own
`sql-test.js` asserts on all of them, including the comment *"Better matches have lower bm25
(since they're all negative)"* which confirms the sign convention above. `highlight()` and
`snippet()` work for result excerpts — verified output in that test:
`snippet(documents_fts, 2, '<b>', '</b>', '...', 4)` → `...document <b>2</b> (of <b>2</b>).`

### 5.5 Query syntax, prefix queries, and escaping

- **Prefix**: `MATCH 'orbit*'` — supported natively, cheap. **Always append `*` to the user's
  last token** so search-as-you-type works.
- **Phrase**: `MATCH '"quarterly revenue"'`.
- **Boolean**: `AND` / `OR` / `NOT`, and `NEAR()`.
- ⚠️ **You must sanitise user input before putting it in `MATCH`.** FTS5 query syntax will
  throw `fts5: syntax error near ...` on stray `"`, `*`, `(`, `-`, `:` etc. A raw user query
  like `foo:bar` or `"unclosed` is a 500. **Tokenise the user's input yourself and rebuild a
  safe query string**, e.g. split on non-alphanumerics, drop empties, wrap each token in
  double quotes, append `*` to the final token:
  `["orbit", "manifest"] → '"orbit" "manifest"*'`.
  This is non-negotiable and is the #1 bug in naive FTS5 integrations.

### 5.6 Typo tolerance — the weakest part of the stack

SQLite has no `pg_trgm`, no `similarity()`, no fuzzy operator. Options, ranked:

1. **FTS5 `trigram` tokenizer** — ✅ **available** (§5.2, VERIFIED). It tokenises into overlapping
   3-character sequences, which makes `MATCH` behave like substring search and gives
   **partial** typo tolerance (a one-char typo still shares most trigrams).
   **Limitations [VERIFIED from <https://www.sqlite.org/fts5.html>]:**
   - Requires queries of **at least 3 characters**; shorter queries match nothing.
   - It's designed to make `LIKE` and `GLOB` fast on the indexed column — and D1 caps
     `LIKE`/`GLOB` patterns at **50 bytes** (§5A). Note [VERIFIED] **that cap does not apply
     to `MATCH`**, so trigram-via-`MATCH` is unconstrained; only a `LIKE` fallback would be.
   - It **does not rank by edit distance** — BM25 over trigrams is a crude proxy.
   - Index is substantially larger than a word tokenizer's.
   - Can't be combined with `porter` on the same column → you need a **second FTS table**
     (or a second column set) if you want both stemming and trigram. That's the practical
     shape: `files_fts` (unicode61+porter, primary) and `files_trgm` (trigram, name-only,
     used as a fallback ranker).
2. **Trigram on the *name* column only.** This is the pragmatic 80% answer: typos matter most
   for filenames ("orbit-manifets.txt"), and the name column is tiny, so the index bloat is
   irrelevant. Body typos are largely rescued by the vector half anyway.
3. **Client-side/JS fuzzy re-rank**: pull top-N by BM25 + vector, then compute
   Levenshtein/Jaro-Winkler in the Worker against `name` for the ~50 candidates. Cheap
   (50 short strings), no schema cost, and gives you *real* edit-distance ranking. But it only
   reorders things already retrieved — it can't *find* a file the retrievers both missed.
4. **`spellfix1`** — a loadable extension. **Not available on D1** (§8.2).
5. **Precomputed n-gram column**: no longer needed, since the real `trigram` tokenizer is
   confirmed available. Keep in mind only as a curiosity.

**Recommendation:** ship (2) — a **name-only `files_trgm` FTS5 table using
`tokenize="trigram"`**, queried as a third RRF source — plus (3) as a JS re-rank over the
fused top-N. Do **not** promise Levenshtein-quality fuzzy matching over file bodies.

### 5.7 If FTS5 were unavailable

Moot — **FTS5 is definitively available** (§5.1). Recorded only so nobody re-litigates it: the
fallback would have been a hand-rolled inverted index in ordinary tables
(`terms(term, file_id, tf)` + a `df` table, BM25 computed in SQL/JS), which is workable at 10k
files but strictly worse. Not needed.

---

## 6. Fusion ranking — RRF

*(This section is being cross-checked by a dedicated research pass; numbers below are the
well-established ones and will be re-confirmed with citations.)*

### 6.1 Why not normalise scores

BM25 returns an unbounded negative-ish score whose scale depends on corpus statistics, document
length and the number of query terms. Cosine similarity returns [-1, 1] (and in practice a
narrow band like 0.6-0.9 for a decent embedding model, because everything is somewhat similar
to everything). These are **not comparable**, and worse, **not stably comparable across
queries** — the BM25 range for a one-word query differs wildly from a five-word query.

Min-max normalising each list per-query "fixes" the range but introduces its own pathology: if
the keyword list has one great hit and nine terrible ones, min-max stretches the terrible ones
up to fill [0,1]. And a list with a single result normalises to... 1.0, or 0/0.

**RRF sidesteps all of it by throwing away the scores and using only the ranks.**

### 6.2 The formula

Cormack, Clarke & Buettcher, SIGIR 2009, *"Reciprocal Rank Fusion outperforms Condorcet and
individual Rank Learning Methods"* —
<https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf>:

```
RRFscore(d) = Σ over rankers r of   1 / (k + rank_r(d))
```

where `rank_r(d)` is d's 1-based rank in ranker r's list, and `k` is a constant, conventionally
**60**. Documents absent from a list simply contribute nothing for that ranker (equivalently,
rank = ∞).

**What `k` does.** It damps the influence of the very top ranks. With `k = 0`, rank 1 scores
1.0 and rank 2 scores 0.5 — a 2× cliff, so the #1 of either list almost always wins. With
`k = 60`, rank 1 scores 1/61 ≈ 0.0164 and rank 2 scores 1/62 ≈ 0.0161 — nearly equal, so what
actually drives the ranking is **appearing in both lists at all**. That consensus-seeking
behaviour is the entire point of RRF, and it's why it's so robust: a document that is #8 in
both lists beats a document that is #1 in one and absent from the other.

Larger `k` → flatter, more consensus-driven. Smaller `k` → sharper, more "trust the top hit".

**Production defaults [VERIFIED]:**

| System | Parameter | Default |
|---|---|---|
| **Elasticsearch** RRF retriever | `rank_constant` | **60** |
| Elasticsearch | `rank_window_size` (truncate each list before fusing) | 50 (examples use 50) |
| **OpenSearch** | rank constant | 60 |
| **Azure AI Search** hybrid | k | 60 (documented) |

Sources: <https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever>
("Defaults to `60`"), <https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion>.
Elastic's examples also frequently use `rank_constant: 1` for small demo corpora — a useful
reminder that **k should scale with how deep your lists are**. With adrive's ~50-deep lists,
60 is reasonable but arguably high; **k in the 10-60 range is worth A/B-ing**, and lower k
will make the top keyword hit more dominant (probably desirable for a file drive).

**Elasticsearch also supports per-retriever weights** [VERIFIED, same page], with exactly the
formula in §6.3:

> `rrf_score = weight_1 × rrf_score_1 + weight_2 × rrf_score_2 + ... + weight_n × rrf_score_n`

So the weighted variant used below is not a hack — it's the mainstream production design.

**`rank_window_size` matters**: Elastic truncates every retriever's list to the same depth
before fusing. Do the same (§6.4) — it's the thing that stops a long list from dominating.

### 6.3 Weighted RRF

Since adrive has an asymmetry (the keyword side is always available and always fresh; the
vector side is optional and eventually consistent), weight the rankers:

```
RRFscore(d) = Σ_r  w_r / (k + rank_r(d))
```

Suggested starting point: `w_keyword = 1.0`, `w_vector = 1.0` for general queries, but consider
boosting keyword when the query "looks lexical" (contains a dot-extension, a hyphen, quotes,
or is a single token that appears verbatim in a filename) — see §6.6.

### 6.4 Concrete TypeScript

```ts
export interface Ranked { readonly fileId: string }

export interface FusionInput {
  readonly results: readonly Ranked[]   // ALREADY sorted best-first, deduped by fileId
  readonly weight?: number              // default 1
}

export interface FusedHit {
  readonly fileId: string
  readonly score: number
  /** per-source 1-based rank, for debugging + UI ("matched: name, content") */
  readonly ranks: Readonly<Record<string, number>>
}

const RRF_K = 60

export function reciprocalRankFusion(
  sources: Readonly<Record<string, FusionInput>>,
  opts: { k?: number; limit?: number } = {}
): FusedHit[] {
  const k = opts.k ?? RRF_K
  const acc = new Map<string, { score: number; ranks: Record<string, number> }>()

  for (const [sourceName, { results, weight = 1 }] of Object.entries(sources)) {
    results.forEach((hit, i) => {
      const rank = i + 1                       // 1-based
      const contribution = weight / (k + rank)
      let entry = acc.get(hit.fileId)
      if (entry === undefined) {
        entry = { score: 0, ranks: {} }
        acc.set(hit.fileId, entry)
      }
      entry.score += contribution
      entry.ranks[sourceName] = rank
    })
  }

  const fused = [...acc.entries()]
    .map(([fileId, v]) => ({ fileId, score: v.score, ranks: v.ranks }))
    .sort((a, b) =>
      b.score - a.score ||
      // deterministic tie-break: prefer the one with the better single rank, then by id
      Math.min(...Object.values(a.ranks)) - Math.min(...Object.values(b.ranks)) ||
      (a.fileId < b.fileId ? -1 : 1)
    )

  return opts.limit === undefined ? fused : fused.slice(0, opts.limit)
}
```

Usage:

```ts
const fused = reciprocalRankFusion({
  keyword: { results: bm25Hits,  weight: 1.0 },
  vector:  { results: vectorHits, weight: 1.0 },
}, { limit: 50 })
```

**Notes on the implementation:**
- **Dedup to file level BEFORE fusing.** Vector hits are *chunks*; collapse them to one entry
  per `fileId` (§4) and re-rank, so `rank_vector` means "rank of the file", not "rank of a
  chunk". Otherwise a file with 40 chunks floods the list and RRF double-counts it.
- **Truncate each list to the same N before fusing** (N = 50 is a good default; Vectorize caps
  at 50 with metadata anyway). Unequal list lengths quietly bias RRF toward the longer list.
- A document in only one list still scores — it just gets one term. That's correct and is how
  RRF handles the vector index being cold/absent.
- The `ranks` map is genuinely useful in the UI: render "matched name" vs "matched content"
  vs "semantically similar" badges from it.

### 6.5 Alternatives and when they'd be better

- **Convex combination / alpha blending**: `score = α·norm(vec) + (1-α)·norm(bm25)`, α ≈ 0.5-0.7.
  Used by Weaviate (`relativeScoreFusion`) and many pgvector tutorials. Retains score
  *magnitude*, which RRF discards — so it can distinguish "great match" from "best of a bad
  lot". Requires a normalisation scheme and per-corpus tuning to work well. There is published
  work (Bruch et al., on fusion functions for hybrid retrieval) arguing convex combination with
  good normalisation beats RRF when you can tune it. **The tuning requirement is exactly what
  a self-hosted single-user app cannot supply**, which is why RRF is right here.
- **Score normalisation (min-max / z-score)**: same idea, more fragile per-query.
- **Cross-encoder rerank**: Workers AI has **`@cf/baai/bge-reranker-base`** at
  **$0.003/M input tokens / 283 neurons per M** [VERIFIED, workers-ai pricing page] — by far
  the cheapest model in the catalogue. Feeding the fused top-20 (query, filename+snippet) pairs
  into it would be a **big** relevance win for very little money, and it's the single best
  "phase 2" upgrade for this project. Latency cost: one extra model call.

### 6.6 Pragmatic additions on top of RRF

- **Exact-name shortcut**: if the raw query exactly equals (or is a prefix of) a file's display
  name, pin that file at rank 1 regardless of fusion. Users typing `orbit-manifest.txt` expect
  it first, always. This is a "boost", not a fusion input.
- **Tag exact-match boost**: a query token equal to a tag is a strong signal; add it as a third
  RRF source (`tags`) rather than hacking the score.
- **Recency tiebreak** only within near-equal scores, never as a primary sort.

---

## 7. Lifecycle: ids, cleanup, versioning, and failure without Queues

### 7.1 Vector ID scheme

Constraint: **vector id ≤ 64 bytes** [VERIFIED, §1.3]. A UUIDv4 is 36 chars.

**Recommended: `{fileId}:{versionSeq}:{chunkIndex}`**

```
7c9e6679-7425-40de-944b-e07fc1f90ae7:12:0007
└──────────── 36 ────────────────────┘ └2┘ └4┘   = 36+1+2+1+4 = 44 bytes ✔
```

- `versionSeq` = the monotonically increasing integer version number from D1 (not a UUID —
  a version UUID would push you to 77 bytes and **blow the 64-byte cap**).
- Zero-pad `chunkIndex` so ids sort naturally; 4 digits caps at 10k chunks/file, which is
  well past any sane per-file cap.
- Deterministic ⇒ **re-running the indexer is idempotent** (upsert overwrites in place).

**But do not rely on derivation alone for deletion.** Also keep an authoritative D1 mapping
table (`file_chunks`, §9). Reasons: you need the exact set of live ids to delete when chunk
counts shrink between versions, and you need something to reconcile against when D1 and
Vectorize drift. Vectorize's `list-vectors` op (added 2025-08-25, [VERIFIED §1.0]) lets a
periodic GC job enumerate the index and delete orphans that D1 doesn't know about.

### 7.2 The version transition (N chunks → M chunks)

The trap: v12 produced 40 chunks, v13 produces 25. Upserting v13's 25 vectors leaves **15
orphaned v12 vectors** that still match queries and point at stale content.

Because the id embeds `versionSeq`, v13's ids never collide with v12's — so the correct
sequence is a **full swap**, not an in-place update:

```
1. D1: INSERT new version row (versionSeq = 13), state = 'pending'
2. Extract text → chunk → embed
3. Vectorize.upsert(new vectors for v13)         // batched
4. D1: INSERT file_chunks rows for v13; mark file.index_state = 'ready',
       file.indexed_version = 13
5. Vectorize.deleteByIds(all vector_ids of v12)  // read from file_chunks
6. D1: DELETE file_chunks rows for v12
```

**Order matters.** Upsert-new *before* delete-old means the worst case is "both versions are
briefly searchable" (harmless — dedup to best chunk per file collapses them, §4), rather than
"file is briefly unsearchable". Given eventual consistency (§1.4) this window is minutes; a
delete-then-insert order would make the file vanish from semantic search for that whole window.

Also: because the D1 hydration step is authoritative, a stale v12 chunk hitting the result set
just resolves to the same `file_id` and gets rendered with current data. No stale content leaks.

### 7.3 Delete and purge

- **Soft delete (trash)**: set `deleted = 1` in D1. Do **not** try to synchronously fix
  Vectorize. The D1 hydration join filters it out immediately (§2's warning: the Vectorize
  metadata filter is an optimisation, never the correctness boundary). Optionally enqueue a
  metadata upsert for the GC job.
- **Purge / hard delete**: read `vector_id`s from `file_chunks` for the file → `deleteByIds`
  in batches → delete `file_chunks` rows → delete FTS rows → delete R2 objects.
- **Failure is expected**, so purge must be **re-drivable**: keep a `pending_vector_deletes`
  table (or a `purge_state` on the file row) so a partially-failed purge is retried by the
  cron rather than silently leaving orphans.
- **Backstop GC**: a weekly cron that pages through `list-vectors`, and for any vector id whose
  `file_id` prefix is absent from D1 (or whose `versionSeq` ≠ `files.indexed_version`), deletes
  it. This is the only thing that makes the system self-healing.

### 7.4 Failure handling without Queues

`ctx.waitUntil` has **no retry and no visibility** — if the isolate dies or the 30 s window
expires, the work is simply gone. So the durable state must live in D1, and something must
re-drive it. **Cron Triggers are the queue substitute** (5/account on Free, [VERIFIED §3A]).

Make the indexing job a **D1-backed state machine**:

```sql
-- on the files table (or a sidecar index_jobs table)
index_state        TEXT NOT NULL DEFAULT 'pending',
                   -- 'pending'|'extracting'|'embedding'|'ready'|'failed'|'skipped'|'unsupported'
index_version      INTEGER,          -- which versionSeq is currently indexed
index_cursor       INTEGER DEFAULT 0,-- next chunk index to embed (resumability)
index_attempts     INTEGER DEFAULT 0,
index_error        TEXT,
index_next_run_at  INTEGER           -- unix seconds, for exponential backoff
```

Flow:
1. **Upload request** (fast path): write file + version + FTS rows **synchronously**. The file
   is keyword-searchable the instant the response returns. Set `index_state='pending'`.
2. **`ctx.waitUntil`** (optimistic fast path): try to do extraction + chunk + embed + upsert
   right away. On success → `'ready'`. On failure or on hitting the chunk budget →
   write `index_cursor`/`index_error`, leave state `'pending'`, bump `index_next_run_at`.
3. **Cron trigger** (every 1-5 min, the durable path): `SELECT ... WHERE index_state IN
   ('pending','failed') AND index_attempts < 5 AND index_next_run_at <= now LIMIT k`. Resume
   from `index_cursor`. Exponential backoff: `next_run_at = now + 60 * 2^attempts`.
4. After 5 attempts → `'failed'` with the error text retained.

**Visibility** (the "how do you make it visible" half of the question):
- Expose `index_state` in the file list/detail UI: a small "indexing…" or "semantic index
  failed" affordance, plus a manual **Reindex** action that resets `attempts=0, cursor=0,
  state='pending'`.
- A tiny admin/health endpoint: counts by `index_state`, oldest `pending`, last cron run.
  For a single-user self-hosted drive this beats any log-scraping.
- Log the error string into `index_error` — not just `console.error`, which nobody reads.

**Degradation is the whole point:** `index_state = 'failed'` must never mean "file is lost".
It means "this file is findable by name/tag/keyword but not by meaning". That is a survivable
state, and it is the same state every file is in when the self-hoster has no Vectorize
binding at all (§9).


---

## 8. Alternatives to Vectorize on a CF-only stack

### 8.1 Embeddings as BLOBs in D1 + brute-force cosine in the Worker

**Mechanics.** Store each chunk's embedding as a `BLOB` (Float32Array bytes:
`dims * 4` bytes → 384-dim = **1,536 bytes**, 1024-dim = **4,096 bytes**). At query time:
`SELECT chunk_id, file_id, vec FROM chunk_vectors` → decode → cosine against the query vector
→ top-k. Normalise vectors at write time so cosine is just a dot product.

**Is it viable? Do the arithmetic against the verified limits.**

*CPU budget* [VERIFIED limits, INFERRED estimate]: Workers Paid gives **30 s CPU by default**
(up to 5 min); **Workers Free gives 10 ms**. A dot product of D dims is ~D multiply-adds. In
optimised JS over a `Float32Array`, [INFERRED] expect very roughly **100-500 M flops/s-ish**
for this access pattern — call it ~1-3 µs per 384-dim dot product including loop overhead.

| Chunks | Dims | Dot products | Est. CPU (compute only) | Free (10 ms)? | Paid (30 s)? |
|---|---|---|---|---|---|
| 1,000 | 384 | 1,000 | ~1-3 ms | **marginal** | easily |
| 10,000 | 384 | 10,000 | ~10-30 ms | **NO** | easily |
| 100,000 | 384 | 100,000 | ~100-300 ms | no | yes |
| 10,000 | 1024 | 10,000 | ~30-80 ms | no | yes |

**But CPU is not the binding constraint — data movement is.** 10,000 chunks × 1,536 bytes =
**15 MB** that must be read out of D1 and deserialised **on every single search**. Against the
verified limits that is brutal:
- **Rows read**: 10,000 rows per search. Free tier = 5 M rows read/day → **500 searches/day**
  and that's before any other query. Paid is fine (25 B/mo).
- **Deserialisation CPU** dwarfs the dot products — decoding 15 MB of BLOBs into typed arrays
  is the real cost, and it counts fully against CPU time.
- **128 MB isolate memory** — 15 MB is OK, 150 MB is not.
- D1 result serialisation happens inside the Workers CPU/memory limits ([VERIFIED] from the
  D1 limits page: *"Operations on a D1 database, including query execution and result
  serialization, run within the Workers platform CPU and memory limits"*).

**Verdict [INFERRED, but with high confidence given the verified numbers]:**
- **≤ ~2,000 chunks: genuinely viable on Workers Paid**, and a great no-dependency fallback.
- **~2,000-20,000 chunks: viable but wasteful** on Paid; add a cache (see below).
- **> ~20,000 chunks: don't.**
- **On Workers Free (10 ms CPU): not viable at any interesting scale.** This is the key
  finding — brute force is *not* the free-tier escape hatch people assume it is.

**Mitigations if you do it:** cache the whole matrix in a module-global `Float32Array` keyed by
a generation counter (isolates are reused, so most searches skip the D1 read entirely); or
store the matrix as **one packed R2 object** (a single fetch of a contiguous `Float32Array`
instead of 10k D1 rows — far cheaper on rows-read and much faster to decode); or quantise to
int8 (4× less data, ~1-2% recall loss).

**The R2-packed-matrix variant is genuinely attractive for adrive's scale** and worth
prototyping: one R2 GET of a few MB, decoded into a Float32Array, scanned in a few ms. It
sidesteps Vectorize's free-tier query-dimension pricing *and* its eventual consistency.

### 8.2 `sqlite-vec` in D1 — ✅ DEFINITIVELY NO (VERIFIED)

Two independent locks, both confirmed in the workerd source:

1. **The vtable authorizer allowlists only `fts5` and `fts5vocab`** (§5.1). `USING vec0(...)`
   returns `not authorized`. Full stop.
2. **No extension loading exists.** There is no `sqlite3_enable_load_extension` call anywhere
   in `sqlite.c++`. (`"load_extension"` does appear in `ALLOWED_SQLITE_FUNCTIONS`, which looks
   alarming but is inert — SQLite disables extension loading by default at the C-API level,
   and there is no filesystem to load a `.so` from.)

**Cloudflare has said so directly.** In cloudflare/agents#1472 (opened and closed May 2026), a
user's analysis that `vec0` would be rejected and loadable extensions unavailable was answered
by Cloudflare contributor mattzcarey:

> I would plan around using FTS5 in DOs and vectors in external providers (or Vectorize).

That is essentially an endorsement of the architecture in §9. Open community request:
<https://community.cloudflare.com/t/please-add-support-for-sqlite-vec-for-durable-objects-sql-storage-and-d1/786935>

### 8.3 Durable Objects with the SQLite storage backend

DO SQLite gives you a real SQLite database per object with synchronous, local queries —
attractive because a single-user drive maps perfectly onto **one DO**. You could hold the whole
vector matrix in DO memory (it's stateful, so no reload per request) and brute-force it with no
D1 rows-read cost at all.

**[VERIFIED] DO SQLite supports FTS5 exactly as D1 does** — the DO storage docs
(<https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>) carry *verbatim
the same wording* ("including `fts5vocab`") and both link the same workerd `sqlite.c++`
authorizer. Same engine, same answer. **sqlite-vec is equally unavailable there** (§8.2).

Two DO-specific notes [VERIFIED]:
- *"Writing data to [SQLite virtual tables] also counts towards rows written"* — FTS5 index
  maintenance is billable.
- **DO SQLite has NO export restriction.** Its PITR is bookmark-based and operates on the whole
  database. So the nasty `wrangler d1 export` + virtual-tables bug (§5.3b #1) **does not apply
  to DOs**. If FTS5-plus-reliable-backup matters a lot, a DO is the safer backend for the
  search index.

Even without sqlite-vec, the "**single DO holding an in-memory Float32Array of all embeddings**"
pattern is the strongest pure-CF alternative to Vectorize:
- No per-query dimension billing, no eventual consistency — **read-your-writes**.
- The matrix stays hot in the DO's memory between requests (subject to eviction).
- Costs: DO requests + duration, and 128 MB memory. 10k × 384-dim = 15 MB — fits comfortably.
- Downsides: cold starts must rebuild the matrix from storage; DOs are a paid-plan-flavoured
  product for most real use; single point of failure; and it's a lot of machinery to hand a
  self-hoster.

### 8.4 Honest recommendation for 100s-10,000s of files

**Use Vectorize.** At adrive's realistic scale it is GA, fast (31 ms P50), free-tier-available,
and costs ~$1-2/month on Paid. Building a bespoke vector store to save that is not a good
trade for a project where **search quality is the headline feature** — spend the complexity
budget on chunking, fusion and the keyword side instead.

**But architect the vector half behind an interface** (`VectorStore` port with
`upsert/query/delete`), because:
1. The **free-tier query-dimension economics are genuinely bad** at a few thousand vectors
   (§1.2) — some self-hosters will need an alternative.
2. `D1BlobVectorStore` (§8.1, with the R2-packed-matrix optimisation) is a ~150-line
   implementation that covers the "≤2,000 chunks, Workers Paid, no Vectorize" case and gives
   you **strong consistency** as a bonus.
3. It makes the "no vector search at all" mode (§9) fall out for free as a null implementation.

---

## 9. Recommended architecture for adrive

### 9.1 Shape in one paragraph

**D1 + FTS5 is the primary, always-on, strongly-consistent search engine. Vectorize is an
optional recall booster fused in via RRF.** Every file is findable by name/tag/content keyword
the instant its upload request returns. Semantic search arrives seconds later and can be turned
off entirely — by config, by a missing binding, or by a failed embedding — without any
degradation in the primary path. This ordering is forced by three verified facts: Vectorize is
eventually consistent (§1.4), its free-tier query budget collapses as the index grows (§1.2),
and it's an ANN index with ~95% precision (§1.0).

### 9.2 D1 schema sketch

```sql
-- ── source of truth ────────────────────────────────────────────────
CREATE TABLE files (
  id                TEXT PRIMARY KEY,              -- uuid
  display_name      TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  kind              TEXT NOT NULL,                 -- 'text'|'markdown'|'code'|'csv'|'binary'
  current_version   INTEGER NOT NULL,
  size_bytes        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,                       -- soft delete
  -- indexing state machine (§7.4)
  index_state       TEXT NOT NULL DEFAULT 'pending',
  indexed_version   INTEGER,
  index_cursor      INTEGER NOT NULL DEFAULT 0,
  index_attempts    INTEGER NOT NULL DEFAULT 0,
  index_error       TEXT,
  index_next_run_at INTEGER
);
CREATE INDEX idx_files_live    ON files(deleted_at, updated_at DESC);
CREATE INDEX idx_files_pending ON files(index_state, index_next_run_at);

CREATE TABLE file_versions (
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  text_content TEXT,          -- extracted text, TRUNCATED (see §5.3b #3 — keep well under 100KB
                              -- per FTS row; store full text in R2 if needed)
  PRIMARY KEY (file_id, version)
);

CREATE TABLE tags      (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE file_tags (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);
CREATE INDEX idx_file_tags_tag ON file_tags(tag_id);

-- ── vector bookkeeping (authoritative map, §4.5/§7.1) ──────────────
CREATE TABLE file_chunks (
  vector_id  TEXT PRIMARY KEY,            -- '{fileId}:{version}:{ordinal}'  ≤64 bytes
  file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  ordinal    INTEGER NOT NULL,
  char_start INTEGER NOT NULL,            -- slice back into text_content for snippets
  char_end   INTEGER NOT NULL
);
CREATE INDEX idx_chunks_file ON file_chunks(file_id, version);

-- re-drivable deletes, because waitUntil has no retries (§7.3)
CREATE TABLE pending_vector_deletes (
  vector_id TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL
);

-- ── FTS5: primary keyword index ────────────────────────────────────
-- Standalone (not external-content): the indexed doc is a COMPOSITION of
-- name + tags + body, which has no 1:1 base row. Chunk-grained so no single
-- indexed value approaches the ~100KB corruption threshold (§5.3b #3).
CREATE VIRTUAL TABLE files_fts USING fts5(
  name,
  tags,
  body,
  file_id  UNINDEXED,
  chunk_no UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);

-- ── FTS5: trigram index over names only, for typo tolerance (§5.6) ─
CREATE VIRTUAL TABLE files_trgm USING fts5(
  name,
  file_id UNINDEXED,
  tokenize = "trigram"
);
```

Notes:
- Consider a **second FTS5 table with `tokenize="porter unicode61"`** if stemming matters
  ("projections" matching "projection"). Porter can't be combined with trigram on one column.
  Start without it; add if evaluation shows a gap.
- `files_fts` is **chunk-grained**: one row per chunk, with name+tags repeated on the chunk-0
  row only (or on all rows, weighted). This keeps rows small and lets BM25 do passage-level
  matching, mirroring the vector side.

### 9.3 Vectorize index config

```bash
wrangler vectorize create adrive-chunks --dimensions=384 --metric=cosine
# metadata indexes MUST exist before the first insert (§2) — max 10, 64-byte values
wrangler vectorize create-metadata-index adrive-chunks --property-name=file_id --type=string
wrangler vectorize create-metadata-index adrive-chunks --property-name=deleted --type=boolean
wrangler vectorize create-metadata-index adrive-chunks --property-name=kind    --type=string
```

`--dimensions` must match the configured embedding model and **cannot be changed later**.
384 for `bge-small-en-v1.5` (free-tier friendly); 1024 for `bge-m3` (better quality).

```jsonc
// wrangler.jsonc
{
  "d1_databases": [{ "binding": "DB", "database_name": "adrive" }],
  "r2_buckets":   [{ "binding": "BUCKET", "bucket_name": "adrive" }],
  "ai":           { "binding": "AI" },                       // optional
  "vectorize":    [{ "binding": "VECTORIZE", "index_name": "adrive-chunks" }], // optional
  "triggers":     { "crons": ["*/2 * * * *"] }
}
```

### 9.4 Upload-time indexing flow

```
POST /upload
├─ SYNCHRONOUS (in the request, must be fast + must not fail)
│   ├─ R2.put(object)
│   └─ D1.batch([
│        INSERT files, INSERT file_versions,
│        INSERT file_tags,
│        INSERT files_fts (name, tags, body='')   ← findable NOW
│        INSERT files_trgm (name)
│      ])
│   └─ return 200 { id, index_state: 'pending' }
│
└─ ctx.waitUntil(...)   // ~30s budget, no retries (§3A)
    ├─ extract text (R2 get → decode → strip)
    ├─ D1: UPDATE file_versions SET text_content = ?
    ├─ chunk (§4.2)  → cap at N chunks
    ├─ D1.batch: UPDATE/INSERT files_fts body rows  ← full-text findable NOW
    ├─ if (no AI binding || no VECTORIZE binding || !config.semanticSearch)
    │     → UPDATE files SET index_state='skipped'; DONE      ← graceful degradation
    ├─ AI.run(model, { text: chunks.map(withTitlePrefix) })   ← ONE batched call
    ├─ VECTORIZE.upsert(vectors)                              ← ONE batched call
    ├─ D1.batch: INSERT file_chunks; UPDATE files SET index_state='ready', indexed_version=v
    └─ on ANY failure → UPDATE files SET index_error=?, index_next_run_at=?, attempts=attempts+1
                        (state stays 'pending' → cron picks it up, §7.4)

CRON (*/2)
    ├─ SELECT ... WHERE index_state IN ('pending','failed')
    │      AND index_attempts < 5 AND index_next_run_at <= now LIMIT 5
    ├─ resume from index_cursor  (large files span multiple cron runs)
    ├─ drain pending_vector_deletes
    └─ (weekly) GC pass: list-vectors → delete orphans not in file_chunks
```

The critical property: **the synchronous block contains no AI, no Vectorize, and no network
calls that can fail in ways that matter.** Upload never fails because embedding failed.

### 9.5 Query-time flow

```ts
async function search(q: string, opts: SearchOpts): Promise<SearchResult[]> {
  const parsed = parseQuery(q)   // sanitised FTS5 string (§5.5) + detected filters

  // 1. Fire all retrievers in parallel. Vector side is best-effort.
  const [keyword, trigram, vector] = await Promise.all([
    keywordSearch(parsed, 50),                       // D1 FTS5 + bm25()
    parsed.terms.length ? trigramSearch(parsed, 30) : [],
    semanticSearch(q, 50).catch(() => []),           // ← NEVER let this break search
  ])

  // 2. Collapse chunk-level hits to file-level, MAX pooling (§4.4)
  const kw  = collapseToFiles(keyword)
  const vec = collapseToFiles(vector)

  // 3. Fuse (§6.4)
  const fused = reciprocalRankFusion({
    keyword: { results: kw,      weight: 1.0 },
    trigram: { results: trigram, weight: 0.5 },   // fuzzy is a weaker signal
    vector:  { results: vec,     weight: 1.0 },
  }, { limit: 50 })

  // 4. Hydrate from D1 — THIS is the authoritative filter (§2)
  //    ⚠️ batch ids ≤100 per query (D1 bound-param limit, §5A)
  const files = await hydrate(fused.map(f => f.fileId), { excludeDeleted: true, ...opts })

  // 5. Boosts + presentation
  return applyExactNameBoost(q, joinPreservingOrder(fused, files))
}

async function semanticSearch(q: string, topK: number): Promise<Ranked[]> {
  if (!env.AI || !env.VECTORIZE || !config.semanticSearch) return []   // ← the off switch
  const { data } = await env.AI.run(config.embedModel, { text: [q], pooling: 'cls' })
  const res = await env.VECTORIZE.query(data[0], {
    topK,
    returnMetadata: 'indexed',          // no latency overhead (§1.5)
    filter: { deleted: false },         // optimisation only, not the security boundary
  })
  return res.matches.map(m => ({
    fileId: String(m.metadata?.file_id ?? m.id.split(':')[0]),  // fallback: derive from id
    score: m.score,
  }))
}

/** MAX pooling: best chunk wins, then re-rank files by that score (§4.4). */
function collapseToFiles(hits: readonly ChunkHit[]): Ranked[] {
  const best = new Map<string, number>()
  for (const h of hits) {
    const prev = best.get(h.fileId)
    if (prev === undefined || h.score > prev) best.set(h.fileId, h.score)
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([fileId]) => ({ fileId }))
}
```

Latency budget [INFERRED from verified numbers]: embed query ~50-150 ms ∥ D1 FTS5 ~5-20 ms;
Vectorize ~30-80 ms; hydrate ~10 ms. **Total ~150-250 ms**, dominated by the query embedding.
If that's too slow, cache query embeddings in KV keyed by the normalised query string — search
queries repeat a lot.

### 9.6 Graceful degradation — the whole vector half is optional

**Yes, completely.** This is a first-class mode, not an afterthought:

| Condition | Behaviour |
|---|---|
| No `VECTORIZE` binding in wrangler config | `semanticSearch()` returns `[]`; RRF fuses one list; results identical to pure BM25 ranking |
| No `AI` binding (and no external embedder configured) | same |
| `config.semanticSearch = false` | same, explicitly |
| Vectorize quota exhausted / throws | `.catch(() => [])` — search still returns |
| Individual file's embedding failed | that file is keyword-findable only; `index_state='failed'` visible in UI |
| Vectorize eventually-consistent lag | new file is keyword-findable immediately, semantically findable seconds later |

**Why RRF makes this free:** with one input list, `Σ w/(k+rank)` is monotonic in rank, so the
fused order **is** the keyword order. No special-casing, no branch — the degraded path is the
same code path.

Recommend a three-valued config rather than a boolean:
`semanticSearch: 'off' | 'auto' | 'required'`, where `'auto'` (the default) enables it iff both
bindings are present. A self-hoster who just doesn't add the bindings gets a fully working
keyword drive with zero configuration and zero errors.

### 9.7 Build order

1. **D1 + FTS5 keyword search, with proper query sanitisation and BM25 column weights.**
   This alone is a good file drive. Ship it.
2. Trigram name index + JS edit-distance re-rank (typo tolerance).
3. RRF fusion harness with a single source (proves the seam, no behaviour change).
4. Chunking + Workers AI + Vectorize behind the `VectorStore` port; add as a second RRF source.
5. Cron reconciliation + GC + `index_state` UI.
6. *(later)* `@cf/baai/bge-reranker-base` cross-encoder over the fused top-20 — cheapest
   quality win available (§6.5).

### 9.8 Pre-build verification checklist

Cheap experiments that de-risk the remaining unknowns:

- [ ] `SELECT sqlite_version();` on D1 — confirm 3.47.0 as the source implies.
- [ ] Create both FTS5 tables (`unicode61` and `trigram`) on a scratch D1; confirm `bm25()`,
      `highlight()`, `snippet()`, prefix `foo*`, and case-insensitivity.
- [ ] Confirm `wrangler d1 migrations apply` handles the virtual-table migration.
- [ ] **Measure actual write→read visibility on Vectorize** for a single ~20-vector upsert.
      The docs say "a few seconds" (§1.4); get a real number, it drives the UX copy.
- [ ] Confirm the embedding model's true output dims via `shape` (§3.1) and that
      `VECTORIZE.describe()` agrees.
- [ ] Check whether `list-vectors` is on the **Workers binding** or CLI/REST-only (§1.5) —
      determines how the GC job is written.
- [ ] Time a `waitUntil` indexing run on a large file to calibrate the per-run chunk budget.
- [ ] Verify Time Travel restore works on a DB containing FTS5 tables (§5.3b #1).

---

## Appendix: claim confidence summary

| Claim | Status |
|---|---|
| Vectorize is GA (2024-09-26), v2, v1 deprecated | **VERIFIED** |
| Vectorize works on Workers Free (30M queried / 5M stored dims) | **VERIFIED** |
| Vectorize is eventually consistent; "a few seconds" typical, minutes-to-hours if unbatched | **VERIFIED** (no SLA published) |
| Vectorize P50 query ~31 ms, ~95% precision | **VERIFIED** (CF's own benchmark) |
| Max 1536 dims, 64-byte ids, 10 KiB metadata, topK≤50 w/ metadata, 10 metadata indexes, 64-byte indexed values | **VERIFIED** |
| Filters: `$eq $ne $in $nin $lt $lte $gt $gte`, implicit AND, no `$or`, no array membership | **VERIFIED** |
| Metadata indexes must exist before insert | **VERIFIED** |
| Workers AI: 10k neurons/day free on both plans; bge-small = 384 dims / 512 tokens | **VERIFIED** |
| bge-m3 / embeddinggemma / qwen3 output dims | **INFERRED** — read `shape` at runtime |
| Workers AI embedding latency | **UNKNOWN** — not published |
| **D1 supports FTS5 virtual tables** | **VERIFIED** ×3 (docs, workerd source, CF's own tests) |
| **D1 SQLite is 3.47.0; `unicode61`/`ascii`/`trigram`/`porter` all available** | **VERIFIED** (workerd MODULE.bazel + fts5_tokenize.c) |
| `bm25()`, `highlight()`, `snippet()`, `match` available on D1 | **VERIFIED** (workerd allowlist + tests) |
| Triggers work on D1 (depth 10; no TEMP triggers) | **VERIFIED** (workerd authorizer) |
| **`wrangler d1 export` fails on DBs with virtual tables; can wedge the DB** | **VERIFIED** (docs + workers-sdk#9519) |
| FTS5 `integrity-check` corrupts D1 shadow tables; >100KB values corrupt too | **VERIFIED** (emdash-cms#252, #1130) |
| Time Travel works with virtual tables | **INFERRED** — docs silent; verify |
| **sqlite-vec / loadable extensions: NOT supported on D1 or DO** | **VERIFIED** (authorizer allowlist + CF staff reply) |
| DO SQLite = same FTS5 support, but no export restriction | **VERIFIED** |
| Workers Free: 10 ms CPU, 50 subrequests; `waitUntil` ≤30 s | **VERIFIED** |
| D1: 2 MB row, 100 bound params, 50-byte LIKE/GLOB (not MATCH), single-threaded | **VERIFIED** |
| Brute-force cosine viability thresholds (~2k chunks Paid, not viable Free) | **INFERRED** — arithmetic over verified limits; benchmark before relying on it |
| RRF formula and k=60 convention | **VERIFIED** (Cormack et al. SIGIR 2009) |
| MaxP > SumP/AvgP for passage→document aggregation | **VERIFIED** (IR literature; ES defaults to max) |
