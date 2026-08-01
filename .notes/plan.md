# adrive — implementation plan

## Context

`adrive` ("agents drive") is a new, self-hosted file drive designed to be run as a
private single-tenant instance — not a service I host for customers. The need: a
place for agents and scripts to put files via CLI or API, get a share link back
immediately, and find things later without folder hierarchies. Columbia Drive and
Columbia Pages are the inspiration, not the source; this is a from-scratch rebuild
on a different stack with a deliberately smaller feature surface.

Seven things it must do: upload any file over CLI or API; view files in a dashboard;
get a share link from any surface; public/private visibility; serve uploaded static
HTML projects as real sites; deployment-based auth (one passcode + minted API keys,
no user accounts); tags instead of folders; and genuinely good search.

The repo is empty — `main` with no commits. Everything below is greenfield.

**Simplicity is the north star.** Minimal clean UI, a CLI that's pleasant to use,
and the smallest service graph that does the job.

### Supporting research (read the relevant one before implementing an area)

| File | What it settles |
|---|---|
| `.notes/decisions.md` | The locked product contract — every scoping answer |
| `.notes/stack-research.md` | Effect v4 + SvelteKit + D1, verified by installing betas and compiling probes |
| `.notes/search-research.md` | Hybrid search design, 81 verified claims |
| `.notes/cf-limits.md` | Cloudflare limits governing the upload path |

---

## Product contract (locked)

- **Files** have a UUID URL `/f/{uuid}`, full append-only version history (`?v=N`),
  tags, and one `public` boolean. No folders, no custom metadata.
- **All HTML is public**, whether a site or a lone `.html` file — uploading HTML
  forces public. This is the single most simplifying decision in the project:
  the grant system never serves executable bytes, and there is no
  cookie-on-content-origin path to build.
- **Sites** upload as a walked directory behind an explicit `adrive site put ./dist`.
  Versioned for audit, but **only the newest version is servable**; prior asset sets
  are deleted from R2 so storage stays bounded.
- **Default visibility is public** (`--private` opts out). Tags are free-form and
  auto-created; tag filters are **OR**.
- **Trash + restore**, **file TTL**, and **download counts** are all in scope.
- **Per-file cap ~100 MB**, set by the Workers request-body limit — *not* by R2,
  which allows 5 GiB. No total-storage quota.
- **Auth**: one `PASSCODE` env var, plus minted API keys at a single full-access
  level. CLI logs in via **device flow with a headless mode** that prints a URL
  approvable from any machine.

---

## Stack

SvelteKit on Cloudflare Workers · Tailwind v4 · Effect v4 `4.0.0-beta.102`
(generator syntax throughout, `Effect.runPromiseExit` only at entry points) ·
D1 via `@effect/sql-d1` · R2 · Runed for client URL state · Prettier, no ESLint.

### Repo layout — pnpm monorepo

```
adrive/
├── apps/web/                 SvelteKit app (the only deployable)
│   ├── src/lib/server/       Effect services, programs, layers
│   ├── src/routes/           dashboard routes + content routes
│   ├── migrations/           wrangler D1 migrations
│   └── wrangler.jsonc
├── packages/shared/          protocol types + schemas, imported by both
├── packages/cli/             the `adrive` CLI
└── pnpm-workspace.yaml
```

`shared` holds the wire schemas so the CLI and server can't drift. The CLI's deps
are light because Effect v4 core contains the CLI module.

### Verified stack facts that change how this is written

Confirmed by installing the betas and compiling probe code, not from docs:

- **`npm i effect` installs v3.** Pin `4.0.0-beta.102` explicitly.
- **CLI/SQL/HTTP live in core**: `effect/unstable/cli`, `effect/unstable/sql`,
  `effect/unstable/http`. `@effect/cli`, `@effect/sql`, `@effect/platform` have
  **no v4 release** — do not install them.
