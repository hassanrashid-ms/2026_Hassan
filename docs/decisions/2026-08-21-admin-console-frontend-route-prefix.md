# Admin console frontend routes live under `/dashboard`, not `/admin`

**Date:** 2026-08-21
**Status:** Accepted
**Context:** debugging a raw `401 unauthorized` JSON response appearing in the browser instead of the admin console UI, through the shared ngrok dev tunnel

## The problem

`scripts/dev-proxy.mjs` puts one local origin (`:8787`, tunneled by ngrok) in front of both the
frontend (`:5173`) and the backend API (`:4000`), routing by a fixed path-prefix list mirroring
`backend/src/app.ts`'s mounts:

```js
const API_PREFIXES = ['/docs', '/auth', '/sdk', '/surface', '/agent', '/admin', '/socket.io']
```

Anything under `/admin/*` is proxied straight to the Express backend. But the admin console's
frontend (`surfaces/admin-console`, `AppRoutes.tsx`) also mounted its client-side routes at
`/admin` (`/admin/login`, `/admin/overview`, `/admin/workspaces/:id`) — the same prefix as the
backend's real `/admin` router (`app.ts`: `app.use('/admin', adminRouter)`).

Through the tunnel, every request under `/admin/*` hit the Express API before it could ever reach
the React app, regardless of whether it was a real page load or a fetch. Since a plain browser
navigation carries no `Authorization` header, `requireAgentSession` answered with its raw
`{"error":{"code":"unauthorized",...}}` JSON instead of the frontend ever rendering anything — the
admin console UI was unreachable through the shared tunnel, full stop.

`/agent` doesn't have the same problem only because the agent-console's frontend never uses that
prefix for its own routes (`/inbox`, `/tickets`, etc., all top-level) — the collision is specific to
admin, which happened to reuse its API's own prefix as its frontend mount path.

## The decision

Move the admin console's frontend routes to `/dashboard` instead of `/admin`:

- `AppRoutes.tsx`: `/dashboard/login`, `/dashboard` (shell), `/dashboard/workspaces/:id`
- `AdminConsoleShell.tsx`, `AdminLogin.tsx`, `Overview.tsx`, `WorkspaceDetail.tsx`,
  `adminAuthErrorHandling.ts`, `main.tsx`'s 401 dispatch: all updated to match

The backend's `/admin/*` API is untouched — `adminApi.ts` still calls `/admin/workspaces`,
`/admin/agents`, etc. Only the frontend's own client-side route prefix changed, so it no longer
collides with anything in `dev-proxy.mjs`'s `API_PREFIXES` list.

## Alternatives considered

- **Smarter proxy routing** (e.g. distinguish by `Accept` header or a `/admin/api/*` sub-path):
  rejected as more proxy logic for a dev-only convenience tool, with more ways to get subtly wrong.
- **Do nothing, use `localhost:5173` directly for the admin UI**: works, but permanently gives up
  on testing the admin console through the same tunnel used for everything else, which is the
  whole reason `dev-proxy.mjs` exists.
