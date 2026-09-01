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
  - `resolutionSource → 'admin_forced'` — its own value in the `resolution_source` pg enum (`shared/db/schema/enums.ts`), not `null` and not reused as `'agent'`. **Revision 2026-09-01:** this was originally shipped leaving `resolutionSource` `null`, which read as `"Closed"` in the agent console's ticket-outcome label (`ticketOutcome.ts`) — indistinguishable from an auto-closed ticket, and the whole point of a distinct event type below. `'admin_forced'` fixes that while still keeping resolution-rate metrics honest, since it is neither `null` (reads as no resolution) nor `'agent'` (reads as a real agent resolution).
  - `assignedAgentId → ctx.agentId` — the forcing admin, stamped purely so the console can show "Force-resolved by {name}". Deliberately **not** added to `AGENT_OWNED_RESOLUTIONS` in `surface/services/messagesService.ts`: on reopen, an admin override reassigns normally via `assignOnHandoff` rather than routing back to an admin who may not triage support tickets.
  - No message is posted to the player. The close is silent from the player's perspective.
- New event type `conversation_resolved_forced`, payload `{ admin_agent_id: uuid }`. This is a distinct event type, not `conversation_resolved` with a new `source` value, because every consumer of `conversation_resolved` (resolution-rate and bot-containment metrics) currently assumes that event means the player or the bot actually reached a resolution. Overloading it with an admin override would silently corrupt those metrics. Anything reading "was this conversation ever force-resolved" checks for this event type instead.
- Register the route + Zod schema in `backend/src/docs/openapi.ts` per repo convention. `resolution_source` there must list every enum value (`bot`, `agent`, `player_confirmed`, `timed_out`, `player_stated`, `admin_forced`) — it had drifted to just `['bot', 'agent']` and was fixed alongside `'admin_forced'`'s addition.
- Console display, two independent spots, both fixed in the same revision:
  - `ticketOutcome.ts` (`agent-console/pages/Inbox/components/context/`, the ticket list rail) renders `resolutionSource === 'admin_forced'` as `"Force-resolved by {name}"`. Rows written before this revision (still `null`) fall back to `"Resolved by an admin"` rather than `"Closed"` — legacy-only, new force-resolves never hit that branch.
  - `resolverLabel()` in `ThreadPanel.tsx` (the thread header's read-only tooltip) renders the same case as `"Force-resolved by {name}"`. No status param there to give legacy `null` rows the same fallback — they still read `"Closed"`, same as before this revision, since this function only ever runs once `readOnly` (i.e. resolved-or-closed) already gates it.
- Migration: `backend/drizzle/0030_sparkling_storm.sql` — `ALTER TYPE "public"."resolution_source" ADD VALUE 'admin_forced'`.

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