- **D1 has no transactions, and `withTransaction` is a `Die`, not a typed error** —
  the typechecker will not stop you. Use the raw binding's `db.batch()`, which
  Cloudflare documents as sequential with full rollback. Add a CI grep for it.
- **`sql.stream()` also dies.** Page with LIMIT/keyset instead.
- **Per-request layers are cheap** — `D1Client.make` does no I/O. Pattern:
  `Layer.unwrap(Effect.map(Db, (db) => D1.layer({ db })))`. `Db.asEffect()` does
  not exist; `Effect.map(Db, …)` is the form that compiles.
- **`Effect.gen` adapter is gone** — zero-arg generator, direct `yield*`.
- **`Context.Service` class style**, not `Effect.Service`/`Context.Tag`.
- **No `Layer.scoped`** — use `Effect.acquireRelease` inside `Layer.effect`.
- **`Schema.TaggedErrorClass`**, not v3's `Schema.TaggedError`.
- **Effect Schema is not Standard Schema natively** — remote-function args need
  `Schema.toStandardSchemaV1(…)`.
- **Remote functions are still experimental** — opt in via
  `compilerOptions.experimental.async` and `kit.experimental.remoteFunctions`.
- **`form` schemas reject non-optional booleans** — checkbox fields must be
  `Schema.optionalKey(Schema.Boolean)`.
- **CLI v4 renames**: `Options`→`Flag`, `Args`→`Argument`, and
  `Command.withSubcommands` takes **an array**, not varargs.
- **Asymmetry that causes silent bugs**: `Cause.findDefect` returns a `Result`
  (`.success`); `Cause.findErrorOption` returns an `Option` (`.value`).

### Tooling deviations (forced, not preferences)

- **`@effect/language-service` refuses to run on TS 7** → use **`@effect/tsgo`**
  (a real CI gate: verified exit 1 on a floating-Effect canary, 0 when clean).
- **`svelte-check` hard-crashes on a TS-7-only install.** Working setup: keep
  `typescript` at **~6**, add TS 7 as `@typescript/native@npm:typescript@7`, run
  `svelte-check --tsgo`. A TS-7-only project is not currently possible.

```jsonc
"check": "svelte-kit sync && pnpm check:types && pnpm check:effect && pnpm check:svelte",
"check:types":  "tsc --noEmit",
"check:effect": "effect-tsgo diagnostics --project tsconfig.json --format pretty",
"check:svelte": "svelte-check --tsconfig ./tsconfig.json --tsgo"
```

Gitignore `.svelte-check/` — a stale cache there reports errors for deleted files.

---

## Architecture

### Two origins, one Worker

A dashboard host and a **cookie-less content host** share one deploy, gated by a
pre-router host check in `hooks.server.ts`. Content-host requests may only reach
content routes; dashboard-host requests may only reach dashboard routes. Anything
else is **421 Misdirected Request**.

Three properties carried from Columbia Pages, which got this right:
1. **Refuse to boot if the two origins are equal** — an assertion, not a doc note.
2. **Re-check the host inside credential validation**, so a routing bug alone
   cannot authenticate a request on the content origin.
3. **`__Host-` cookie prefix** — the browser then structurally forbids scoping the
   cookie to a parent domain.

Locally this is a **port split**: dashboard `:5173`, content `:5174`, so the
boundary is exercised in dev exactly as in prod. Both bind `0.0.0.0` for Tailscale.

### Effect service graph

Deliberately small. Bindings become services; everything else is derived.

```ts
class Db     extends Context.Service<Db,     D1Database>()("app/Db") {}
class Bucket extends Context.Service<Bucket, R2Bucket>()("app/Bucket") {}

const SqlLive = Layer.unwrap(Effect.map(Db, (db) => D1.layer({ db })))

const requestLayer = (env: Env) =>
  Layer.mergeAll(SqlLive, BlobsLive, FilesLive, SearchLive, AuthLive).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Db, env.DB),
      Layer.succeed(Bucket, env.BUCKET)
    ))
  )
```

