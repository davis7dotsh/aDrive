# a-drive stack research

Date: 2026-07-27. Verification method matters here: Effect v4 is in beta and the
published docs lag the source badly, so **most of this was verified by installing
the exact beta into `/tmp/effect-probe`, reading `node_modules/effect/src/*.ts`,
and compiling + running probe programs**. Claims are marked:

- **[SRC]** — read from installed source/`.d.ts` at the stated path.
- **[RUN]** — I executed it and pasted the real output.
- **[DOC]** — from official docs at a cited URL.
- **[?]** — uncertain / could not confirm. Treat as unknown, not as fact.

Probe dir: `/tmp/effect-probe` (effect 4.0.0-beta.102, TS 7.0.2, workers-types).
Second probe: `/tmp/kit-probe` (@sveltejs/kit 2.70.1 + effect beta together).

---

## 1. Versions and package layout

### Effect v4 is `4.0.0-beta.102`, published under the `beta` dist-tag

[RUN] `npm view effect dist-tags --json`:

```json
{ "latest": "3.22.0", "beta": "4.0.0-beta.102" }
```

`latest` is still v3.22.0. **`npm i effect` gives you v3.** You must ask for the
beta explicitly.

### The CLI/SQL/HTTP modules moved INTO the core `effect` package

This is the single biggest structural change from v3 and it is confirmed.

[SRC] `effect@4.0.0-beta.102/package.json` `exports` includes:

```
.  ./testing
./unstable/ai      ./unstable/cli      ./unstable/cluster  ./unstable/devtools
./unstable/encoding ./unstable/eventlog ./unstable/http    ./unstable/httpapi
./unstable/observability ./unstable/persistence ./unstable/process
./unstable/reactivity ./unstable/rpc  ./unstable/schema   ./unstable/socket
./unstable/sql     ./unstable/workflow ./unstable/workers
```

So:

| v3 package | v4 location |
|---|---|
| `@effect/cli` | **`effect/unstable/cli`** (in core) |
| `@effect/sql` | **`effect/unstable/sql`** (in core) |
| `@effect/platform` (http bits) | **`effect/unstable/http`** (in core) |
| `@effect/rpc` | `effect/unstable/rpc` (in core) |

**Your hunch about Columbia was right.** [RUN] `npm view @effect/cli dist-tags`
returns only `{"latest":"0.76.0"}` — **there is no v4-tagged `@effect/cli`**.
Same for `@effect/sql` (`0.52.0` latest, no beta) and `@effect/platform`
(`0.97.0` latest, no beta). Those are v3-only packages now. Do **not** install
them.

Packages that DO still exist separately and DO have a `4.0.0-beta.102` beta tag
([RUN] `npm view <pkg> dist-tags --json`):

- `@effect/sql-d1` → `4.0.0-beta.102` ✅
- `@effect/platform-node` → `4.0.0-beta.102` ✅
- `@effect/vitest` → `4.0.0-beta.102`
- `@effect/opentelemetry` → `4.0.0-beta.102`

`@effect/language-service` is versioned independently: `0.87.1`.
`@effect/tsgo` is versioned independently: `0.24.3`.

### Install commands

```bash
# runtime
pnpm add effect@beta @effect/sql-d1@beta

# CLI companion (platform-node gives FileSystem/Path/Terminal/Stdio + runMain)
pnpm add @effect/platform-node@beta

# dev tooling
pnpm add -D @effect/language-service @effect/tsgo typescript@7
```

Pin exactly while in beta — these are betas and APIs move between them:

```jsonc
{
  "dependencies": {
    "effect": "4.0.0-beta.102",
    "@effect/sql-d1": "4.0.0-beta.102",
    "@effect/platform-node": "4.0.0-beta.102"
  }
}
```

[SRC] `@effect/sql-d1@4.0.0-beta.102/package.json` has
`peerDependencies: { "effect": "^4.0.0-beta.102" }` and
`dependencies: { "@cloudflare/workers-types": "^5.20260708.1" }` — so
workers-types comes in transitively, and the effect peer is pinned tightly.
Keep `effect` and `@effect/sql-d1` on the **same** beta number.

### Other stack versions [RUN] `npm view <pkg> version`

| package | version |
|---|---|
| `@sveltejs/kit` | 2.70.1 |
| `svelte` | 5.56.8 |
| `@sveltejs/adapter-cloudflare` | 7.2.9 |
| `wrangler` | 4.114.0 |
| `svelte-check` | 4.7.4 |
| `typescript` | **7.0.2** (yes, really shipped — see §6) |
| `tailwindcss` | 4.3.3 |
| `runed` | 0.37.1 |

---

## 2. @effect/sql-d1 — real usage  ← PRIORITY 1

I read the whole driver: [SRC]
`/tmp/effect-probe/node_modules/@effect/sql-d1/src/D1Client.ts` (268 lines).

### What the module exports

[SRC] `src/index.ts` exports exactly one namespace:

```ts
export * as D1Client from "./D1Client.ts"
```

Import either way:

```ts
import * as D1 from "@effect/sql-d1/D1Client"
// or
import { D1Client } from "@effect/sql-d1"
```

### The layer constructors

[SRC] Two, both returning `Layer<D1Client | SqlClient, ConfigError>`:

```ts
export const layer: (config: D1ClientConfig)
  => Layer.Layer<D1Client | Client.SqlClient, Config.ConfigError>

export const layerConfig: (config: Config.Wrap<D1ClientConfig>)
  => Layer.Layer<D1Client | Client.SqlClient, Config.ConfigError>
```

Note both provide **both** `D1Client` *and* the generic
`SqlClient` tag, so domain code can depend on the portable
`SqlClient.SqlClient` and stay driver-agnostic. `Reactivity.layer` is
provided internally, so you don't supply it.

`D1ClientConfig` [SRC]:

```ts
export interface D1ClientConfig {
  readonly db: D1Database                     // the Workers binding
  readonly prepareCacheSize?: number          // default 200
  readonly prepareCacheTTL?: Duration.Input   // default 10 minutes
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}
```

The only required field is `db`. So the per-request layer is literally
`D1.layer({ db: platform.env.DB })`.

Snake_case ↔ camelCase mapping, if you want it:

```ts
import { String as Str } from "effect"
D1.layer({
  db,
  transformQueryNames: Str.camelToSnake,
  transformResultNames: Str.snakeToCamel
})
```

### ⚠️ TRANSACTIONS ARE NOT SUPPORTED — confirmed twice

[SRC] The driver's own module docstring says:

> "Transactions, streaming queries, and `updateValues` are not supported by this
> driver."

[SRC] line 213: `const transactionAcquirer = Effect.die("transactions are not supported in D1")`
[SRC] line 61-62: `/** Not supported in d1 */ readonly updateValues: never`
[SRC] line 206: `executeStream(...) { return Stream.die("executeStream not implemented") }`

[RUN] I proved the failure mode with a fake D1 binding
(`/tmp/effect-probe/src/probe-d1-tx.ts`):

