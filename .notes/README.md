# .notes

Planning and research for adrive, written before any code existed. Kept in the
repo because the research is expensive to reproduce and several findings are
non-obvious enough that rediscovering them mid-build would cost real time.

| File | What it is | Read it when |
|---|---|---|
| [plan.md](plan.md) | The implementation plan — architecture, schema, build order, verification | Starting any phase |
| [decisions.md](decisions.md) | The locked product contract; every scoping answer and why | Any question of "what should this do?" |
| [stack-research.md](stack-research.md) | Effect v4 + SvelteKit + D1, verified by installing the betas and compiling probe code | Writing Effect, D1, remote functions, or CLI code |
| [search-research.md](search-research.md) | Hybrid search design — FTS5, Vectorize, RRF, chunking. 81 verified claims | Touching search or indexing |
| [cf-limits.md](cf-limits.md) | Cloudflare Workers/R2/D1 limits with sources | Touching the upload path |

## Conventions in the research files

Claims are marked by how they were established:

- **[VERIFIED]** / **[SRC]** / **[RUN]** — confirmed from primary source, or by
  actually running code. Trust these.
- **[INFERRED]** — reasoned from verified facts. Probably right.
- **[?]** / **[UNCONFIRMED]** — not established. **Do not design against these
  without checking**; each research file lists its open items at the end.

## The five findings most likely to save you a bad afternoon

1. **D1 has no transactions and `withTransaction` is a defect, not a typed error** —
   the typechecker won't stop you. Use the raw binding's `db.batch()`.
2. **Awaiting `pipeTo` before `bucket.put()` deadlocks.** Kick off the pipe, then
   `Promise.all`. Also makes `wrangler dev` match production.
3. **FTS5 `MATCH` input must be sanitized** — a query containing `"` or `:` is
   otherwise a 500 on ordinary user input.
4. **`wrangler d1 export` cannot export a DB with virtual tables**, and a failed
   export can wedge the database. FTS stays pure derived state with a rebuild path.
5. **Vectorize bills every query as a full index scan** — roughly six searches per
   month on the free tier once the index grows. The keyword tier must always work
   alone.

Effect v4 is beta and its APIs move between releases. Everything here is pinned to
`4.0.0-beta.102`; re-verify against source on any bump.
