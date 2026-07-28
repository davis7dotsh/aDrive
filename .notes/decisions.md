# adrive — locked decisions

Answers from the scoping phases. These are the product contract; change them
deliberately, not incidentally.

## Product

| Decision | Choice |
|---|---|
| Versioning | **Full history.** Append-only immutable versions, `?v=N` selects historical. Stable URL always resolves newest. Versions can't be individually deleted. |
| Organization | **Tags only.** No folders. No custom key=value metadata — tags do that job. |
| Search depth | **Metadata + extracted text of text-ish files** (md, txt, json, csv, source, html). Size-capped. No PDF. |
| Search type | **Hybrid: vector + keyword.** Embeddings generated per file on upload, fused with SQLite keyword search via Reciprocal Rank Fusion. Semantic recall *and* exact-filename precision. |
| Trash | **Yes.** Soft delete + restore window + purge. |
| File TTL | **Yes.** Upload with expiry, swept. |
| Download counts | **Yes.** Deduped per logical request so range requests don't inflate. |
| Custom metadata | **No.** Cut for simplicity. |

## URLs & hosting

| Decision | Choice |
|---|---|
| File URL | `/f/{uuid}` — full UUID. |
| Topology | **One Worker, host-gated routes.** Dashboard host + content host on the same deploy; pre-router host check, 421 on mismatch. |
| Content origin | **Separate hostname**, cookie-less. All bytes and all sites served from it. |
| HTML | **All HTML is public**, whether a site or a lone `.html` file. Uploading HTML forces public with a clear message. |
| HTML files | A lone `.html` file **renders**, same as a site. |
| Sites | **Always public.** |

> Consequence worth keeping in mind: because no HTML is ever private, the grant
> system never has to serve executable bytes, and there is no
> cookie-on-the-content-origin path to build. Private files are only ever
> downloaded or previewed as inert content.

## Auth

| Decision | Choice |
|---|---|
| Model | Deployment-based. One `PASSCODE` env var; API keys minted from the dashboard. No users. |
| CLI login | **Device flow** + a **headless mode** that prints a URL you can open on any machine. |
| Key scopes | **One level — full access.** The passcode already grants everything on a single-user instance; scopes would be theater. |

## Uploads

| Decision | Choice |
|---|---|
| Protocol | **Single-shot now, multipart-ready schema.** Design the endpoint + tables so multipart drops in later with no data migration and no CLI protocol break. |
| Per-file cap | **~100 MB**, set by the Workers request-body limit — *not* by R2 (which allows 5 GiB single-part, 50× more). Enforce from `Content-Length` before reading a byte; **411** if absent. |
| Sites | **CLI walks the directory**, uploads each asset, then commits a manifest. No archives, no unzip in the Worker. |
| Site detection | **Explicit** — `adrive site put ./dist` / `--site`. No surprising behavior from path shape. |
| Site versions | **Versioned, only newest servable.** Each republish records a version row (audit trail of what changed when), but the prior asset set is deleted from R2. Storage stays bounded; `?v=N` is not servable for sites. |
| Limits | **Per-file cap only**, configurable via env. No total-storage quota, no reservation/accounting logic. |
| Extraction | **`ctx.waitUntil` per file** — fires on upload, runs in background, snappy response. No Queues. `waitUntil` is **30 s wall clock with no retries**, so durable state lives in a D1 state machine (`index_state`/`attempts`/`next_run_at`) re-driven by a **Cron Trigger** as the queue substitute. |

## UI / CLI

| Decision | Choice |
|---|---|
| Design | **Clean and neutral.** System font, whitespace, subtle borders, one accent, small radii. Minimal. |
| CLI scope | stdin/stdout piping, global `--json`, tag management. **No MCP server** for now. |
| CLI success output | Confirmation line, **share URL alone on its own line**, then a dim detail line (id / size / visibility / tags). URL is positionally parseable. |
| Tags | **Free-form, auto-created on use.** Case-insensitively deduped (`Report` == `report`), display capitalization preserved. |
| Tag filtering | **OR** — a file matches if it has *any* selected tag. Adding tags broadens. |
| Search UX | **Live, debounced (~200ms).** URL stays in sync via Runed `useSearchParams` so results are shareable and back works. Needs a monotonic run counter so a slow response can't overwrite a newer one. |
| Default visibility | **Public.** Uploading is for sharing, so the link works immediately. `--private` opts out. |