```
query exit: [{"id":"a"},{"id":"b"}]
withTransaction FAILED, reasons: [ 'Die' ]
pretty: Error: transactions are not supported in D1
```

**This is a `Die` (defect), not a typed failure.** It will NOT show up in your
`E` channel, so the typechecker will not stop you from calling
`sql.withTransaction(...)` — it will blow up as a 500 at runtime. Treat
"never call `withTransaction`" as a project rule and consider a lint/grep for it.

Same for `sql.stream(...)` / `executeStream` → `Stream.die`. Don't use
streaming queries against D1; page with `LIMIT`/`OFFSET` or keyset pagination.

**What to use instead:** D1's native `batch()`, which is atomic. Cloudflare
documents `db.batch([...])` as running in a single transaction implicitly. The
Effect driver does **not** wrap `batch`, so reach through to the raw binding for
multi-statement atomicity:

```ts
// You keep the raw D1Database in a service, alongside the SqlClient
const applyAtomic = Effect.fn("applyAtomic")(function* (rows: ReadonlyArray<Row>) {
  const db = yield* Db                      // raw D1Database binding service
  yield* Effect.tryPromise({
    try: () => db.batch(rows.map((r) =>
      db.prepare("INSERT INTO files (id, name, size) VALUES (?, ?, ?)")
        .bind(r.id, r.name, r.size))),
    catch: (cause) => new StorageError({ cause })
  })
})
```

[DOC] **Confirmed** against
<https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>. Verbatim:

> "D1 operates in auto-commit. Our implementation guarantees that each statement
> in the list will execute and commit, sequentially, non-concurrently."

and on failure:

> "If a statement in the sequence fails, then an error is returned for that
> specific statement, and it aborts or rolls back the entire sequence."

So `batch()` gives you sequential, non-concurrent execution with
all-or-nothing rollback — the practical substitute for a transaction. The docs
also confirm explicit transactions (`BEGIN`/`COMMIT`) are **not** supported via
the Workers binding, which is exactly why the Effect driver dies on
`withTransaction`. There is also `db.exec()` for running one or more queries
directly without prepared statements or bindings (useful for DDL, not for
user input).

### Queries in Effect.gen — with real proof of parameter binding

[RUN] `/tmp/effect-probe/src/probe-stmt.ts` ran each of these against a fake
binding that records the compiled SQL + bound params. Actual captured output:

```
{"sql":"SELECT * FROM files WHERE id = ?","params":["abc'; DROP TABLE files;--"]}
{"sql":"SELECT * FROM files WHERE id IN (?,?,?)","params":["a","b","c"]}
{"sql":"INSERT INTO files (\"id\",\"name\") VALUES (?,?)","params":["1","n"]}
{"sql":"UPDATE files SET \"name\" = ? WHERE id = ?","params":["new","1"]}
{"sql":"SELECT * FROM \"files\" LIMIT ?","params":[10]}
{"sql":"SELECT * FROM files WHERE (a = ? AND b = ?)","params":[1,2]}
```

Note the SQL-injection attempt went through as a **bound parameter**, not
interpolated text. The source producing that:

```ts
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"

const prog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // interpolation => bound parameter, always
  yield* sql`SELECT * FROM files WHERE id = ${id}`

  // IN clause
  yield* sql`SELECT * FROM files WHERE id IN ${sql.in(["a", "b", "c"])}`

  // INSERT helper builds the column list for you
  yield* sql`INSERT INTO files ${sql.insert({ id: "1", name: "n" })}`

  // UPDATE helper
  yield* sql`UPDATE files SET ${sql.update({ name: "new" })} WHERE id = ${"1"}`

  // sql("ident") is an IDENTIFIER (quoted), NOT a parameter — never pass user input
  yield* sql`SELECT * FROM ${sql("files")} LIMIT ${10}`

  // boolean helpers
  yield* sql`SELECT * FROM files WHERE ${sql.and([sql`a = ${1}`, sql`b = ${2}`])}`
})
```

Typed row results — the tag call is generic:

```ts
const rows = yield* sql<{ id: string; name: string; size: number }>`
  SELECT id, name, size FROM files ORDER BY name
`
// rows: ReadonlyArray<{ id: string; name: string; size: number }>
```

That generic is an **unchecked assertion**, not validation. If you want real
validation, decode the rows with a Schema (see §5) or use the `SqlSchema`
helpers in `effect/unstable/sql/SqlSchema.ts` [SRC — file exists; I did not
exercise its API, so treat its exact surface as [?]].

The error type is `SqlError` from `effect/unstable/sql` — note the import path,
which cost me a compile error:

```ts
// ✅ correct
import { SqlClient, SqlError } from "effect/unstable/sql"
type E = SqlError.SqlError

// ❌ wrong — SqlError is NOT nested under SqlClient
type Bad = SqlClient.SqlError.SqlError
```

### Migrations — use Wrangler, not the Effect Migrator

[SRC] `effect/unstable/sql/Migrator.ts` exists and exports `make`, `fromGlob`,
`fromBabelGlob`, `fromRecord`, `fromFileSystem`. But:

1. Its loaders are filesystem/glob based (`fromFileSystem` requires
   `FileSystem`), which you don't have in a Worker.
2. [SRC] The migrator's `ensureMigrationsTable` uses `sql.onDialectOrElse({...})`
   and, more importantly, the generic runner path relies on locking/transactional
   semantics that **D1 does not provide** (see the `Effect.die` above).

**Recommendation: use Wrangler's native D1 migrations.** They're first-class,
work locally and remotely, and don't fight the driver:

```bash
wrangler d1 create a-drive-db
wrangler d1 migrations create a-drive-db init
# edit migrations/0001_init.sql
wrangler d1 migrations apply a-drive-db --local
wrangler d1 migrations apply a-drive-db --remote
wrangler d1 migrations list a-drive-db
```

Keep `migrations/` at the repo root and point `wrangler.jsonc` at it via
`migrations_dir` if you relocate it. Your Effect code then only ever *reads and
writes* — it never owns schema. This also keeps CI simple: schema changes are a
Wrangler step, not an app-boot step. [?] I did not verify the exact
`migrations_dir` key name against current Wrangler docs this session.

---

## 3. Per-request bindings on Workers  ← PRIORITY 2

### The constraint

`platform.env.DB` / `platform.env.BUCKET` exist only inside a request. You
cannot build a D1 layer at module scope. The skill at
`/home/davis/.claude/skills/effect-v4-serverless-patterns/references/lifetimes.md`
states the rule directly:

> | Worker `env` or binding-derived client/stub | Invocation by default | Usually not | Keep current bindings fresh and avoid cross-request I/O; promote only with explicit current documentation |

and:

> Workers may process multiple concurrent requests in one isolate. Never put
> mutable request state or request-owned I/O in global scope.

### The canonical shape (compiles clean — `/tmp/effect-probe/src/probe-boundary.ts`)

Bindings become **services**; the D1 layer is derived from the binding service
via `Layer.unwrap`; everything is provided per request.

