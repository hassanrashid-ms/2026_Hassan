# Resolved-ticket composer lock and auto-close countdown

**Status:** Draft
**Date:** 2026-09-02

## Problem

An agent was able to send a message on a conversation whose status was `resolved`. Two independent gaps allow this:

1. **No server-side guard.** `sendAgentMessage` (`backend/src/agent/services/messagesService.ts`) fetches `conversation.status` but never checks it before calling `postMessage`. Nothing at the API rejects a send on a `resolved`/`closed` conversation — permission checks must run at the API per this repo's rules, and today this one doesn't.
2. **Stale client cache.** The console already computes `readOnly = status === 'resolved' || status === 'closed'` (`ConversationDetailPane.tsx`) and disables the composer when `readOnly` is true (`ThreadPanel.tsx`). But when a conversation resolves *while an agent is viewing it* — via player confirmation, the 24h inactivity-clock auto-resolve job, or another agent's force-resolve — the socket event that announces it (`conversation:phase_changed`, emitted to the `conv:{id}:agents` room all three triggers already reach) only triggers `ThreadPanel`'s handler to invalidate `['inbox','mine']`/`['inbox','unassigned']`. It never invalidates `['conversation', conversationId, 'detail']`, the query `status` is read from. So `status` stays stale, `readOnly` stays `false`, and the composer stays live and accepts a send that gap #1 then lets through.

Separately, there's no visibility into when a resolved ticket will auto-close (`resolution_cycle.resolvedAt` + the workspace's `autoCloseDays`, default 7 — see `backend/src/shared/jobs/autoClose.ts`). An agent viewing a resolved ticket has no way to tell if it closes in an hour or a week.

## Goals

- A resolved or closed conversation can never accept an agent-authored message, enforced at the API, not just the UI.
- The console's read-only state for a conversation updates immediately when it resolves while being viewed, regardless of which of the three triggers caused it.
- An agent viewing a resolved ticket sees a live countdown to when it auto-closes.

## Non-goals

- Changing player-side message posting — a player message still reopens a resolved/closed conversation with no time limit, per the existing status machine. This spec only tightens the agent-authored send path.
- Changing the auto-close job itself, its 7-day default, or per-workspace configurability.
- A server-push countdown (e.g. a scheduled re-emit as the deadline approaches). The countdown is a client-side tick from data already on the conversation-detail response.

## Design

### A. Server-side send guard

`backend/src/agent/services/messagesService.ts`: after the existing `found` lookup (which already selects `status`), add a status check before calling `postMessage`, matching the `wrong_status` pattern already used by `askResolved` (`resolutionService.ts`) and `escalateConversation` (`escalationService.ts`):

```ts
const BLOCKED_SEND_STATUSES = new Set(['resolved', 'closed']);
if (BLOCKED_SEND_STATUSES.has(found.status)) return { outcome: 'wrong_status' } as const;
```

`backend/src/agent/controllers/messagesController.ts`: map the new `wrong_status` outcome to `409`, mirroring the existing outcome→status-code table style already used for `askResolved`/`escalateConversation` handlers:

```ts
wrong_status: [409, 'Cannot send a message to a resolved or closed conversation.'],
```

Update `backend/src/docs/openapi.ts`'s existing schema for this route to include the new `409` response.

### B. Fix the stale `readOnly` bug

`frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`, the `conversation:phase_changed` socket handler:

```ts
socket.on('conversation:phase_changed', () => {
  void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
  void queryClient.invalidateQueries({ queryKey: ['tickets'] });
  void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
  void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
  void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
});
```

This matches the invalidation breadth `forceResolve`'s own `onSuccess` already uses, and for the same reason noted in that code's comment: `ConversationDetailPane` prefers a cached queue-row's (`summary`) status over `detail`'s, so `tickets`/`tickets-summary` must be invalidated too, not just `detail` — otherwise a stale `summary` row keeps overriding the freshly-refetched `detail.data.status`.

All three resolve triggers (player confirmation, inactivity-clock timeout, force-resolve) already call `emitPhaseChanged`, which reaches the `conv:{id}:agents` room `ThreadPanel` joins on `join_conversation` — so no backend or room-membership change is needed, only the client-side invalidation set.