Domain services: `Files`, `Tags`, `Search`, `Sites`, `Auth`, `Blobs`. No shared
`ManagedRuntime` initially — everything is request-scoped anyway, so the entry
point is just `Effect.runPromiseExit(program.pipe(Effect.provide(requestLayer(env))))`.

**Optional bindings (AI, Vectorize).** Implemented as a **null-object layer swap**,
not `Effect.serviceOption`: `Embedder` and `VectorIndex` always exist, but resolve
to a no-op implementation when the binding is absent. Call sites stay branch-free.
This also sidesteps the Columbia footgun where an optional service resolved via
`serviceOption` must be wired with `Layer.provide` (a dependency edge) rather than
merged into the same `Layer.mergeAll`, or it silently yields `None`.

**Entry-point Cause translation** (`src/lib/server/edge.ts`): capture
`getRequestEvent()` **synchronously** before entering a fiber (Workers have no
`AsyncLocalStorage`), then map the Exit — rethrow SvelteKit `error()`/`redirect()`
defects and `isValidationError` unchanged, map tagged domain errors to statuses,
and log `Cause.pretty` with a generic 500 for anything else.

### Data model

```sql
files(id TEXT PK, display_name, content_type, kind, current_version,
      size_bytes, public INT, is_site INT, created_at, updated_at,
      deleted_at, purge_at, purge_state, expires_at,
      download_count, last_download_at,
      index_state, indexed_version, index_cursor, index_attempts,
      index_error, index_next_run_at)

file_versions(file_id, version, r2_key, size_bytes, sha256, content_type,
              created_at, text_content, PRIMARY KEY (file_id, version))

tags(id, name, normalized_name UNIQUE, color, created_at)
file_tags(file_id, tag_id, PRIMARY KEY (file_id, tag_id))

site_assets(file_id, version, path, r2_key, content_type, size_bytes,
            PRIMARY KEY (file_id, version, path))

file_chunks(vector_id PK, file_id, version, ordinal, char_start, char_end)
pending_vector_deletes(vector_id PK, queued_at)

api_keys(id, name, prefix UNIQUE, secret_hash, created_at, last_used_at, revoked_at)
device_codes(device_code_hash PK, user_code UNIQUE, status, interval_seconds,
             expires_at, created_at)
device_tokens(token_hash PK, device_id, name, created_at, last_used_at, revoked_at)

-- FTS5 (derived state only — see backup note)
CREATE VIRTUAL TABLE files_fts USING fts5(
  name, tags, body, file_id UNINDEXED, chunk_no UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE files_trgm USING fts5(
  name, file_id UNINDEXED, tokenize = "trigram");
```

R2 keys are server-generated and opaque — no user data in the key.
Files: `v/{fileId}/{randomUuid}`. Site assets: `s/{fileId}/{version}/{path}`.

Migrations are **Wrangler-native**, not Effect's Migrator (its loaders need a
filesystem and it relies on transactional semantics D1 lacks).

### Search — two tiers, fused

