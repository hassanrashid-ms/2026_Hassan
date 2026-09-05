# Inactivity clock: don't ask the player when the agent hasn't replied

## Problem

`postMessage.ts:143-150` resets the inactivity clock (`resolutionCycle.inactivityDueAt`) on any
public message while the conversation is `open`/`awaiting_player`, regardless of author. So the
clock measures general thread silence, not "silence after an agent replied." `inactivityClock.ts`'s
stage 1 (`runAskStage`) then posts "Did this solve your issue?" purely because the window expired —
even when the agent never replied to the player's last message. Asking a player whether an
unaddressed message "solved it" is nonsensical.

The codebase already computes the relevant signal, just one step too late: stage 2
(`runTimeoutStage`, `inactivityClock.ts:179-191`) sets `resolutionCycle.supportOwedFlag = true`
when the latest public, non-system message is from the player — but only as a post-hoc metric on
auto-resolve, after stage 1 has already sent the nonsensical ask.

## Fix

### 1. Gate stage 1 on the same "last public, non-system message" check

In `runAskStage` (`inactivityClock.ts`), before posting `RESOLUTION_CHECK_MESSAGE`, look up the
latest public, non-system message for the conversation — same query stage 2 already runs
(`inactivityClock.ts:179-190`: `authorType != 'system'`, `visibility = 'public'`, ordered by
`seq desc`, limit 1).

- If that message's `authorType` is `'agent'` (or `'bot'`): behave exactly as today — post the ask,
  flip `confirmPhase` to `'inactivity_ask'`, append `resolution_check_requested`.
- If it's `'player'` (the agent hasn't replied since): take the new reply-owed path below instead
  of asking.

### 2. Reply-owed path: notify instead of ask

New file `domain/notifications/notifyAgentReplyOwed.ts`, mirroring `notifyAgent.ts`'s shape:

```ts
export type NotifyAgentReplyOwedParams = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
};

export async function notifyAgentReplyOwed(
  tx: Tx,
  params: NotifyAgentReplyOwedParams,
): Promise<NotificationView> {
  // Same conversation/workspace lookup as notifyAgent, writes:
  // type: 'reply_owed', payload: { ticket_number, priority, workspace_name, workspace_slug }
  // Reuses the exported toNotificationView from notifyAgent.ts.
}
```

- **Conversation has an assigned agent:** call `notifyAgentReplyOwed` for that agent.
- **Conversation is unassigned** (`assignedAgentId` is null — possible via `unassignConversation`
  leaving status untouched): instead, insert one `reply_owed` notification per `team_lead` in the
  workspace (query `workspaceMember` where `role = 'team_lead'` and `deactivatedAt is null`), since
  there's no specific agent to notify.
- Both cases emit `emitNotificationNew` through the job's existing `tryIo('jobs', { workspaceId,
conversationId })` pattern (already used in this file for `emitMessageToRooms`/
  `emitPhaseChanged`), so the notification pushes live over the socket the same way every other
  notification does.

`candidates()` (`inactivityClock.ts:59-78`) needs `conversation.assignedAgentId` added to its
select so `runAskStage` can branch on it, and `lockAndCheck` (`inactivityClock.ts:86-101`) should
re-read it too, to avoid acting on a stale assignment if the ticket was unassigned between the
candidate scan and the lock.

### 3. Re-arm the clock, don't flip confirmPhase

On the reply-owed path: skip `postMessage` (no player-facing text), call the already-exported
`touchInactivityClock(tx, { conversationId, now })` directly to push `inactivityDueAt` one window
out, and leave `confirmPhase` at `'none'`. This means:

- The agent gets nudged again only after another full silent window, not every tick.
- Stage 2's timeout logic can never fire off this path (it requires `confirmPhase =
'inactivity_ask'`, which this path never sets) — so an unanswered ticket can no longer
  auto-resolve as `timed_out` while genuinely still waiting on the agent, which was possible before
  this fix in the edge case where the player's message itself was old enough to satisfy both
  windows.

### 4. Audit event

Append a new event type `reply_owed_reminder_sent` (payload: `{ source: 'inactivity', notified:
'agent' | 'team_leads' }`), the reply-owed path's equivalent of `resolution_check_requested`.

## What doesn't change

- `supportOwedFlag` / stage 2's timeout logic: unchanged. It still exists for the case where an ask
  _was_ sent (agent had replied at the time) and the player then went silent.
- `touchInactivityClock`'s trigger (any public message resets the clock): unchanged. This fix only
  changes what stage 1 does when the window expires, not what resets it.
- No schema/migration changes — `notification.type` is free text, no enum to extend.

## Testing

- `jobs.inactivityClock.test.ts`: new cases —
  - agent hasn't replied (last public message is player's) → no `RESOLUTION_CHECK_MESSAGE` posted,
    `confirmPhase` stays `'none'`, `inactivityDueAt` pushed out a full window, a `reply_owed`
    notification row exists for the assigned agent, `reply_owed_reminder_sent` event appended.
  - agent had replied → unchanged existing behavior (ask posted, phase flips).
  - unassigned conversation, agent hasn't replied → one `reply_owed` notification per team lead,
    none for a plain `agent` role member.
  - internal note from the agent does not count as a reply (mirrors the existing
    `visibility = 'internal'` exclusion in stage 2's query).
- `notifications` test coverage: add a focused test for `notifyAgentReplyOwed`'s payload shape,
  alongside existing `notifyAgent` tests if any exist.
