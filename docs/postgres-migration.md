# Postgres Migration Path (PLAN — needs a deliberate greenlight)

> **Status: PLAN ONLY.** This document is the honest map of *what it would take*
> to move Donor Scout's data layer from `better-sqlite3` to PostgreSQL. It is
> **not** a task to start blind. It is a large, risky, cross-cutting rewrite that
> touches nearly every request handler in `server.js`. Read the cost section
> before scheduling it, and decide explicitly between **"migrate to Postgres"**
> and the cheaper **"stay on SQLite + add a durability story"** alternative.

This is roadmap item **P1-5** (Postgres migration path + observability). The
**observability** half is already shipped (`/healthz`, `/readyz`, structured
request logging — see [containerization.md](./containerization.md)); this doc is
the Postgres half.

---

## Why this is hard (read this first)

The whole backend is a single ~4,900-line ESM file (`server.js`) talking to
`better-sqlite3` with **synchronous** prepared statements. Concretely, today:

- **~192** `db.prepare(...)` sites,
- **~374** synchronous `.get()` / `.all()` / `.run()` executions,
- **17** `db.transaction(fn)` blocks that wrap multi-statement writes,

…all written in the synchronous style that `better-sqlite3` makes possible:

```js
// Synchronous — runs inline, returns the row, throws on error.
const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const tx = db.transaction((rows) => { for (const r of rows) insert.run(r); });
tx(rows);
```

**Every mainstream Postgres driver is asynchronous** (`pg`, `postgres`/postg.js,
Prisma, Knex, Drizzle). There is no synchronous Postgres client for Node. So the
migration is not "swap the connection string" — it is:

1. **Every query site becomes `await`.** ~374 call sites change shape, and every
   function that contains one becomes `async`, which **propagates up the call
   stack** — route handlers, helpers like `orgScope`/`teamPayload`/`scoreProspect`,
   and anything they call. Async colors the whole codebase.
2. **`db.transaction(fn)` has no async equivalent.** better-sqlite3's transaction
   helper relies on synchronous execution. With `pg` you must explicitly
   `BEGIN` / `COMMIT` / `ROLLBACK` on a **dedicated client checked out of the
   pool**, and thread that client through every statement in the transaction.
   The 17 transaction blocks each need careful manual rewriting (and the routes
   that call them become async).