**Tier 1: D1 + FTS5.** Primary, synchronous, strongly consistent. FTS5 *is*
supported on D1 — verified three ways (CF's supported-extensions docs, the workerd
SQL authorizer allowlisting exactly `fts5`/`fts5vocab`, and CF's own test suite).
SQLite 3.47.0, so **`porter` and `trigram` tokenizers are both available** — this
recovers the typo tolerance we thought we'd lost leaving Postgres/`pg_trgm`.
`bm25()` with column weights (name 10×, tags 5×, body 1×); more negative is better.

**Tier 2: Vectorize + Workers AI.** Optional semantic booster, **auto-detected
from the presence of bindings**.

**Fusion: Reciprocal Rank Fusion**, `Σ w/(k + rank)`, `k=60`, three sources
(keyword 1.0, vector 1.0, trigram 0.5). Chunks collapse to files by **MAX pooling**
*before* fusing, so a 40-chunk file can't flood the list. Plus an exact-name pin:
a query equal to a filename ranks that file first, always.

The property that makes tier 2 cleanly optional: **with one input list RRF is
monotonic in rank**, so the keyword-only path is the same code, no branch.

**D1 hydration is the authoritative filter** — visibility, deletion, and tag
filtering all happen there. Vectorize metadata filters are an optimization only,
never the correctness boundary.

### Why the vector half must degrade gracefully

Vectorize bills `(stored_vectors + queries) × dimensions` — **every query is billed
as if it scanned the whole index**. At ~13k stored 384-dim vectors that's ~5M
queried dims per search against a 30M/month free cap: roughly **six searches a
month**. It is also **eventually consistent** ("typically a few seconds"; docs warn
unbatched writes can take over an hour), so upload-then-immediately-search is
broken for the vector half — tier 1 carries that case.

Since we auto-detect, the dashboard states the cost model plainly next to the
current index size, so enabling it is informed rather than a silent quota burn.

Hard constraints: **tags cannot be filtered in Vectorize** (no array-membership
operator); **metadata indexes must exist before the first insert**, max 10 — so
`deleted`, `kind`, and `visibility` are created at provisioning time or the index
must be rebuilt later. **Pin `pooling: "cls"` and the model/dimension in config** —
changing either silently invalidates every stored vector, and the index dimension
is immutable after creation.

### Background indexing without Queues

`ctx.waitUntil` fires extraction and embedding per upload. It has a **30 s wall
clock and no retries**, so durable state lives in D1 (`index_state`, `index_cursor`,
`index_attempts`, `index_next_run_at`) and a **Cron Trigger re-drives it** — the
queue substitute. Exponential backoff, 5 attempts, then `failed` with the error
retained and a manual **Reindex** action in the UI.

`index_state = 'failed'` never means "file is lost" — it means findable by
name/tag/keyword but not by meaning, the same state every file is in on an
instance with no Vectorize binding.

---

## Critical implementation details

These are the places where the obvious implementation is wrong.

**Streaming into R2.** Validate `Content-Length` first — **411** if absent, **413**
if over cap — *before reading a byte*. Then:

```ts
const { readable, writable } = new FixedLengthStream(size);
const pumped = request.body.pipeTo(writable);   // do NOT await
const [object] = await Promise.all([bucket.put(key, readable, opts), pumped]);
```

Awaiting `pipeTo` before `put` **deadlocks** — the stream has no reader until
`put` starts consuming. Never `await request.arrayBuffer()` (128 MB isolate
memory, shared across concurrent requests). Trust `object.size`, not the header,
as the stored size. `FixedLengthStream` also makes `wrangler dev` behave like
production — the local binding proxy otherwise loses stream length.

**FTS5 `MATCH` input must be sanitized.** A raw query like `"unclosed` or `foo:bar`
throws a syntax error — a 500 on ordinary input. Tokenize on non-alphanumerics,
quote each token, append `*` to the last for search-as-you-type:
`["orbit","manifest"] → '"orbit" "manifest"*'`. The research calls this the #1 bug
in naive FTS5 integrations.

**Backup vs virtual tables.** `wrangler d1 export` **cannot export a DB containing
virtual tables**, and a failed export can wedge the database. Since this is
self-hosted, backup is not optional — so **FTS tables are pure derived state** with
a `rebuild-index` command, making per-table export of the real tables a complete
backup. Also: **never run FTS5 `'integrity-check'` on D1** — it corrupts the shadow
tables. Keep any single indexed value under ~100 KB (also a corruption trigger).

**D1 limits that bite.** 100 bound params per statement (30 chunks × 4 cols = 120,
overflow — size the batches). 2 MB cap on any TEXT value *and* the whole row, so
full text lives in R2 and only truncated chunks go in D1. Free plan: ~50 queries
per invocation and only 6 simultaneous connections — pool the puts when uploading
a 50-asset site, and embed a file's chunks in **one `AI.run()` with an array**.

**Version transition order.** Upsert new vectors *before* deleting old ones. The
worst case then is "both versions briefly searchable" (harmless — MAX pooling
collapses them), rather than "file briefly unsearchable" for the whole
eventual-consistency window.

**Purge is a state machine.** `none → pending → done|failed`. Delete R2 objects
before rows, so a partial failure never lets the DB claim bytes were freed.

---

## Build order

Each phase leaves the app working and independently verifiable.

**Phase 1 — spine: upload → store → serve.** *(first milestone)*
Monorepo scaffold, wrangler config with D1+R2, initial migration, the Effect
service graph and entry-point Cause translation, host-gating with the
equal-origins boot assertion, single-shot upload with the FixedLengthStream
pattern, and content serving with correct content-type, visibility, and
`Content-Disposition`. Minimal CLI: `login` (API key paste), `put`, `get`.
*Verify:* `adrive put file.pdf` returns a URL; the URL serves correct bytes; a
private file 404s anonymously; the content host 421s on a dashboard path.

**Phase 2 — dashboard.** SvelteKit + Tailwind v4, file list, detail page with
version history, upload via drag-and-drop, copy-link button (the gap Columbia
never filled), visibility toggle, trash + restore.

**Phase 3 — tags and keyword search.** Tag CRUD and auto-create-on-use, FTS5
tables with sanitized MATCH, BM25 ranking, RRF over keyword+trigram, live
debounced search UI with Runed URL state and a monotonic run counter so a slow
response can't overwrite a newer one.

**Phase 4 — sites.** `adrive site put ./dist`, session/asset/commit protocol,
path-based serving with content-type inference, republish replacing the prior
asset set.

**Phase 5 — device flow + API keys.** Passcode login, key minting UI, device flow
with headless mode, `--json` everywhere, tag commands, stdin/stdout piping.

**Phase 6 — semantic search.** Extraction in `waitUntil`, the D1 indexing state
machine, cron re-driver, chunking + embedding, Vectorize upsert/delete lifecycle,
RRF third source, index-state UI with Reindex, and the cost disclosure.

**Deferred:** multipart/resumable uploads (schema is shaped for it), PDF text
extraction, reranking via `bge-reranker-base`, MCP server.

---

## Verification

- **Per phase:** `pnpm check` (tsc + effect-tsgo + svelte-check) and `pnpm format:check`.
- **Upload path:** round-trip a small text file, a 90 MB file (near cap), a
  zero-byte file, and a chunked request with no `Content-Length` (expect 411).
  Confirm both `wrangler dev` and deployed behave identically — that divergence is
  exactly what `FixedLengthStream` is guarding.
- **Host gating:** dashboard path on the content host → 421; content path on the
  dashboard host → 421; equal origins → refuses to boot.
- **Search:** exact filename ranks first; a typo'd filename still finds the file
  (trigram); a content phrase finds a file whose *name* doesn't match; tag OR
  filtering broadens; a query with `"` or `:` doesn't 500.
- **Degradation:** remove the Vectorize and AI bindings — search must still work,
  identically ranked minus the semantic source.
- **Indexing:** kill a `waitUntil` mid-flight and confirm cron picks the file up
  and completes it.
- **Backup:** per-table export succeeds with FTS tables present; `rebuild-index`
  reconstructs search from the real tables.
- **Manual:** dev servers bound `0.0.0.0`, reachable at
  `http://<dev-host>:5173/` (dashboard) and `:5174` (content).

## Open risks

- **Effect v4 is beta and APIs move between releases** (`Layer.scoped` removed,
  `Schema.minLength` → `isMinLength`, no `asEffect`). Pin `4.0.0-beta.102`; re-verify
  against source on any bump.
- **`@effect/tsgo` editor integration under TS 6 is unverified** — CI is confirmed.
- **Max statements per D1 `batch()` is undocumented.** Keep batches modest.
- **Workers AI sync batch array cap is undocumented** — keep to ~50 chunks/call.
- **Vectorize write→read lag should be measured** on a scratch index before relying
  on any assumption tighter than "seconds".
