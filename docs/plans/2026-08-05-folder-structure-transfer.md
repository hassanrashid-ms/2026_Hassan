# Folder Structure Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.
>
> **Deviation from the default plan shape, by explicit user instruction:** this plan has only 3
> tasks, each large-grained (not bite-sized TDD steps), because this is a pure mechanical
> file-move/split with no new behavior — there is nothing to TDD. **No subagent runs
> `pnpm typecheck` / `pnpm test` / `verify-seam.sh` as part of its own task.** All three tasks are
> file-disjoint and are designed to run **in parallel** (e.g. via `superpowers:dispatching-parallel-agents`
> or three concurrent `Agent` calls). A single combined validation gate (Task 4) runs once, after
> all three land, per the user's explicit choice.

**Goal:** Restructure the `app` repo's backend (`backend/src/`) and frontend (`frontend/src/`)
into the target layout specified in `docs/specs/2026-08-05-folder-structure-revamp.md`, with zero
behavior change.

**Architecture:** Backend splits each vertical (`sdk/`, `surface/`) into
`models/controllers/services/routers`, moves cross-vertical code into `shared/`, and scaffolds an
empty `agentside/` vertical. Frontend moves the single screen into `pages/`, renames `api.ts` /
`bridge.ts` into `api/` / `services/`, and scaffolds empty `components/` and `lib/`. Frontend and
both backend halves touch entirely disjoint file sets, so they run as independent tasks.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, Zod, Vite + React (no changes to any of
these — this is a directory/file reorganization only).

## Global Constraints

- **Scope:** `2026_Hassan` (`app`) repo only. `2026_Hassan_Sdk` is untouched (per spec, out of
  scope — see `sdk-distribution-plain-folder-not-upm` memory).
- **No behavior change.** Same routes, same request/response shapes, same middleware order, same
  status codes, same response fields. If anything looks like it should also change, leave it and
  note it — do not bundle it into this refactor.
- **No hard deletes / no new logic / no new validation.** This task only moves and mechanically
  splits existing code.
- Every `.ts` import in this repo is a relative path (`../foo.ts`) — there are no path aliases
  except the workspace package `@support/types`. Every file move must update every relative
  import that touches it, including in test files.
- **No subagent runs verification commands.** That happens once, in Task 4, after Tasks 1–3 are
  all committed.
- Each task commits its own work independently (its own git commit(s)), so a problem found in
  Task 4 is traceable to one task's diff.

---

### Task 1: Backend shared/ move + agentside/ scaffold

**Files:**
- Move: `backend/src/db/` → `backend/src/shared/db/` (all contents: `client.ts`, `schema/`,
  `seed.ts`, `setup.ts`, `sql/`, `withWorkspace.ts`)
- Split-move: `backend/src/auth/` → two destinations:
  - `backend/src/shared/auth/`: `playerToken.ts`, `playerTokenRoute.ts`, `workspaceSecret.ts`
    (token issuance/verification)
  - `backend/src/shared/middleware/`: `requirePlayerToken.ts`, `requireSdkHeaders.ts` (the
    Express `RequestHandler`s that gate requests using those tokens)
- Move: `backend/src/jobs/` → `backend/src/shared/jobs/` (`queue.ts`, `sessionTimeout.ts`)
- Move: `backend/src/events/` → `backend/src/shared/events/` (`appendEvent.ts`)
- Move: `backend/src/playerState/` → `backend/src/shared/playerState/` (`declaredKeys.ts`,
  `split.ts`)
- Create (empty, scaffold only): `backend/src/agentside/models/`, `backend/src/agentside/controllers/`,
  `backend/src/agentside/services/`, `backend/src/agentside/routers/` — each gets a `.gitkeep` so
  git tracks the empty directory. No code in any of them.
- Modify: `backend/src/app.ts` (only the `playerTokenRouter` import path)
- Modify: `backend/tests/auth.playerToken.test.ts`, `backend/tests/auth.middleware.test.ts`,
  `backend/tests/isolation.test.ts`, `backend/tests/playerState.split.test.ts`,
  `backend/tests/jobs.sessionTimeout.test.ts`, `backend/tests/withWorkspace.test.ts`,
  `backend/tests/globalSetup.ts`, `backend/tests/helpers/app.ts` (each has one or more
  `../src/db/...`, `../src/auth/...`, `../src/jobs/...`, or `../src/events/...` imports that need
  the `shared/` segment inserted — `playerToken.ts`/`workspaceSecret.ts` imports go to
  `shared/auth/`, none of the test files import `requirePlayerToken`/`requireSdkHeaders` directly
  so `shared/middleware/` needs no test-file edits)
