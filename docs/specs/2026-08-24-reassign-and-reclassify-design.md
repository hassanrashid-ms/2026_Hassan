# Reassign conversations & correct classification

## Why

The permission matrix (`Docs/Customer Support Tool - CRM v2.txt`, "Permission matrix") has two
conversation actions that exist as concepts but have no endpoint or UI yet:

- **Reassign any conversation** — Team Lead/Admin only. Today the only ways a conversation's
  `assigned_agent_id` changes are `claim` (self-assign, only when unassigned) and `take-over`
  (self-assign, only from `bot_active`). Neither lets a TL/Admin move a conversation that already
  has an owner to a *different* agent — the thing "reassignment" means in the spec's people-and-routing
  glossary ("lead reassigns").
- **Correct the classification** — Agent, Team Lead, and Admin. `conversation.subintent_id` is
  currently write-once from the agent's side: `classifyIfUnset` (`domain/bot/applyBotTurn.ts`) only
  sets it while `NULL`. There is no path for a human to fix a wrong bot classification, or to
  classify a conversation the bot never got to.

This spec adds one endpoint and one small UI control for each, reusing the existing
claim/take-over/merge code paths as templates rather than introducing new patterns.

## Rules this must honor (from the product spec)

- Reassignment is Team Lead/Admin only; a regular Agent keeps only `claim` and `take-over` for
  self-assignment. This is a different permission than "view all in workspace", which every role has.
- Classification correction is available to all three roles — it's a data-quality fix, not an
  escalation of privilege.
- Nothing is ever deleted or silently overwritten without a record: every assignment and
  classification change is an event; classification changes are also change-logged, matching how
  taxonomy edits are audited.
- A deactivated agent's open conversations return to the unassigned queue rather than staying with
  someone who isn't there (existing rule) — reassignment must not be a backdoor around this, so the
  target agent must be an active member of the workspace.

## Backend

### Reassign

New function `reassignConversation(ctx, conversationId, targetAgentId)` in
`agent/services/conversationsService.ts`, alongside `claimConversation`/`takeOverConversation`.

| Check | Failure |
|---|---|
| Conversation exists in this workspace and `status IN ('open', 'awaiting_player', 'escalated')` | 404 if missing, 409 `invalid_status` otherwise — `bot_active` goes through `take-over`, `resolved`/`closed`/`new` are not ownable states |
| Target agent has a non-deactivated `workspace_member` row in `ctx.workspaceId` | 404 `agent_not_found` |
| Target agent's `agent.status = 'active'` | 409 `agent_not_active` |

On success, in one transaction:
1. `UPDATE conversation SET assigned_agent_id = targetAgentId` — no `isNull` guard, unlike `claim`;
   this is the override path and may move a conversation away from its current owner.
2. `appendEvent({ type: 'conversation_reassigned', actorId: ctx.agentId, actorType: 'agent', payload: { agent_id: targetAgentId, reassigned_by: ctx.agentId, via: 'reassign' } })`.
3. Post an internal system message via a new `postReassignedNotice` helper (same shape as the
   existing `postTakenOverNotice`): `"Reassigned to {targetAgentName} by {actorName}."`.

New route: `PATCH /agent/conversations/:id/assign`, body `{ agentId: string }` (Zod-validated
uuid), gated by `requireTeamLeadOrAdmin`. Controller mirrors
`takeOverConversationHandler`: on success, `emitInboxChanged(io, workspaceId, conversationId, status)`
(status is unchanged, but this is the exact signal `ContextRail`'s `conversation:changed` socket
listener already invalidates its caches on) and emit the posted message to agent/player rooms via
`emitMessageToRooms` (player payload is `null` since the message is internal).

Response: `{ reassigned: boolean }`, following `{ taken_over: boolean }`'s existing shape.

### Correct classification

New function `reclassifyConversation(ctx, conversationId, subintentId)` in the same service file.