```ts
// src/lib/server/effect/services.ts
import { Context, Data, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as D1 from "@effect/sql-d1/D1Client"

// ---------- typed errors
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly id: string
}> {}
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: unknown
}> {}

// ---------- raw bindings as services (class style, v4)
export class Db extends Context.Service<Db, D1Database>()("app/Db") {}
export class Bucket extends Context.Service<Bucket, R2Bucket>()("app/Bucket") {}

// ---------- the SqlClient layer, derived from the Db binding service
export const SqlLive = Layer.unwrap(
  Effect.map(Db, (db) => D1.layer({ db }))
)

// ---------- an R2 service written against the Bucket binding
export interface BlobsShape {
  readonly put: (
    key: string,
    body: ReadableStream | ArrayBuffer
  ) => Effect.Effect<void, StorageError>
  readonly get: (key: string) => Effect.Effect<R2ObjectBody, NotFound | StorageError>
}
export class Blobs extends Context.Service<Blobs, BlobsShape>()("app/Blobs") {}

export const BlobsLive = Layer.effect(
  Blobs,
  Effect.gen(function* () {
    const bucket = yield* Bucket
    return Blobs.of({
      put: Effect.fn("Blobs.put")(function* (key, body) {
        yield* Effect.tryPromise({
          try: () => bucket.put(key, body as any),
          catch: (cause) => new StorageError({ cause })
        })
      }),
      get: Effect.fn("Blobs.get")(function* (key) {
        const obj = yield* Effect.tryPromise({
          try: () => bucket.get(key),
          catch: (cause) => new StorageError({ cause })
        })
        if (obj === null) return yield* new NotFound({ id: key })
        return obj
      })
    })
  })
)

// ---------- the whole per-request graph, one function of env
export const requestLayer = (env: { DB: D1Database; BUCKET: R2Bucket }) =>
  Layer.mergeAll(SqlLive, BlobsLive).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Db, env.DB),
      Layer.succeed(Bucket, env.BUCKET)
    ))
  )
```

Gotcha I hit [RUN/SRC]: `Db.asEffect()` **does not exist** in beta.102. The
service class is itself yieldable/an Effect, so `Effect.map(Db, ...)` is the
form that compiles. `yield* Db` works inside `Effect.gen`.

### Cost of building a layer per request — measured

[RUN] `/tmp/effect-probe/src/probe-runtime.ts` counts constructions across three
sequential requests through one shared `ManagedRuntime`:

```
a 42:a
b 42:b
c 42:c
sharedBuilds = 1 (expect 1)
reqBuilds    = 3 (expect 3)
provideService: 42:direct
sharedBuilds still = 1
```

Interpretation, all confirmed by that run:

- A module-scope `ManagedRuntime` builds its shared layer **once** and reuses it
  across requests, exactly as the skill's lifetimes doc describes.
- A per-request layer builds **once per request** — that's the price, and it's
  the correct price for binding-derived resources.
- `Effect.provideService(Tag, value)` injects a value with **no layer build at
  all**. Prefer it for plain values.

Is the per-request D1 layer expensive? [SRC] `D1Client.make` does: build a
statement compiler, create a `Cache` for prepared statements, and assemble the
client object. **No I/O, no connection.** D1 has no connection handshake — the
binding is an RPC stub. So the per-request cost is a few object allocations. The
prepared-statement cache (default 200 entries / 10 min TTL) is created fresh per
request and thrown away, so you lose statement-cache reuse across requests, but
you gain correctness and binding freshness. That is the right trade on Workers.

### Two viable boundary designs

**Option A — no shared runtime (simplest, recommended to start).** Everything is
request-scoped anyway, so skip `ManagedRuntime` entirely:

```ts
const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(requestLayer(env)))
)
```

**Option B — shared runtime for host-safe layers only.** Only if you actually
grow share-safe services (pure config, parsers, a stateless fetch wrapper):

```ts
// module scope — ONLY share-safe layers, never bindings
const runtime = ManagedRuntime.make(AppSharedLayer)

// per request
const exit = await runtime.runPromiseExit(
  program.pipe(Effect.provide(requestLayer(env)))
)
```

Per the skill's boundaries doc: do **not** `dispose()` a shared runtime after
each request, and don't assume finalizers run on Worker teardown — Workers give
you no reliable shutdown hook.

`ctx.waitUntil` for non-critical background work: get it from
`platform.ctx.waitUntil(...)`. [SRC] `@sveltejs/adapter-cloudflare/ambient.d.ts`
declares `ctx: ExecutionContext` on `App.Platform` (and a deprecated `context`
alias). Only use it for work whose failure you're willing to not observe; await
anything that must happen.

---

## 4. Effect v4 vs v3 — breaking changes that matter  ← PRIORITY 4

### 4.1 `Effect.gen` adapter is GONE

[RUN] I compiled both forms. The v3 adapter form is now a **type error**:

```ts
// ❌ v3 — no longer typechecks in v4
Effect.gen(function* (_) {
  const a = yield* _(Effect.succeed(1))
})
// error TS2345: Argument of type '(_: any) => Generator<...>' is not assignable
//   to parameter of type '() => Generator<any, any, never>'.
//   Target signature provides too few arguments. Expected 1 or more, but got 0.

// ✅ v4 — direct yield*, zero-arg generator
Effect.gen(function* () {
  const a = yield* Effect.succeed(1)
  const b = yield* Effect.succeed(2)
  return a + b
})
```

[SRC] There is exactly **one** `Effect.gen` overload in beta.102 and it takes
`f: () => Generator<Eff, AEff, never>` — no adapter overload exists.

### 4.2 Service definition: `Context.Service`, not `Effect.Service` / `Context.Tag`

[SRC] `grep "^export const Service" Effect.ts` → **no match**. `Effect.Service`
does not exist in v4. `Context.Tag` is likewise gone; the v4 API is
`Context.Service` with two calling conventions [SRC `Context.ts:200-370`]:

```ts
// (a) function style — value key
const Database = Context.Service<{ query: (sql: string) => string }>("Database")

// (b) class style — two-stage, this is what you want for app services
class Config extends Context.Service<Config, { port: number }>()("Config") {}
```

The class-style form takes an optional `{ make }` option that bakes the
constructor into the class [SRC]:

```ts
<Self, Shape>(): <Identifier extends string, E, R, Args>(
  id: Identifier,
  options?: { readonly make: ((...args: Args) => Effect<Shape, E, R>) | Effect<Shape, E, R> }
) => ServiceClass<Self, Identifier, Shape> & { readonly make: ... }
```

The service class is **yieldable** (`yield* Users`) and carries helpers
`Service.of(...)`, `.use(f)`, `.useSync(f)` [SRC `Context.ts:425-437`]. Also
`Context.Reference` exists for keys with a lazily-computed default
[SRC `Context.ts:2075`].

### 4.3 Layer API