- Do NOT touch: `backend/src/sdk/`, `backend/src/surface/` — Task 2 owns those, including their
  imports of `db`/`auth`/`events`/`playerState`.

**What "move" means here:** `git mv` the file/directory, then fix every relative import inside the
moved file that pointed at a sibling that also moved (e.g. `shared/db/withWorkspace.ts` imports
`./client.ts` — same relative path, no change needed, since both moved together). The only imports
that change are ones crossing the old top-level boundary, i.e. anything reaching `../env.ts`,
`../errors.ts` from one level deeper now (`shared/db/client.ts` → `../../env.ts` instead of
`../env.ts`), anything crossing from `auth/` into the two files that now live in `middleware/`
instead (or vice versa), and anything in `sdk/`/`surface`/`app.ts`/tests reaching into `db`/
`auth`/`middleware`/`jobs`/`events`/`playerState` (those gain a `shared/` path segment) — but only
touch those in the files listed above; leave `sdk/`/`surface/` internals for Task 2.

- [ ] **Step 1: Move the six directories/splits**

```bash
cd backend/src
git mv db shared_db_tmp && mkdir -p shared && git mv shared_db_tmp shared/db
git mv auth shared/auth
mkdir -p shared/middleware
git mv shared/auth/requirePlayerToken.ts shared/middleware/requirePlayerToken.ts
git mv shared/auth/requireSdkHeaders.ts shared/middleware/requireSdkHeaders.ts
git mv jobs shared/jobs
git mv events shared/events
git mv playerState shared/playerState
```

(The `db` two-step avoids `git mv` refusing to move a directory into a not-yet-existing
`shared/` parent in one shot — adjust if your git version handles it directly. `auth/` moves whole
first, then the two middleware files split out of it into their own sibling folder — `shared/auth/`
ends up holding only `playerToken.ts`, `playerTokenRoute.ts`, `workspaceSecret.ts`.)

- [ ] **Step 2: Fix intra-shared relative imports one level deeper, and across the auth/middleware split**

Every file that moved from `backend/src/X/` to `backend/src/shared/X/` is now one directory
deeper. Any import that previously read `../env.ts`, `../errors.ts`, or `'@support/types'` is
unaffected in *specifier* but now needs one more `../`:

- `shared/db/client.ts`: `from '../env.ts'` → `from '../../env.ts'`
- `shared/db/setup.ts`: `from '../env.ts'` → `from '../../env.ts'`
- `shared/auth/playerToken.ts`: `from '../env.ts'` → `from '../../env.ts'`
- `shared/auth/playerTokenRoute.ts`: `from '../env.ts'` → `from '../../env.ts'`, `from '../errors.ts'` → `from '../../errors.ts'`
- `shared/middleware/requireSdkHeaders.ts`: `from '../errors.ts'` → `from '../../errors.ts'`
- `shared/middleware/requirePlayerToken.ts`: `from '../errors.ts'` → `from '../../errors.ts'`,
  **and** its `from './playerToken.ts'` import (for `InvalidPlayerToken`, `verifyPlayerToken`)
  changes to `from '../auth/playerToken.ts'`, since `playerToken.ts` stayed in `shared/auth/` while
  this file moved into the new `shared/middleware/` sibling.
- `shared/jobs/sessionTimeout.ts`: `from '../env.ts'` → `from '../../env.ts'`

Imports between two moved shared modules (e.g. `shared/db/withWorkspace.ts` importing
`./client.ts`, `shared/auth/playerTokenRoute.ts` importing `../db/schema/index.ts` →
`../db/schema/index.ts` is unchanged since `db` is now a sibling under `shared/`,
`shared/middleware/requirePlayerToken.ts` importing `../db/withWorkspace.ts` unchanged,
`shared/jobs/sessionTimeout.ts` importing `../events/appendEvent.ts` and `../db/schema/index.ts`
and `../db/withWorkspace.ts` unchanged, `shared/playerState/declaredKeys.ts` importing
`../db/schema/index.ts` unchanged) need **no path change** — verify each by reading the moved
file, don't assume.

