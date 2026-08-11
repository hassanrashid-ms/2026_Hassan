# Support CRM — App

Core API, agent console and web support surface for **Support CRM**, a multi-tenant customer
support tool for mobile games. A player opens support inside the game, reads help articles,
describes a problem to a bot in their own words, and reaches a human when they need one. Agents
work the resulting conversations in a web console.

The Unity game-client SDK lives in the companion repo,
[`2026_Hassan_Sdk`](https://github.com/hassanrashid-ms/2026_Hassan_Sdk).

> **Status: the SDK seam is built.** Steps 1–3 of the wire contract's build order (see
> [`docs/specs/2026-08-04-sdk-wire-contract.md`](docs/specs/2026-08-04-sdk-wire-contract.md#build-order)
> — not the *Build order* section below, which uses different numbering) are done:
> `POST /auth/player-token`, the four `/sdk/*` endpoints, `GET /surface/bootstrap` and
> `POST /surface/events/article_read`, the session-timeout worker, and a deliberately-ugly
> web surface stub. Ten of the 33 specced tables exist; see
> [`docs/decisions/2026-08-04-sdk-path-schema-subset.md`](docs/decisions/2026-08-04-sdk-path-schema-subset.md).
> Item **2** below ("The SDK seam") is what this covers; item **3** ("The core loop end
> to end" — conversations and messages) has not started.

**One workspace = one game.** Nothing is shared between workspaces — not content, categories,
forms, players or issues. Multiple games are expected.

## Architecture

```
Unity SDK ─┐
Web SDK ───┼──▶ Core API (Express, Socket.io, RLS workspace scoping)
Console ───┘         │
                     ├── PostgreSQL (relational + append-only events)
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
| Database | **PostgreSQL 17** — self-hosted, Docker |
| Access layer | **Drizzle ORM** + `drizzle-kit` migrations |
| Tenancy | **Row-Level Security** — one policy per scoped table |
| Realtime | Socket.io + `@socket.io/redis-adapter`, rooms per conversation |
| Jobs | BullMQ repeatable jobs |
| Files | S3 or Cloudflare R2, presigned PUT — never proxy uploads through Node |
| Bot retrieval | **Weaviate Cloud**, BM25 (see `docs/specs/2026-08-07-weaviate-faq-search-design.md`) |
| Console | Vite + React + TanStack Query + Tailwind + shadcn/ui |
| Charts | Recharts |

Deployment is **self-hosted, Docker only** — two services, Postgres and Redis. The full schema is 33
tables, specced in [`docs/specs/2026-08-04-database-and-schema-design.md`](docs/specs/2026-08-04-database-and-schema-design.md)
with diagrams in [`docs/specs/erd.html`](docs/specs/erd.html) — ten are built so far, see **What
exists** below. The database choice reverses an earlier written decision; rationale in
[`docs/decisions/2026-08-04-postgresql-over-mongodb.md`](docs/decisions/2026-08-04-postgresql-over-mongodb.md).

## Getting started

```bash
git clone git@github.com:hassanrashid-ms/2026_Hassan.git
cd 2026_Hassan
cp .env.example .env                 # then set PLAYER_JWT_SECRET (32+ chars) and
                                      # WEAVIATE_URL/WEAVIATE_API_KEY (Weaviate Cloud) — API won't boot without them
docker compose up -d                 # Postgres 17 + Redis 7
pnpm install
pnpm db:setup                        # extensions → drizzle-kit push → RLS
pnpm db:seed                         # prints the workspace secret ONCE — save it
pnpm dev                             # api on :4000, web surface on :5173
```

| Command | What it does |
|---|---|
| `pnpm test` | every package's suite; the API's needs Postgres up |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm db:setup` | idempotent; re-run after any schema change |
| `pnpm db:studio` | launch Drizzle Studio GUI DB dashboard (http://local.drizzle.studio) |
| `http://localhost:4000/docs` | interactive Swagger UI API documentation |
| `http://localhost:4000/docs/json` | raw OpenAPI 3.0 specification JSON |
| `SEED_SECRET=… ./scripts/verify-seam.sh` | proves the SDK seam end to end against a running API |

Tests run against `support_test`, created automatically. `globalSetup` refuses any database whose
name does not end in `_test`, so pointing the suite at a real database is not possible by accident.

## What exists

Steps 1–3 of the [wire contract's build order](docs/specs/2026-08-04-sdk-wire-contract.md#build-order)
(a different numbering than the *Build order* section below): `POST /auth/player-token`, the four
`/sdk/*` endpoints, `GET /surface/bootstrap`, `POST /surface/events/article_read`, the 30-minute
session-timeout job, and a deliberately-ugly web surface stub. Ten of the 33 tables — see
[`docs/decisions/2026-08-04-sdk-path-schema-subset.md`](docs/decisions/2026-08-04-sdk-path-schema-subset.md).
Full implementation plan and rationale in
[`docs/plans/2026-08-04-app-side-sdk-seam.md`](docs/plans/2026-08-04-app-side-sdk-seam.md).

**Not built:** conversations, messages, the bot, the taxonomy, forms, the agent console, the admin
console, reporting. Item 3 ("The core loop end to end") of the *Build order* section below.

## Owed

- **Nothing watches `sdk_incident`.** The write path exists; alerting does not. A rising count is how
  you learn a release broke support entry for a whole platform, so an unwatched stream is the silent
  failure it was built to prevent. Until then, this query is the manual check:

  ```sql
  select date_trunc('hour', occurred_at) as hour,
         payload->>'kind' as kind, count(*)
    from event
   where type = 'sdk_incident' and occurred_at > now() - interval '24 hours'
   group by 1, 2 order by 1 desc;
  ```

- **`GET /surface/bootstrap` returns `raw` outside production.** Remove that branch when the real
  chat UI lands; the agent Game View is what reads freeform state.
- **Agent auth is not built.** `agent` carries a Google identity (`email`, `google_subject`) and no
  password, per [`docs/decisions/2026-08-04-agent-auth-google-oauth.md`](docs/decisions/2026-08-04-agent-auth-google-oauth.md).
  The OAuth flow — client registration, callback, token verification, the **mindstormstudios.com org
  check**, session issuance and the Redis denylist — ships with the console slice and needs its own
  plan. The seeded admin row has a null `google_subject` until that person's first real login.

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

Week 1 is built in sequence rather than five-way parallel. Full detail in
[`docs/specs/2026-08-04-sdk-wire-contract.md`](docs/specs/2026-08-04-sdk-wire-contract.md).

1. **The spine.** Drizzle schema + first migration, RLS policies on every scoped table, agent auth,
   the `event` table, seeded workspace and `Other` taxonomy. No UI. The cross-workspace isolation test
   is written here, not later — authenticate as workspace A, hit every endpoint with workspace B's IDs,
   **expect `404`, not `403`** (under RLS the rows are invisible, so the handler cannot tell "not
   yours" from "not there").
2. **The SDK seam.** `POST /auth/player-token` plus the four `/sdk/*` endpoints, then a deliberately
   ugly web stub that reads the token from the URL fragment, renders the player's state and calls
   `SupportBridge.post({type:'close'})`, then the real `Assets/Support/` SDK pointed at it. **This
   comes before the chat loop on purpose:** the seam spans both repos — token issuance, the fragment
   handoff, snapshot delivery, the bridge, session end — and it is where the surprises live. Prove it
   while it is still cheap to change.
3. **The core loop end to end.** `POST /conversations` and `POST /messages` with correct sequencing and
   tenant isolation. Player message from a crude page → crude agent inbox → agent reply → player sees
   it. Ugly is fine. If this loop doesn't work, nothing else matters, so it ships before the bot is
   touched.
4. **Bot and Knowledge Base.** Build the *handoff* path first and the clever part second: a bot that
   always says "let me get someone" is a working system, while a clever bot with no fallback is broken.

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