## Stack (given)

SvelteKit on Cloudflare Workers · Tailwind v4 · Effect v4 (generator syntax
throughout; `Effect.runPromiseExit` only at endpoint/remote-function entry
points) · Effect v4 CLI module · D1 via `@effect/sql-d1` · R2 · Runed for
client-side URL search params · TypeScript 7 · Prettier, no ESLint · checks via
Effect LSP + svelte-check + tsc.

### Stack facts (verified by installing the betas and compiling probes)

Full detail in `.notes/stack-research.md`.

- **Effect v4 is `4.0.0-beta.102`.** `npm i effect` installs **v3** — pin explicitly.
- **CLI/SQL/HTTP moved into core.** `@effect/cli`, `@effect/sql`, `@effect/platform`
  have *no* v4 release. Use `effect/unstable/cli`, `effect/unstable/sql`,
  `effect/unstable/http`. Separate packages that do have v4 betas:
  `@effect/sql-d1`, `@effect/platform-node`, `@effect/vitest`.
- **D1 has no transactions, and it fails as a defect.** The driver calls
  `Effect.die(...)` — `withTransaction` produces a `Die`, not a typed failure, so
  the typechecker won't catch it. Use D1 native `batch()` (sequential, full
  rollback on failure). Matters for the purge state machine and version commit.
  Streaming queries are also unsupported.
- **Migrations: Wrangler, not Effect's Migrator.**
- **Per-request layers are cheap.** `D1Client.make` does no I/O. Pattern:
  `Layer.unwrap(Effect.map(Db, db => D1.layer({ db })))`. Note `Db.asEffect()`
  does not exist.
- **Effect Schema is not Standard Schema natively** — remote function args need
  `Schema.toStandardSchemaV1()`.
- **Trap:** `Cause.findDefect` returns a `Result` (`.success`); `findErrorOption`
  returns an `Option` (`.value`). Mixing them is a silent bug.

### Tooling deviations from the original spec

Two things don't work as specified; both are forced, not preferences.

- **`@effect/language-service` refuses to run on TS 7** → use **`@effect/tsgo`**.
- **`svelte-check` hard-crashes on a TS-7-only install.** Working setup: keep
  `typescript` at **6.x**, add TS 7 as `@typescript/native@npm:typescript@7`, run
  `svelte-check --tsgo`. A TS-7-*only* project is not possible today.

### v3 knowledge that is now wrong

`Effect.gen` adapter gone · `Effect.Service`/`Context.Tag` → `Context.Service` ·
no `Layer.scoped` · `Cause` is a flat `reasons` array ·
`Schema.minLength` → `.check(Schema.isMinLength(...))` ·
`Schema.Date` rejects ISO strings.

## Search architecture

Full detail in `.notes/search-research.md`. Two tiers, fused.

**Tier 1 — D1 + FTS5 (primary, always on, synchronous, strongly consistent).**
FTS5 *is* supported on D1 — verified three ways (CF supported-extensions docs, the
workerd SQL authorizer source allowlisting exactly `fts5`/`fts5vocab`, and CF's own
`sql-test.js`). SQLite **3.47.0**, so **`porter` and `trigram` tokenizers are both
available** — this recovers the typo tolerance we thought we'd lost leaving
Postgres/`pg_trgm`. `bm25()`, `highlight()`, `snippet()` all verified.

**Tier 2 — Vectorize (optional booster).** GA, on the Free plan, 31 ms P50.
Fused into tier 1 by Reciprocal Rank Fusion.

**Fusion — RRF**, `Σ w_r/(k + rank_r(d))`, `k=60` (the Elasticsearch/OpenSearch/Azure
default). Truncate lists to equal depth; dedup chunks→files *before* fusing.
**With one input list RRF is monotonic in rank, so the keyword-only path is the
exact same code — no branch.** That's what makes tier 2 cleanly optional.

### Why Vectorize must stay optional

Billing is `(stored_vectors + queries) × dimensions` — **every query is billed as
if it scanned the whole index**. At ~13k stored 384-dim vectors that's ~5M queried
dims *per search* against the 30M/month free cap: about **6 searches/month**.
A self-hoster on Free cannot rely on it. Config: `'off' | 'auto' | 'required'`,
defaulting to auto-detect bindings.