- [ ] **Step 3: Scaffold agentside/**

```bash
cd backend/src
mkdir -p agentside/models agentside/controllers agentside/services agentside/routers
touch agentside/models/.gitkeep agentside/controllers/.gitkeep agentside/services/.gitkeep agentside/routers/.gitkeep
```

- [ ] **Step 4: Update `backend/src/app.ts`**

Change only this line:

```ts
import { playerTokenRouter } from './auth/playerTokenRoute.ts'
```
to:
```ts
import { playerTokenRouter } from './shared/auth/playerTokenRoute.ts'
```

Leave the `sdkRouter` and `surfaceRouter` imports untouched — Task 2 keeps those import paths
stable.

- [ ] **Step 5: Update the 8 test files**

In each of `backend/tests/auth.playerToken.test.ts`, `auth.middleware.test.ts`,
`isolation.test.ts`, `playerState.split.test.ts`, `jobs.sessionTimeout.test.ts`,
`withWorkspace.test.ts`, `globalSetup.ts`, `helpers/app.ts`: insert `shared/` into every import
path that reads `../src/db/...`, `../src/auth/...`, `../src/jobs/...`, or `../src/events/...`
(none of these test files import `requirePlayerToken`/`requireSdkHeaders` directly — those are
only exercised through HTTP requests against `app.ts` — so no test import needs to point at
`shared/middleware/`). Example (`auth.playerToken.test.ts`):

```ts
import { closeDb } from '../src/db/client.ts'
import { withWorkspace } from '../src/db/withWorkspace.ts'
import { player } from '../src/db/schema/index.ts'
import { generateWorkspaceSecret } from '../src/auth/workspaceSecret.ts'
import { verifyPlayerToken } from '../src/auth/playerToken.ts'
```
becomes:
```ts
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { player } from '../src/shared/db/schema/index.ts'
import { generateWorkspaceSecret } from '../src/shared/auth/workspaceSecret.ts'
import { verifyPlayerToken } from '../src/shared/auth/playerToken.ts'
```

And `helpers/app.ts` (one level deeper, `../../src/...`):
```ts
import { createApp } from '../../src/app.ts'
import { signPlayerToken, type PlayerClaims } from '../../src/auth/playerToken.ts'
```
becomes:
```ts
import { createApp } from '../../src/app.ts'
import { signPlayerToken, type PlayerClaims } from '../../src/shared/auth/playerToken.ts'
```

Apply the same `../src/db` → `../src/shared/db`, `../src/auth` → `../src/shared/auth`,
`../src/jobs` → `../src/shared/jobs`, `../src/events` → `../src/shared/events` substitution to the
other six files, reading each first to find its exact current imports (grep `^import` in each file
before editing — do not guess line numbers).

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared backend/src/agentside backend/src/app.ts backend/tests
git commit -m "refactor: move shared backend modules under shared/, scaffold agentside/"
```

---

### Task 2: Backend per-vertical split (sdk/, surface/)

**Files:**
- Create under `backend/src/sdk/`: `models/sessionModels.ts`, `controllers/sessionsController.ts`,
  `services/sessionsService.ts`, `routers/sessionsRouter.ts`, and the equivalent
  controller/service/router split for `incidents.ts` and `unread.ts` (their own model file only if
  they need a shared DTO shape — otherwise skip an empty model file for them).
- Create under `backend/src/surface/`: the same controller/service/router split for
  `articleRead.ts` and `bootstrap.ts`.
- Keep: `backend/src/sdk/router.ts` and `backend/src/surface/router.ts` **at their current path**
  — rewrite their contents to import from the new `routers/` files and re-export the same
  `sdkRouter` / `surfaceRouter` names, so `app.ts` needs zero changes for this task.
- Keep: `backend/src/sdk/headers.ts` where it is (shared helper within `sdk/`, not a route), but
  update its one import: `PlayerContext` moved with `requirePlayerToken.ts` into
  `shared/middleware/`, so `import type { PlayerContext } from '../auth/requirePlayerToken.ts'`
  becomes `import type { PlayerContext } from '../shared/middleware/requirePlayerToken.ts'`.
- Delete (after splitting): `backend/src/sdk/sessionsStart.ts`, `sessionsEnd.ts`, `incidents.ts`,
  `unread.ts`, `backend/src/surface/articleRead.ts`, `bootstrap.ts` — their logic now lives in
  `controllers/`/`services/`.
- Import all `shared/` references (`shared/db`, `shared/auth`, `shared/middleware`,
  `shared/events`, `shared/playerState`) using the paths Task 1 establishes — these are new
  imports in newly created files, not edits to Task 1's files, so there is no merge conflict even
  though both tasks run in parallel: agree on the target path up front (`../../shared/db/...` etc.
  from `sdk/services/*.ts`, `../../shared/middleware/requirePlayerToken.ts` for the `PlayerContext`
  type) rather than waiting for Task 1 to land.

**Rules (from the spec, apply uniformly to every route in `sdk/` and `surface/`):**
- **Router**: only `Router()` + `.use(middleware)` + `.get/.post(path, controllerFn)`. No logic,
  no imports beyond controllers and middleware.
- **Controller**: Zod validation of `req.body`/`req.query`, calls exactly one service function,
  translates the result into `res.status().json(...)` or `sendError(...)`. No Drizzle, no
  `withWorkspace`, no direct DB access.
- **Service**: takes already-validated input (plus context like `player`), performs all DB/business
  logic via `withWorkspace`, returns a plain value or throws. No `req`, no `res`, no Zod.
- **Model**: request/response DTOs scoped to that vertical. The actual DB schema stays only in
  `shared/db`.

**Worked example — `sdk/sessions/start`** (apply this same pattern to every other route by reading
its current file and following the same shape):

Current `backend/src/sdk/sessionsStart.ts` combines Zod parsing, a `withWorkspace` transaction
(insert session, conflict check, `appendEvent`, snapshot split/insert, `appendEvent`), and
`res.json`. Split into:

`backend/src/sdk/models/sessionModels.ts`:
```ts
import type { SessionStartBody as SessionStartBodyType } from '@support/types'

export type StartSessionInput = SessionStartBodyType
```

`backend/src/sdk/services/sessionsService.ts`:
```ts
import { and, eq, isNull } from 'drizzle-orm'
import { coerceInstant } from '@support/types'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { playerStateSnapshot, session } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { loadDeclaredKeys } from '../../shared/playerState/declaredKeys.ts'
import { splitSnapshot } from '../../shared/playerState/split.ts'
import { headerPayload } from '../headers.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'
import type { StartSessionInput } from '../models/sessionModels.ts'

// startSession/endSession bodies are copied verbatim from the current sessionsStart.ts /
// sessionsEnd.ts withWorkspace callbacks — same statements, same order, same comments explaining
// why (ON CONFLICT DO NOTHING semantics, the session_id-not-ours guard, DO NOTHING on the
// snapshot insert). Read the current file and move the callback body in unchanged; only the
// import paths and the wrapping function signature are new.
export async function startSession(player: PlayerContext, body: StartSessionInput) {
  const now = new Date()
  const startedAt = coerceInstant(body.started_at, now)
  await withWorkspace(player.workspaceId, async (tx) => {
    // ... exact body of the withWorkspace callback from current sessionsStart.ts, unchanged ...
  })
}

export async function endSession(player: PlayerContext, body: /* SessionEndBody */ any) {
  const now = new Date()
  await withWorkspace(player.workspaceId, async (tx) => {
    // ... exact body of the withWorkspace callback from current sessionsEnd.ts, unchanged ...
  })
}
```

`backend/src/sdk/controllers/sessionsController.ts`:
```ts
import type { RequestHandler } from 'express'
import { SessionStartBody, SessionEndBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { startSession, endSession } from '../services/sessionsService.ts'

export const sessionsStart: RequestHandler = async (req, res) => {
  const player = req.player!
  const parsed = SessionStartBody.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }
  await startSession(player, parsed.data)
  res.status(200).json({ ok: true })
}

