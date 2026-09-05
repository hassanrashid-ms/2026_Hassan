# Ticket assignment notifications

Status: draft
Date: 2026-09-02

## Problem

When a ticket is assigned to an agent — by claim, take-over, manual reassign, the
unassigned-queue sweep, or bot handoff — nothing tells that agent it happened unless
they are already looking at the inbox for that workspace. There is no persistent
record of "you were assigned this" either, so an agent who was offline, in a
different workspace, or simply not watching the inbox has no way to discover a new
assignment except by re-scanning the ticket list.

Agents commonly belong to more than one workspace (game). An assignment can land in
a workspace the agent is not currently viewing.

## Goals

- The moment a ticket becomes assigned to an agent, they see a toast — even if the
  assignment happened in a workspace other than the one they're currently viewing,
  in which case the toast/notification must say which workspace it was.
- Notifications persist (a new `notification` table) so an agent can review recent
  assignments after the toast is gone, not just at the instant of assignment.
- A bell icon in the agent-console navbar shows a red bubble for pending (unread)
  notifications and opens a dropdown of recent notifications.
- Clicking a notification in the dropdown marks it read and opens that ticket
  (switching the active workspace first if the ticket belongs to a different one).
- An explicit "mark all as read" action clears the bubble without visiting each
  ticket.
- The send/create path is a single function, isolated in its own module, called
  from every place a ticket becomes assigned — including future assignment paths —
  so adding a new assignment mechanism later means one function call, not new
  plumbing.

## Non-goals

- Notifying the _previous_ agent when a ticket is reassigned away from them.
- Notifying about anything other than ticket assignment (no message notifications,
  no mention notifications, etc.) — the `type` column is generic for future reuse,
  but only `ticket_assigned` is implemented here.
- Push notifications outside the browser tab (browser push, email, mobile). Only
  in-app toast + persistent dropdown.
- Pruning/deleting old notifications. Rows are kept forever, consistent with the
  "no hard deletes anywhere" rule already in this codebase.
- A separate deployable service. This is an in-process backend module with its own
  table — "isolated" here means a clean module boundary, not a network boundary.

## Approach

### Data model

New table, `backend/src/shared/db/schema/notifications.ts`:

```ts
notification = pgTable('notification', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id), // RLS tenant column
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agent.id), // recipient
  type: text('type').notNull(), // 'ticket_assigned'
  conversationId: uuid('conversation_id').references(() => conversation.id),
  payload: jsonb('payload')
    .notNull()
    .default(sql`'{}'::jsonb`),
  readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }), // null = unread
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
```

Standard `tenant` RLS policy on `workspace_id`, identical in shape to every other
scoped table (`002_rls.sql` convention): `USING (workspace_id = current_setting('app.workspace_id'))`.

For `type: 'ticket_assigned'`, `payload` holds:

```json
{
  "ticketNumber": 482,
  "priority": "p2",
  "via": "claim" | "take_over" | "reassign" | "sweep" | "bot_handoff",
  "workspaceName": "Wanderlust Kingdoms",
  "workspaceSlug": "wanderlust-kingdoms"
}
```

