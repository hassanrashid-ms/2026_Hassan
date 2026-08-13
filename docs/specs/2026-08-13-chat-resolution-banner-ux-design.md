# Chat resolution banner UX fixes

Status: approved
Depends on: 2026-08-13-new-ticket-conversation-design.md (for the "Open a new ticket" button's backend action only)

## Problem

Three issues in the player-facing resolution flow (`frontend/src/surfaces/webview/pages/SupportChat.tsx`):

1. The confirm banner ("Did this solve it?") reads awkwardly and should be rephrased.
2. A player can keep typing and sending messages while either banner (`confirmPending` or `settled`) is showing, even though the banner is asking for a decision first.
3. The resolved banner offers only one path back into the conversation ("Still facing issues? → Yes"), which just reopens the same thread. There's no way to start over.
4. On reopen, the system's handoff message ("You're being connected to our support team.") is inserted into the database *before* the player's own message that triggered the reopen, so it renders above the player's message instead of after it — reading as if support responded before the player said anything.

Note: the handoff message is already correctly attributed as `authorType: 'system'`, never `'player'` — issue 4 is purely an ordering bug, not an attribution bug.

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

## Testing

- Unit/integration test in `backend/tests/surface.messages.test.ts` asserting that on reopen, the player's message has a lower `seq` than the system handoff message.
- Frontend check: composer `disabled` state during `confirmPending` and `settled`.
- Manual verification of new banner copy and two-button resolved layout in the webview.

## Out of scope

- The actual "open a new ticket" backend behavior — see the companion spec.