export const sessionsEnd: RequestHandler = async (req, res) => {
  const player = req.player!
  const parsed = SessionEndBody.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }
  await endSession(player, parsed.data)
  res.status(200).json({ ok: true })
}
```

`backend/src/sdk/routers/sessionsRouter.ts`:
```ts
import { Router } from 'express'
import { sessionsStart, sessionsEnd } from '../controllers/sessionsController.ts'

export const sessionsRouter = Router()
sessionsRouter.post('/sessions/start', sessionsStart)
sessionsRouter.post('/sessions/end', sessionsEnd)
```

Preserve every `console.log`/`console.warn` call and its exact message and payload shape — they
are not decoration, they're referenced by the spec as intentional operational visibility. Move
them into whichever new file now contains that line of logic (parse-failure logs go in the
controller, transaction-step logs go in the service).

Apply the identical pattern to:
- `sdk/incidents.ts` → `sdk/services/incidentsService.ts` + `sdk/controllers/incidentsController.ts`
  + `sdk/routers/incidentsRouter.ts`
- `sdk/unread.ts` → `sdk/services/unreadService.ts` + `sdk/controllers/unreadController.ts` +
  `sdk/routers/unreadRouter.ts`
- `surface/articleRead.ts` → `surface/services/articleReadService.ts` +
  `surface/controllers/articleReadController.ts` + `surface/routers/articleReadRouter.ts`
- `surface/bootstrap.ts` → `surface/services/bootstrapService.ts` +
  `surface/controllers/bootstrapController.ts` + `surface/routers/bootstrapRouter.ts`

Read each current file before splitting it — don't assume its shape matches sessionsStart.ts
beyond the controller/service/router boundary rule.

- [ ] **Step 1: Read every current route file**

```bash
cat backend/src/sdk/sessionsStart.ts backend/src/sdk/sessionsEnd.ts backend/src/sdk/incidents.ts \
    backend/src/sdk/unread.ts backend/src/surface/articleRead.ts backend/src/surface/bootstrap.ts