[SRC] Exports present in beta.102: `succeed`, `succeedContext`, `sync`,
`syncContext`, `effect`, `effectContext`, `effectDiscard`, `suspend`, `unwrap`,
`mergeAll`, `merge`, `provide`, `provideMerge`, `flatMap`, `tap`, `tapError`,
`tapCause`, `orDie`, `catchTag`, `catchCause`, `updateService`, `fresh`,
`launch`, `mock`, `span`, `withSpan`, `build`, `buildWithScope`,
`buildWithMemoMap`, `makeMemoMapUnsafe`, `empty`.

Notable: **there is no `Layer.scoped`.** The skill states this and I confirmed it
— `Layer.scoped` is absent from the export list. Use `Effect.acquireRelease`
*inside* `Layer.effect`; `Layer.effect` supplies the acquisition scope and
removes `Scope.Scope` from the layer's requirements:

```ts
const PoolLive = Layer.effect(
  Pool,
  Effect.acquireRelease(openPool, (pool) => pool.close)
)
```

`Layer.unwrap` [SRC `Layer.ts:1498`] has signature
`<A,E1,R1,E,R>(self: Effect<Layer<A,E1,R1>, E, R>) => Layer<A, E|E1, R1 | Exclude<R, Scope>>`
— that's the one that makes "derive a layer from a service" work (used in §3).

Memoization is by **layer object identity** — store parameterized layers in
constants; calling a layer factory twice allocates twice.

### 4.4 Errors: `Data.TaggedError` still the workhorse

[SRC `Data.ts:1131`]:

```ts
export const TaggedError: <Tag extends string>(tag: Tag) =>
  new <A extends Record<string, any> = {}>(args: ...) =>
    Cause.YieldableError & { readonly _tag: Tag } & Readonly<A>
```

It's **yieldable** — `return yield* new NotFound({ id })` works directly inside
`Effect.gen` and lands in the typed error channel. That pattern is used in the
§3 code and compiles.

Schema-backed errors moved/renamed. [SRC] v4 has `Schema.ErrorClass` and
**`Schema.TaggedErrorClass`** (note the `Class` suffix — it is *not*
`Schema.TaggedError` as in v3):

```ts
export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()(
  "ValidationFailed",
  { field: Schema.String, message: Schema.String }
) {}
```

[RUN] Instantiating it produced
`{"_tag":"ValidationFailed","field":"name","message":"too short"}`.

### 4.5 Cause is now a flat array of reasons — this is a real API break

[SRC `Cause.ts:77`]:

```ts
export interface Cause<out E> extends Pipeable, Inspectable, Equal {
  readonly [TypeId]: typeof TypeId
  readonly reasons: ReadonlyArray<Reason<E>>   // <-- flat array
}
```

`Reason` is `Fail<E> | Die | Interrupt`. **The v3 recursive
`Empty/Fail/Die/Sequential/Parallel` tree is gone.** No more `Cause.failures`
returning a `Chunk`, no tree walking.

Finder functions return **`Result`**, not `Option` [SRC]:

```ts
Cause.findFail   : <E>(self: Cause<E>) => Result<Fail<E>, Cause<never>>
Cause.findError  : <E>(self: Cause<E>) => Result<E, Cause<never>>
Cause.findDie    : <E>(self: Cause<E>) => Result<Die, Cause<E>>
Cause.findDefect : <E>(self: Cause<E>) => Result<unknown, Cause<E>>
Cause.findInterrupt : <E>(self: Cause<E>) => Result<Interrupt, Cause<E>>
// ...with *Option variants where you want an Option:
Cause.findErrorOption : <E>(self: Cause<E>) => Option<E>
```

Predicates: `Cause.hasFails`, `hasDies`, `hasInterrupts`, `hasInterruptsOnly`.
Rendering: `Cause.pretty(cause)`, `Cause.prettyErrors(cause, opts)`.

[RUN] Real observed behaviour (`probe-cause.ts`):

```
isFailure true
reasons [ 'Fail' ]
findError success? Success {"_id":"Option","_tag":"Some","value":{"why":"x","_tag":"Boom"}}
hasDies false hasFails true
defect reasons [ 'Die' ]
findDefect tag Success {"status":404,"body":{"message":"nope"}}
```

Note the second block: a plain `throw` inside `Effect.sync` becomes a **`Die`**
reason and `findDefect` hands you back the original thrown object intact. That
is exactly the mechanism that lets SvelteKit's `error()` / `redirect()` survive
a trip through Effect — see §5.

### 4.6 Exit

[SRC] `Exit<A, E> = Success<A, E> | Failure<A, E>`, with `Exit.isSuccess` /
`Exit.isFailure` guards, and `exit.cause` on the failure branch. Also
`Exit.hasFails`, `hasDies`, `hasInterrupts`, `Exit.match`, `Exit.getSuccess`,
`Exit.getCause`, and `Result`-returning `filterValue` / `filterCause` /
`findError` / `findDefect`.

### 4.7 ManagedRuntime

[SRC `ManagedRuntime.ts`] `ManagedRuntime.make(layer, { memoMap? })` returns an
object with `runFork`, `runSync`, `runSyncExit`, `runPromise`, `runPromiseExit`,
`runCallback`, `context()`, `contextEffect`, `dispose()`, `disposeEffect`, and
`[Symbol.asyncDispose]`. The layer builds **lazily on first use**; the build
fiber is cached (`buildFiber`), so concurrent first callers await the same build
— and a *failed* build stays failed for that runtime's lifetime.

### 4.8 Schema was rewritten — the refinement API is different

This bit me and is easy to get wrong from v3 memory.

- ❌ `Schema.minLength(1)` — **does not exist**. [RUN] `TypeError: Schema.minLength is not a function`, and tsc suggests `isMinLength`.
- ✅ v4 uses `.check(...)` with **`is`-prefixed** predicates.

```ts
import { Schema } from "effect"

const FileMeta = Schema.Struct({
  id: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1)),
  size: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  tags: Schema.Array(Schema.String),
  createdAt: Schema.DateFromString        // NOT Schema.Date — see below
})

export type FileMeta = typeof FileMeta.Type
export type FileMetaEncoded = typeof FileMeta.Encoded
```

Available check predicates include [SRC]: `isMinLength`, `isFinite`, `isInt`,
`isGreaterThan`, `isGreaterThanOrEqualTo`, `isLessThan`, `isLessThanOrEqualTo`,
`isBetween`, `isMultipleOf`, `isUUID`, `isULID`, `isPattern`, `isTrimmed`,
`isStartsWith`, `isEndsWith`, `isIncludes`, `isUppercased`, `isLowercased`, plus
`*Date` variants (`isBetweenDate` etc.).

**`Schema.Date` vs `Schema.DateFromString`** [RUN] — `Schema.Date` expects an
actual `Date` object and *rejects* an ISO string:

```
SchemaError: Expected a valid Date, got "2026-07-27T22:35:59.973Z"
  at ["createdAt"]
```

Use `Schema.DateFromString` for JSON/ISO input. Also available:
`DateFromMillis`, `DateTimeUtc`, `DateTimeUtcFromString`, `DateTimeUtcFromMillis`,
`DateTimeZoned`, `DateTimeZonedFromString`.

