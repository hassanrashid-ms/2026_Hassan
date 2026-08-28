# Resolution confirmation — bot and agent-initiated — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/specs/2026-08-13-resolution-confirmation-design.md` — rename `bot_phase` to `confirm_phase`, add an agent-triggered "is this resolved?" ask, and add one shared player-answer path that both the bot's article confirmation and the agent's ask converge on.

**Architecture:** One column (`conversation.confirm_phase`) is the whole state machine. Two writers put a conversation into a pending state — the bot's existing `offer_article` (unchanged) and a new `POST /agent/conversations/:id/ask-resolved`. One writer takes it out: `applyResolutionAnswer` in `domain/conversations/`, reached by `POST /surface/resolution-answer` (the banner's Yes/No) and, for the bot source only, by the model's existing `confirm_resolution` tool through `applyBotTurn`. `applyResolutionAnswer` delegates the `bot_article` branches straight to `applyBotTurn`'s existing `resolve` / `handoff('article_rejected')` cases, so the bot path is reused rather than reimplemented and cannot regress.

**Tech Stack:** Express 5 + Zod, Drizzle ORM (hand-written rename migration + `--custom` snapshot), Socket.io, Vitest + supertest, React + TanStack Query.

## Global Constraints

- **`bot_phase` is shipped, not hypothetical.** The spec's claim that it "was never implemented" is stale — see _Contradictions resolved_ below. This plan performs a real rename with a real migration.
- **Column name:** `conversation.confirm_phase`, pg enum type `confirm_phase`, values exactly `('none', 'bot_article', 'agent_ask')`. Drizzle export renamed `botPhase` → `confirmPhase`.
- **Fixed copy, never model output:** `RESOLUTION_CHECK_MESSAGE = 'Did this solve it?'`. Posted as `author_type: 'system'`, `visibility: 'public'`.
- **Every state change writes `conversation` and `event` in one transaction**, through one function. Socket emits happen only after the transaction commits, never inside it.
- **No new event types beyond the two in the spec:** `resolution_check_requested`, `resolution_check_declined`. The bot path keeps `bot_article_offered` / `conversation_resolved` / `bot_article_rejected` / `bot_handoff` untouched.
- **Event payload keys are snake_case**, matching every existing payload in this repo (`agent_id`, not the spec's `actorId`).
- **Player-facing routes may only call `toPlayerView`.** No new serializer.
- **Every new endpoint is registered in `backend/src/docs/openapi.ts`** — repo rule, not optional.
- **Expect 404, not 403, from RLS.** A conversation in another workspace is indistinguishable from a missing one.
- **No hard deletes, no new nullable-by-accident columns, `confirm_phase` is `not null default 'none'`.**
- **The forms slice still adds a `'form'` value later.** Don't design the enum as closed to that.

---

## Contradictions resolved (spec is stale in five places)

The spec was read against the shipped code. Confirmed with the project owner:

1. **`bot_phase` shipped in the bot tool-calling slice.** `enums.ts:30` has `pgEnum('bot_phase', ['none','article_confirm'])`, `conversations.ts:50` has the column, and `drizzle/0001_cold_wiccan.sql` applied it. So the spec's "rename with no migration cost" is wrong on both counts: there is a migration, and the existing value is `article_confirm`, not `bot_article`. **Decision: do the full rename** (type, column, value) so the codebase and the spec speak one vocabulary. It is safe because `bot_phase` is exposed on no wire — not in `@support/types`, not in any response, not in the frozen SDK contract.
2. **There is no fixed "Did this solve it?" string today.** The bot's ask is _inside the model-written reply_ that accompanies `offer_article`; `messages.ts` only holds `HANDOFF_PLAYER_MESSAGE`. So the spec's "the same string the bot's flow posts" describes something that does not exist. **Decision:** add `RESOLUTION_CHECK_MESSAGE` for the agent path; the bot path is unchanged and keeps phrasing its own ask. The _banner_ is what is genuinely shared.
3. **Reopen assignment keys off the `conversation.resolution_source` column, not the event payload.** `messagesService.ts:115` reads `prior.resolutionSource === 'agent'`. The spec says `conversation_resolved.source: 'agent'` is "exactly the signal that table's row keys off" — the outcome is right, the mechanism is not. **Decision:** the `agent_ask` Yes branch writes `resolution_source = 'agent'` on the row _and_ `source: 'agent'` in the event payload.
4. **"Both buttons call the same endpoint used for a typed confirmation" is not implementable as written.** The typed path is `POST /surface/messages`, which for `bot_article` runs the model. **Decision:** a new dedicated `POST /surface/resolution-answer` carries the tap. Convergence is at the writer, not the route: a typed "yes" on `bot_article` still reaches `applyBotTurn`'s `resolve` through the model's `confirm_resolution` tool, and a tap reaches the same case directly, producing the same row and the same event.
5. **A typed answer to an `agent_ask` is not interpreted.** Owner's decision: **buttons only** for `agent_ask`. No keyword matching, no bot turn inside an agent-owned conversation. A typed "yes" there is an ordinary player message the agent reads.

Two things the spec leaves unstated, decided here:

6. **`confirm_phase` reaches no client today** — it is in no response payload and no socket event, and a decline posts no message, so nothing would trigger a refetch. Added: the field on `GET /surface/messages` and on `AgentConversationSummary`, plus a new socket event `conversation:phase_changed` emitted to both conversation rooms on every phase transition.
7. **`ask-resolved` ownership guard.** The spec's guard is status-only while calling it "the agent must own the conversation". `assignOnHandoff` can legitimately leave an `open` conversation unassigned (no active agent), and a status-only guard would let any agent ask on a thread someone else owns. **Decision: the assigned owner, or any agent when `assigned_agent_id IS NULL`.** Flagged for the owner to revisit if team leads should be able to ask on others' threads.

---

## File map

| File                                                                           | Status        | Responsibility                                                      |
| ------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------- |
| `backend/src/shared/db/schema/enums.ts`                                        | modify        | `confirmPhase` enum, three values                                   |
| `backend/src/shared/db/schema/conversations.ts`                                | modify        | `confirm_phase` column                                              |
| `backend/drizzle/0002_confirm_phase.sql`                                       | create        | hand-written rename + add value                                     |
| `backend/src/domain/bot/{tools,toolLoop,botTurn,orchestrator,applyBotTurn}.ts` | modify        | mechanical rename, no behaviour change                              |
| `packages/types/src/chat.ts`                                                   | modify        | `ConfirmPhaseValue`, `ResolutionAnswerBody`, response/socket shapes |
| `backend/src/shared/realtime/emit.ts`                                          | modify        | `emitPhaseChanged`                                                  |
| `backend/src/domain/conversations/resolutionAnswer.ts`                         | create        | the one answer writer, both sources                                 |
| `backend/src/domain/conversations/resolutionMessages.ts`                       | create        | `RESOLUTION_CHECK_MESSAGE`                                          |
| `backend/src/domain/conversations/index.ts`                                    | modify        | re-export both                                                      |
| `backend/src/agent/services/resolutionService.ts`                              | create        | `askResolved` guard + write                                         |
| `backend/src/agent/controllers/conversationsController.ts`                     | modify        | `askResolvedHandler`                                                |
| `backend/src/agent/routers/conversationsRouter.ts`                             | modify        | route                                                               |
| `backend/src/surface/services/resolutionService.ts`                            | create        | player answer: resolve conversation, verify session, delegate, emit |
| `backend/src/surface/controllers/resolutionController.ts`                      | create        | Zod parse + status codes                                            |
| `backend/src/surface/routers/resolutionRouter.ts`                              | create        | route                                                               |
| `backend/src/surface/router.ts`                                                | modify        | mount                                                               |
| `backend/src/surface/services/messagesService.ts`                              | modify        | `confirm_phase` in `getPlayerMessages`                              |
| `backend/src/agent/services/conversationsService.ts`                           | modify        | `confirm_phase` in summaries                                        |
| `backend/src/docs/openapi.ts`                                                  | modify        | two new paths                                                       |
| `frontend/src/features/chat/api/playerChatApi.ts`                              | modify        | `answerResolution`                                                  |
| `frontend/src/surfaces/webview/pages/SupportChat.tsx`                          | modify        | banner + phase socket handler                                       |
| `frontend/src/surfaces/agent-console/api/agentApi.ts`                          | modify        | `askResolved`                                                       |
| `frontend/src/surfaces/agent-console/pages/Inbox/Inbox.tsx`                    | modify        | pass `confirmPhase`                                                 |
| `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`   | modify        | "Ask if resolved" button + phase socket handler                     |
| `backend/tests/*`                                                              | modify/create | see each task                                                       |
| `docs/decisions/spec-contradictions.md`                                        | modify        | record items 1–5                                                    |

## Parallelisation

```
Task 1 (schema)  ─┐
Task 2 (types)   ─┴─▶ Task 3 (agent ask) ─┐
                      Task 4 (answer)   ─┼─▶ Task 6 (player banner) ─┐
                      Task 5 (read/exp) ─┘   Task 7 (agent button)  ─┴─▶ Task 8 (e2e + docs)
```

- **Wave A:** Tasks 1 and 2 in parallel — Task 1 touches only DB schema + bot files, Task 2 only `packages/types` + `emit.ts`. No file overlap.
- **Wave B:** Tasks 3, 4 and 5 in parallel. Overlap check: Task 3 owns `agent/{services/resolutionService,controllers/conversationsController,routers/conversationsRouter}.ts`; Task 4 owns `domain/conversations/*` and `surface/{services,controllers,routers}/resolution*.ts` + `surface/router.ts`; Task 5 owns `surface/services/messagesService.ts` and `agent/services/conversationsService.ts`. `openapi.ts` is touched by 3 and 4 — **Task 3 appends its block before Task 4's**; if both run in one worktree, expect a trivial merge in that one file.
- **Wave C:** Tasks 6 and 7 in parallel — separate surfaces, and `surfaces/*` never cross-import by repo rule.
- **Wave D:** Task 8 alone.

Every wave leaves `pnpm typecheck` and `pnpm test` green. Postgres must be up for the API suite.

---

### Task 1: Rename `bot_phase` → `confirm_phase`

**Files:**

- Modify: `backend/src/shared/db/schema/enums.ts:30`
- Modify: `backend/src/shared/db/schema/conversations.ts:9,50`
- Create: `backend/drizzle/0002_confirm_phase.sql` (+ generated snapshot/journal entry)
- Modify: `backend/src/domain/bot/tools.ts:8,71,73,74`
- Modify: `backend/src/domain/bot/toolLoop.ts:60`
- Modify: `backend/src/domain/bot/botTurn.ts:31`
- Modify: `backend/src/domain/bot/orchestrator.ts:18,26,148`
- Modify: `backend/src/domain/bot/applyBotTurn.ts:45,64,90,141`
- Test: `backend/tests/schema.test.ts:217-229`, `backend/tests/bot.phase.test.ts`, `backend/tests/bot.toolLoop.test.ts`, `backend/tests/bot.tools.test.ts`, `backend/tests/bot.contextAssembly.test.ts:28`, `backend/tests/bot.orchestrator.test.ts:58`

**Interfaces:**

- Consumes: nothing.
- Produces: `confirmPhase` pgEnum export; `conversation.confirmPhase` Drizzle column; `ToolPhase = 'none' | 'bot_article' | 'agent_ask'`; `BotTurnInput.confirmPhase`; `BotTurnContextInput.confirmPhase` (orchestrator).

- [ ] **Step 1: Update the failing schema test first**

In `backend/tests/schema.test.ts`, replace the `bot_phase` test (lines 217-229) with:

```ts
it('conversation.confirm_phase defaults to none, accepts agent_ask, and rejects an unknown value', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const { rows } = await ownerPool.query<{ id: string; confirm_phase: string }>(
    `insert into conversation (workspace_id, player_id) values ($1, $2) returning id, confirm_phase`,
    [workspaceId, playerId],
  );
  expect(rows[0]?.confirm_phase).toBe('none');

  await ownerPool.query(`update conversation set confirm_phase = 'agent_ask' where id = $1`, [
    rows[0]?.id,
  ]);
  await ownerPool.query(`update conversation set confirm_phase = 'bot_article' where id = $1`, [
    rows[0]?.id,
  ]);

  await expect(
    ownerPool.query(`update conversation set confirm_phase = 'bogus' where id = $1`, [rows[0]?.id]),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && pnpm vitest run tests/schema.test.ts -t confirm_phase`
Expected: FAIL — `column "confirm_phase" of relation "conversation" does not exist`.

- [ ] **Step 3: Rename in the Drizzle schema**

`backend/src/shared/db/schema/enums.ts` — replace line 30:

```ts
// The forms slice adds 'form'. `bot_article` is set by the bot's offer_article,
// `agent_ask` by POST /agent/conversations/:id/ask-resolved. Both mean the same
// thing to the player: a yes/no question is on screen.
export const confirmPhase = pgEnum('confirm_phase', ['none', 'bot_article', 'agent_ask']);
```

`backend/src/shared/db/schema/conversations.ts` — line 9 import `confirmPhase` instead of `botPhase`, and replace line 48-50:

```ts
    /** Guard, not a scheduler — decides whether confirm_resolution is offered to
     *  the model at all, and whether the player sees the Yes/No banner. The
     *  forms slice widens this to add 'form'. */
    confirmPhase: confirmPhase('confirm_phase').notNull().default('none'),
```

- [ ] **Step 4: Generate an empty migration to keep the snapshot honest**

Drizzle cannot generate an enum _value_ rename, and its column-rename prompt is interactive. Take the snapshot, write the SQL by hand:

```bash
cd backend && pnpm exec drizzle-kit generate --custom --name=confirm_phase
```

This writes `drizzle/0002_confirm_phase.sql` (empty), a `drizzle/meta/0002_snapshot.json` matching the edited schema, and a journal entry. If the generated filename differs, use whatever it produced — do not rename it.

- [ ] **Step 5: Write the migration SQL**

Put this in the generated `backend/drizzle/0002_confirm_phase.sql`:

```sql
-- bot_phase shipped in 0001 with values ('none','article_confirm'). This is the
-- rename the 2026-08-13 resolution-confirmation spec assumed was free: the
-- column is on no wire, so renaming it costs nothing beyond this file.
ALTER TYPE "public"."bot_phase" RENAME TO "confirm_phase";--> statement-breakpoint
ALTER TYPE "public"."confirm_phase" RENAME VALUE 'article_confirm' TO 'bot_article';--> statement-breakpoint
ALTER TYPE "public"."confirm_phase" ADD VALUE 'agent_ask';--> statement-breakpoint
ALTER TABLE "conversation" RENAME COLUMN "bot_phase" TO "confirm_phase";
```

`ADD VALUE` inside a transaction is fine on PostgreSQL 17 as long as the new value is not _used_ in the same transaction — it is not.

- [ ] **Step 6: Apply and verify against the live database**

Run: `cd .. && pnpm db:setup`
Then:

```bash
docker compose exec -T postgres psql -U support_owner -d support -c "\d+ conversation" | grep confirm_phase
docker compose exec -T postgres psql -U support_owner -d support -c "select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='confirm_phase' order by enumsortorder"
```

Expected: the column is `confirm_phase` / `not null` / `default 'none'`, and the labels are exactly `none`, `bot_article`, `agent_ask`.

- [ ] **Step 7: Rename every code reference**

Mechanical, no behaviour change. In `backend/src/domain/bot/`:

- `tools.ts:8` → `export type ToolPhase = 'none' | 'bot_article' | 'agent_ask'`
- `tools.ts:73-75` →

```ts
/**
 * confirm_resolution is offered to the model only while confirm_phase =
 * 'bot_article' — a property of the request, not of the prompt (spec 4 §3).
 * 'agent_ask' deliberately does NOT unlock it: an agent-owned conversation
 * runs no bot turn, and its answer arrives through the banner instead.
 */
export function toolsForPhase(phase: ToolPhase): unknown[] {
  return phase === 'bot_article'
    ? [...ALWAYS_AVAILABLE_TOOLS, CONFIRM_RESOLUTION_TOOL]
    : [...ALWAYS_AVAILABLE_TOOLS];
}
```

- `botTurn.ts:31` → `confirmPhase: 'none' | 'bot_article' | 'agent_ask'` (rename the field, keep the comment)
- `toolLoop.ts:60` → `toolsForPhase(input.confirmPhase)`
- `orchestrator.ts:18` → `confirmPhase: 'none' | 'bot_article' | 'agent_ask'`; `:26` → `.select({ ..., confirmPhase: conversation.confirmPhase })`; `:148` → `confirmPhase: conv.confirmPhase`
- `applyBotTurn.ts` → `.set({ confirmPhase: 'bot_article' })` (line 45), and `confirmPhase: 'none'` in the three other `.set(...)` calls (64, 90, 141)

- [ ] **Step 8: Rename in the tests**

- `bot.phase.test.ts`: the raw SQL in `conversationRow` (`select status, confirm_phase, resolution_source ...`), `setBotPhase` → `setConfirmPhase(id, phase: 'none' | 'bot_article' | 'agent_ask')` with `update conversation set confirm_phase = $2`, every `bot_phase` assertion → `confirm_phase`, every `'article_confirm'` → `'bot_article'`, and the test names.
- `bot.toolLoop.test.ts:39,141,144,150,202,209`, `bot.tools.test.ts:11-12`, `bot.contextAssembly.test.ts:28`, `bot.orchestrator.test.ts:58`: `botPhase` → `confirmPhase`, `'article_confirm'` → `'bot_article'`.

- [ ] **Step 9: Prove nothing is left behind**

Run: `cd backend && grep -rn "bot_phase\|botPhase\|article_confirm" src tests`
Expected: no matches outside `drizzle/0001_*.sql`, `drizzle/meta/0001_snapshot.json` and `drizzle/0002_confirm_phase.sql` (history — never edit those).

- [ ] **Step 10: Full suite + typecheck**

Run: `cd .. && pnpm typecheck && pnpm test`
Expected: PASS. Any bot-path failure here is a rename miss, not a behaviour change.

- [ ] **Step 11: Commit**

```bash
git add backend/src backend/drizzle backend/tests
git commit -m "refactor(db): rename bot_phase to confirm_phase and add agent_ask"
```

---

### Task 2: Shared types and the phase socket event

**Files:**

- Modify: `packages/types/src/chat.ts`
- Modify: `backend/src/shared/realtime/emit.ts`
- Test: `backend/tests/realtime.phaseChanged.test.ts` (create)

**Interfaces:**

- Consumes: nothing (no DB, runs in parallel with Task 1).
- Produces:
  - `type ConfirmPhaseValue = 'none' | 'bot_article' | 'agent_ask'`
  - `const ResolutionAnswerBody` (Zod) → `{ helped: boolean; session_id?: string }`
  - `type ResolutionAnswerResponse = { confirm_phase: ConfirmPhaseValue; status: ConversationStatusValue }`
  - `type AskResolvedResponse = { asked: boolean }`
  - `type ConversationPhaseChangedEvent = { conversation_id: string; confirm_phase: ConfirmPhaseValue }`
  - `PlayerMessagesResponse.confirm_phase: ConfirmPhaseValue`
  - `AgentConversationSummary.confirm_phase: ConfirmPhaseValue`
  - `emitPhaseChanged(io, conversationId, payload)`

- [ ] **Step 1: Write the failing socket test**

Create `backend/tests/realtime.phaseChanged.test.ts`. Model it on `tests/realtime.rooms.test.ts` — read that file first for the exact `startRealtimeServer` / `connectClient` / token-minting boilerplate it uses, and reuse it verbatim; only the assertion below is new.

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitPhaseChanged } from '../src/shared/realtime/emit.ts';
import { getIo } from '../src/shared/realtime/socketServer.ts';
import { startRealtimeServer, connectClient } from './helpers/realtime.ts';
// + the same db helpers/token helpers realtime.rooms.test.ts uses

