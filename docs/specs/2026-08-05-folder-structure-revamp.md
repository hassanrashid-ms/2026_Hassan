# Folder structure revamp — backend & frontend

Status: approved design, not yet implemented.

## Why

Backend currently mixes route-handling, business logic, and DB access in one file per
route, split only by vertical (`sdk/`, `surface/`). There's no home yet for the
agent/admin console that CLAUDE.md already describes as part of this repo. Frontend is
flat — one file each for the api client, bridge messaging, and the single screen — with
no room to grow into pages/components/services as the agent console gets built.

This is a pure structural refactor: same routes, same request/response shapes, same
middleware, same status codes. Nothing here changes runtime behavior.

Scope: the `app` repo (`2026_Hassan`) only. The Unity SDK repo (`2026_Hassan_Sdk`) is
untouched.

## Backend

### Top-level layout

```
backend/src/
├── agent/          # agent/admin console API — scaffolded now, empty until that work starts
│   ├── models/
│   ├── controllers/
│   ├── services/
│   └── routers/
├── surface/             # player-facing web support widget API
│   ├── models/
│   ├── controllers/
│   ├── services/
│   └── routers/
├── sdk/                 # Unity/Web SDK wire-contract API
│   ├── models/
│   ├── controllers/
│   ├── services/
│   └── routers/
├── shared/
│   ├── db/              # ← db/ (client, schema/, seed, setup, withWorkspace) — pure move
│   ├── auth/            # ← auth/ (playerToken, playerTokenRoute, workspaceSecret)
│   ├── middleware/      # ← auth/ (requirePlayerToken, requireSdkHeaders)
│   ├── jobs/            # ← jobs/ (queue, sessionTimeout)
│   ├── events/          # ← events/ (appendEvent)
│   └── playerState/     # ← playerState/ (declaredKeys, split)
├── app.ts               # stays at root — wires the three verticals' routers, unchanged mount paths
├── server.ts
├── env.ts
├── env/
└── errors.ts
```

`agent/` is scaffolded (four empty subfolders) so the next feature work has a home
immediately, per the earlier decision that no agent-console backend code exists yet.

`shared/auth/playerTokenRoute.ts` (the `/auth/player-token` router) moves under
`shared/auth/` as-is — it's called by the game's own backend, not by any of the three
verticals, so it isn't itself a vertical. `app.ts` keeps
`app.use('/auth', playerTokenRouter)` unchanged.

`shared/auth/` and `shared/middleware/` are a deliberate split, not one bucket: `auth/` holds
token issuance and verification (`playerToken`, `playerTokenRoute`, `workspaceSecret`) —
code that *produces* or *checks* credentials. `middleware/` holds the Express
`RequestHandler`s that *gate* a request using those credentials
(`requirePlayerToken`, `requireSdkHeaders`) — code that plugs into a router's `.use()`
chain. Every vertical's router imports its gating middleware from `shared/middleware/`
and, where it needs the token/claims shape, imports types from `shared/auth/`.

### Per-vertical split (controller / service / router / model)

Every existing route file today is one `RequestHandler` doing Zod validation, DB
transaction, business logic, and `res.json()` together (e.g. `sdk/sessionsStart.ts`).
Each one gets split like this, using `sdk/sessions/start` as the worked example:

```
sdk/
├── models/
│   └── sessionModels.ts        # typed shapes passed between controller and service
├── controllers/
│   └── sessionsController.ts   # sessionsStart, sessionsEnd — parse req.body, call service, res.json/sendError
├── services/
│   └── sessionsService.ts      # startSession(player, body) — withWorkspace, insert, split, appendEvent
└── routers/
    └── sessionsRouter.ts       # sdkRouter.post('/sessions/start', sessionsStart) — same path, same middleware
```

Rules applied uniformly to every route in `sdk/` and `surface/`:

- **Router**: only `Router()` + `.use(middleware)` + `.get/.post(path, controllerFn)`.
  No logic, no imports beyond controllers and middleware.
- **Controller**: Zod validation of `req.body`/`req.query`, calls exactly one service
  function, translates the result into `res.status().json(...)` or `sendError(...)`.
  No Drizzle, no `withWorkspace`, no direct DB access.
- **Service**: takes already-validated input (plus whatever context it needs, e.g.
  `player`), performs all DB/business logic, returns a plain value or throws. No `req`,
  no `res`, no Zod — callable and unit-testable without spinning up Express.
- **Model**: request/response DTOs and serializers scoped to that vertical — e.g. a
  future `toPlayerView`/`toAgentView` pair. The actual DB schema (Drizzle tables) stays
  only in `shared/db`; per-vertical `models/` never redefines it.

Route paths, HTTP methods, middleware order (`requirePlayerToken`,
`requireSdkHeaders`), status codes, and response bodies are preserved exactly.

## Frontend

Current state: `SupportSurface.tsx`, `api.ts`, `boot.ts`, `bridge.ts`, `main.tsx` — one
screen, no router, no pages. Target:

```
frontend/src/
├── main.tsx
├── boot.ts
├── pages/
│   └── SupportSurface.tsx      # the one screen today; future agent-console pages land here
├── api/
│   └── surfaceApi.ts           # ← api.ts unchanged: raw fetch calls (fetchBootstrap, reportArticleRead)
├── services/
│   └── bridgeService.ts        # ← bridge.ts: SupportBridge messaging, above the raw fetch layer
├── components/                  # scaffolded empty — extracted UI pieces land here
└── lib/                         # scaffolded empty — shared hooks/utils land here
```

`api/` holds only raw HTTP calls (mirrors what "api" means on the backend side).
`services/` holds cross-cutting domain logic that isn't a direct HTTP call — bridge
messaging today, future things like client-side token handling later. `pages/`,
`components/`, `lib/` close the gap between what CLAUDE.md already documents as the
intended shape and what actually exists.

## Migration approach & safety

1. **Scope**: `app` repo only. Unity SDK repo (`2026_Hassan_Sdk`) untouched — its own
   folder structure is a separate, already-decided concern (plain
   `Assets/Support/` + asmdef, not this refactor).
2. **Order**:
   1. Pure moves first — `shared/` (db, auth, jobs, events, playerState) and update
      relative import paths. Commit, run `pnpm typecheck` + `pnpm test`.
   2. Per-route controller/service extraction, one route at a time (start with `sdk/`,
      then `surface/`), each followed by `pnpm typecheck` + `pnpm test`.
   3. Wire `agent/` scaffold (empty folders, no code).
   4. Frontend move (independent of backend, can happen any time after step 1).
3. **Verification gate after every step**: `pnpm typecheck` (this codebase has no path
   aliases — every move touches relative imports and typecheck will catch a missed
   one immediately), `pnpm test` (API suite needs Postgres up), and
   `SEED_SECRET=… ./scripts/verify-seam.sh` (proves the SDK seam end-to-end — the one
   thing that must not regress) before moving to the next route.
4. **No behavior changes bundled in.** No route path changes, no new validation, no
   new middleware, no renamed response fields — the SDK wire contract is frozen
   (CLAUDE.md: "add response fields freely, never remove or retype one"). Anything
   that looks like it should also change while touching this code goes in a follow-up
   ticket, not into this refactor.
5. **Rollback unit**: each route's extraction is committed independently, so a
   regression in one route doesn't block or need to be untangled from the others.

## Out of scope

- Unity SDK repo folder structure (already decided, see
  `sdk-distribution-plain-folder-not-upm` memory).
- Any new agent-console functionality — `agent/` is scaffolded empty only.
- Any behavior, validation, or contract change to existing routes.