Decoders [SRC]: `decodeUnknownEffect`, `decodeEffect`, `decodeExit`,
`decodeSync`, `decodePromise`, `decodeResult`, `decodeOption`,
`decodeUnknownOption`, and the matching `encode*` family.

[RUN] A successful decode:

```
decoded ok: {"id":"1","name":"a","size":3,"tags":["x"],"createdAt":"2026-07-27T22:36:15.721Z"}
```

---

## 5. SvelteKit remote functions + Effect  ← PRIORITY 5

### 5.1 Effect v4 Schema as a remote-function validator — YES, with one call

**Effect schemas are NOT Standard Schema out of the box.** [RUN]:

```
has ~standard natively?: false
after toStandardSchemaV1: true
vendor/version: "effect" 1
valid: {"value":{"name":"a","age":1}}
invalid: {"issues":[{"path":["age"],"message":"Expected number, got \"x\""}]}
```

You must wrap with **`Schema.toStandardSchemaV1(schema)`** [SRC `Schema.ts:1260`].
It returns `StandardSchemaV1<Encoded, Type> & S` — i.e. the wrapper is *also*
still an Effect schema, so you can keep using it for decode/encode.

Version compatibility checks out [RUN]:
- `@sveltejs/kit@2.70.1` depends on `@standard-schema/spec` `^1.0.0`
- `effect@4.0.0-beta.102` depends on `@standard-schema/spec` `^1.1.0`

Compatible ranges, single resolved copy.

And SvelteKit's actual `query` declaration takes any `StandardSchemaV1`
[SRC `@sveltejs/kit/types/index.d.ts:3646`]:

```ts
export function query<Schema extends StandardSchemaV1, Output>(
  schema: Schema,
  fn: (arg: StandardSchemaV1.InferOutput<Schema>) => MaybePromise<Output>
): RemoteQueryFunction<StandardSchemaV1.InferInput<Schema>, Output, StandardSchemaV1.InferOutput<Schema>>;
```

[RUN] I typechecked an Effect schema against `StandardSchemaV1`,
`InferInput`, and `InferOutput` in `/tmp/kit-probe` under TS 7 — clean compile.
So this works:

```ts
// src/routes/files/data.remote.ts
import { Schema } from "effect"
import { query } from "$app/server"

const ListArgs = Schema.Struct({
  folder: Schema.String,
  limit: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
})

export const listFiles = query(
  Schema.toStandardSchemaV1(ListArgs),
  async ({ folder, limit }) => { /* folder: string, limit: number — inferred */ }
)
```

Caveat worth knowing: `InferInput` is the schema's **Encoded** type and
`InferOutput` is its **Type**. If you use a transforming codec like
`DateFromString`, callers must pass the *encoded* form (a string) and your
handler receives the *decoded* form (a `Date`). That's usually what you want,
but it does mean the client-facing arg type is the encoded one.

**Remote functions are still experimental at kit 2.70.1 — confirmed from the
installed types**, not just from the skill. [SRC]
`@sveltejs/kit/types/index.d.ts:486-490`:

```ts
/**
 * Whether to enable the experimental remote functions feature. This feature is
 * not yet stable and may be changed or removed at any time.
 * @default false
 */
remoteFunctions?: boolean;
```

So you must opt in:

```js
compilerOptions: { experimental: { async: true } },
kit: { experimental: { remoteFunctions: true } },
```

Full set of `$app/server` remote exports at 2.70.1 [SRC, line numbers in
`types/index.d.ts`]: `getRequestEvent` (3541), `command` (3549/3557/3565),
`form` (3573/3581/3589), `prerender` (3597/3608/3619), `query`
(3630/3638/3646), plus `query.batch` (3655/3663) and `query.live`
(3670/3672/3674). Each takes three overloads: no-validator, `"unchecked"`, or a
`StandardSchemaV1`.

⚠️ **`form` + booleans.** The `form` overload has a type-level guard that will
reject a schema containing a non-optional boolean, with this literal error
message baked into the type [SRC line 3589]:

> "Error: All booleans in form schemas must be optional (e.g.
> `v.optional(v.boolean(), false)`) because checkbox inputs do not send a false
> value when unchecked."

With Effect Schema that means `Schema.optionalKey(Schema.Boolean)` (or a
defaulted variant) for every checkbox field — a plain `Schema.Boolean` will not
compile in a `form`.

### 5.2 Running an Effect inside a remote function

The key correctness rule from the skill's boundaries doc: **capture
`getRequestEvent()` synchronously**, before entering an Effect fiber, because
Workers have no `AsyncLocalStorage`.

```ts
// src/lib/server/effect/edge.ts
import { error, redirect } from "@sveltejs/kit"
import { getRequestEvent } from "$app/server"
import { Cause, Effect, Exit } from "effect"
import { requestLayer, NotFound, StorageError } from "./services"
import type { SqlClient } from "effect/unstable/sql"
import type { Blobs } from "./services"

type AppProgram<A, E> = Effect.Effect<A, E, SqlClient.SqlClient | Blobs>

export const runRemote = async <A, E>(program: AppProgram<A, E>): Promise<A> => {
  // synchronous capture, before any await
  const event = getRequestEvent()
  const env = event.platform?.env
  if (!env) error(500, "Cloudflare bindings unavailable")

  const exit = await Effect.runPromiseExit(
    program.pipe(Effect.provide(requestLayer(env)))
  )

  if (Exit.isSuccess(exit)) return exit.value
  return handleCause(exit.cause)
}

const handleCause = (cause: Cause.Cause<unknown>): never => {
  // 1. framework control-flow defects must pass through UNCHANGED
  const defect = Cause.findDefect(cause)
  if (defect._tag === "Success") {
    const d = defect.success as any
    // SvelteKit error() and redirect() throw plain objects with these shapes
    if (d && typeof d === "object" && "status" in d) {
      throw d          // rethrow: SvelteKit owns this
    }
  }

  // 2. typed domain failures -> explicit client-safe status
  const err = Cause.findErrorOption(cause)
  if (err._tag === "Some") {
    const e = err.value as any
    switch (e?._tag) {
      case "NotFound":     error(404, "Not found")
      case "StorageError": console.error(Cause.pretty(cause)); error(502, "Storage unavailable")
    }
  }

  // 3. anything else: log the full Cause server-side, generic 500 to the client
  console.error(Cause.pretty(cause))
  error(500, "Internal error")
}
```

Two details behind this, both confirmed:

- [RUN] `Cause.findDefect` returns the thrown object **intact**
  (`findDefect tag Success {"status":404,"body":{"message":"nope"}}`), which is
  what makes the pass-through in step 1 work.
- [SRC/RUN] `Cause.findDefect` returns a `Result`, so the guard is
  `._tag === "Success"` and the payload is `.success` — **not** Option's
  `.value`. `findErrorOption` returns an `Option`, so that one uses `.value`.
  Mixing these up is a silent bug; note the asymmetry.

Usage stays tiny:

```ts
// src/routes/files/data.remote.ts
import { query, form } from "$app/server"
import { Schema } from "effect"
import { runRemote } from "$lib/server/effect/edge"
import { listFilesProgram, deleteFileProgram } from "$lib/server/effect/programs"

export const listFiles = query(
  Schema.toStandardSchemaV1(Schema.Struct({ folder: Schema.String })),
  ({ folder }) => runRemote(listFilesProgram(folder))
)
```

### 5.3 `error()` / `redirect()` / `fail()` / `invalid()`

Per the skill (`boundaries.md` cause-translation matrix) — I'm relaying this
rather than re-deriving it:

| Cause content | What to do |
|---|---|
| Known tagged failure | map to explicit client-safe status/body |
| SvelteKit `HttpError` defect | rethrow unchanged |
| SvelteKit redirect defect | rethrow unchanged |
| Remote-form `ValidationError` defect | identify with the installed `isValidationError` guard, rethrow unchanged |
| `fail(...)` | it's a **return value** (`ActionFailure`), not an exception — never feed it to exception mapping |
| Unknown defect | log `Cause.pretty`, return generic 500 |
| Interruption | map deliberately; don't mislabel as domain failure |

`fail()` belongs to **classic form actions**, not remote functions. In a remote
`form`, programmatic validation issues come from `invalid(...)` and surface via
`fields.x.issues()`. Redirect is supported inside `form`, `query`, and
`prerender`, but **not** `command`.

The `isValidationError` guard the skill refers to **does exist** and is exported
from `@sveltejs/kit` [SRC `types/index.d.ts:2995`]:

```ts
export function isValidationError(e: unknown): e is ActionFailure;
```

Use it in the defect branch of your Cause handler so remote-form validation
errors pass through untouched instead of being flattened into a 500:

```ts
import { isValidationError } from "@sveltejs/kit"

const defect = Cause.findDefect(cause)
if (defect._tag === "Success") {
  const d = defect.success
  if (isValidationError(d)) throw d       // let SvelteKit render the issues
  if (d && typeof d === "object" && "status" in d) throw d  // error()/redirect()
}
```

Related: there's a `handleValidationError` hook [SRC line 937-941] that runs when
a remote function's argument fails validation — worth wiring up so bad client
input is logged consistently rather than surfacing as an opaque error.

`platform` inside remote functions: [SRC] kit's remote-function machinery
spreads the request event (`...event` at
`src/runtime/app/server/remote/shared.js:108`), so `getRequestEvent().platform`
is populated the same as in an endpoint. Still guard it — it's typed optional
and is absent in some dev configurations.

---

## 6. Tooling: TypeScript 7, svelte-check, Effect language service  ← PRIORITY 6

### 6.1 TypeScript 7 has actually shipped

[RUN] `npm view typescript dist-tags --json`:

```json
{ "latest": "7.0.2", "rc": "7.0.1-rc", "beta": "6.0.0-beta", "next": "7.1.0-dev.20260727.1" }
```

`npm i typescript` now gives you **7.0.2**, the native (Go) compiler.
[RUN] `npx tsc --version` → `Version 7.0.2`.

[SRC] The npm package is a thin launcher: `bin` is only `{"tsc": "./bin/tsc"}`,
`lib/` contains just `getExePath.js`, `tsc.js`, `version.cjs` — and the real
compiler ships as platform-specific optional deps
(`@typescript/typescript-linux-x64@7.0.2`, etc.).

**Note what's missing from `lib/`: there is no `tsserver.js` and no
`typescript.js` API entrypoint.** That has direct consequences below.

I used TS 7.0.2 to typecheck every Effect v4 probe in this report — including
generics-heavy CLI and Layer code — with no compiler bugs encountered.

### 6.2 `@effect/language-service` does NOT work with TypeScript 7

This is the important gotcha. [RUN] running its CLI in a TS-7 project:

```
ERROR (#1): TypeScriptFoundIsNot5Or6: @effect/language-service supports
TypeScript 5.x and 6.x; for TypeScript 7.x and forward use @effect/tsgo or
refer to side-by-side usage on
https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0.
```

[SRC] Its README line 4 says the same: *"If you are using TypeScript 7.0 or
newer, use `@effect/tsgo` instead."*

That follows from §6.1 — a TS language-service plugin needs `tsserver`, and TS 7
doesn't ship one in that package.

### 6.3 `@effect/tsgo` — and it genuinely works in CI

[RUN] `npm view @effect/tsgo dist-tags` → `{"latest":"0.24.3"}`. Binary is
**`effect-tsgo`** [SRC `package.json` `bin`], with platform binaries as optional
deps.

It is itself an Effect v4 CLI. [RUN] `npx effect-tsgo --help` subcommands:

```
patch           Patch the Effect Language Service binary
unpatch         Unpatch and restore the original TypeScript-Go binary
get-exe-path    Print the Effect Language Service executable path
diagnostics     Gets the Effect language service diagnostics on the given files or project
setup           Setup @effect/tsgo for the given project using an interactive CLI.
config          Configure diagnostic severities for an existing tsconfig using the interactive rule picker.
```

`diagnostics` flags [RUN]: `--file`, `--project`, `--format
<json|pretty|text|github-actions>`, `--strict` (warnings→errors), `--severity`,
`--progress`, `--lspconfig`.

**I ran the negative canary the skill prescribes**, and it passed. With a
deliberately floating Effect in the project:

```
/tmp/effect-probe/src/canary.ts:5:3 - error effect(floatingEffect): This Effect value is neither yielded nor used in an assignment.

5   Effect.succeed(1) // floating - not yielded
    ~~~~~~~~~~~~~~~~~

/tmp/effect-probe/src/probe-cli.ts:15:3 - message effect(unnecessaryEffectGen): This Effect.gen contains a single return statement.
/tmp/effect-probe/src/probe-schema.ts:5:15 - message effect(schemaNumber): This Schema number API accepts `NaN`, `Infinity`, and `-Infinity`. Use `Schema.Finite` ...

Checked 5 files out of 5 files.
1 errors, 0 warnings and 2 messages.
```

Exit codes verified [RUN]: **`EXIT_WITH_CANARY=1`, `EXIT_CLEAN=0`** — so it is a
real CI gate, not just editor sugar. GitHub Actions format also works [RUN]:

```
::error file=/tmp/effect-probe/src/canary.ts,line=2,col=46,endLine=2,endColumn=63,title=floatingEffect::This Effect value is neither yielded nor used in an assignment.
```

One environment wrinkle [RUN]: the first invocation failed with
`spawnSync .../@effect/tsgo-linux-x64/lib/tsc EACCES` — the shipped binary
wasn't executable after `npm install` (I had install scripts disabled). Fix:

```bash
chmod +x node_modules/@effect/tsgo-linux-x64/lib/tsc
```

Worth knowing for CI images that install with `--ignore-scripts`.

Diagnostics still read plugin config from `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "plugins": [{ "name": "@effect/language-service" }]
  }
}
```