| Check | Failure |
|---|---|
| Conversation exists in this workspace | 404 |
| Target subintent exists in this workspace and `archivedAt IS NULL` | 409 `invalid_subintent` |

No status restriction — allowed on any conversation status, including `resolved`/`closed`, since
this corrects reporting data rather than performing a workflow action.

On success, in one transaction:
1. `UPDATE conversation SET subintent_id = subintentId, classification_source = 'agent'`.
2. `appendEvent({ type: 'conversation_reclassified', actorId: ctx.agentId, actorType: 'agent', payload: { from_subintent_id, to_subintent_id: subintentId, classification_source: 'agent' } })`.
3. `appendChangeLog({ entityType: 'conversation', entityId: conversationId, actorId: ctx.agentId, changes: [{ field: 'subintent_id', before: from_subintent_id, after: subintentId }] })`.

No system message posted — classification is metadata; the badge itself is the visible artifact of
the change, and it doesn't need to interrupt the transcript the way ownership changes do.

New route: `PATCH /agent/conversations/:id/subintent`, body `{ subintentId: string }`
(Zod-validated uuid), open to any authenticated agent (no extra role middleware — just
`requireAgentSession`, matching how `GET /agent/intents` is open to any role today). Controller
emits `emitInboxChanged` the same way as reassign.

### Both

- Register both routes and their Zod schemas in `backend/src/docs/openapi.ts`, per repo convention.
- Both new event types (`conversation_reassigned`, `conversation_reclassified`) join the existing
  free-text `event.type` column — no enum to extend, matching `conversation_assigned` /
  `conversation_taken_over` today.

## Frontend

Both controls live in `ThreadPanel.tsx`'s header row, where the subintent badge and `TagPicker`
already sit.

- **`AssignPicker`** (new component, `pages/Inbox/components/AssignPicker.tsx`) — a popover/search
  list modeled directly on `TagPicker.tsx`, sourced from the existing `GET /agents` endpoint instead
  of `GET /agent/tags`. Trigger renders the current assignee's name (or "Unassigned"). Rendered only
  when `canBuildForms(session)` from `lib/agentSession.ts` is true — that helper's role set (`undefined
  | team_lead | admin`) is exactly the Team Lead/Admin gate this feature needs, so it's reused as-is
  rather than adding a duplicate `canReassign` helper. Selecting an agent calls the new
  `reassignConversation` API function and invalidates `['conversation', id, 'detail']`,
  `['tickets']`, and `['inbox', 'mine']` — the same set `takeOver`/`claim` already invalidate.
- **Subintent badge becomes interactive** — the existing static
  `<Badge>{subintent.intent_name} · {subintent.subintent_name}</Badge>` (line ~292-296 today) becomes
  the trigger for a new `SubintentPicker` popover, same `TagPicker` pattern again, sourced from the
  existing `GET /agent/intents` (already powers `CategorySidebar` and the Taxonomy tab), flattened to
  its non-archived subintents and grouped by intent name in the list. Visible to every role — no
  gating. Selecting one calls the new `reclassifyConversation` API function and invalidates
  `['conversation', id, 'context']`, which is where `ThreadPanel` already reads `subintent` from
  (see the existing comment on that line about the context payload having no top-level subintent).
- No new page or route. Both additions are enrichments of the existing thread header.

## Out of scope

- Notifying the newly-assigned agent (the product spec mentions "agents are told... when a
  conversation is reassigned to them") — there is no notification infrastructure anywhere in this
  codebase yet. The `conversation_reassigned` event plus the conversation's appearance in the
  target agent's "mine" queue is the only signal, consistent with every other state change today.
- Auto-assignment / round-robin logic — untouched. This only adds a manual override path alongside it.
- Priority correction and label correction — separate rows in the permission matrix, not part of
  this spec.
- Bulk reassignment or bulk reclassification — one conversation at a time, matching every other
  mutation in this router.
