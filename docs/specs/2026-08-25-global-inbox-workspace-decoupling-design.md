# Global Inbox & Workspace Decoupling — Design

## Purpose

Currently, a regular agent's session JWT permanently binds them to a single `workspace_id`. If an agent supports multiple games (workspaces), they must completely log out and log back in to switch context. Furthermore, they cannot see a unified view of all tickets across all their assigned workspaces.

This spec details the architectural changes required to:
1. Decouple authentication from authorization so an agent can switch workspaces instantly without requiring a new JWT.
2. Build a "Global Inbox" that aggregates active tickets across all workspaces an agent belongs to.
3. Update the realtime socket architecture to stream updates from multiple workspaces into a single agent connection.

This generalizes a pattern that already exists for global admins (`2026-08-21-superadmin-workspace-console-access-design.md`): JWT carries identity only, workspace is resolved per request.

## 1. Session Model Change (Decoupling)

**Agent JWT modification:**
- Remove `workspace_id` from the regular agent's JWT. The JWT becomes `{ agent_id, is_admin: false }` — the same shape admin JWTs already use. Signing (`agentSession.ts`, HS256, `AGENT_SESSION_JWT_SECRET`, issuer `support-crm`, audience `support-agent-dev`) and TTL (12h) are unchanged. The JWT is strictly proof of identity (Authentication); it carries no authorization context.

**Per-request authorization:**
- The frontend passes the target workspace on every API request via the `X-Workspace-Id` header.
- `resolveConsoleWorkspace` — currently admin-only — is generalized to run for all agents, replacing the branch in `requireAgentSession.ts` that trusted a JWT-embedded `workspace_id`. This merges the admin and regular-agent authorization paths into a single code path.
- Before `withWorkspace()` opens the RLS transaction, the middleware authorizes the request:
  `SELECT role, deactivated_at FROM workspace_member WHERE agent_id = <JWT agent_id> AND workspace_id = <Header workspace_id>`
- If the agent is not an active member (row missing or `deactivated_at IS NOT NULL`), the request yields `404 Not Found` (RLS convention: "not yours" and "not there" are indistinguishable).

**Authorization cache (Redis):**
- The membership check above is cached in Redis, keyed `wsauth:{agent_id}:{workspace_id}`, value `{ role, deactivated }`, TTL 60s.
- Cache hit → skip the Postgres query entirely; steady-state per-request cost is a Redis GET.
- Cache miss → query Postgres, populate the cache.
- **Invalidation:** the admin action that sets `deactivated_at` on a `workspace_member` row also deletes the corresponding cache key, so removal from a workspace takes effect immediately rather than waiting out the TTL. Any other membership change (e.g. role update) is bounded by the 60s TTL.
- This also means workspace-level deactivation now takes effect near-instantly, an improvement over today where a regular agent's JWT-embedded `workspace_id` is trusted for the life of the token.

**Rollout / mixed-token window:**
- JWT TTL is 12h, so old tokens (embedded `workspace_id`) and new tokens (identity-only) coexist during rollout. The middleware ignores a JWT's `workspace_id` claim if present — it authenticates identity as before but authorization always comes from the header + membership check. No forced logout is required; old tokens age out naturally.

**Google OAuth integration:**
- Unchanged from `2026-08-04-agent-auth-google-oauth.md`. Google provides the initial identity (ID token) at `/login`, verified and discarded in favor of our custom JWT. The custom JWT manages session identity; `X-Workspace-Id` + the membership check manage authorization context.

**Explicitly out of scope (follow-up):**
- Agent-level JWT revocation (a Redis denylist for full account deactivation/offboarding) is referenced as planned-but-unbuilt in the OAuth decision doc. The cache above only handles workspace-membership changes, not "this agent's account no longer exists." Not addressed in this spec — flagged so it isn't forgotten.

## 2. Workspace Switcher & Default Workspace

- **Switcher UI:** a dropdown in the console header listing the agent's active `workspace_member` rows. Selecting one updates local state driving the `X-Workspace-Id` header and refetches data — no new login, no page reload, no socket reconnect.
- **Default workspace on load:** the last-active workspace id is persisted client-side (`localStorage`) and restored on login/reload. If that workspace is no longer valid (membership removed or deactivated), fall back to the first membership returned by `workspace_member`. If the agent has zero active memberships, show an empty/no-access state.
- **Clicking a Global Inbox ticket** sets the active workspace to that ticket's workspace automatically, so the agent can claim/respond seamlessly without a manual switch.

## 3. Global Inbox (Scatter-Gather Pattern)

Because RLS is enforced via `app.workspace_id` per transaction, a single SQL query cannot select rows across multiple workspaces without breaking tenant isolation. Global Inbox instead scatters one query per workspace and gathers the results in memory.

- **New endpoint:** `GET /agent/global-inbox`
- **Scatter-gather logic:**
  1. Query `workspace_member` for all active workspace ids the agent belongs to (subject to the same Redis-cached authorization as regular requests).
  2. Run the standard inbox query against each workspace inside its own `withWorkspace(id)` transaction, with **bounded concurrency** (e.g. `p-limit(10)`) rather than raw `Promise.all()` — a single agent's membership count can grow into the dozens, and unbounded fan-out would open that many simultaneous transactions per request.
  3. Each per-workspace query is capped (e.g. top 50 by priority/recency) before merging, so one workspace with a large backlog can't dominate fetch cost or crowd out the others in the final list.
  4. Merge results in memory, sort by priority/timestamp, return the unified list.
- **Partial failure:** if a given workspace's query errors (e.g. transient DB issue), it is excluded from the merged result rather than failing the whole request. The response includes `failed_workspaces: string[]` so the frontend can show a subtle "N workspaces failed to load" indicator without blocking the rest of the inbox.
- This preserves "one transaction = one workspace" RLS isolation while providing a unified view.

## 4. Realtime Sockets

An agent viewing Global Inbox must receive realtime updates whenever a new chat arrives in *any* of their active workspaces.

- **Single socket, multiple rooms:** the frontend establishes one socket connection with its JWT. The backend queries the agent's active workspace memberships during handshake and joins the socket to `workspace:{id}:inbox` for each — the same room-join pattern already used for admins.
- **Switching the active workspace in the UI does not require rejoining rooms** — the socket is already subscribed to all of them at connect time; only which room's events the UI foregrounds changes. Room membership is cheap in Socket.io even across dozens of rooms, unlike the DB fan-out in section 3.
- **Payload enhancement:** `emitInboxChanged` (`emit.ts`) currently emits `{ conversation_id, status }` to `workspace:{id}:inbox`. It gains `workspace_id: string` in the payload so the Global Inbox view can attribute the update to the right workspace list. Existing single-workspace inbox listeners are unaffected — they already scope by their own room.

## Frontend Surface

- **Workspace switcher:** dropdown described in section 2.
- **Primary Inbox tab:** new tab fetching from `/agent/global-inbox`. Clicking a ticket sets the active workspace and opens the conversation.

## Future Extensibility (not designed here)

A Gmail-style unified "all mail" view — searching or archiving across all workspaces, not just active tickets — is a natural extension of the Global Inbox scatter-gather primitive once it ships. No decision in this spec blocks that; it's called out here so a future spec can build on this foundation rather than needing to be reconciled with it.

## Out of Scope

- Agent-level JWT revocation / Redis denylist for full account deactivation (see section 1).
- The "all mail" cross-workspace archive/search feature (see Future Extensibility).