```

- [ ] **Step 2: Create `sdk/models/`, `sdk/controllers/`, `sdk/services/`, `sdk/routers/` and split
  sessions, incidents, unread per the pattern above**

- [ ] **Step 3: Create `surface/controllers/`, `surface/services/`, `surface/routers/` and split
  articleRead, bootstrap per the same pattern**

- [ ] **Step 4: Rewrite `backend/src/sdk/router.ts` to aggregate from `routers/`**

```ts
import { Router } from 'express'
import { requirePlayerToken } from '../shared/middleware/requirePlayerToken.ts'
import { requireSdkHeaders } from '../shared/middleware/requireSdkHeaders.ts'
import { getEnv } from '../env.ts'
import { sessionsRouter } from './routers/sessionsRouter.ts'
import { incidentsRouter } from './routers/incidentsRouter.ts'
import { unreadRouter } from './routers/unreadRouter.ts'

export const sdkRouter = Router()
sdkRouter.use(requirePlayerToken, requireSdkHeaders)

if (getEnv().NODE_ENV === 'test') {
  sdkRouter.get('/_whoami', (req, res) => {
    res.json(req.player)
  })
}

sdkRouter.use(sessionsRouter)
sdkRouter.use(incidentsRouter)
sdkRouter.use(unreadRouter)
```

- [ ] **Step 5: Rewrite `backend/src/surface/router.ts` to aggregate from `routers/`**

```ts
import { Router } from 'express'
import { requirePlayerToken } from '../shared/middleware/requirePlayerToken.ts'
import { articleReadRouter } from './routers/articleReadRouter.ts'
import { bootstrapRouter } from './routers/bootstrapRouter.ts'