[SRC] README options include `diagnostics`, `diagnosticSeverity` (per-rule:
`off|error|warning|message|suggestion`), `diagnosticsName`,
`missingDiagnosticNextLine`, `includeSuggestionsInTsc`,
`ignoreEffectWarningsInTscExitCode`, `ignoreEffectErrorsInTscExitCode`,
`ignoreEffectSuggestionsInTscExitCode`, `quickinfo`,
`quickinfoEffectParameters`, `quickinfoMaximumLength`, `completions`, `goto`,
`inlays`, `refactors`, `allowedDuplicatedPackages`, `barrelImportPackages`,
`namespaceImportPackages`, `topLevelNamedReexports`, `importAliases`,
`noExternal`, `keyPatterns`, `effectFn`, `layerGraphFollowDepth`,
`mermaidProvider`.

Per-line suppression, seen in Effect's own source [SRC]:
`// @effect-diagnostics-next-line floatingEffect:off`

### 6.4 svelte-check + TS 7

**RESOLVED — it works, but only with a TS6 + TS7 side-by-side install.**
Tested end-to-end in `/tmp/sc-probe` (svelte-check 4.7.4, svelte 5.56.8,
kit 2.70.1). My §6.1 concern was justified, and there is a supported fix.

[SRC] `svelte-check@4.7.4` peer deps are `typescript: "^5.0.0 || ^6.0.0"` —
TS 7 is **not** in the peer range.

[RUN] With only `typescript@7` installed, svelte-check **hard-crashes** before
checking anything:

```
Error: TypeScript 7 support currently requires both TypeScript 7 and TypeScript 6
installed in your project, and requires using the --tsgo or --tsgo-experimental-api
flag. You can setup both version with an npm alias via the following command.
npm install --save-dev typescript@~6 @typescript/native@npm:typescript@7
```

So the tool names its own remedy. Note the alias direction is the **opposite**
of what you'd guess: `typescript` stays on **6.x**, and TS 7 goes in under the
alias **`@typescript/native`**.

[RUN] Applying it resolves to `typescript 6.0.3` + `@typescript/native 7.0.2`:

```bash
pnpm add -D "typescript@~6" "@typescript/native@npm:typescript@7"
```

Then `svelte-check --tsgo` works, and it really is checking. Canary — a
deliberately broken component:

```svelte
<script lang="ts">
  let count: number = $state("not a number");
  const bad: string = 123;
</script>
```

produced:

```
/tmp/sc-probe/src/Bad.svelte:3:7
Error: Type 'string' is not assignable to type 'number'. (ts)

/tmp/sc-probe/src/Bad.svelte:4:9
Error: Type 'number' is not assignable to type 'string'. (ts)

svelte-check found 2 errors and 0 warnings in 1 file
```

Exit codes are a usable CI gate [RUN]: **errors → 1, clean → 0.**
`--tsgo-experimental-api` also ran clean; `--tsgo` is the safer default.

⚠️ **Cache gotcha [RUN]:** after deleting the bad component, svelte-check still
reported its 2 errors — sourced from a stale generated file at
`.svelte-check/svelte/src/++Bad.svelte.ts`, which briefly made a clean run look
like a failure. `rm -rf .svelte-check` cleared it and the run went to 0/exit 0.
Gitignore that directory and clear it in CI if you see errors for files that no
longer exist.

**Consequence: you cannot run a TS-7-only project.** TS 6 must be present for
svelte-check regardless, and `@effect/language-service` also requires TS 5/6
(§6.2). One coherent setup:

- `typescript@~6` → the real `tsc`; also what svelte-check and the Effect
  language-service editor plugin bind against;
- `@typescript/native@npm:typescript@7` → TS 7 native, driven via
  `svelte-check --tsgo`;
- `@effect/tsgo` → Effect semantic diagnostics on the TS 7 engine.

### 6.5 Suggested `check` script

Verified-compatible ordering and flags:

```jsonc
{
  "scripts": {
    "check": "svelte-kit sync && pnpm run check:types && pnpm run check:effect && pnpm run check:svelte",
    "check:types":  "tsc --noEmit",
    "check:effect": "effect-tsgo diagnostics --project tsconfig.json --format pretty",
    "check:svelte": "svelte-check --tsconfig ./tsconfig.json --tsgo",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "typescript": "~6",
    "@typescript/native": "npm:typescript@7",
    "@effect/tsgo": "^0.24.3",
    "@effect/language-service": "^0.87.1"
  }
}
```