describe('conversation:phase_changed', () => {
  it('reaches both the player room and the agents room', async () => {
    // ...seed workspace/player/conversation and mint a player token + agent token
    // exactly as realtime.rooms.test.ts does, then join both clients to the
    // conversation and await the emit.
    const received: string[] = [];
    playerClient.on('conversation:phase_changed', (p: { confirm_phase: string }) =>
      received.push(`player:${p.confirm_phase}`),
    );
    agentClient.on('conversation:phase_changed', (p: { confirm_phase: string }) =>
      received.push(`agent:${p.confirm_phase}`),
    );

    emitPhaseChanged(getIo(), conversationId, {
      conversation_id: conversationId,
      confirm_phase: 'agent_ask',
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(received.sort()).toEqual(['agent:agent_ask', 'player:agent_ask']);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && pnpm vitest run tests/realtime.phaseChanged.test.ts`
Expected: FAIL — `emitPhaseChanged` is not exported.

- [ ] **Step 3: Add the types**

Append to `packages/types/src/chat.ts`:

```ts
/**
 * Which yes/no question, if any, is currently on the player's screen. Mirrors
 * `conversation.confirm_phase` exactly. The player-facing banner renders
 * whenever this is not 'none'; the value only tells the *server* what a tap
 * means, which is why the webview never branches on it.
 */
export type ConfirmPhaseValue = 'none' | 'bot_article' | 'agent_ask';

/**
 * The banner's Yes/No. No conversation id: the thread is resolved from the
 * player token under RLS, same as every other surface route. `session_id` is
 * best-effort attribution only — verified server-side, degraded to null on any
 * miss, and never a gate.
 */
export const ResolutionAnswerBody = z.object({
  helped: z.boolean(),
  session_id: z.uuid().optional(),
});

export type ResolutionAnswerResponse = {
  confirm_phase: ConfirmPhaseValue;
  status: ConversationStatusValue;
};

export type AskResolvedResponse = { asked: boolean };

/** Emitted to both conversation rooms on every confirm_phase transition. A
 *  decline posts no message, so this is the only signal either client gets. */
export type ConversationPhaseChangedEvent = {
  conversation_id: string;
  confirm_phase: ConfirmPhaseValue;
};
```

Then add the field to the two existing shapes in the same file:

```ts
export type PlayerMessagesResponse = {
  conversation_id: string | null;
  messages: PlayerMessageView[];
  status?: ConversationStatusValue;
  /** 'none' when there is no conversation at all. */
  confirm_phase: ConfirmPhaseValue;
};
```

```ts
export type AgentConversationSummary = {
  id: string;
  player: { external_player_id: string };
  status: ConversationStatusValue;
  confirm_phase: ConfirmPhaseValue;
  last_message_preview: string | null;
  last_message_at: string | null;
};
```

- [ ] **Step 4: Add the emit helper**

Append to `backend/src/shared/realtime/emit.ts` (and add `ConversationPhaseChangedEvent` to the existing `@support/types` type import):

```ts
/**
 * Typed, unlike emitMessageToRooms: a two-field contract, not a serializer's
 * output. Goes to both rooms because both sides have UI keyed to the phase —
 * the player's banner and the agent's "Ask if resolved" button — and a decline
 * posts no message, so there is nothing else to refetch on.
 */
export function emitPhaseChanged(
  io: Server,
  conversationId: string,
  payload: ConversationPhaseChangedEvent,
): void {
  io.to(agentRoom(conversationId)).emit('conversation:phase_changed', payload);
  io.to(playerRoom(conversationId)).emit('conversation:phase_changed', payload);
}
```

- [ ] **Step 5: Run the test**

Run: `cd backend && pnpm vitest run tests/realtime.phaseChanged.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd .. && pnpm typecheck`
Expected: FAIL, in exactly two places — `getPlayerMessages` and `listConversations` now miss the required `confirm_phase`. That is Task 5's job. To keep this task's commit green on its own, add the literal `confirm_phase: 'none'` to both return sites now (Task 5 replaces it with the real column read):

- `backend/src/surface/services/messagesService.ts` — the `if (!found) return { conversation_id: null, messages: [] }` early return and the final return.
- `backend/src/agent/services/conversationsService.ts` — the `summaries.push({...})` literal.

Re-run: `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/types backend/src backend/tests
git commit -m "feat(types): add ConfirmPhaseValue, resolution-answer contract and conversation:phase_changed"
```

---

### Task 3: `POST /agent/conversations/:id/ask-resolved`

**Files:**

- Create: `backend/src/domain/conversations/resolutionMessages.ts`
- Modify: `backend/src/domain/conversations/index.ts`
- Create: `backend/src/agent/services/resolutionService.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/agent/routers/conversationsRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.askResolved.test.ts` (create)

**Interfaces:**

- Consumes: `conversation.confirmPhase` (Task 1); `AskResolvedResponse`, `emitPhaseChanged` (Task 2); existing `postMessage`, `appendEvent`, `withWorkspace`, `AgentContext`, `toAgentView`/`toPlayerView`, `emitMessageToRooms`.
- Produces:
  - `RESOLUTION_CHECK_MESSAGE = 'Did this solve it?'`
  - `askResolved(ctx: AgentContext, conversationId: string): Promise<AskResolvedOutcome>` where
    `type AskResolvedOutcome = { ok: true; posted: PostedMessageRow } | { ok: false; reason: 'not_found' | 'wrong_status' | 'not_owner' | 'already_pending' }`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/agent.askResolved.test.ts`. Copy the standalone-app + `beforeAll(createSocketServer)` boilerplate from `tests/agent.conversations.test.ts` lines 1-50 verbatim (including `setupAgent`), then:

```ts
async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, confirm_phase, assigned_agent_id from conversation where id = $1`,
    [id],
  );
  return rows[0];
}
async function eventsFor(id: string) {
  const { rows } = await ownerPool.query(
    `select type, actor_type, payload from event where conversation_id = $1 order by id`,
    [id],
  );
  return rows;
}
async function messagesFor(id: string) {
  const { rows } = await ownerPool.query(
    `select author_type, visibility, body from message where conversation_id = $1 order by seq`,
    [id],
  );
  return rows;
}

describe('POST /agent/conversations/:id/ask-resolved', () => {
  it('posts the fixed question, sets agent_ask, and writes resolution_check_requested', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await setupAgent(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(
      `update conversation set status = 'open', assigned_agent_id = $2 where id = $1`,
      [conversationId, agentId],
    );

    const res = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ asked: true });
    const row = await conversationRow(conversationId);
    expect(row.confirm_phase).toBe('agent_ask');
    expect(row.status).toBe('open');
    expect(await messagesFor(conversationId)).toEqual([
      { author_type: 'system', visibility: 'public', body: 'Did this solve it?' },
    ]);
    const events = await eventsFor(conversationId);
    expect(events).toEqual([
      {
        type: 'resolution_check_requested',
        actor_type: 'agent',
        payload: { source: 'agent', agent_id: agentId },
      },
    ]);
  });

  it('rejects a double-ask with 409 and writes nothing the second time', async () => {
    // ...same setup, status 'open', assigned
    await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_pending');
    expect((await messagesFor(conversationId)).length).toBe(1);
    expect((await eventsFor(conversationId)).length).toBe(1);
  });

  it('rejects when status is bot_active', async () => {
    // ...setup, leave status at its 'bot_active' default, assign the agent
    const res = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('wrong_status');
    expect((await conversationRow(conversationId)).confirm_phase).toBe('none');
  });

  it('rejects when status is resolved', async () => {
    // ...setup, update status = 'resolved'
    expect(
      (
        await request(app)
          .post(`/conversations/${conversationId}/ask-resolved`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(409);
  });

  it('allows awaiting_player', async () => {
    // ...setup, update status = 'awaiting_player', assigned
    expect(
      (
        await request(app)
          .post(`/conversations/${conversationId}/ask-resolved`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(200);
  });

  it('allows any agent when the conversation is unassigned', async () => {
    // ...setup, status = 'open', assigned_agent_id stays null
    expect(
      (
        await request(app)
          .post(`/conversations/${conversationId}/ask-resolved`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(200);
  });

  it('rejects with 403 when another agent owns it', async () => {
    // ...seed a second agent row directly and set assigned_agent_id to it
    const res = await request(app)
      .post(`/conversations/${conversationId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_owner');
    expect((await conversationRow(conversationId)).confirm_phase).toBe('none');
  });

  it('404s on a conversation in another workspace', async () => {
    const otherWorkspaceId = await seedWorkspace();
    const otherPlayerId = await seedPlayer(otherWorkspaceId);
    const foreignId = await seedConversation({
      workspaceId: otherWorkspaceId,
      playerId: otherPlayerId,
    });
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [foreignId]);
    const res = await request(app)
      .post(`/conversations/${foreignId}/ask-resolved`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('422s on a non-uuid id', async () => {
    expect(
      (
        await request(app)
          .post('/conversations/not-a-uuid/ask-resolved')
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(422);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd backend && pnpm vitest run tests/agent.askResolved.test.ts`
Expected: FAIL — every case 404s, the route does not exist.

- [ ] **Step 3: Add the fixed copy**

Create `backend/src/domain/conversations/resolutionMessages.ts`:

```ts
/**
 * The one question both paths ask. A constant, not model output and not
 * agent-authored: the player's Yes/No is only meaningful as an answer to a
 * question whose wording the code controls (spec 4 §3's whole safety argument).
 * The agent path posts it; the bot phrases its own ask inside the reply that
 * accompanies offer_article, and shares only the banner.
 */
export const RESOLUTION_CHECK_MESSAGE = 'Did this solve it?';
```

Add `export * from './resolutionMessages.ts'` to `backend/src/domain/conversations/index.ts`.

- [ ] **Step 4: Write the service**

Create `backend/src/agent/services/resolutionService.ts`:

```ts
import { eq } from 'drizzle-orm';
import {
  postMessage,
  RESOLUTION_CHECK_MESSAGE,
  type PostedMessageRow,
} from '../../domain/conversations/index.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { conversation } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

const ASKABLE_STATUSES = new Set(['open', 'awaiting_player']);

export type AskResolvedOutcome =
  | { ok: true; posted: PostedMessageRow }
  | { ok: false; reason: 'not_found' | 'wrong_status' | 'not_owner' | 'already_pending' };

/**
 * The agent-side twin of the bot's offer_article: it puts the conversation into
 * a pending yes/no and nothing more. It never resolves anything — there is no
 * agent-side "mark resolved" in this product, by design. Only the player's
 * answer moves the status.
 *
 * `for('update')` is load-bearing, not defensive: without it two taps racing on
 * the same row both read 'none' and both post the question.
 */
export async function askResolved(
  ctx: AgentContext,
  conversationId: string,
): Promise<AskResolvedOutcome> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({
        status: conversation.status,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
      })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1)
      .for('update');

    // RLS makes "another workspace's" and "nonexistent" the same answer.
    if (!found) return { ok: false, reason: 'not_found' };
    if (!ASKABLE_STATUSES.has(found.status)) return { ok: false, reason: 'wrong_status' };
    // Unassigned is allowed: assignOnHandoff returns null when no agent is
    // active, and an open-but-unowned conversation must not be a dead end.
    if (found.assignedAgentId !== null && found.assignedAgentId !== ctx.agentId) {
      return { ok: false, reason: 'not_owner' };
    }
    // Rejects a double-ask and a replayed request in one check — the same job
    // the bot's phase guard does on its side.
    if (found.confirmPhase !== 'none') return { ok: false, reason: 'already_pending' };

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId,
      authorType: 'system',
      actorId: null,
      body: RESOLUTION_CHECK_MESSAGE,
      visibility: 'public',
    });

    await tx
      .update(conversation)
      .set({ confirmPhase: 'agent_ask' })
      .where(eq(conversation.id, conversationId));

    // No session_id: an agent-console request has no player session behind it.
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'resolution_check_requested',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { source: 'agent', agent_id: ctx.agentId },
    });

    return { ok: true, posted };
  });
}
```

- [ ] **Step 5: Add the controller**

Append to `backend/src/agent/controllers/conversationsController.ts` (and extend its imports with `askResolved`, `emitMessageToRooms`, `emitPhaseChanged`, `toAgentView`, `toPlayerView`):

```ts
const ASK_RESOLVED_ERRORS = {
  not_found: [404, 'Conversation not found.'],
  wrong_status: [
    409,
    'A resolution check can only be asked while the conversation is open or awaiting player.',
  ],
  not_owner: [403, 'Another agent owns this conversation.'],
  already_pending: [409, 'A resolution check is already pending on this conversation.'],
} as const;

export const askResolvedHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = ConversationIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }

  const result = await askResolved(ctx, params.data.id);
  if (!result.ok) {
    const [status, message] = ASK_RESOLVED_ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }

  // After commit, never inside it. The question is a public system message, so
  // both audiences get it; the phase event is what un-greys the player's banner
  // and greys the agent's button.
  emitMessageToRooms(
    getIo(),
    params.data.id,
    toPlayerView(result.posted),
    toAgentView(result.posted),
  );
  emitPhaseChanged(getIo(), params.data.id, {
    conversation_id: params.data.id,
    confirm_phase: 'agent_ask',
  });

  res.status(200).json({ asked: true });
};
```

Confirm `sendError`'s signature in `backend/src/errors.ts` puts the machine-readable code in `error` — the tests assert `res.body.error === 'already_pending'`. If it nests it differently, match the existing shape and fix the assertions, not the helper.

- [ ] **Step 6: Register the route**

`backend/src/agent/routers/conversationsRouter.ts`:

```ts
conversationsRouter.post('/conversations/:id/ask-resolved', askResolvedHandler);
```

- [ ] **Step 7: Register it in the OpenAPI doc**

Append after the existing `/agent/conversations/{id}/claim` block in `backend/src/docs/openapi.ts`:

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/ask-resolved',
  summary: 'Agent Ask If Resolved',
  description:
    'Asks the player "Did this solve it?" and sets confirm_phase = agent_ask. Requires status open or awaiting_player, confirm_phase none, and either ownership or an unassigned conversation. There is no agent-side resolve: only the player\'s answer moves the status.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Asked',
      content: { 'application/json': { schema: z.object({ asked: z.boolean() }) } },
    },
    403: { description: 'Another agent owns this conversation' },
    404: { description: 'Conversation not found' },
    409: { description: 'Wrong status, or a check is already pending' },
  },
});
```

- [ ] **Step 8: Run the tests**

Run: `cd backend && pnpm vitest run tests/agent.askResolved.test.ts`
Expected: PASS, all nine.

- [ ] **Step 9: Confirm the docs route renders**

Run: `cd .. && pnpm dev` then `curl -s localhost:4000/docs/json | grep -c ask-resolved`
Expected: ≥ 1. Stop the dev server.

- [ ] **Step 10: Commit**

```bash
git add backend/src backend/tests
git commit -m "feat(agent): add POST /agent/conversations/:id/ask-resolved"
```

---

### Task 4: The shared player-answer path

**Files:**

- Create: `backend/src/domain/conversations/resolutionAnswer.ts`
- Modify: `backend/src/domain/conversations/index.ts`
- Create: `backend/src/surface/services/resolutionService.ts`
- Create: `backend/src/surface/controllers/resolutionController.ts`
- Create: `backend/src/surface/routers/resolutionRouter.ts`
- Modify: `backend/src/surface/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/domain.resolutionAnswer.test.ts` (create), `backend/tests/surface.resolutionAnswer.test.ts` (create)

**Interfaces:**

- Consumes: `conversation.confirmPhase` (Task 1); `ResolutionAnswerBody`, `ResolutionAnswerResponse`, `emitPhaseChanged` (Task 2); existing `applyBotTurn`, `appendEvent`, `postMessage`, `PlayerContext`.
- Produces:
  - `applyResolutionAnswer(tx, ctx: { workspaceId, conversationId, playerId, sessionId }, helped: boolean): Promise<ResolutionAnswerOutcome>`
  - `type ResolutionAnswerOutcome = { kind: 'rejected' } | { kind: 'resolved'; source: 'bot' | 'agent' } | { kind: 'handed_off'; posted: PostedMessageRow } | { kind: 'declined' }`
  - `answerResolution(ctx: PlayerContext, body): Promise<{ ok: false } | { ok: true; conversationId: string; outcome: ResolutionAnswerOutcome; status: ConversationStatusValue }>`

- [ ] **Step 1: Write the failing domain tests**

Create `backend/tests/domain.resolutionAnswer.test.ts`. Reuse `tests/bot.phase.test.ts`'s helpers (`conversationRow`, `messagesFor`, `eventsFor`, `setConfirmPhase`) — copy them into this file rather than exporting them, matching how the suite already duplicates such helpers.

```ts
describe('applyResolutionAnswer', () => {
  it('writes nothing when confirm_phase is none', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    );

    expect(outcome).toEqual({ kind: 'rejected' });
    expect((await conversationRow(conversationId)).status).toBe('bot_active');
    expect(await eventsFor(conversationId)).toEqual([]);
    expect(await messagesFor(conversationId)).toEqual([]);
  });

  it('yes on bot_article resolves with source bot and posts nothing', async () => {
    // ...seed, setConfirmPhase(conversationId, 'bot_article')
    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    );

    expect(outcome).toEqual({ kind: 'resolved', source: 'bot' });
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('resolved');
    expect(row.confirm_phase).toBe('none');
    expect(row.resolution_source).toBe('bot');
    expect(await eventsFor(conversationId)).toEqual([
      { type: 'conversation_resolved', payload: { source: 'bot', confirmed_by: 'player' } },
    ]);
    expect(await messagesFor(conversationId)).toEqual([]);
  });

  it('yes on agent_ask resolves with source agent and posts nothing', async () => {
    // ...seed, setConfirmPhase(conversationId, 'agent_ask'), status 'open'
    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, true),
    );

    expect(outcome).toEqual({ kind: 'resolved', source: 'agent' });
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('resolved');
    expect(row.confirm_phase).toBe('none');
    // The column, not the event, is what reopen actually reads.
    expect(row.resolution_source).toBe('agent');
    expect(await eventsFor(conversationId)).toEqual([
      { type: 'conversation_resolved', payload: { source: 'agent', confirmed_by: 'player' } },
    ]);
    expect(await messagesFor(conversationId)).toEqual([]);
  });

  it('no on bot_article still runs spec 4 handoff(article_rejected) unchanged', async () => {
    // ...seed workspace + an ACTIVE agent (so assignOnHandoff has someone), player, conversation
    // setConfirmPhase(conversationId, 'bot_article')
    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, false),
    );

    expect(outcome.kind).toBe('handed_off');
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('open');
    expect(row.confirm_phase).toBe('none');
    expect(row.assigned_agent_id).toBe(agentId);
    expect(await messagesFor(conversationId)).toEqual([
      {
        author_type: 'system',
        visibility: 'public',
        body: "You're being connected to our support team.",
      },
    ]);
    expect((await eventsFor(conversationId)).map((e) => e.type)).toEqual([
      'bot_article_rejected',
      'bot_handoff',
    ]);
  });

  it('no on agent_ask clears the phase, touches no status, posts no message', async () => {
    // ...seed, status 'awaiting_player', assigned_agent_id = agentId, setConfirmPhase 'agent_ask'
    const outcome = await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(tx, { workspaceId, conversationId, playerId, sessionId: null }, false),
    );

    expect(outcome).toEqual({ kind: 'declined' });
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('awaiting_player');
    expect(row.confirm_phase).toBe('none');
    expect(row.assigned_agent_id).toBe(agentId);
    expect(row.resolution_source).toBe(null);
    expect(await messagesFor(conversationId)).toEqual([]);
    expect(await eventsFor(conversationId)).toEqual([
      { type: 'resolution_check_declined', payload: { source: 'agent' } },
    ]);
  });

  it('a second answer after the first is rejected and writes nothing', async () => {
    // ...seed, setConfirmPhase 'agent_ask'
    await withWorkspace(workspaceId, (tx) => applyResolutionAnswer(tx, base, false));
    const second = await withWorkspace(workspaceId, (tx) => applyResolutionAnswer(tx, base, false));
    expect(second).toEqual({ kind: 'rejected' });
    expect((await eventsFor(conversationId)).length).toBe(1);
  });
});
```

Note the payload assertions compare `{ type, payload }` shapes — have `eventsFor` select exactly `type, payload` for this file so the objects match.

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd backend && pnpm vitest run tests/domain.resolutionAnswer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the writer**

Create `backend/src/domain/conversations/resolutionAnswer.ts`:

```ts
import { eq } from 'drizzle-orm';
import { applyBotTurn } from '../bot/applyBotTurn.ts';
import type { PostedMessageRow } from './postMessage.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { conversation } from '../../shared/db/schema/index.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';

export type ResolutionAnswerContext = {
  workspaceId: string;
  conversationId: string;
  playerId: string;
  /** Verified by the caller, or null. Attribution only — never a gate. */
  sessionId: string | null;
};

export type ResolutionAnswerOutcome =
  | { kind: 'rejected' }
  | { kind: 'resolved'; source: 'bot' | 'agent' }
  | { kind: 'handed_off'; posted: PostedMessageRow }
  | { kind: 'declined' };

/**
 * The only place a player's Yes/No is applied, for both sources. One
 * transaction, owned by the caller.
 *
 * The `bot_article` branches delegate to applyBotTurn's existing `resolve` and
 * `handoff('article_rejected')` cases rather than reimplementing them. That is
 * the point: a tap and the model's confirm_resolution tool then reach literally
 * the same code, so they cannot drift, and the bot path cannot regress because
 * this slice did not touch it.
 *
 * `for('update')` makes a double-tap safe — the second answer reads 'none' and
 * is rejected, instead of resolving an already-resolved conversation.
 */
export async function applyResolutionAnswer(
  tx: Tx,
  ctx: ResolutionAnswerContext,
  helped: boolean,
): Promise<ResolutionAnswerOutcome> {
  const [found] = await tx
    .select({ confirmPhase: conversation.confirmPhase })
    .from(conversation)
    .where(eq(conversation.id, ctx.conversationId))
    .limit(1)
    .for('update');

  // An answer with no question outstanding writes nothing. Covers a stale
  // banner, a replayed request and a double tap in one guard.
  if (!found || found.confirmPhase === 'none') return { kind: 'rejected' };

  const botCtx = { workspaceId: ctx.workspaceId, conversationId: ctx.conversationId };

  if (found.confirmPhase === 'bot_article') {
    if (helped) {
      await applyBotTurn(tx, botCtx, { kind: 'resolve', subintentId: null });
      return { kind: 'resolved', source: 'bot' };
    }
    const result = await applyBotTurn(tx, botCtx, {
      kind: 'handoff',
      reason: 'article_rejected',
      subintentId: null,
    });
    const posted = result.posted[0];
    if (!posted) throw new Error('handoff produced no player message');
    return { kind: 'handed_off', posted };
  }

  // agent_ask.
  if (helped) {
    await tx
      .update(conversation)
      // resolution_source is what reopen reads to keep the previous owner
      // (spec 4 §10) — the event payload is the audit trail, not the signal.
      .set({ status: 'resolved', confirmPhase: 'none', resolutionSource: 'agent' })
      .where(eq(conversation.id, ctx.conversationId));
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_resolved',
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      actorId: ctx.playerId,
      actorType: 'player',
      payload: { source: 'agent', confirmed_by: 'player' },
    });
    return { kind: 'resolved', source: 'agent' };
  }

  // A decline touches no status: a human already owns this conversation, so
  // there is nothing to hand off. The agent sees it through the phase event.
  await tx
    .update(conversation)
    .set({ confirmPhase: 'none' })
    .where(eq(conversation.id, ctx.conversationId));
  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'resolution_check_declined',
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    actorId: ctx.playerId,
    actorType: 'player',
    payload: { source: 'agent' },
  });
  return { kind: 'declined' };
}
```

Add `export * from './resolutionAnswer.ts'` to `backend/src/domain/conversations/index.ts`.

- [ ] **Step 4: Run the domain tests**

Run: `cd backend && pnpm vitest run tests/domain.resolutionAnswer.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Commit the writer**

