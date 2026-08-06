# Logger middleware + centralized log dispatch

**Status: implemented and verified (2026-08-06).**

## Context

The backend currently logs via scattered raw `console.*` calls: an inline request logger in `app.ts`, error logging in `errors.ts`, and assorted lines in `db/setup.ts`, `db/seed.ts`, `shared/jobs/queue.ts`, `sdk/controllers/sessionsController.ts`, `sdk/services/sessionsService.ts`, and `server.ts`. There's no shared logging abstraction, no log-level control, and no way to later plug in remote telemetry (e.g. shipping logs to a service) without touching every call site again.

The user wants:
- An Express request/response logging middleware.
- A single `dispatchLog` function all logging goes through, so a future telemetry sink can be added in one place.
- Three env-controlled verbosity levels: none, mild, verbose (verbose = log everything, including headers/bodies/timing).
- Every existing `console.log`/`console.error` call site replaced with the new logger.

## Design

### 1. `backend/src/shared/logging/logger.ts` — the dispatch core

```ts
export type LogLevel = 'none' | 'mild' | 'verbose'
type LogEntry = { level: 'info' | 'warn' | 'error'; tag: string; message: string; meta?: Record<string, unknown> }

function dispatchLog(entry: LogEntry): void {
  // single choke point — today: console; future: also push to a remote sink here
  const line = `[${entry.tag}] ${entry.message}`
  const consoleFn = entry.level === 'error' ? console.error : entry.level === 'warn' ? console.warn : console.log
  consoleFn(line, entry.meta ?? '')
}

export const logger = {
  info: (tag: string, message: string, meta?: Record<string, unknown>) => dispatchLog({ level: 'info', tag, message, meta }),
  warn: (tag: string, message: string, meta?: Record<string, unknown>) => dispatchLog({ level: 'warn', tag, message, meta }),
  error: (tag: string, message: string, meta?: Record<string, unknown>) => dispatchLog({ level: 'error', tag, message, meta }),
}
```

`dispatchLog` is the one seam a future telemetry client hooks into (e.g. also call `telemetryClient.send(entry)` there) — no other file needs to change when that lands.

Log level gating for *general-purpose* calls (db setup, jobs, startup, etc.) is simple: `none` suppresses everything except errors, `mild`/`verbose` show info/warn/error. The request-logging middleware (below) is where the mild/verbose distinction really matters, since verbose there means headers/query/body/timing.

### 2. `backend/src/env.ts` — add `LOG_LEVEL`

```ts
LOG_LEVEL: z.enum(['none', 'mild', 'verbose']).default('mild'),
```

Added `LOG_LEVEL=mild` to `.env.example` (repo root) with a comment: `none` = silent except errors, `mild` = method+path+status+duration, `verbose` = + headers, query, body, response body.

### 3. `backend/src/shared/middleware/requestLogger.ts` — the logging middleware

Replaces the inline logger in `app.ts`. Behavior by level:
- `none`: middleware is a no-op passthrough.
- `mild`: on response finish, logs `METHOD path -> status (Xms)`.
- `verbose`: additionally logs request headers, query params, request body, and response headers/body. Hooks into `res.on('finish')` for timing/status; wraps `res.json` only when level is verbose to capture the response body (no overhead at other levels).

Registered in `app.ts`, replacing the old inline block:
```ts
app.use(requestLoggerMiddleware)
```

### 4. Replaced existing `console.*` call sites

Swapped each for `logger.info/warn/error(tag, message, meta)`, preserving existing tags (`[http]`, `[error]`) and semantics:
- `backend/src/errors.ts` — kept the existing guard against ever logging the raw `InvalidWorkspaceId` object; only `error.name`/`error.message`/`error.stack` are logged.
- `backend/src/server.ts`, `backend/src/shared/db/setup.ts`, `db/seed.ts`, `backend/src/shared/jobs/queue.ts`, `backend/src/sdk/controllers/sessionsController.ts`, `backend/src/sdk/services/sessionsService.ts`.

## Files touched

- New: `backend/src/shared/logging/logger.ts`
- New: `backend/src/shared/middleware/requestLogger.ts`
- Edit: `backend/src/env.ts` (added `LOG_LEVEL`)
- Edit: `.env.example` (repo root, added `LOG_LEVEL`)
- Edit: `backend/src/app.ts` (swapped inline logger for middleware)
- Edit: `backend/src/errors.ts`, `backend/src/server.ts`, `backend/src/shared/db/setup.ts`, `backend/src/shared/db/seed.ts`, `backend/src/shared/jobs/queue.ts`, `backend/src/sdk/controllers/sessionsController.ts`, `backend/src/sdk/services/sessionsService.ts` — replaced `console.*` with `logger.*`
- Edit: `CLAUDE.md` (documented the logger under Stack/Rules)

## Verification (all passed)

1. `pnpm typecheck` — clean across the workspace.
2. `pnpm test` — 172 backend, 8 frontend, 24 types tests passing.
3. Manually ran the backend and hit `GET /health`:
   - `LOG_LEVEL=mild` → single `[http] GET /health -> 200 (3ms)` line.
   - `LOG_LEVEL=verbose` → full request (headers/query/body) and response (headers/body) logged.
   - `LOG_LEVEL=none` → no per-request line logged (and no startup line — `none` is silent except errors, by design).