3. **SQL dialect differences.** SQLite is forgiving; Postgres is strict:
   - Placeholders `?` → `$1, $2, …`.
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL`/`GENERATED … AS IDENTITY`.
   - SQLite stores booleans/timestamps as ints/text; Postgres has real `BOOLEAN`,
     `TIMESTAMPTZ`, `JSONB`. Every `is_active`, `created_at`, `score_reasons`
     (JSON-in-TEXT) column needs a typed target and a cast.
   - `INSERT … ON CONFLICT` upserts, `datetime('now')` → `now()`, `RETURNING`
     semantics, `LIKE` case-sensitivity, etc.
   - `lastInsertRowid` (better-sqlite3) → `RETURNING id`.
4. **Concurrency model flips.** Single-file SQLite serializes writers (WAL helps
   readers); Postgres is genuinely concurrent. Code that quietly relied on
   single-writer serialization may need explicit locking or `SELECT … FOR UPDATE`.
5. **The test harness assumes synchronous boot + an isolated file DB.**
   `test/helpers.js` sets `DATA_DIR` to a temp dir and imports `server.js`, which
   opens the DB **at import time, synchronously**. Postgres needs an async
   connection (and a running server), so the harness's boot model changes too.

None of these is individually exotic. The cost is **breadth and risk**: a
mechanical-but-pervasive async rewrite across the entire request surface, where a
missed `await` is a silent data bug, not a crash.

---

## Recommended approach: a data-access abstraction, migrated incrementally

**Do not** do a big-bang find-and-replace of `db.prepare` across 4,900 lines.
Instead, **decouple the application from `better-sqlite3` first**, behind a small
repository/data-access layer, and migrate behind that seam.

### Step 0 — Introduce a repository seam (still on SQLite)

Create `lib/db/` exposing an **async-shaped** interface, even while the
implementation is still synchronous better-sqlite3 under the hood:

```js
// lib/db/index.js — the seam. Today backed by better-sqlite3 (sync), but the
// surface is async so callers can be ported once and never again.
export const repo = {
  async getUser(id) { return sqlite.prepare('SELECT * FROM users WHERE id=?').get(id); },
  async listConnections(orgId, userId) { /* ... */ },
  async inTransaction(fn) { /* sqlite: db.transaction(fn)(); pg: BEGIN/COMMIT */ },
  // ...one method per query the app actually performs.
};
```

Because better-sqlite3 is synchronous, an `async` wrapper around it is trivially
correct (it just resolves immediately). This lets us **make the whole app `await`
the data layer *while still on SQLite*** — the safe, test-covered half of the
async migration — **without** a database swap. Ship that, prove the 124 tests
still pass, and the risky part (the actual Postgres driver) is now isolated to
**one module** instead of 374 call sites.

This is the Repository pattern doing exactly its job: the application depends on
an interface, not on `better-sqlite3`. (It pairs naturally with the existing
Strategy and Adapter patterns already in the codebase — `lib/strategies/`,
`lib/mailer.js`.)

### Step 1 — Add a Postgres implementation of the same seam

Implement `lib/db/pg.js` against `pg` (node-postgres) with a connection pool,
selected by an env (`DATABASE_URL` present → Postgres; else SQLite). Both
implementations satisfy the same `repo` contract and the same test suite.

### The alternative: stay on SQLite, add durability (often the right P1 answer)

A migration to Postgres is justified by **write concurrency at scale** and
**operational maturity** (managed backups, read replicas, connection pooling,
multiple app instances sharing one DB). If the actual P1 driver is just *"we
can't lose donor data and we need to host this"* (roadmap **P0-2**), the far
cheaper path is to **keep SQLite and add a durability layer**:

- **[Litestream](https://litestream.io/)** — continuous streaming replication of
  the SQLite file to S3/object storage. Near-zero app changes; point-in-time
  restore; runs as a sidecar. Solves "don't lose the data on the mounted volume."
- **[LiteFS](https://fly.io/docs/litefs/)** — a FUSE filesystem giving SQLite
  replication + read replicas across instances (Fly-oriented).

**When each makes sense:**

| Situation | Choose |
| --- | --- |
| Early tenants, single app instance, "don't lose data" + hosting is the real need | **Stay on SQLite + Litestream.** Cheap, low-risk, hits P0-2. |
| Many concurrent writers per org, need multiple app instances sharing one DB, managed HA/replicas, analytics load | **Migrate to Postgres** via the seam above. |
| Unsure | Ship the **repository seam (Step 0)** now (it's valuable either way and de-risks both paths), keep SQLite + Litestream, and migrate to Postgres only when write-concurrency or multi-instance needs are *demonstrated*, not assumed. |

The honest recommendation: **build the seam, adopt Litestream for durability now,
and treat the full Postgres swap as demand-driven** — do not pay the async-rewrite
cost speculatively.

---

## Architecture: current vs. target

```mermaid
flowchart LR
  subgraph Current["CURRENT — synchronous, single-file"]
    R1["Route handlers + helpers\n(~192 db.prepare, ~374 .get/.all/.run,\n17 db.transaction — all SYNC, inline)"]
    S1[("better-sqlite3\n(sync, WAL)\ndata/scout.db")]
    R1 -- "sync calls, no await" --> S1
  end

  subgraph Target["TARGET — async behind a repository seam"]
    R2["Route handlers + helpers\n(all await repo.*)"]
    REPO["lib/db — repository seam\n(async interface; inTransaction())"]
    IMPL1["sqlite impl\n(better-sqlite3 + Litestream backup)"]
    IMPL2["postgres impl\n(pg pool, BEGIN/COMMIT,\n$1 placeholders, RETURNING)"]
    R2 -- "await" --> REPO
    REPO -. "DATABASE_URL unset" .-> IMPL1
    REPO -. "DATABASE_URL set" .-> IMPL2
    IMPL1 --> S2[("SQLite (WAL)\n+ S3 via Litestream")]
    IMPL2 --> PG[("PostgreSQL\n(managed, pooled, HA)")]
  end

  Current ==>|"Step 0: introduce seam (still SQLite),\nthen Step 1: add pg impl"| Target