```bash
git add backend/src/domain backend/tests/domain.resolutionAnswer.test.ts
git commit -m "feat(domain): add applyResolutionAnswer for both confirm sources"
```

- [ ] **Step 6: Write the failing route tests**

Create `backend/tests/surface.resolutionAnswer.test.ts`. Copy the standalone-app + player-token boilerplate from `tests/surface.messages.test.ts` (read it first; it already mints a player token and starts a socket server for `getIo()`), mounting `resolutionRouter` behind the real `requirePlayerToken`.

```ts
describe('POST /surface/resolution-answer', () => {
  it('resolves an agent_ask on yes', async () => {
    // ...seed workspace/player/conversation, status 'open', confirm_phase 'agent_ask'
    const res = await request(app)
      .post('/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ confirm_phase: 'none', status: 'resolved' });
  });

  it('409s when no check is outstanding', async () => {
    // ...seed, leave confirm_phase 'none'
    const res = await request(app)
      .post('/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('no_check_pending');
  });

  it('404s when the player has no conversation at all', async () => {
    // ...seed a player with no conversation
    expect(
      (
        await request(app)
          .post('/resolution-answer')
          .set('Authorization', `Bearer ${token}`)
          .send({ helped: true })
      ).status,
    ).toBe(404);
  });

  it('422s when helped is missing', async () => {
    expect(
      (
        await request(app)
          .post('/resolution-answer')
          .set('Authorization', `Bearer ${token}`)
          .send({})
      ).status,
    ).toBe(422);
  });

  it('accepts an unverifiable session_id and stamps the event with null', async () => {
    // ...seed, confirm_phase 'agent_ask'
    const res = await request(app)
      .post('/resolution-answer')
      .set('Authorization', `Bearer ${token}`)
      .send({ helped: false, session_id: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(200);
    const { rows } = await ownerPool.query(
      `select session_id from event where conversation_id = $1`,
      [conversationId],
    );
    expect(rows[0]?.session_id).toBe(null);
  });
});
```