`workspaceName`/`workspaceSlug` are snapshotted at creation time, not looked up via
join at read time — same rule the `event` table already follows ("payload values in
events are snapshotted, never live pointers"), and necessary here because a
dropdown read may happen from a request scoped to a _different_ workspace than the
one the notification belongs to.

Index: `(agent_id, workspace_id, read_at)` to support the unread-count and
mark-all-read queries per workspace.

### Send function (the integration point)

`backend/src/domain/notifications/notificationsService.ts`:

```ts
export async function notifyAgent(
  tx: Tx,
  params: {
    workspaceId: string;
    agentId: string;
    type: string;
    conversationId?: string;
    payload: Record<string, unknown>;
  },
): Promise<NotificationRow>;
```

Called inside the _same transaction_ as the assignment write, immediately after the
existing `appendEvent(...)` call, at every current assignment site:

- `claimConversation` (`conversationsService.ts`)
- `takeOverConversation` (`conversationsService.ts`)
- `reassignConversation` (`conversationsService.ts`)
- `assignNextTicket` (`domain/routing/assignNextTicket.ts`, sweep — called once per
  loop iteration, so a sweep that assigns 5 tickets creates 5 notifications)
- wherever the bot-handoff assignment (`assignOnHandoff`) is committed

Each call site already runs inside `withWorkspace(workspaceId, tx => ...)`, so
`notifyAgent` has the correct `app.workspace_id` set for the RLS insert, and can
read `workspace.name`/`workspace.slug` in the same transaction to build the
snapshot payload (the `workspace` table is unscoped, so this read is always valid
regardless of which workspace is active).

If a future assignment path is added, wiring in a notification is one
`notifyAgent(tx, { ... })` call at the point where the assignment write commits —
nothing else in this design needs to change.

### Realtime delivery

New per-agent Socket.io room, alongside the existing `conv:{id}:agents`,
`conv:{id}:player`, `workspace:{id}:inbox` rooms (`shared/realtime/rooms.ts`):

```ts
export const agentNotificationRoom = (agentId: string): string => `agent:${agentId}`;
```

An agent's socket already joins every workspace's inbox room it's a member of on
connect (`socketServer.ts`) — add joining `agentNotificationRoom(agentId)` at the
same point, once per connection, independent of workspace. This is what makes
cross-workspace delivery work for free: the room isn't workspace-scoped, so an
assignment in any workspace the agent belongs to reaches the same socket.

After the assignment transaction commits, the handler layer (not the service, same
pattern `emitInboxChanged` already follows) emits:

```ts
emitNotificationNew(io, agentId, notificationView); // io.to(agentNotificationRoom(agentId)).emit('notification:new', notificationView)
```

For sweep, the handler emits one `notification:new` per assignment returned by
`sweepUnassignedQueue`, same as it already emits one `conversation:changed` per
assignment.

### API surface

Registered in `backend/src/docs/openapi.ts` per repo convention.

| Method  | Path                      | Notes                                                                                                                      |
| ------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/notifications`          | Returns `{ notifications: NotificationView[], unreadCount: number }` — latest 20 across **all** of the caller's workspaces |
| `PATCH` | `/notifications/:id/read` | Marks one notification read                                                                                                |
| `PATCH` | `/notifications/read-all` | Marks all of the caller's unread notifications read, across all their workspaces                                           |

### Cross-workspace reads and writes

Notifications are workspace-scoped rows (RLS requires a single `app.workspace_id`
per transaction) but must be readable/writable across every workspace an agent
belongs to in one dropdown/one "mark all read" action. This reuses the existing
`getGlobalInbox` pattern (`agent/services/globalInboxService.ts`) exactly:

1. `listActiveMembershipsForAgent(agentId)` (existing, uses `adminDb`, intentionally
   bypasses RLS to answer "which workspaces is this agent in") gets the workspace
   list.
2. Scatter: one `withWorkspace(ws.id, tx => ...)` query per workspace, gathered
   with `Promise.all` (reuse the existing `pLimit` concurrency cap), each returning
   that workspace's notifications for this agent.
3. Gather: merge, sort by `createdAt DESC`, take the top 20 for `GET
/notifications`; sum unread counts across workspaces for `unreadCount`.
4. `PATCH /notifications/:id/read`: look up which workspace the id belongs to (from
   the gathered set, or a light per-workspace existence check) and issue the update
   inside that workspace's `withWorkspace`.
5. `PATCH /notifications/read-all`: same scatter as step 2, then one `UPDATE
notification SET read_at = now() WHERE agent_id = $1 AND read_at IS NULL` inside
   each workspace's `withWorkspace`, in parallel.

An agent in exactly one workspace is the same code path with a one-element scatter
— no special-casing.

### Frontend

**Bell + dropdown** — new `NotificationBell.tsx` in
`frontend/src/surfaces/agent-console/components/`, mounted in
`AgentConsoleShell.tsx`'s header next to the existing avatar dropdown. Tailwind
utilities/theme tokens only, per repo styling rules.

- TanStack Query hook fetches `GET /notifications` (`notifications`,
  `unreadCount`). Bell shows a red bubble with the unread count when `> 0`.
- Dropdown lists up to 20 notifications, unread ones visually distinct (e.g.
  `bg-accent-soft` per surface tokens). Each row shows the ticket number, priority,
  and — when `payload.workspaceName` differs from the currently active
  workspace — that workspace's name, so a cross-workspace notification is
  unambiguous at a glance.
- Row click: `PATCH /notifications/:id/read`, switch active workspace to
  `payload.workspaceSlug` if different from the current one (same mechanism
  `WorkspaceSwitcher` already uses), then navigate to that conversation's thread.
- "Mark all as read" button in the dropdown header: `PATCH
/notifications/read-all`, clears the bubble immediately (optimistic update).

**Realtime toast** — existing socket connection subscribes to `notification:new`;
on receipt: `toast(...)` via Sonner (already wired at the app root) with the
ticket number + workspace name, and prepend/update the `GET /notifications` query
cache so the bell bubble and dropdown reflect it without waiting for the next
fetch.

## Error handling

- `notifyAgent` failing must not roll back the assignment — but per repo
  convention ("one function writes both conversation and event in a single
  transaction"), the notification insert runs in the _same_ transaction as the
  assignment write, so either both commit or both roll back together. A failure
  here means the assignment itself failed, which is already the correct behavior
  for a transaction failure — there's no case where "assignment succeeds but
  notification silently fails" because they're the same commit.
- Realtime emit (`notification:new`) happens after commit, at the handler layer,
  same as `emitInboxChanged` — if the socket emit itself fails or the agent is
  offline, the notification row already exists and the next `GET /notifications`
  (e.g. on page load, or dropdown open) surfaces it. Socket delivery is
  best-effort; the row is the durable source of truth.
- `PATCH /notifications/:id/read` for an id belonging to a workspace the caller
  isn't a member of, or an id that doesn't exist: 404 (RLS/ownership
  indistinguishable, per existing tenancy convention).
- A workspace failing during the scatter in `GET /notifications` (e.g. transient
  DB error) degrades that workspace's slice to empty rather than failing the whole
  request — mirrors `getGlobalInbox`'s `failed_workspaces` handling.

## Testing

- Unit: `notifyAgent` inserts a row with correct `workspace_id`, snapshot payload.
- Unit: each assignment call site (`claimConversation`, `takeOverConversation`,
  `reassignConversation`, `assignNextTicket`, bot-handoff assignment) creates
  exactly one notification for the newly-assigned agent.
- Unit: sweep assigning N tickets creates N notifications, correctly attributed
  per ticket/agent.
- Unit: `GET /notifications` scatter-gathers across multiple workspaces, sorts by
  recency, caps at 20, sums unread count correctly.
- Unit: `PATCH /notifications/:id/read` and `/read-all` correctly scoped to the
  calling agent, 404 for another agent's notification.
- Integration: assignment via `PATCH /conversations/:id/assign` in workspace B
  while socket is connected → `notification:new` received on `agent:{agentId}`
  room without joining `workspace:B:inbox` from the client.
- OpenAPI doc entries added for all three new routes.
