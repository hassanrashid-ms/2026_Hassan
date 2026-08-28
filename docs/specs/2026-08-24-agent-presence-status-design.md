# Agent Presence & Status — Design

## Summary

Add a live presence indicator for agents — Online / Away, automatic Offline on disconnect, and On Leave surfaced from the existing account-level flag — shown as a colored bubble on the agent's avatar. Every agent gets a header dropdown to set their own Online/Away status. The existing team_lead/admin-only Workload page gains a status column so a team lead can see who's actually available alongside the open-ticket counts it already shows.

## Background

`agent.status` (`backend/src/shared/db/schema/enums.ts`) already has an `on_leave` value — an account-level, admin-managed lifecycle flag, unrelated to whether the agent is currently connected. There is no live presence concept yet. Socket.io + `@socket.io/redis-adapter` is already wired up (`backend/src/shared/realtime/socketServer.ts`); every connected agent socket already joins `inboxRoom(workspaceId)`. The Workload page (`frontend/src/surfaces/agent-console/pages/Workload/Workload.tsx`, backed by `GET /agent/workload`, `requireTeamLeadOrAdmin`) already computes a per-workspace agent roster with open/resolved counts — this design extends that roster query rather than duplicating it.

Presence is **not** persisted in Postgres: it has no history value and must not be trusted as true across a process restart, so Redis is the right home for it, matching this repo's existing rule that Redis is a queue/pub-sub bus, not a system of record — the "record" here is simply "is a socket open right now," which Redis is well suited to answer.

## Status precedence

Exactly one status is shown per agent, in this order:

1. `on_leave` — if `agent.status === 'on_leave'`. Overrides presence unconditionally; a disconnected agent on leave and a connected one both show `on_leave`.
2. `online` / `away` — from Redis, only meaningful while at least one socket is connected.
3. `offline` — default when neither of the above applies.

Bubble colors: 🟢 online, 🟡 away, ⚪ offline, 🔵 on_leave.

## Redis keys

- `presence:conn:{agentId}` — integer connection counter (INCR on socket connect, DECR on disconnect). Handles multiple tabs/devices for the same agent without flapping to offline when one tab closes.
- `presence:status:{agentId}` — string, `online` or `away`. Absent (or counter at 0) reads as `offline`. No TTL: correctness relies on the socket `disconnect` event firing, which Socket.io guarantees even for crashed/frozen clients via its own ping-timeout, so a separate expiry is redundant.

Presence is keyed by `agentId` alone, not per-workspace — matches the existing identity model where `agent` is a global, unscoped table. An agent connected under multiple workspaces (e.g. an admin) shares one presence value across all of them.

## Socket protocol (`backend/src/shared/realtime/socketServer.ts`)

- **On agent connect**: after the existing `socket.join(inboxRoom(data.workspaceId))`, `INCR presence:conn:{agentId}`; if it was 0 before the increment, `SET presence:status:{agentId} online` and emit `presence_changed { agentId, status: 'online' }` to `inboxRoom(data.workspaceId)`.
- **On agent disconnect**: `DECR presence:conn:{agentId}`; if it reaches 0, `DEL presence:status:{agentId}` and emit `presence_changed { agentId, status: 'offline' }` to `inboxRoom(data.workspaceId)`.
- Reconnecting always lands back on `online`, never restores a prior `away` — a fresh session defaults to present; "away" is a deliberate in-session action, not a remembered preference.

## REST API

- **`PATCH /agent/presence`** — body `{ status: 'online' | 'away' }`, self only. Rejects any other value with 400. Requires the connection counter to be > 0 (can't set presence while fully disconnected — there is no socket to have opened it); returns 409 if the counter is 0. Writes `presence:status:{agentId}`, then emits `presence_changed { agentId, status }` to `inboxRoom(workspaceId)` for the calling session's workspace via `getIo()`.
- **`GET /agent/presence`** — self only. Returns `{ status: 'online' | 'away' | 'offline' }`, read from `presence:status:{agentId}` (via `presence:conn` to disambiguate offline). Used by the header dropdown to restore state on mount/refresh. Does not fold in `on_leave` — that's a display-layer concern, kept out of this narrow endpoint.
- **`GET /agent/workload`** (existing, unchanged gate) — each `WorkspaceWorkloadAgent` gains a `status: 'online' | 'away' | 'offline' | 'on_leave'` field, computed server-side per roster row using the precedence above (batch-read `presence:conn`/`presence:status` for all roster agent ids in one Redis round trip, not N+1).
- Both new routes registered in `backend/src/docs/openapi.ts`, per repo convention.

Register the schema:

```ts
export type AgentWorkloadEntry = {
  agentId: string;
  agentName: string;
  openCount: number;
  resolved7d: number;
  status: 'online' | 'away' | 'offline' | 'on_leave';
};
```

## Error handling

- Redis unreachable: `GET /agent/workload` must not fail the whole page over presence — catch the Redis read and fall every row's `status` back to `offline`, letting open/resolved counts still render. `PATCH`/`GET /agent/presence` do fail (5xx) on Redis errors — there's nothing meaningful to degrade to for a single-agent write/read.
- `PATCH /agent/presence` with an unrecognized status string → 400 (Zod).
- `PATCH /agent/presence` when the caller has no open socket (counter at 0) → 409, since "online" or "away" without a connection is a contradiction, not a valid state to persist.

## Frontend

- **`AgentConsoleShell.tsx` header** (all roles): replace the static `{session.displayName}` span with `[Avatar w/ status dot] {displayName} [status dropdown ▾]`. Dropdown options: Online, Away — that's it; Offline and On Leave are never agent-selectable. On mount, `GET /agent/presence` seeds the dot; selecting an option calls `PATCH /agent/presence` and updates local state optimistically.
- **Workload page**: add a status-bubble column next to the `Agent` name cell, reusing the same `Avatar`/`AvatarFallback` (dummy avatar, initials) with a small colored dot badge in the corner — same visual as the header. No new nav item; page/route/label stay as they are.
- **Live updates**: both surfaces listen for `presence_changed` on the existing authenticated socket connection (already established for conversation realtime) and patch state directly — the header ignores events for other agents, the Workload page's TanStack Query cache is patched in place for the matching `agentId` row. No polling, no full refetch.

## Testing

- Backend: unit tests for the Redis presence helper (connect/disconnect counter arithmetic, `on_leave` precedence over presence), integration tests for `PATCH`/`GET /agent/presence` (including the 400 and 409 cases), and an extension of the existing Workload test asserting the new `status` field and its Redis-down fallback to `offline`.
- Frontend: extend `AgentConsoleShell.test.tsx` for the dropdown (options, optimistic update, restoring state from `GET /agent/presence`), extend `Workload.test.tsx` for the bubble column, and a test asserting a `presence_changed` socket event patches the Workload row without a refetch.