- [ ] **Step 7: Run them to confirm they fail**

Run: `cd backend && pnpm vitest run tests/surface.resolutionAnswer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Write the surface service**

Create `backend/src/surface/services/resolutionService.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { ConversationStatusValue, ResolutionAnswerBody } from '@support/types';
import {
  applyResolutionAnswer,
  toAgentView,
  toPlayerView,
  type ResolutionAnswerOutcome,
} from '../../domain/conversations/index.ts';
import { conversation, session } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import {
  emitInboxChanged,
  emitMessageToRooms,
  emitPhaseChanged,
} from '../../shared/realtime/emit.ts';
import { getIo } from '../../shared/realtime/socketServer.ts';
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts';

type Body = z.infer<typeof ResolutionAnswerBody>;

export type AnswerResolutionResult =
  | { ok: false; reason: 'not_found' | 'no_check_pending' }
  | { ok: true; status: ConversationStatusValue };

/**
 * The banner's Yes/No. No conversation id in the request: the thread is the
 * player's latest, resolved under RLS from the token — the same rule
 * getPlayerMessages follows, so the two can never disagree about which
 * conversation the banner belonged to.
 */
export async function answerResolution(
  ctx: PlayerContext,
  body: Body,
): Promise<AnswerResolutionResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // FK checks bypass RLS, so an unverified session id could point across the
    // tenant boundary and event.session_id is ON DELETE RESTRICT — a bad id
    // would roll the whole answer back. Any miss degrades to null instead.
    const [verifiedSession] = body.session_id
      ? await tx
          .select({ id: session.id })
          .from(session)
          .where(and(eq(session.id, body.session_id), eq(session.playerId, ctx.playerId)))
          .limit(1)
      : [];

    const [found] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1);
    if (!found) return { ok: false as const, reason: 'not_found' as const };

    const outcome = await applyResolutionAnswer(
      tx,
      {
        workspaceId: ctx.workspaceId,
        conversationId: found.id,
        playerId: ctx.playerId,
        sessionId: verifiedSession?.id ?? null,
      },
      body.helped,
    );
    if (outcome.kind === 'rejected')
      return { ok: false as const, reason: 'no_check_pending' as const };

    const [after] = await tx
      .select({ status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, found.id))
      .limit(1);

    return { ok: true as const, conversationId: found.id, outcome, status: after!.status };
  });

  if (!result.ok) return result;

  // Emits only after commit. Phase always changed if we got here.
  emitPhaseChanged(getIo(), result.conversationId, {
    conversation_id: result.conversationId,
    confirm_phase: 'none',
  });
  if (result.outcome.kind === 'handed_off') {
    emitMessageToRooms(
      getIo(),
      result.conversationId,
      toPlayerView(result.outcome.posted),
      toAgentView(result.outcome.posted),
    );
  }
  // A decline changes no status, so the inbox has nothing to refetch for.
  if (result.outcome.kind !== 'declined') {
    emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.status);
  }

  return { ok: true, status: result.status };
}
```

- [ ] **Step 9: Controller and router**

Create `backend/src/surface/controllers/resolutionController.ts`:

```ts
import type { RequestHandler } from 'express';
import { ResolutionAnswerBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { answerResolution } from '../services/resolutionService.ts';

const ERRORS = {
  not_found: [404, 'No conversation found for this player.'],
  no_check_pending: [409, 'There is no resolution check to answer.'],
} as const;

export const resolutionAnswerHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  const body = ResolutionAnswerBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'helped must be a boolean and session_id, if present, a uuid.',
    );
    return;
  }

  const result = await answerResolution(ctx, body.data);
  if (!result.ok) {
    const [status, message] = ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }

  res.status(200).json({ confirm_phase: 'none', status: result.status });
};
```

Create `backend/src/surface/routers/resolutionRouter.ts`:

```ts
import { Router } from 'express';
import { resolutionAnswerHandler } from '../controllers/resolutionController.ts';

