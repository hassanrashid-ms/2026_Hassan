# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

The **Core API, agent console, admin console and web support surface** for Support CRM — a
multi-tenant customer support tool for mobile games. One of two repos:

| Repo | Contents |
|---|---|
| `2026_Hassan` (this one) | Core API + agent/admin console + web support surface |
| `2026_Hassan_Sdk` | Unity game-client SDK |

---

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | start all services |
| `pnpm test` | every package's suite; API suite needs Postgres up |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm db:setup` | idempotent; re-run after any schema change |
| `pnpm db:seed` | seed dev data |
| `SEED_SECRET=… ./scripts/verify-seam.sh` | proves the SDK seam end to end |

See `README.md` for the full getting-started sequence and `.env.example` for required env vars.

---

## Stack

| Layer | Choice |
|---|---|
| Repo | pnpm workspaces monorepo, shared `@support/types` as the SDK↔server contract |
| Server | Express 5 + TypeScript + Zod |
| Database | PostgreSQL 17 (`pgvector/pgvector:pg17`) — self-hosted, Docker |
| Access layer | Drizzle ORM + `drizzle-kit` migrations |
| Tenancy | Row-Level Security — one policy per scoped table, not an ORM hook |
| Realtime | Socket.io + `@socket.io/redis-adapter`, rooms per conversation |
| Jobs | BullMQ repeatable jobs |
| Files | S3 or Cloudflare R2, presigned PUT — never proxy uploads through Node |
| Bot retrieval | pgvector, HNSW index — same database |
| Console | Vite + React + TanStack Query + Tailwind + shadcn/ui |
| Charts | Recharts |

Two Docker services: Postgres and Redis. Redis is a queue and pub/sub bus, not a system of record.

---

## Architecture

```
Unity SDK ─┐
Web SDK ───┼──▶ Core API (Express, Socket.io, RLS workspace scoping)
Console ───┘         │
                     ├── PostgreSQL (relational + append-only events + pgvector)
                     ├── Redis + BullMQ (sockets, scheduled jobs)
                     └── Object storage (presigned uploads)
```

- **Support UI is a web app** — the Unity SDK is a thin shell that opens it with a signed token. Chat, bot, forms, articles all live here.
- **Token in URL fragment** (`#t=`) — never in the query string. Never reaches the server in a request line.
- **Workspace = one game.** RLS enforces tenant isolation at the database layer. Every scoped table has a policy; every request sets `app.workspace_id` for its transaction. Only `workspace` and `agent` tables are unscoped.
- **The SDK never holds a secret.** The game's own backend calls `POST /auth/player-token`.

---

## Folder structure

```
/
├── backend/
│   ├── src/
│   │   ├── routes/       express routers
│   │   ├── services/     business logic
│   │   ├── db/           drizzle schema + migrations
│   │   ├── jobs/         BullMQ workers
│   │   └── lib/          shared utilities
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── pages/        route-level components
│   │   ├── components/   shared UI
│   │   └── lib/          api client, hooks
│   └── package.json
├── packages/
│   └── types/            @support/types — shared SDK↔server contract
├── scripts/              dev and CI scripts
├── docs/
│   ├── project-overview.md   domain model, status machine, decisions, metrics
│   ├── specs/                wire contract, schema, ERD
│   └── decisions/            ADRs and spec contradictions
└── docker-compose.yml
```

---

## Rules

### Tenancy
- Every scoped table has an RLS policy. Every request sets `app.workspace_id` via `select set_config('app.workspace_id', $1, true)` — **not** `SET LOCAL ... = $1` (syntax error).
- RLS does not bind the table owner — use `FORCE ROW LEVEL SECURITY` or connect as non-owner role (`support_app`).
- FK checks bypass RLS. Any client-supplied id used as a FK must be confirmed visible with an explicit scoped `SELECT` first.
- Expect `404` not `403` from RLS — "not yours" and "not there" are indistinguishable.

### Data integrity
- **No hard deletes anywhere. Don't even write the route.** Enforce with `ON DELETE RESTRICT`.
- **Nothing is deleted** — not a message, not a conversation, not a subintent.
- All state changes go through one function that writes both `conversation` and `event` in a single transaction. Never ad-hoc updates.
- Payload values in events are snapshotted, never live pointers.
- Enforce `event` table append-only with `REVOKE UPDATE, DELETE`, not a convention.

### Security
- **Internal notes must never reach a player.** Use two serializers: `toAgentView` and `toPlayerView`. Player serializer is an explicit field whitelist. Player-facing routes may only call the player serializer.
- Emit to `conv:{id}:agents` and `conv:{id}:player` as separate Socket.io rooms.
- **Signing a presigned GET must check `message.visibility`.** Walk `attachment → message → visibility` and refuse for player tokens.
- **Permission checks run at the API.** Hiding a control in the UI is not enforcement.

### SDK wire contract
- **Frozen: add response fields freely, never remove or retype one.** Shipped Unity builds sit in app stores for years.
- `POST /sdk/sessions/start` is idempotent via `ON CONFLICT (id) DO NOTHING` on session id — the SDK generates the id, duplicate delivery is expected.

### General
- Missing player state is a state, not an error — never reject a conversation because of it.
- Treat `state.raw` as PII by default.
- `abandoned` status does not exist. Don't reintroduce it.
- `is_required` on form fields is soft — re-ask once, then move on. Never block on a required field.
- Bot containment is reported, never a goal.
