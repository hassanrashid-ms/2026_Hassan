# Make conversation priority actually work

## Why

`conversation.priority` (`conversation_priority` enum: `p1`/`p2`/`p3`/`p4`) is a fully built,
filterable, sortable column — `listConversations`'s default `ORDER BY conversation.priority,
createdAt` and `globalInboxService`'s cross-workspace merge sort both already rank by it correctly.
It looks broken because nothing ever writes anything but the schema default:

- Both conversation-insert sites (`surface/services/newTicketService.ts`,
  `surface/services/messagesService.ts`) omit `priority` from `.values()`, so every conversation is
  born `p3`.
- `subintent.defaultPriority` (`shared/db/schema/taxonomy.ts:46`) exists specifically to seed
  priority from classification — the column comment says as much ("No consumer yet... Column
  exists so routing work later needs no migration") — but no code path reads it.
- There is no way to change a conversation's priority after creation either: no endpoint, no UI
  control. `ConversationRow.tsx` only renders the badge.

This spec gives priority two real write paths: automatic, from subintent classification, and
manual, from an agent overriding it directly — with manual permanently taking precedence once used.

## Rules this must honor

- **Manual always wins.** Once an agent has explicitly set a conversation's priority, no later
  auto-classification (including reclassification to a different subintent) may overwrite it.
- Auto-priority only fires when the target subintent actually has a `defaultPriority` configured —
  a subintent with no default leaves the conversation's priority untouched.
- No silent no-op events: skip the update (and the event) entirely when the computed priority
  equals the current one, so the event stream isn't padded with `p3 → p3` noise.
- Same append-only pattern as every other conversation mutation: `UPDATE conversation` + `appendEvent`
  in one transaction. Manual edits are also change-logged, matching `reclassifyConversation`.
- Manual priority edit is open to any active agent — same permission level as claim/take-over/reclassify,
  not gated to Team Lead/Admin (that gate is reserved for reassign, per the existing permission matrix).

## Data model change

Add `priorityManuallySet boolean not null default false` to `conversation`
(`shared/db/schema/conversations.ts`). This is the only way to distinguish "still `p3` because
nobody's touched it" from "an agent chose `p3`." Generate the migration with `pnpm db:generate`
after the schema edit; existing rows default to `false`, which is correct — no conversation has ever
had its priority manually set today.

## Backend

### Auto-priority from subintent classification

A new internal helper, `applySubintentDefaultPriority(tx, conversation, subintent)`, called from
both places `conversation.subintentId` is written, inside their existing transaction:

- `domain/bot/applyBotTurn.ts` → `classifyIfUnset` (bot's first classification)
- `agent/services/conversationsService.ts` → `reclassifyConversation` (agent-initiated correction)

Logic: if `subintent.defaultPriority IS NOT NULL`, `conversation.priorityManuallySet` is `false`,
and `subintent.defaultPriority !== conversation.priority` → `UPDATE conversation SET priority =
subintent.defaultPriority` and `appendEvent({ type: 'conversation_priority_changed', actorId,
actorType, payload: { from, to, reason: 'subintent_default' } })`, using the same `actorId`/`actorType`
already in scope at each call site (`'bot'` in `classifyIfUnset`, `'agent'` in `reclassifyConversation`).
Otherwise, no-op. This is a plain function call inside the existing transaction, not a new
withWorkspace block — no new failure modes, no new checks.

### Manual priority edit

New function `setConversationPriority(ctx, conversationId, priority)` in
`agent/services/conversationsService.ts`, alongside `claimConversation`/`reassignConversation`/`reclassifyConversation`.

| Check                                 | Failure |
| ------------------------------------- | ------- |
| Conversation exists in this workspace | 404     |

No status restriction, same reasoning as `reclassifyConversation` — priority is metadata, not a
workflow action, so it's correctable on `resolved`/`closed` conversations too. No-op (skip update
and event) if `priority` equals the current value.

On success, in one transaction:

1. `UPDATE conversation SET priority = :priority, priority_manually_set = true`.
2. `appendEvent({ type: 'conversation_priority_changed', actorId: ctx.agentId, actorType: 'agent', payload: { from, to, reason: 'manual' } })`.
3. `appendChangeLog({ entityType: 'conversation', entityId: conversationId, actorId: ctx.agentId, changes: [{ field: 'priority', before: from, after: priority }] })`.

New route: `PATCH /agent/conversations/:id/priority`, body `{ priority: 'p1'|'p2'|'p3'|'p4' }`
(Zod-validated enum), open to any authenticated agent (`requireAgentSession` only, same gate as
`reclassifyConversation`'s route). Controller mirrors `reclassifyConversationHandler`: on success,
`emitInboxChanged(io, workspaceId, conversationId, status)`. Response: `{ updated: boolean }`,
following the existing `{ reassigned: boolean }` / `{ taken_over: boolean }` shape convention.

No system message posted — same reasoning as reclassify: the badge is the visible artifact, no
need to interrupt the transcript.

### Both

- Register the new route and its Zod schema, and the new `conversation_priority_changed` event
  type, in `backend/src/docs/openapi.ts`.
- `conversation_priority_changed` joins the existing free-text `event.type` column — no enum to
  extend.

## Frontend

- `agentApi.ts`: new `setConversationPriority(token, id, priority)` calling `PATCH
/agent/conversations/:id/priority`.
- Extract `PRIORITY_BADGE_VARIANT` out of `ConversationRow.tsx` into a shared constant (e.g.
  `pages/Inbox/priorityBadge.ts`) so both the list row and the new picker use the same map.
- New `PriorityPicker.tsx` (`pages/Inbox/components/`), modeled on `SubintentPicker.tsx`'s
  Popover+Command pattern: trigger is the priority `Badge`, list is the 4 static priority values
  (no query needed — unlike subintents/agents this isn't a fetched list). Visible to every role, no
  gating, matching `SubintentPicker`. Selecting a value calls `setConversationPriority` and
  invalidates `['conversation', id, 'detail']`, `['tickets']`, `['inbox', 'mine']`.
- Wire `PriorityPicker` into `ThreadPanel.tsx`'s header, next to the subintent badge — the header
  currently has no priority display at all.
- `AgentConversationDetail` (`packages/types/src/agent-context.ts`) gets a `priority` field; the
  backend query behind `GET /agent/conversations/:id` (`fetchConversation`) must select the column
  if it isn't already.

## Testing

Backend: integration tests for `setConversationPriority` (event emitted with correct payload,
`priorityManuallySet` becomes `true`, no-op when value unchanged, 404 on missing conversation) and
for `applySubintentDefaultPriority` from both call sites (applies when unset, skipped when
`priorityManuallySet` is `true`, skipped when the subintent has no default, no-op when the computed
value equals the current one). Frontend: component test for `PriorityPicker` mirroring whatever
test exists for `SubintentPicker`/`AssignPicker`, if any.

## Out of scope

- Retroactively applying subintent default priority when `taxonomyService.mergeSubintent` bulk
  repoints conversations from a merged subintent — existing conversations' priority is untouched by
  a merge.
- Any change to `assignOnHandoff` (auto-assignment) — it stays workload/presence-based, priority-blind.
  Priority already drives ordering at read time (queue sort); this spec doesn't add priority as an
  assignment-eligibility input.
- Bulk priority edits — one conversation at a time, matching every other mutation in this router.
- Notifying an agent when a conversation they own crosses a priority threshold — no notification
  infrastructure exists anywhere in this codebase yet.