export const surfaceRouter = Router()
surfaceRouter.use(requirePlayerToken)
surfaceRouter.use(bootstrapRouter)
surfaceRouter.use(articleReadRouter)
```

- [ ] **Step 6: Delete the now-split original route files**

```bash
git rm backend/src/sdk/sessionsStart.ts backend/src/sdk/sessionsEnd.ts backend/src/sdk/incidents.ts backend/src/sdk/unread.ts
git rm backend/src/surface/articleRead.ts backend/src/surface/bootstrap.ts
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/sdk backend/src/surface
git commit -m "refactor: split sdk/ and surface/ routes into controller/service/router/model"
```

---

### Task 3: Frontend restructure

**Files:**
- Create: `frontend/src/pages/SupportSurface.tsx` (moved from `frontend/src/SupportSurface.tsx`,
  no code change beyond import paths)
- Create: `frontend/src/api/surfaceApi.ts` (moved from `frontend/src/api.ts`, unchanged beyond its
  own imports, which are external-only and don't change)
- Create: `frontend/src/services/bridgeService.ts` (moved from `frontend/src/bridge.ts`)
- Create (empty, scaffold only): `frontend/src/components/.gitkeep`, `frontend/src/lib/.gitkeep`
- Modify: `frontend/src/main.tsx` (import path for `SupportSurface`)
- Keep in place: `frontend/src/boot.ts`, `frontend/src/boot.test.ts`, `frontend/src/styles.css`

- [ ] **Step 1: Move the three files**

```bash
cd frontend/src
mkdir -p pages api services components lib
git mv SupportSurface.tsx pages/SupportSurface.tsx
git mv api.ts api/surfaceApi.ts
git mv bridge.ts services/bridgeService.ts
touch components/.gitkeep lib/.gitkeep
```

- [ ] **Step 2: Update `frontend/src/main.tsx`**

```ts
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SupportSurface } from './pages/SupportSurface.tsx'
import './styles.css'
```

- [ ] **Step 3: Update `frontend/src/pages/SupportSurface.tsx`**

Change its three local imports (now one directory deeper) from:
```ts
import { fetchBootstrap, reportArticleRead } from './api.ts'
import { readBoot, scrubToken, type SurfaceBoot } from './boot.ts'
import { post } from './bridge.ts'
```
to:
```ts
import { fetchBootstrap, reportArticleRead } from '../api/surfaceApi.ts'
import { readBoot, scrubToken, type SurfaceBoot } from '../boot.ts'
import { post } from '../services/bridgeService.ts'
```

- [ ] **Step 4: Verify `api/surfaceApi.ts` and `services/bridgeService.ts` need no internal
  import changes**

Both only import external packages (`@support/types`) or nothing — read each file to confirm
before moving on; if either imports something else from `frontend/src/`, fix that path the same
way as Step 3.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "refactor: move frontend into pages/api/services layout"
```

---

### Task 4: Combined validation gate (run after Tasks 1–3 are all committed, NOT in parallel, NOT by a task subagent)

**Files:** none — this task runs commands only.

- [ ] **Step 1: Typecheck**

```bash
pnpm typecheck
```
Expected: no errors. Since there are no path aliases, any missed import from Tasks 1–3 surfaces
here immediately.

- [ ] **Step 2: Run the test suite** (needs Postgres up — `docker compose up -d` if not already
  running)

```bash
pnpm test
```
Expected: all suites pass, including the 7 backend test files edited in Task 1.

- [ ] **Step 3: Verify the SDK seam end-to-end**

```bash
SEED_SECRET=<your seed secret> ./scripts/verify-seam.sh
```
Expected: pass — this is the one thing the spec says must not regress.

- [ ] **Step 4: If anything fails, fix it in a follow-up commit scoped to the task that caused it**
  (Task 1 for `shared/`-adjacent breakage, Task 2 for `sdk/`/`surface/`-adjacent breakage, Task 3
  for frontend). Do not bundle unrelated fixes together.

---

## Self-review notes

- **Spec coverage:** backend top-level layout (Task 1 + agentside scaffold in Task 1), per-vertical
  controller/service/router/model split (Task 2), frontend layout (Task 3), migration safety gate
  (Task 4) — all covered. `shared/auth/playerTokenRoute.ts` staying mounted at `/auth` unchanged is
  handled in Task 1 Step 4.
- **Parallelism check:** Task 1 touches `backend/src/{db,auth,jobs,events,playerState}` (moved to
  `shared/db`, `shared/auth`, `shared/middleware`, `shared/jobs`, `shared/events`,
  `shared/playerState`), `backend/src/agentside/`, `backend/src/app.ts` (one line), and 8 files
  under `backend/tests/`. Task 2 touches `backend/src/sdk/`, `backend/src/surface/` only — it does
  not touch `app.ts`, because `sdk/router.ts` and `surface/router.ts` keep their current path and
  name. Task 3 touches `frontend/src/` only. No two tasks write the same file, so there's no need
  for git worktree isolation — they can share the working tree directly.
- **Deviation from spec's incremental order:** the spec's own migration approach (move shared
  first, commit, typecheck; then one route at a time; verify after each) is the safer sequence,
  but the user explicitly asked for 2–3 parallel tasks with no per-task validation, trading that
  incremental safety net for speed. Task 4 is the compromise the user chose: one full gate at the
  end instead of one per route.
