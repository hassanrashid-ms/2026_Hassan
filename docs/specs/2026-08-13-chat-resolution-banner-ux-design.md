# Chat resolution banner UX fixes

Status: approved
Depends on: 2026-08-13-new-ticket-conversation-design.md (for the "Open a new ticket" button's backend action only)

## Problem

Six issues in the player-facing resolution flow (`frontend/src/surfaces/webview/pages/SupportChat.tsx`) and its agent-console/backend counterparts:

1. The confirm banner ("Did this solve it?") reads awkwardly and should be rephrased.
2. A player can keep typing and sending messages while either banner (`confirmPending` or `settled`) is showing, even though the banner is asking for a decision first.
3. The resolved banner offers only one path back into the conversation ("Still facing issues? → Yes"), which just reopens the same thread. There's no way to start over.
4. On reopen, the system's handoff message ("You're being connected to our support team.") is inserted into the database _before_ the player's own message that triggered the reopen, so it renders above the player's message instead of after it — reading as if support responded before the player said anything.
5. The agent-triggered "Did this solve it?" message is correctly stored as `authorType: 'system'`, but the agent console's shared bubble component (`ChatThread.tsx`) only has two visual states — "own" (agent) vs "not own" — so it renders identically to a real player message. Agents can't tell it apart from something the player actually typed.
6. Tapping "No" on the agent-ask confirm banner posts no message at all — `resolutionAnswer.ts`'s decline branch only flips `confirm_phase` back to `none` and logs a silent event. The agent's open thread doesn't even refetch, so there's no visible signal in the transcript that the player declined.

Note: the handoff message (issue 4) and the "Did this solve it?" message (issue 5) are already correctly attributed as `authorType: 'system'`, never `'player'` — issue 4 is purely an ordering bug and issue 5 is purely a rendering bug, neither is a DB attribution bug.

## Changes

### 1. Confirm banner copy

`confirmPending` block in `SupportChat.tsx`: change heading text from "Did this solve it?" to **"Is your issue resolved?"**. Yes/No buttons and their behavior are unchanged.

### 2. Disable composer while a banner is showing

`ChatComposer` already accepts a `disabled` prop (currently only driven by `send.isPending`). Extend the condition passed to it:

```ts
<ChatComposer onSend={(body) => send.mutate(body)} disabled={send.isPending || confirmPending || settled} />
```

While `confirmPending` or `settled` is true, the player must resolve the banner before typing again. No other change to `ChatComposer` itself.

### 3. Resolved banner: two clear actions

Replace the single "Still facing issues? → Yes" row with two buttons, heading unchanged ("Your ticket is resolved."):

- **Still facing issues** — same action as today's Yes button: `send.mutate("I'm still facing issues.")`, which reopens the same conversation via the existing `REOPENABLE_STATUSES` path in `messagesService.ts`. No backend change.
- **Open a new ticket** — calls the new-ticket endpoint defined in `2026-08-13-new-ticket-conversation-design.md`. Closes the current conversation for good and starts a fresh one; the webview clears the visible message list and returns to the empty "Say hello" state.

This button is inert (or hidden) until the new-ticket backend from the companion spec ships. Sequencing between the two specs is a rollout decision, not a design constraint — the button can be added to the UI in this change and wired up when the endpoint exists.

### 4. Fix handoff message ordering on reopen

In `messagesService.ts`'s `sendPlayerMessage`, the reopen branch currently does, inside one transaction:

1. insert the system handoff message
2. insert the player's message

Swap the order: insert the player's message first, then the system handoff message. This changes only insertion order (and therefore `seq`/`created_at` ordering) within the existing transaction — no schema change, no change to `authorType`, no change to the socket emit sequence (player message emitted, then `reopenPosted`), which already emits in the correct order and doesn't need to change.

### 5. Distinguish system messages in the agent console

`frontend/src/features/chat/components/ChatThread.tsx` currently derives bubble styling purely from `isOwn = chatMessage.authorType === currentAuthorType` — two states only. Add a third: when `chatMessage.authorType === 'system'`, render it as a centered, muted system-note style (not left/right-aligned like a party's bubble) — e.g. small pill text, no "own"/"not own" positioning. This applies to every system message (the "Did this solve it?" ask, the reopen handoff message), not just the resolution flow, since the underlying bug is the missing third visual state in a shared component.

No change needed on the webview side — `ChatBubbles.tsx`'s `own = authorType === 'player'` already renders any non-player message (bot/agent/system) as an incoming bubble, which reads correctly from the player's own perspective.

### 6. Post a player message when "No" is tapped on the agent-ask banner

In `resolutionAnswer.ts`'s decline branch (`confirm_phase === 'agent_ask'`, `helped === false`), post a real player-authored message — **"No, I'm still having issues."** — via `postMessage` before flipping `confirm_phase` back to `none`, mirroring the existing "Still facing issues" send pattern used elsewhere in this flow. Then emit it through `emitMessageToRooms` (currently skipped entirely for the `'declined'` outcome in `resolutionService.ts`) so both the player's and agent's transcripts update immediately over the normal `message:new` path — no separate fix needed to `ThreadPanel.tsx`'s socket handling, since `message:new` already drives a refetch there.

The bot-article decline path (helped=false, confirm_phase='bot_article') already posts a visible handoff message and is unaffected by this change.

## Testing

- Unit/integration test in `backend/tests/surface.messages.test.ts` asserting that on reopen, the player's message has a lower `seq` than the system handoff message.
- Frontend check: composer `disabled` state during `confirmPending` and `settled`.
- Frontend check: a `system`-authored message in `ChatThread.tsx` renders with the new centered/muted style, distinct from both "own" and "not own" bubbles.
- Backend test: tapping "No" on an `agent_ask` banner creates a player-authored message ("No, I'm still having issues.") and emits `message:new` to both rooms.
- Manual verification of new banner copy and two-button resolved layout in the webview.

## Out of scope

- The actual "open a new ticket" backend behavior — see the companion spec.
- The webview's own unread-badge display (`TopBar.tsx`) — investigated, found to already render the correct numeric count from `bootstrapService.ts`; if a "shows 1 instead of the real count" badge bug persists, it's likely in a different code path (e.g. the native Unity SDK badge via `backend/src/sdk/services/unreadService.ts`) not yet confirmed and not covered here.