export const resolutionRouter = Router();
resolutionRouter.post('/resolution-answer', resolutionAnswerHandler);
```

Mount it in `backend/src/surface/router.ts` alongside the others (`surfaceRouter.use(resolutionRouter)`).

- [ ] **Step 10: Register it in the OpenAPI doc**

Append to the surface section of `backend/src/docs/openapi.ts`:

```ts
registry.registerPath({
  method: 'post',
  path: '/surface/resolution-answer',
  summary: 'Player Answer Resolution Check',
  description:
    "The banner's Yes/No, for both sources. Yes resolves the conversation (source bot or agent, per confirm_phase); No hands off to a human on bot_article, and only clears the phase on agent_ask. 409 when no check is pending.",
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: ResolutionAnswerBody } } } },
  responses: {
    200: {
      description: 'Answer applied',
      content: {
        'application/json': { schema: z.object({ confirm_phase: z.string(), status: z.string() }) },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No resolution check pending' },
  },
});
```

Use whatever the file already names the player security scheme (`bearerPlayerJwt` above is a guess — grep the file for the surface-route security value and match it exactly), and import `ResolutionAnswerBody` from `@support/types`.

- [ ] **Step 11: Run the route tests**

Run: `cd backend && pnpm vitest run tests/surface.resolutionAnswer.test.ts`
Expected: PASS, all five.

- [ ] **Step 12: Commit**

```bash
git add backend/src backend/tests
git commit -m "feat(surface): add POST /surface/resolution-answer"
```

---

### Task 5: Expose `confirm_phase` on the read paths

**Files:**

- Modify: `backend/src/surface/services/messagesService.ts` (`getPlayerMessages`)
- Modify: `backend/src/agent/services/conversationsService.ts` (`listConversations`)
- Test: `backend/tests/surface.messages.test.ts`, `backend/tests/agent.conversations.test.ts`

**Interfaces:**

- Consumes: `conversation.confirmPhase` (Task 1); `ConfirmPhaseValue` and the two widened response types (Task 2).
- Produces: `GET /surface/messages` → `confirm_phase`; `GET /agent/conversations` → `confirm_phase` per summary.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/surface.messages.test.ts`:

