# Admin force-resolve

## Problem

Resolving a conversation today only happens through `askResolved` (`POST /agent/conversations/:id/ask-resolved`): an agent asks, a "Did this solve it?" banner goes to the player, and only the player's confirmed Yes (or the inactivity clock timing out) moves status to `resolved`. There is no way for an admin to close a conversation that is stuck — e.g. `bot_active` with no player response, or `escalated` with an unreachable player — without waiting on that consent step.

## Solution

Add a second, admin-only path that transitions a conversation straight to `resolved`, bypassing the ask/confirm cycle entirely.

### Backend

- New route `POST /agent/conversations/:id/force-resolve`, registered in `conversationsRouter.ts` alongside `ask-resolved`.
- New service function `forceResolve(ctx: AgentContext, conversationId: string): Promise<ForceResolveOutcome>` in `resolutionService.ts`.
- Authorization: reject with `403` unless `ctx.isAdmin` is true. `isAdmin` is already present on `AgentContext` (sourced from JWT claims via `requireAgentSession`), so this is an in-handler check, not new middleware — the route stays under `/agent/*`, not `/admin/*`.
- Allowed source statuses: any status except `resolved` and `closed` — i.e. `new`, `bot_active`, `open`, `awaiting_player`, `escalated`, regardless of current `confirmPhase`. This is intentionally broader than `ASKABLE_STATUSES` because the stuck conversations this exists for are not limited to the three askable statuses.
- Effect, in the same transaction pattern every other state change uses (conversation + event together):
  - `status → 'resolved'`
  - `confirmPhase → 'none'`
  - No message is posted to the player. The close is silent from the player's perspective.
- New event type `conversation_resolved_forced`, payload `{ admin_agent_id: uuid }`. This is a distinct event type, not `conversation_resolved` with a new `source` value, because every consumer of `conversation_resolved` (resolution-rate and bot-containment metrics) currently assumes that event means the player or the bot actually reached a resolution. Overloading it with an admin override would silently corrupt those metrics. Anything reading "was this conversation ever force-resolved" checks for this event type instead.
- Register the route + Zod schema in `backend/src/docs/openapi.ts` per repo convention.

### Frontend

- `ThreadPanel.tsx`: add a "Force resolve" button next to the existing "Ask if resolved" button.
  - Visible only when the current session's `isAdmin` is true.
  - Enabled for any status except `resolved`/`closed` (mirrors the backend's allowed-status set, not the narrower `askable` condition used for "Ask if resolved").
  - Clicking opens a confirmation dialog (admin-facing, not player-facing) before firing the request, since this bypasses the normal consent flow and should not be a single-click accident.
  - On success, invalidates/refetches the conversation the same way the existing `ask` mutation does.

### Out of scope

- No change to `askResolved`, `applyResolutionAnswer`, or the inactivity clock.
- No player-visible message or notification of any kind.
- No bulk/multi-conversation force-resolve — one conversation at a time, from the thread panel.

### Testing

- Backend: unit tests for `forceResolve` — non-admin rejection, successful transition from each non-terminal status (including mid-`confirmPhase`), event payload shape, and that no message row is written.
- Frontend: button visibility gated on `isAdmin`, confirmation dialog required before the mutation fires.
