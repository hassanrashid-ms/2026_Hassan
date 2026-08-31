# Bot Config live test panel

## Problem

Admins editing `BotConfig` (prompt, rules, tools, limits) have no way to see how their
changes actually change bot behavior short of saving, opening a real conversation, and
playing a player. That's slow, pollutes real conversation data, and doesn't show *why*
the bot answered the way it did (which article it cited, whether grounding passed,
why it handed off).

## Goal

A persistent chat panel inside Bot Config where an admin types as a player and gets
real bot replies — run through the actual decider, against the config **currently in
the form** (including unsaved edits) — with the bot's internal tool activity (searches,
citations, grounding, handoff reason) surfaced alongside each reply. Nothing in the
test conversation is persisted.

## Non-goals

- Persisting or tagging test conversations for an audit trail.
- Wiring up the `{{player_level}}` / `{{spend_tier}}` prompt placeholders — see
  "Known gap" below.
- Streaming or a realistic typing indicator; a simple loading state while the turn
  runs is enough.

## Frontend

### Placement

`BotConfig.tsx` currently renders one tab at a time. It gains a persistent right-side
pane — `BotTestPanel` — visible alongside whichever tab (Prompt / Rules / Tools /
Version History) is active, so an admin can tweak a rule and re-test without leaving
the tab.

New file: `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.tsx`

### Component reuse

`BotTestPanel` is built from `features/chat/components/**`, not
`surfaces/webview/components/chat/**`. The webview components are surface-specific
(per `frontend/CLAUDE.md`'s "surfaces never cross-import" rule) and themed with
webview's `--color-*` tokens; embedding them inside the agent-console surface would
either look wrong or require duplicating agent-console's theme onto them. The
`features/chat` components already re-theme correctly per surface via shared token
names, which is exactly what this panel needs:

- `ChatThread` — renders the test conversation. `currentAuthorType="agent"` (admin is
  spectating, not one of the chat participants), messages tagged `player` / `bot`.
- `Composer` — admin's input, `allowVisibilityToggle={false}`, `allowAttachments={false}`
  (attachments are out of scope; the test message is text-in/text-out).
- `MessageBody` — bot replies render through the same markdown path a real player would
  see, so the panel is also a preview of formatting, not just logic.

No socket connection, no `useJumpToLatest`/optimistic-send-then-reconcile — this thread
is never backed by the server's conversation state, so the reconciliation machinery
built for real send-latency doesn't apply. State is a plain `ChatMessage[]` in
component state, reset on tab navigation away or page reload.

### Simulated player context

A collapsible form above the composer, with the two `BotTurnInput` fields that
currently branch prompt behavior:

- **Subintent** — dropdown sourced from the workspace's subintent catalog, or "None".
- **Confirm phase** — defaults to `none`; matches `ConfirmPhaseValue`.

`player_level` / `spend_tier` are **not** included — see Known gap.

### Tool activity display

Under each bot reply, a compact strip built directly from the returned
`BotTurnDecision`, no new computation on the frontend:

| `decision.kind` | Strip shows |
|---|---|
| `answer` (with `articleId`) | Cited article title/id, grounding score, ungrounded words if any |
| `answer` (no article) | "Answered without a citation" |
| `handoff` | `decision.reason`, rendered in plain language (e.g. `unhelped_cap` → "Gave up after too many unhelpful replies") |
| `resolve` | "Marked resolved" |
| `unavailable` | `decision.reason` as an error state, red border on the strip |
| `confirm_player_resolution` | The quoted text it's confirming against |

If `decision.searches` is non-empty (regardless of kind — a search can precede any
outcome), a nested "Searched: `<query>` → N results" line per search.

### Error handling

- Network/5xx from `test-turn` → an error card in the thread in place of a bot bubble
  ("Test turn failed — check server logs"), not a silent drop.
- Draft config failing the same Zod schema `POST /agent/bot-config` uses → surfaced as
  a 400 before any decider call; panel shows "Fix validation errors on this tab before
  testing," same pattern the other tabs already use for save failures.

## Backend

### New endpoint

`POST /agent/bot-config/test-turn` — same auth guard as `POST /agent/bot-config`
(Admin role only, since it can execute against arbitrary unsaved prompt text).

Registered in `backend/src/agent/routers/botConfigRouter.ts`, alongside the existing
bot-config routes, and added to `backend/src/docs/openapi.ts` per the repo's "every new
endpoint gets registered in openapi.ts" rule.

**Request body:**

```ts
{
  config: SaveBotConfigBody;        // same shape as POST /agent/bot-config — the draft
  subintentId: string | null;
  confirmPhase: ConfirmPhaseValue;
  history: PlayerMessageView[];     // prior turns in this test conversation
  playerMessage: string;            // the new message being tested
}
```

**Response body:**

```ts
{
  decision: BotTurnDecision;        // unchanged shape — kind, reason, articleId, searches
  grounding: { score: number; ungrounded: string[] } | null; // null when no citation was made
}
```

### Execution path

The real path (`runBotTurn` in `domain/bot/orchestrator.ts`) is DB-coupled: `gather()`
reads conversation status and history from Postgres, and `applyBotTurn()` writes the
outcome back. Neither is reusable here. Instead:

1. Build a synthetic `BotTurnInput` directly from the request body — `workspaceId`
   from the authenticated session, `conversationId` unused/synthetic,
   `subintentId`/`confirmPhase` from the request, `history` from the request
   (converted from `PlayerMessageView[]`, same shape the real path already uses),
   `botMessageCount`/`unhelpedReplyCount` derived by counting `history` client-side
   rather than a DB `COUNT`.
2. Assemble the prompt via `buildMessages()`/`buildSystemPrompt()` in
   `domain/bot/contextAssembly.ts` and `defaultPrompt.ts`, but against
   `req.body.config` instead of the row `bot_config` normally loads — this is the one
   substitution that makes the "unsaved draft" requirement work, and it's a pure
   function swap, not a fork of the assembly logic.
3. Call `toolLoopDecider` directly with the assembled input. This already returns
   `BotTurnDecision` including `searches`.
4. Grounding is scored inside `toolLoopDecider`'s tool-call handling today and only
   ever logged (`bot.grounding` tag), never returned. Pull the `{ score, ungrounded }`
   result out and include it in the response instead of leaving it log-only for this
   path.
5. Return the decision. No `applyBotTurn()` call, no conversation/message/event writes.

Article search (`searchArticles` → Weaviate) runs unmodified and hits real,
workspace-scoped article data — that's read-only and doesn't need faking; it's also
the whole point of testing (does the real article catalogue actually answer this).

### Known gap

`{{player_level}}` and `{{spend_tier}}` are declared in `BOT_PROMPT_PLACEHOLDERS`
(`defaultPrompt.ts`) but the substitution in `contextAssembly.ts`'s `buildMessages()`
only replaces `{{subintents}}` and `{{articles}}` — the other two are currently inert
in production, not just in this feature. The test panel intentionally does not build
UI for them. When that substitution is implemented, extend the simulated-player-context
form with matching fields at that time.

## Testing

- Backend: a test asserting `test-turn` produces the same `BotTurnDecision` for an
  input equivalent to what the real orchestrator would produce for identical
  config/history (same decider, so this is really testing the synthetic-`BotTurnInput`
  assembly, not the decider itself). A second test asserting no rows are written to
  `conversation`, `message`, or `event` for a workspace after a `test-turn` call.
- Frontend: a component test per `BotTurnDecision.kind` verifying the tool-activity
  strip renders the right fields for each case (table above).