```ts
it('GET /messages reports confirm_phase', async () => {
  // ...existing seed helpers in this file: workspace, player, conversation, token
  await ownerPool.query(`update conversation set confirm_phase = 'agent_ask' where id = $1`, [
    conversationId,
  ]);
  const res = await request(app)
    .get(`/messages?session_id=${sessionId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.confirm_phase).toBe('agent_ask');
});

it('GET /messages reports none when the player has no conversation', async () => {
  // ...player with no conversation
  const res = await request(app)
    .get(`/messages?session_id=${sessionId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.body.conversation_id).toBe(null);
  expect(res.body.confirm_phase).toBe('none');
});
```

Add to `backend/tests/agent.conversations.test.ts`:

```ts
it('lists confirm_phase per conversation', async () => {
  // ...existing seed: workspace, agent + token, player, conversation assigned to the agent
  await ownerPool.query(`update conversation set confirm_phase = 'agent_ask' where id = $1`, [
    conversationId,
  ]);
  const res = await request(app)
    .get('/conversations?status=mine')
    .set('Authorization', `Bearer ${token}`);
  expect(res.body.conversations[0].confirm_phase).toBe('agent_ask');
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd backend && pnpm vitest run tests/surface.messages.test.ts tests/agent.conversations.test.ts`
Expected: FAIL — `confirm_phase` is `'none'` (the placeholder Task 2 wrote), not `'agent_ask'`.

- [ ] **Step 3: Read the real column in `getPlayerMessages`**

In `backend/src/surface/services/messagesService.ts`, widen the select and both returns:

```ts
const [found] = await tx
  .select({
    id: conversation.id,
    status: conversation.status,
    confirmPhase: conversation.confirmPhase,
  })
  .from(conversation)
  .where(eq(conversation.playerId, ctx.playerId))
  .orderBy(desc(conversation.createdAt))
  .limit(1);
// No conversation means no question on screen — 'none', not undefined, so
// the banner has one thing to test and never a missing field.
if (!found) return { conversation_id: null, messages: [], confirm_phase: 'none' };

const rows = await tx
  .select()
  .from(message)
  .where(eq(message.conversationId, found.id))
  .orderBy(message.seq);
const messages = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null);
return {
  conversation_id: found.id,
  messages,
  status: found.status,
  confirm_phase: found.confirmPhase,
};
```

Update the function's return type annotation to `Promise<PlayerMessagesResponse>` if it still spells the shape inline.

- [ ] **Step 4: Read it in `listConversations`**

In `backend/src/agent/services/conversationsService.ts`, add `confirmPhase: conversation.confirmPhase` to the select and `confirm_phase: row.confirmPhase,` to the `summaries.push({...})` literal.

- [ ] **Step 5: Run the tests**

Run: `cd backend && pnpm vitest run tests/surface.messages.test.ts tests/agent.conversations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src backend/tests
git commit -m "feat(api): expose confirm_phase on the player thread and agent inbox"
```

---

### Task 6: Player webview banner

**Files:**

- Modify: `frontend/src/features/chat/api/playerChatApi.ts`
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx`

**Interfaces:**

- Consumes: `POST /surface/resolution-answer` (Task 4); `confirm_phase` on `GET /surface/messages` (Task 5); `conversation:phase_changed` (Task 2).
- Produces: `answerResolution(token, helped, sessionId?): Promise<ResolutionAnswerResponse>`.

- [ ] **Step 1: Add the API call**

Append to `frontend/src/features/chat/api/playerChatApi.ts` (import `ResolutionAnswerResponse` from `@support/types`):

```ts
/**
 * The banner's Yes/No. Carries no source and no conversation id: the backend
 * decides what the tap means from confirm_phase, which is why the webview never
 * branches on it.
 */
export function answerResolution(
  token: string,
  helped: boolean,
  sessionId?: string,
): Promise<ResolutionAnswerResponse> {
  return apiCall(`/surface/resolution-answer`, token, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { helped, session_id: sessionId } : { helped }),
  });
}
```

- [ ] **Step 2: Wire the mutation and the socket handler in `SupportChat.tsx`**

Import `answerResolution`, then add below the `send` mutation:

```ts
const answer = useMutation({
  mutationFn: (helped: boolean) => answerResolution(boot!.token, helped, boot!.sessionId),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] });
  },
});
```

In the existing socket `useEffect`, next to the `message:new` handler:

```ts
// The only signal for a decline: it posts no message and changes no status,
// so nothing else would tell this screen to drop the banner.
socket.on('conversation:phase_changed', () => {
  void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] });
});
```

- [ ] **Step 3: Render the banner**

Add above the existing `{settled && (...)}` block:

```tsx
const confirmPending = (messagesQuery.data?.confirm_phase ?? 'none') !== 'none';
```

```tsx
{
  confirmPending && (
    <div className="shrink-0 border-t border-muted/15 bg-surface px-4 py-3">
      <p className="text-base font-semibold text-text">Did this solve it?</p>
      <div className="mt-2 flex items-center gap-3">
        <SupportButton
          variant="soft"
          className="min-h-9 px-4 py-2 text-sm"
          disabled={answer.isPending}
          onClick={() => answer.mutate(true)}
        >
          Yes
        </SupportButton>
        <SupportButton
          variant="soft"
          className="min-h-9 px-4 py-2 text-sm"
          disabled={answer.isPending}
          onClick={() => answer.mutate(false)}
        >
          No
        </SupportButton>
      </div>
    </div>
  );
}
```

The banner is identical for both sources by design — the tap carries no source, and the server reads `confirm_phase` to decide what it meant.

- [ ] **Step 4: Typecheck and build**

Run: `cd .. && pnpm typecheck && pnpm --filter @support/web build`
Expected: PASS.

- [ ] **Step 5: Verify by hand against a running stack**

Run `pnpm dev`, open the webview with a dev token, then from `psql`:

```sql
update conversation set confirm_phase = 'agent_ask', status = 'open' where id = '<id>';
```

The banner does not appear until something invalidates the query — that is expected, this SQL bypasses the emit. Then tap **No** and confirm: the banner disappears, `confirm_phase` is `none`, `status` is still `open`, no new message row, one `resolution_check_declined` event. Tap through a **Yes** on a fresh `agent_ask` and confirm `status = 'resolved'`, `resolution_source = 'agent'`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat(webview): render the resolution-check banner"
```