As a secondary UX guard for the residual race (agent's send request is in flight the instant the ticket resolves), add an `onError` branch to the `send` mutation that shows a toast when the server responds `409`:

```ts
onError: (error, _variables, context) => {
  setPending((current) =>
    current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
  );
  if (isWrongStatusError(error)) {
    toast.error('This ticket was just resolved — your message was not sent.');
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
  }
},
```

(`isWrongStatusError` — a small helper checking the API error's status code, following whatever existing pattern `agentApi.ts` uses to surface HTTP status on thrown errors; use that pattern rather than introducing a new one.)

### C. Expose `resolved_at` and `auto_close_days` on conversation detail

`backend/src/agent/services/conversationContextService.ts`, `getConversationDetail`: join `resolution_cycle` (on `conversationId`, most recent cycle — same join shape the auto-close job itself uses against `resolution_cycle.resolvedAt`) and `workspace` (already joinable, or already in scope via `ctx.workspaceId`) to select `resolvedAt` and `autoCloseDays`.

`packages/types/src/agent-context.ts`, `AgentConversationDetail`: add

```ts
resolved_at: string | null;
auto_close_days: number;
```

`resolved_at` is `null` whenever there's no closed resolution cycle (i.e. status isn't `resolved`/`closed`) — the frontend only reads it when `readOnly && status === 'resolved'`. `auto_close_days` is returned unconditionally (cheap, workspace-scoped, not sensitive) rather than gated behind the team-lead/admin-only `/agent/workspace-settings` endpoint, since any agent who can view the conversation should be able to see when it closes.

Update the response schema in `backend/src/docs/openapi.ts` for `GET /agent/conversations/:id` to include both fields.

### D. Resolved-ticket banner with live countdown

`ThreadPanel.tsx` gains two new props, threaded from `ConversationDetailPane.tsx`'s `detail.data`: `resolvedAt?: string | null` and `autoCloseDays?: number`.

New hook, colocated with `ThreadPanel.tsx` or in `features/chat/hooks/` if it fits that shared layer better:

```ts
function useAutoCloseCountdown(resolvedAt: string | null | undefined, autoCloseDays: number | undefined): string | null {
  const deadline = resolvedAt && autoCloseDays ? new Date(resolvedAt).getTime() + autoCloseDays * 86_400_000 : null;
  const [label, setLabel] = useState(() => (deadline ? formatCountdown(deadline - Date.now()) : null));
  useEffect(() => {
    if (!deadline) return;
    const tick = () => setLabel(formatCountdown(deadline - Date.now()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [deadline]);
  return label;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'closing soon';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `closes in ${days}d ${hours}h`;
  if (hours > 0) return `closes in ${hours}h ${minutes}m`;
  return `closes in ${minutes}m`;
}
```

The existing amber banner block in `ThreadPanel.tsx` splits on status instead of a single generic string:

```tsx
{readOnly && (
  <div role="status" className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
    <Archive className="size-3.5 shrink-0" />
    {status === 'resolved' ? 'Viewing resolved ticket' : 'Viewing closed ticket'}
    {ticketNumber != null && ` · #${ticketNumber}`}
    {openedAt && ` · ${resolverLabel(resolutionSource, resolvedByAgentName)}`}
    {status === 'resolved' && countdownLabel && ` · ${countdownLabel}`}
  </div>
)}
```

(Replacing the old `${status ?? 'resolved'} · opened ${formatTicketDate(openedAt)}` fragment with `resolverLabel(...)`, which is already computed today for the composer placeholder and is more informative than the bare status word — "Resolved by Sam" rather than "resolved". `closed` tickets keep showing the resolver label with no countdown appended.)

## Data flow summary

```
resolution_cycle.resolvedAt, workspace.autoCloseDays
  → getConversationDetail (join)
  → GET /agent/conversations/:id → AgentConversationDetail.{resolved_at, auto_close_days}
  → ConversationDetailPane (useQuery ['conversation', id, 'detail'])
  → ThreadPanel props → useAutoCloseCountdown → banner text, re-ticked client-side every 60s
```

## Testing

- Backend: unit test for `sendAgentMessage` returning `wrong_status` on `resolved`/`closed`; controller test asserting `409`.
- Backend: `getConversationDetail` test asserting `resolved_at`/`auto_close_days` present after a resolve, `resolved_at: null` before one.
- Frontend: existing `ThreadPanel`/`ConversationDetailPane` tests (if any) extended to cover the `conversation:phase_changed` invalidation set; a countdown-formatting unit test for `formatCountdown` at boundary values (0, <1h, exactly 1d, etc).
- Manual: resolve a ticket via each of the three triggers while another session has it open in the console; confirm the composer disables and the banner/countdown appear without a manual reload.