`svelte-kit sync` first — it generates `$app/server` types and `./$types`, and
everything else fails without it. In CI use `--format github-actions` for
`check:effect` to get inline annotations. Note `check:types` runs TS **6**'s
`tsc` (that's what `typescript` resolves to); `check:effect` and `check:svelte`
are the ones exercising the TS 7 engine.

---

## 7. Effect v4 CLI module — verified by running it

Lives at **`effect/unstable/cli`**, inside core (see §1). Do not install
`@effect/cli` — it has no v4 release.

### Names changed from v3

| v3 (`@effect/cli`) | v4 (`effect/unstable/cli`) |
|---|---|
| `Options` | **`Flag`** |
| `Args` | **`Argument`** |
| `Command` | `Command` |
| `Prompt` | `Prompt` |

[SRC] The barrel exports: `Argument`, `CliConfig`, `CliError`, `CliOutput`,
`Command`, `Completions`, `Flag`, `GlobalFlag`, `HelpDoc`, `Param`,
`Primitive`, `Prompt`.

`Flag` constructors [SRC]: `string`, `boolean`, `integer`, `float`, `date`,
`choice`, `choiceWithValue`, `path`, `file`, `directory`, `redacted`,
`fileText`, `fileParse`, `fileSchema`, `keyValuePair`, `none`. Combinators:
`withAlias`, `withDescription`, `withMetavar`, `withHidden`, `optional`,
`withDefault`, `withFallbackConfig`, `withFallbackPrompt`, `map`, `mapEffect`,
`filter`, `filterMap`, `orElse`, `withSchema`, `atLeast`, `atMost`, `between`.

`Argument` has the same shape plus **`Argument.variadic`**.

`Prompt` [SRC]: `text`, `password`, `hidden`, `confirm`, `toggle`, `select`,
`multiSelect`, `autoComplete`, `integer`, `float`, `date`, `file`, `list`,
`custom`, `all`, `map`, `flatMap`, `succeed`, `run`.

### ⚠️ `withSubcommands` takes an ARRAY

This cost me a compile error — v3 took varargs, v4 takes a single array [SRC
`Command.ts:925`]:

```ts
Command.withSubcommands([upload, list, rm])   // ✅
Command.withSubcommands(upload, list, rm)     // ❌ TS2554
```

### Running it — `Command.run` + `NodeRuntime.runMain`

[SRC] `Command.run(command, { version })` returns
`Effect<void, E | CliError, R | Environment>` where
`Environment = FileSystem | Path | Terminal | ChildProcessSpawner | Stdio`.
`NodeServices.layer` supplies all of them.

### Minimal multi-subcommand CLI — this exact file runs

```ts
import { Console, Effect } from "effect"
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

const upload = Command.make("upload", {
  file: Argument.file("file", { mustExist: true }),
  key: Flag.string("key").pipe(Flag.optional),
  contentType: Flag.string("content-type").pipe(
    Flag.withDefault("application/octet-stream")
  )
}, (cfg) => Console.log(`uploading ${cfg.file} as ${cfg.contentType}`))
  .pipe(Command.withDescription("Upload a file"))

const list = Command.make("list", {
  limit: Flag.integer("limit").pipe(Flag.withDefault(50))
}, (cfg) => Console.log(`listing ${cfg.limit}`))
  .pipe(Command.withDescription("List files"))

const rm = Command.make("rm", {
  ids: Argument.string("ids").pipe(Argument.variadic)
}, (cfg) =>
  Effect.gen(function* () {
    const ok = yield* Prompt.confirm({ message: `Delete ${cfg.ids.length} files?` })
    if (!ok) return
    yield* Console.log("deleted")
  }))

const root = Command.make("adrive", {
  verbose: Flag.boolean("verbose").pipe(Flag.withAlias("v"))
}).pipe(
  Command.withDescription("a-drive CLI"),
  Command.withSubcommands([upload, list, rm])
)

Command.run(root, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
```

[RUN] `node --experimental-strip-types cli.ts --help`:

```
DESCRIPTION
  a-drive CLI

USAGE
  adrive <subcommand> [flags]

FLAGS
  --verbose, -v

GLOBAL FLAGS
  --help, -h                          Show help information
  --version, -v                       Show version information
  --wizard                            Start wizard mode for a command
  --completions <bash|zsh|fish|sh>    Print shell completion script
  --log-level <all|trace|debug|...>   Sets the minimum log level

SUBCOMMANDS
  upload    Upload a file
  list      List files
```

[RUN] Subcommands and parse errors both behave:

```
$ ... list --limit 7
list limit=7

$ ... upload foo.txt --key bar
upload file=foo.txt key={"_id":"Option","_tag":"Some","value":"bar"}

$ ... list --limit notanumber
(prints the `list` help with the flag listed)
```

You get `--wizard` and `--completions` for free.

### Streaming file upload from the CLI

`HttpBody.file(path)` streams from disk — it does **not** buffer the file
[SRC `unstable/http/HttpBody.ts:497`]:

```ts
export const file = (path: string, options?: {...})
  => Effect.Effect<Stream, PlatformError, FileSystem.FileSystem>
```

Internally it `fs.stat`s for `contentLength` and wraps `fs.stream(path)`. Full
upload command (typechecks clean under TS 7):

```ts
import { Config, Console, Effect, Redacted, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, HttpClientResponse
} from "effect/unstable/http"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

const UploadResult = Schema.Struct({ ok: Schema.Boolean, key: Schema.String })

const upload = Command.make("upload", {
  file: Argument.file("file", { mustExist: true }),
  key: Flag.string("key"),
  endpoint: Flag.string("endpoint").pipe(Flag.withDefault("https://a-drive.example")),
  token: Flag.redacted("token").pipe(
    Flag.withFallbackConfig(Config.redacted("ADRIVE_TOKEN"))
  )
}, (cfg) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const body = yield* HttpBody.file(cfg.file)   // streamed, not buffered
    const res = yield* client.execute(
      HttpClientRequest.put(`${cfg.endpoint}/api/files/${cfg.key}`, {
        body,
        headers: { authorization: `Bearer ${Redacted.value(cfg.token)}` }
      })
    )
    const out = yield* HttpClientResponse.schemaBodyJson(UploadResult)(res)
    yield* Console.log(`uploaded: ${out.key}`)
  }))

Command.run(upload, { version: "0.1.0" }).pipe(
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain
)
```

Two things worth copying from that: `Flag.redacted` keeps the token out of logs
(`Redacted.value` to unwrap), and `Flag.withFallbackConfig(Config.redacted(...))`
makes the flag optional when the env var is set. `Effect.provide([...])` accepts
an array of layers.

**Config/state persistence:** [?] I did not find a dedicated
"CLI config file" API. `Config` + `ConfigProvider` is the idiomatic route
(env vars, or a custom provider reading `~/.config/adrive/config.json`), and
core has `ini`/`toml`/`yaml` as dependencies, but I did not verify a supported
file-backed `ConfigProvider` constructor. Treat as unconfirmed.

---

## Open questions / gaps

Resolved since the first draft:

- ✅ **svelte-check + TS 7** — works via the TS6 + `@typescript/native` alias and `--tsgo` (§6.4), canary-verified.
- ✅ **D1 `batch()` atomicity** — confirmed verbatim from Cloudflare docs (§2).
- ✅ **Remote-function experimental flags** — still experimental, `@default false`, confirmed from installed kit types (§5.1).
- ✅ **`isValidationError`** — exists, exported from `@sveltejs/kit` (§5.3), handler compiles.

Still genuinely unknown — do not treat as settled:

1. **`SqlSchema` / `SqlResolver` / `SqlModel`** — these modules exist in `effect/unstable/sql` but I did not exercise their APIs. Read the source before use. They're the intended path for schema-validated rows, so worth a look before hand-rolling decode.
2. **Worker / R2 limits** — request body size, single-PUT max, multipart minimum part size, CPU limits, presigned-URL support from a binding. Not covered here at all; check <https://developers.cloudflare.com/workers/platform/limits/> and <https://developers.cloudflare.com/r2/platform/limits/>. This matters for a drive app — a Worker proxying large uploads may need multipart or direct-to-R2 presigned PUTs.
3. **adapter-cloudflare / wrangler.jsonc shape, `app.d.ts` Platform typing, local-dev story** — not covered (I only confirmed the adapter's `ambient.d.ts` declares `ctx`/`caches`/`cf` on `App.Platform` and deliberately does *not* type `env`, so you declare `env` yourself in `src/app.d.ts`).
4. **`@effect/language-service` in-editor with TS 6** — I confirmed the plugin rejects TS 7 and that `@effect/tsgo` covers CI, but I did not verify the editor plugin actually loads under TS 6.0.3 in this setup.
5. **Effect v4 beta churn** — everything here is pinned to `4.0.0-beta.102`. APIs demonstrably move between betas (`Layer.scoped` gone, `Schema.minLength` → `isMinLength`, no `asEffect`). Re-verify against source on any bump.
6. **Runed and Tailwind v4** — deliberately skipped per instruction.

## Reproduction artifacts

- `/tmp/effect-probe/` — effect beta.102 + sql-d1 + platform-node + TS 7 + tsgo.
  Probes: `probe-boundary.ts` (Worker per-request layers), `probe-d1-tx.ts`
  (transaction defect), `probe-stmt.ts` (parameter binding), `probe-runtime.ts`
  (layer build counts), `probe-schema2.ts` (v4 Schema), `probe-cli.ts` /
  `cli-run.ts` / `probe-upload.ts` (CLI).
- `/tmp/kit-probe/` — kit 2.70.1 + effect beta together; Standard Schema interop.