---

### Task 7: Agent console "Ask if resolved" button

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/Inbox.tsx:49-55`
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`

**Interfaces:**

- Consumes: `POST /agent/conversations/:id/ask-resolved` (Task 3); `confirm_phase` on the inbox summary (Task 5); `conversation:phase_changed` (Task 2).
- Produces: `askResolved(token, conversationId): Promise<AskResolvedResponse>`; `ThreadPanel` prop `confirmPhase?: ConfirmPhaseValue`.

- [ ] **Step 1: Add the API call**

Append to `frontend/src/surfaces/agent-console/api/agentApi.ts` (import `AskResolvedResponse` from `@support/types`):

```ts
export function askResolved(token: string, conversationId: string): Promise<AskResolvedResponse> {
  return apiCall(`/agent/conversations/${conversationId}/ask-resolved`, token, { method: 'POST' });
}
```

- [ ] **Step 2: Pass the phase down**

`Inbox.tsx`, inside the existing `<ThreadPanel ... />`:

```tsx
          confirmPhase={selected?.confirm_phase}
```

`selected` already comes from the cached inbox summaries, so no new query.

- [ ] **Step 3: Add the button**

In `ThreadPanel.tsx`: import `askResolved` and `type ConfirmPhaseValue`, add `confirmPhase` to the props type, then:

```ts
const ask = useMutation({
  mutationFn: () => askResolved(token, conversationId!),
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] });
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
    void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
  },
});

const askable =
  (status === 'open' || status === 'awaiting_player') && (confirmPhase ?? 'none') === 'none';
const waiting = confirmPhase === 'agent_ask';
```

In the header row, after the status badge:

```tsx
{
  (askable || waiting) && (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="ml-auto"
      disabled={!askable || ask.isPending}
      // A real tooltip primitive isn't in this surface yet; the native
      // title is enough for a disabled-state explanation.
      title={waiting ? 'Waiting on player' : undefined}
      onClick={() => ask.mutate()}
    >
      Ask if resolved
    </Button>
  );
}
```

There is deliberately no UI for the answer: the status badge flipping to `resolved`, or staying `open` on a decline, _is_ the confirmation.

- [ ] **Step 4: Refetch on the phase event**

In `ThreadPanel.tsx`'s socket `useEffect`, beside `message:new`:

```ts
// Carries the decline, which posts no message and changes no status.
socket.on('conversation:phase_changed', () => {
  void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
  void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
});
```

The button's enabled state is derived from the inbox summary, so invalidating those two keys is what re-enables it.

- [ ] **Step 5: Typecheck and build**

Run: `cd .. && pnpm typecheck && pnpm --filter @support/web build`
Expected: PASS.

- [ ] **Step 6: Verify by hand, both consoles side by side**

With `pnpm dev`: open a conversation the agent owns at status `open`, click **Ask if resolved**. Confirm the "Did this solve it?" system message appears in both the console thread and the webview, the button greys with the "Waiting on player" title, and the player's banner appears without a manual refresh. Tap **No** in the webview: the agent's button re-enables and the status badge stays `open`. Ask again, tap **Yes**: the badge flips to `resolved`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(agent-console): add Ask if resolved to the thread header"
```

---

### Task 8: Cross-path verification and docs

**Files:**

- Test: `backend/tests/resolution.crossPath.test.ts` (create)
- Modify: `docs/specs/2026-08-13-resolution-confirmation-design.md` (status + stale-claim notes)
- Modify: `docs/decisions/spec-contradictions.md`

**Interfaces:**

- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write the convergence and regression tests**

Create `backend/tests/resolution.crossPath.test.ts`. These are the spec's Verification list, the parts no single earlier task owns. Mount both `surfaceRouter`-style and player-token boilerplate as `tests/surface.resolutionAnswer.test.ts` does.

```ts
describe('resolution confirmation — cross-path', () => {
  it('the same handler produces different sources from the same Yes', async () => {
    // Two conversations for two players in one workspace: one at 'bot_article',
    // one at 'agent_ask'. Answer both with helped: true through the endpoint.
    // Assert both are 'resolved', and that the conversation_resolved payloads
    // are { source: 'bot' } and { source: 'agent' } respectively — one code
    // path, two outcomes, decided only by confirm_phase.
  });

  it('a tap and the model tool converge on identical rows and events for bot_article', async () => {
    // Conversation A: confirm_phase 'bot_article', answered via
    // POST /surface/resolution-answer { helped: true }.
    // Conversation B: confirm_phase 'bot_article', resolved via
    //   applyBotTurn(tx, ctx, { kind: 'resolve', subintentId: null })
    // — the exact call toolLoop's confirm_resolution(true) produces.
    // Assert the two conversations' (status, confirm_phase, resolution_source)
    // are equal, and their event (type, actor_type, payload) lists are equal.
    // This is the buttons-are-accelerators property, asserted rather than
    // assumed — it holds because applyResolutionAnswer delegates to applyBotTurn.
  });

  it('No on bot_article still produces spec 4 handoff(article_rejected) — regression', async () => {
    // Same convergence assertion for helped: false: the endpoint's rows and
    // events must equal applyBotTurn(kind 'handoff', reason 'article_rejected'),
    // including the HANDOFF_PLAYER_MESSAGE row and the assignOnHandoff result.
  });

  it('a reopen after an agent-triggered resolution keeps the previous owner', async () => {
    // Seed an ACTIVE agent, a conversation assigned to them at status
    // 'awaiting_player' with confirm_phase 'agent_ask'.
    // Answer helped: true  -> resolved, resolution_source 'agent'.
    // Then POST /surface/messages with a new player message (the reopen path).
    // Assert status is 'open', assigned_agent_id is STILL that agent, and
    // resolution_source is back to null. Spec 4 §10's middle row, exercised for
    // the first time — nothing could write source 'agent' until this slice.
  });

  it('a reopen keeps nobody when the previous owner was deactivated', async () => {
    // Same as above, then `update agent set status = 'deactivated'` before the
    // reopen. Assert assignOnHandoff's result instead of the old owner.
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd backend && pnpm vitest run tests/resolution.crossPath.test.ts`
Expected: PASS. A failure here is a real defect in Tasks 3–5, not a missing feature — fix the code, not the assertion.

- [ ] **Step 3: Whole-repo verification**

Run: `cd .. && pnpm typecheck && pnpm test`
Expected: PASS, everything. Paste the summary line into the commit body.

- [ ] **Step 4: Update the spec's status and its stale claims**

In `docs/specs/2026-08-13-resolution-confirmation-design.md`: set `**Status:** Implemented (2026-08-13)`, and add a short note under the header:

```markdown
**Implementation note:** `bot_phase` had in fact shipped (migration 0001), so the rename cost a
migration (0002) and a value rename `article_confirm` → `bot_article`. The player's answer arrives
through `POST /surface/resolution-answer`, not through the message endpoint; a typed answer to an
`agent_ask` is not interpreted (buttons only). `confirm_phase` is exposed on `GET /surface/messages`
and the agent inbox summary, with a `conversation:phase_changed` socket event. See
`docs/plans/2026-08-13-resolution-confirmation-implementation.md` § Contradictions resolved.
```

- [ ] **Step 5: Record the contradictions**

Append the five numbered items from this plan's _Contradictions resolved_ section to `docs/decisions/spec-contradictions.md`, following that file's existing entry format (read it first and match it).

- [ ] **Step 6: Commit**

```bash
git add backend/tests docs
git commit -m "test: assert resolution-confirmation convergence, reopen and bot-path regression"
```

---

## Self-review

**Spec coverage:**

| Spec requirement                                                                                                     | Task                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `confirm_phase` column, three values                                                                                 | 1                               |
| `POST /agent/conversations/:id/ask-resolved`, guards, fixed copy, event, dual-room emit                              | 3                               |
| Shared player answer, both sources, all four Yes/No branches                                                         | 4                               |
| Guard: an answer with `confirm_phase = 'none'` writes nothing                                                        | 4 (domain test 1, route test 2) |
| Player banner whenever `confirm_phase != 'none'`, no source branching                                                | 6                               |
| Agent "Ask if resolved" button, enable/disable/tooltip                                                               | 7                               |
| `resolution_check_requested` / `resolution_check_declined`                                                           | 3 / 4                           |
| Reopen + assignment unchanged, agent-resolved case exercised                                                         | 8                               |
| Out of scope, deliberately absent: inactivity clock, bot standalone ask, agent direct resolve, agent-customised copy | —                               |
| Every Verification bullet                                                                                            | 3, 4, 8                         |

**Known deviations from the spec text**, all covered in _Contradictions resolved_: value name `bot_article` requires a real migration; the fixed question is new copy rather than the bot's existing string; the answer has its own route; a typed `agent_ask` answer is not interpreted; event payload keys are snake_case; `resolution_source` is written alongside the event; the ownership guard is stricter than status-only; `confirm_phase` and `conversation:phase_changed` are additions the spec did not name.

**Open question for the owner (non-blocking):** should a team lead be able to ask on a thread another agent owns? Task 3 currently returns 403. Widening it is a one-line change to `askResolved`'s guard plus one test.