### Vector-side constraints that shape the design

- **Eventually consistent** — upserts "typically take a few seconds"; docs warn
  unbatched writes can take **over an hour**. So *upload-then-immediately-search is
  broken for the vector half* — tier 1 must carry that case, which it does, since
  metadata and text index synchronously.
- **Tags cannot be filtered in Vectorize** — no array-membership operator. Tag
  filtering happens in D1 regardless.
- Vector id scheme `{fileId}:{versionSeq}:{ordinal}` = 44 bytes; the id cap is
  **64 bytes**, so a version *UUID* would overflow it.
- Metadata indexes must exist **before first insert**, max 10, only the first
  64 bytes of a string are indexed.
- Upsert-new-then-delete-old on re-version.

### Embeddings & chunking

Workers AI, free on both plans (10k neurons/day ≈ 5M+ tokens — a non-issue here).
`bge-small-en-v1.5` (384 dims / 512 tokens). Use `pooling: "cls"`; read dims from
the response `shape` rather than hardcoding. Chunk at **400–600 tokens with 10–15%
overlap**, prefix each chunk with the filename before embedding, and collapse
chunks→files with **MAX pooling**.

### Landmines to design around

- **`wrangler d1 export` cannot back up a DB containing virtual tables**, and a
  failed export can wedge the DB (workers-sdk#9519).
- FTS5 `integrity-check` **corrupts** D1 shadow tables. Never run it.
- FTS5 indexed values >100 KB corrupt too — chunk before indexing.
- **D1 caps any TEXT value *and* the whole row at 2 MB** — so no one-blob-per-file.
  Chunk across rows; keep full text in R2.
- **D1 allows only 100 bound params per statement** — 30 chunks × 4 columns = 120,
  which overflows. Batch inserts must be sized against this.
- `sqlite-vec` is impossible on D1 *and* Durable Objects (authorizer allowlist).

## Cloudflare limits that shape the build

Full detail in `.notes/cf-limits.md`.

- **Request body: 100 MB** (Free/Pro), 200 MB Business, 500 MB Enterprise. This keys
  off the **zone plan, not the Workers plan** — buying Workers Paid does *not* raise
  it. Sets our per-file cap.
- **R2 is never the bottleneck**: 5 GiB single-part PUT, 50× the Workers limit.
- **CPU: 10 ms Free / 30 s Paid.** A 3,000× gap. Streaming uploads/downloads are I/O
  and fine on Free; it's the extraction/embedding pipeline that dies there — another
  reason the AI path must be flag-gated.
- **Memory: 128 MB per isolate**, shared across concurrent requests. Two concurrent
  buffered 100 MB uploads OOM. Stream to R2 — never buffer.
- **Subrequests: 50 external + 1,000 internal on Free** (R2 and D1 both count against
  the internal pool; D1's own docs still say 50 queries/invocation, so plan against 50).
  Only **6 simultaneous connections** — pool the puts when uploading a 50-asset site.
  Embed a whole file's chunks in **one `AI.run()` with an array**, not N calls.
- **R2 streaming still requires a known length.** Validate `Content-Length` first
  (**411** if absent — this is also where the size cap is enforced, before reading a
  byte), then `new FixedLengthStream(size)`, kick off `pipeTo` *without awaiting*, and
  `Promise.all([put(readable), pumped])`. Awaiting the pipe first deadlocks.
  All three workers-sdk issues on this are still open.

## Carried over from Columbia (worth keeping)

- Denormalized `search_text` column; FTS OR'd with fuzzy matching for free typo tolerance.
- Content origin is cookie-less; non-previewable types forced to `attachment`;
  `nosniff` + restrictive CSP on all served bytes.
- Purge as a state machine (`none → pending → done|failed`) so a failed R2 delete
  never lets the DB claim bytes were freed.
- Server-generated opaque R2 keys — no user data in the key.
- Idempotency keys on upload create + complete, stored separately.
- CLI: stdout is results only, progress to stderr; credentials at `0600` in XDG dirs.

## Known Columbia gaps to fix

- **Add a copy-link button.** Drive had none anywhere; the share affordance was
  "the URL in your address bar." Feature #3 says share links must be easy.
- Don't hardcode `application/octet-stream` in the CLI — sniff content type.
- Don't duplicate the preview allowlist across modules; it drifts.
