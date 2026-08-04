# Support CRM — App

Core API, agent console and web support surface for **Support CRM**, a multi-tenant customer
support tool for mobile games. A player opens support inside the game, reads help articles,
describes a problem to a bot in their own words, and reaches a human when they need one. Agents
work the resulting conversations in a web console.

The Unity game-client SDK lives in the companion repo,
[`2026_Hassan_Sdk`](https://github.com/hassanrashid-ms/2026_Hassan_Sdk).

> **Status: scaffold.** The stack and architecture are decided and written up (see
> [`CLAUDE.md`](CLAUDE.md) and the SDK repo's `docs/specs/overview+sdk.md`), but no application code
> exists yet. `frontend/` and `backend/` are empty. Nothing below the *Planned stack* section is
> installed.

**One workspace = one game.** Nothing is shared between workspaces — not content, categories,
forms, players or issues. Multiple games are expected.

## Architecture

```
Unity SDK ─┐
Web SDK ───┼──▶ Core API (Express, Socket.io, RLS workspace scoping)
Console ───┘         │
                     ├── PostgreSQL (relational + append-only events + pgvector)
                     ├── Redis + BullMQ (sockets, scheduled jobs)
                     └── Object storage (presigned uploads)
```

Two decisions drive most of the design:

**The support UI is built once as a web app.** Every platform's SDK is a thin shell that opens it
with a signed token. So the chat thread, image upload, article browsing, the bot conversation and
the forms all live in *this* repo's web surface — not duplicated in C#, JS, Kotlin and Swift.

**Reporting is event-sourced.** Resolution counts events rather than current status, and a reopen
starts a new resolution cycle, so neither can be derived from a conversation's `status` field. Every
state change appends to an append-only `event` table and all reporting is an aggregation over it.
Resolution state lives on its own `resolution_cycle` rows for the same reason — a conversation can
resolve more than once, and each resolution counts in the window it happened.

## Planned stack

| Layer | Choice |
|---|---|
| Repo | pnpm workspaces monorepo, shared `@support/types` as the SDK↔server contract |
| Server | Express 5 + TypeScript + Zod (schemas double as validation and types) |
| Database | **PostgreSQL 17** (`pgvector/pgvector:pg17`) — self-hosted, Docker |
| Access layer | **Drizzle ORM** + `drizzle-kit` migrations |
| Tenancy | **Row-Level Security** — one policy per scoped table |
| Realtime | Socket.io + `@socket.io/redis-adapter`, rooms per conversation |
| Jobs | BullMQ repeatable jobs |
| Files | S3 or Cloudflare R2, presigned PUT — never proxy uploads through Node |
| Bot retrieval | **pgvector**, HNSW index — same database |
| Console | Vite + React + TanStack Query + Tailwind + shadcn/ui |
| Charts | Recharts |

Deployment is **self-hosted, Docker only** — two services, Postgres and Redis. The schema is 32
tables, specced in [`docs/specs/2026-08-04-database-and-schema-design.md`](docs/specs/2026-08-04-database-and-schema-design.md)
with diagrams in [`docs/specs/erd.html`](docs/specs/erd.html). The database choice reverses an earlier
written decision; rationale in [`docs/decisions/2026-08-04-postgresql-over-mongodb.md`](docs/decisions/2026-08-04-postgresql-over-mongodb.md).

## Getting started

```bash
git clone git@github.com:hassanrashid-ms/2026_Hassan.git
```

There is nothing to install yet — no `package.json`, no workspace manifest, no environment
template. The first task is scaffolding the pnpm workspace; see **Build order** below.

Once scaffolded, this section should carry the real commands (`pnpm install`, dev servers, test
runner, single-test invocation) and the required environment variables. Until then, treat any such
command you find in a doc as aspirational.

## Repository layout

```
frontend/    console (agent-facing) and web support surface (player-facing)
backend/     Core API — Express, Socket.io, Drizzle schema + migrations, BullMQ workers
docs/
  specs/         architecture and API specs
  plans/         implementation plans (YYYY-MM-DD-*.md)
  decisions/     ADRs
  meeting-notes/ YYYY-MM-DD-*.md
CLAUDE.md    guidance for Claude Code — the server-side decision record
```

Product requirements live one level up in `mindstorm/crm/Docs/` — the spec PDF and the
delivery-slices doc — deliberately shared between both repos rather than committed to either. Where
they and any in-repo doc disagree, the spec wins.

## Build order

Ten macro components across three weeks, per the delivery-slices doc:

| Week | Slice | Components |
|---|---|---|
| 1 | 1 | Game SDK · Chat · Bot · Knowledge Base · Tickets |
| 2 | 2 | Intents · Forms |
| 3 | 3 | Ticket View · Game View · Admin Console |

Week 1 is built in sequence rather than five-way parallel:

1. **Days 1–3 — the spine.** Drizzle schema + first migration, RLS policies on every scoped table,
   agent auth, player-token auth, the `event` table. No UI. `POST /conversations` and `POST /messages`
   with correct sequencing and correct tenant isolation. The cross-workspace isolation test is written
   here, not later — authenticate as workspace A, hit every endpoint with workspace B's IDs, expect
   `404`.
2. **Days 4–7 — the core loop end to end.** Player message from a crude page → crude agent inbox →
   agent reply → player sees it. Ugly is fine. If this loop doesn't work, nothing else matters, so
   it ships before the bot is touched.
3. **Rest of week 1 — Bot and Knowledge Base.** Build the *handoff* path first and the clever part
   second: a bot that always says "let me get someone" is a working system, while a clever bot with
   no fallback is broken.

## What must be true, regardless of implementation

These are product requirements from the spec, not preferences:

- **Nothing may prevent a player reaching a human.** Asking for a person redirects immediately — no
  turn limit, no failed answer first. Bot error, timeout or disabled state creates the conversation
  unclassified and auto-assigns it. Refusing a form still hands off, marked form-skipped.
- **Failure is never silent.** The player sees no error; support is alerted.
- **Nothing is deleted** — not a message, not a conversation, not a subintent. Corrections are made
  by adding. No hard-delete route should even be written.
- **Internal notes must never reach a player.** The spec calls this safety-critical.
- **No request ever reads across two workspaces.**
- **Writing something and putting it in front of players are separate acts by different people.**
  Team Leads draft; only Admins publish.
- **Self-serve is counted per session, never per ticket.** Per-ticket improves whenever filing gets
  harder — better number, worse product.
- **First reply means first *human* reply.** Bot, system and internal notes don't count.
- **Player-confirmed and timed-out resolutions are reported separately.** Folded together, silence
  counts as success and the rate rises fastest when support is worst.

## License

Proprietary — Mindstorm Studios.