```

---

## Phased plan

| Phase | Work | Exit criteria |
| --- | --- | --- |
| **0. Seam (still SQLite)** | Carve `lib/db/` with an async interface + `inTransaction()`; port all ~374 call sites to `await repo.*`; make affected helpers/handlers `async`. Implementation is still better-sqlite3 under the async wrapper. | 124 tests still green; `node --check` + boot smoke pass; no behavior change. **This is the bulk of the async cost, done safely on SQLite.** |
| **1. Durability now** | Add Litestream replication of the SQLite file to object storage in the container/host (P0-2). | Verified restore from object storage in staging. |
| **2. PG implementation** | Implement `lib/db/pg.js` against `pg`; author the Postgres schema (typed columns, `BIGSERIAL`, `TIMESTAMPTZ`, `JSONB`); translate dialect (`$n`, `ON CONFLICT`, `RETURNING`); rewrite the 17 transactions as pooled `BEGIN/COMMIT/ROLLBACK`. Env-select via `DATABASE_URL`. | Full suite passes against a Postgres service in CI (see below). |
| **3. Data migration** | One-time export from SQLite → load into Postgres with type coercion + sequence reset (see below). | Row counts + spot-check parity per table; FK integrity holds. |
| **4. Cutover** | Run both in staging; flip `DATABASE_URL` in production behind a maintenance window; keep the SQLite file as a warm rollback. | Production healthy on Postgres; `/readyz` green; error rates flat. |
| **5. Cleanup** | Remove the SQLite impl (or keep it for local dev/tests), document the new runbook. | Single documented prod path. |

---

## Testing strategy (Postgres service in CI)

- **Keep the offline SQLite suite as-is** for fast local/dev runs — the seam means
  the same `node:test` suites run against either backend.
- **Add a CI job** that boots a Postgres service container and runs the **same**
  124 tests against the `pg` implementation:
  ```yaml
  # GitHub Actions sketch
  services:
    postgres:
      image: postgres:16
      env: { POSTGRES_PASSWORD: test, POSTGRES_DB: scout_test }
      ports: ["5432:5432"]
      options: >-
        --health-cmd "pg_isready" --health-interval 5s --health-retries 5
  # test step sets DATABASE_URL=postgres://postgres:test@localhost:5432/scout_test
  ```
- `test/helpers.js` becomes backend-aware: when `DATABASE_URL` is set, connect to
  Postgres and **truncate/create a throwaway schema per run** instead of a temp
  file `DATA_DIR`. The async boot replaces the synchronous import-time open.
- **Parity gate:** the whole suite must pass on **both** backends before cutover —
  that equality is the migration's correctness proof.

---

## Data migration (one-time)

1. Quiesce writes (maintenance window) so the SQLite file is consistent.
2. Create the Postgres schema (typed: `BOOLEAN`, `TIMESTAMPTZ`, `JSONB`, identity
   columns) — tables: `organizations`, `org_config`, `users`, `connections`,
   `referrals`, `teams`, `code_x_impact`, `contact_history`, `voice_profiles`,
   `ai_usage`, `identities`, `magic_link_tokens`, `invitations`, `audit_log`,
   `org_idp_config`, `org_domains`, `follow_up_reminders`, `sessions`.
3. Export each table from SQLite and load into Postgres with **type coercion**:
   `0/1` → `BOOLEAN`, text timestamps → `TIMESTAMPTZ`, JSON-in-TEXT
   (`score_reasons`, `strategy_weights`) → `JSONB`.
4. **Reset sequences** to `MAX(id)+1` per table (SQLite rowids don't carry over).
5. Verify: per-table row counts match, FK integrity holds, spot-check a few orgs
   end-to-end (a scout's connections + referrals + impact).
6. Sessions: simplest is to **let sessions expire** (users re-login) rather than
   migrate the session store; swap the `express-session` store to a PG-backed one.

---

## Risks + rollback

- **Risk: missed `await`.** A forgotten `await` returns a `Promise` instead of a
  row — a silent logic bug, not a crash. *Mitigation:* the parity test gate on
  both backends; lint rules (`no-floating-promises`-style); code review of the
  seam port.
- **Risk: transaction semantics drift.** A transaction split across pooled
  statements without a dedicated client loses atomicity. *Mitigation:*
  `inTransaction()` checks out one client and threads it; test concurrent writes.
- **Risk: dialect bugs** (datetime, boolean, JSON, upsert). *Mitigation:* typed
  schema + parity suite catches most; spot-check date/JSON columns.
- **Risk: concurrency assumptions** that held under single-writer SQLite. *Mitigation:*
  audit write paths; add `FOR UPDATE` / unique constraints where needed.
- **Rollback:** the migration is **gated** at every phase. Steps 0–1 ship value
  with **zero** Postgres dependency and are independently revertable. At cutover
  (Phase 4) the SQLite file is retained as a **warm standby**: flipping
  `DATABASE_URL` back (within the window, before new writes accumulate) reverts
  to SQLite. After the window, rollback means restoring from the Litestream/PG
  backup.

---

## Rough effort

| Phase | Effort | Notes |
| --- | --- | --- |
| 0. Seam + async port (SQLite) | **L** (the big one) | ~374 call sites + ~17 transactions + cascading `async`; mechanical but pervasive and risky. Done under the existing tests. |
| 1. Litestream durability | **S** | Sidecar + config; little/no app change. Often the *actual* P1 need. |
| 2. PG implementation | **M–L** | Schema, dialect, pooled transactions, env-select, CI parity. |
| 3. Data migration script | **S–M** | One-time, type coercion + sequence reset. |
| 4. Cutover + 5. cleanup | **S** | Maintenance window, monitoring, warm rollback. |

**Bottom line:** the expensive, risky work is the **synchronous→async port
(Phase 0)** — and that work is valuable *regardless* of whether Postgres ever
lands, because it decouples the app from `better-sqlite3`. Ship the seam, get
durability via Litestream now, and pull the trigger on the full Postgres swap
**only when write-concurrency / multi-instance demand is demonstrated** — with an
explicit greenlight, not blind.
