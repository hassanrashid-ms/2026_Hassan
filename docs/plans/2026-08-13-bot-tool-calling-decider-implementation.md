# Bot tool-calling decider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `stubDecider` with a real `BotDecider` — a bounded tool-calling loop over the OpenAI Chat Completions API — implementing spec `docs/specs/2026-08-12-bot-tool-calling-decider-design.md` in full.

**Architecture:** A pure `toolLoop(input): Promise<BotTurnDecision>` calls the model with a phase-gated tool set, executes side-effect-free tools (search) and pure-mapping tools (classify/offer/confirm/handoff) inline, and returns one of five decision shapes without writing anything. `applyBotTurn` remains the only writer. Context for each turn is assembled deterministically from `conversation` columns and `event`/`message` rows — never summarized by a model.

**Tech Stack:** `openai` SDK (Chat Completions, tool calling, `strict` JSON schemas), existing `weaviate-client` v3 hybrid/BM25 search, Drizzle ORM, Vitest.

## Global Constraints

- **No test makes a live model call, including in CI.** `openaiClient.callModel` is stubbed in every test.
- **The loop never writes.** All writes happen in `applyBotTurn`, one transaction, exactly as spec 1 requires. Socket emits happen after commit, in `runBotTurn`.
- **A guarantee the product makes is never left to the model's judgment when the code can hold it** (spec §1). No `resolve` tool, no `show_form` tool, ever.
- **`classify` is write-once**, enforced at the DB layer (existing `classifyIfUnset`, unchanged).
- **`confirm_resolution` is offered to the model only when `bot_phase = 'article_confirm'`** — a property of the request tool set, not of the prompt.
- **Budgets are enforced in code, never in `rules`.** `MAX_TOOL_CALLS_PER_TURN = 4` (all tool calls in a turn, including multiple calls returned in one model response — see Task 8's parallel-call decision). `MAX_BOT_MESSAGES = 8` (bot-authored messages in the conversation; on exhaust, no model call at all).
- **`OPENAI_MODEL` has no default** — an unset value fails at boot through the Zod env schema. `.env.example` carries `gpt-5.4-mini` (confirmed supported; change later if needed).
- **Article titles are snapshotted as literals in events** — never re-resolved through the article FK at read time.
- **`bot_active` is one-way.** Once left, never returned to.
- **All under `backend/src/domain/bot/`, exported through `index.ts`.**

## Design decisions this plan resolves beyond the spec text

The spec was read in full alongside the current codebase (specs 1–2 already shipped; spec 3 deleted). Three points the spec leaves ambiguous or unresolved against what's actually in the repo, resolved as follows — confirmed with the project owner:

1. **Reopen's "previous resolution source" (spec §10).** No code path in this repo sets an agent-resolved or `closed` status yet — `applyBotTurn`'s new `resolve` case is the _only_ writer of `resolved` in this slice. Rather than deriving this from an event lookup, `conversation` gains a `resolution_source` column (`bot | agent`, nullable), written whenever a conversation becomes `resolved`/`closed`. This slice writes it only from the `resolve` outcome (`'bot'`); a future agent-resolve action writes `'agent'`. Reopen reads it back and clears it.
2. **Parallel tool calls.** The OpenAI API can return more than one `tool_call` per response. Rather than disabling parallel calling, `toolLoop` processes `tool_calls` in array order and counts **each individual call** against `MAX_TOOL_CALLS_PER_TURN` (not one per response). A terminal tool (`offer_article`, `confirm_resolution`, `handoff`) executing mid-array stops processing the rest of that array. If budget would be exceeded mid-array, remaining calls in the array are not executed and the loop forces `handoff('unsure')`.
3. **"Other" naming.** Spec 3 (which originated this) is deleted from `docs/specs/`. Seeded as: one `intent` row named `Other` with `is_system = true`, containing exactly one `subintent` row also named `Other` — the catch-all `classify` resolves to.

---

## File map

| File                                              | Status        | Responsibility                                                                                                   |
| ------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `backend/src/shared/db/schema/enums.ts`           | modify        | `botPhase`, `resolutionSource` enums                                                                             |
| `backend/src/shared/db/schema/conversations.ts`   | modify        | `bot_phase`, `resolution_source` columns                                                                         |
| `backend/src/env.ts`                              | modify        | `OPENAI_MODEL` required env var                                                                                  |
| `backend/package.json`                            | modify        | `openai` dependency                                                                                              |
| `.env.example`                                    | modify        | `OPENAI_MODEL=gpt-5.4-mini`                                                                                      |
| `backend/src/shared/db/seedTaxonomy.ts`           | modify        | add `Other` as a seeded system intent                                                                            |
| `backend/src/shared/db/seed.ts`                   | modify        | seed the `Other` intent idempotently                                                                             |
| `backend/src/domain/bot/fallbackSubintent.ts`     | **create**    | `resolveFallbackSubintent(tx, workspaceId)`                                                                      |
| `backend/src/domain/bot/botTurn.ts`               | modify        | `HandoffReason`, `UnavailableReason`, `BotTurnDecision`, `BotTurnInput` deltas; `stubDecider` removed at the end |
| `backend/src/domain/bot/contextAssembly.ts`       | **create**    | `buildMessages(input)` — state block, pinning, windowing, subintent index, article catalogue                     |
| `backend/src/domain/bot/openaiClient.ts`          | **create**    | `callModel(messages, tools)`                                                                                     |
| `backend/src/domain/bot/tools.ts`                 | **create**    | `TOOL_DEFS`, `toolsForPhase(phase)`, tool handlers                                                               |
| `backend/src/domain/bot/toolLoop.ts`              | **create**    | `toolLoopDecider: BotDecider`                                                                                    |
| `backend/src/domain/bot/defaultPrompt.ts`         | modify        | drop player-context block from `DEFAULT_BOT_PROMPT`                                                              |
| `backend/src/domain/bot/applyBotTurn.ts`          | modify        | `resolve` outcome, `bot_phase` writes, article events, `resolution_source` write                                 |
| `backend/src/domain/bot/orchestrator.ts`          | modify        | `gather()` adds `botPhase`, `botMessageCount`, `lastPlayerMessageAt`                                             |
| `backend/src/domain/bot/messages.ts`              | modify        | `SILENT_UNAVAILABLE_REASONS` drops `'not_implemented'`                                                           |
| `backend/src/domain/bot/index.ts`                 | modify        | export new modules                                                                                               |
| `backend/src/shared/jobs/botTurns.ts`             | modify        | default decider becomes `toolLoopDecider`                                                                        |
| `backend/src/surface/services/messagesService.ts` | modify        | reopen branch: `HANDOFF_PLAYER_MESSAGE`, §10 assignment, `resolution_source` read+clear                          |
| `backend/tests/*`                                 | modify/create | see per-task Verification                                                                                        |

No new HTTP routes land in this slice, so `backend/src/docs/openapi.ts` is untouched.

---

### Task 1: Schema — `bot_phase` and `resolution_source`

**Files:**

- Modify: `backend/src/shared/db/schema/enums.ts`
- Modify: `backend/src/shared/db/schema/conversations.ts`
- Test: `backend/tests/schema.test.ts`

**Interfaces:**

- Produces: `botPhase` pgEnum (`'none' | 'article_confirm'`), `resolutionSource` pgEnum (`'bot' | 'agent'`); `conversation.botPhase: 'none'|'article_confirm'` (not null, default `'none'`), `conversation.resolutionSource: 'bot'|'agent'|null`.

- [ ] **Step 1: Add the two enums**

In `backend/src/shared/db/schema/enums.ts`, add after `articleState`:

```typescript
export const botPhase = pgEnum('bot_phase', ['none', 'article_confirm']);
export const resolutionSource = pgEnum('resolution_source', ['bot', 'agent']);
```

- [ ] **Step 2: Add the two columns**

In `backend/src/shared/db/schema/conversations.ts`, update the import and add columns to `conversation`:

```typescript
import {
  classificationSource,
  conversationPriority,
  conversationStatus,
  messageAuthorType,
  messageDeliveryState,
  messageVisibility,
  botPhase,
  resolutionSource,
} from './enums.ts';
```

Add, right after `subintentId`:

```typescript
    /** Guard, not a scheduler — decides whether confirm_resolution is offered to
     *  the model at all. The forms slice widens this to add 'form'. */
    botPhase: botPhase('bot_phase').notNull().default('none'),
    /** NULL until the conversation is resolved. Read on reopen to decide
     *  assignment per spec §10, then cleared. */
    resolutionSource: resolutionSource('resolution_source'),
```

- [ ] **Step 3: Update `schema.test.ts`**

Find the existing assertion(s) on table/column counts and add assertions for the two new columns and their defaults/constraints, following whatever pattern the file already uses for `subintent_id` / `classification_source`. Example shape (adapt to the file's existing style):

```typescript
it('conversation.bot_phase defaults to none and rejects an unknown value', async () => {
  const [row] = await db.execute(sql`
    insert into conversation (workspace_id, player_id) values (${workspaceId}, ${playerId})
    returning bot_phase
  `);
  expect(row.bot_phase).toBe('none');

  await expect(
    db.execute(sql`update conversation set bot_phase = 'bogus' where id = ${conversationId}`),
  ).rejects.toThrow();
});
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:generate` then `pnpm db:setup`

- [ ] **Step 5: Run tests**

Run: `pnpm --filter backend test schema.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/db/schema/enums.ts backend/src/shared/db/schema/conversations.ts backend/tests/schema.test.ts backend/src/shared/db/migrations
git commit -m "feat(bot): add conversation.bot_phase and conversation.resolution_source"
```

---

### Task 2: Environment — `OPENAI_MODEL` and the `openai` dependency

**Files:**

- Modify: `backend/src/env.ts`
- Modify: `backend/package.json`
- Modify: `.env.example`
- Test: `backend/tests/env.test.ts`

**Interfaces:**

- Produces: `Env.OPENAI_MODEL: string` (required, no default).

- [ ] **Step 1: Install `openai`**

Run: `pnpm --filter backend add openai`

- [ ] **Step 2: Add `OPENAI_MODEL` to the schema**

In `backend/src/env.ts`, add after `OPENAI_APIKEY`:

```typescript
  OPENAI_APIKEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1, 'OPENAI_MODEL is required'),
```

- [ ] **Step 3: Add to `.env.example`**

```
OPENAI_MODEL=gpt-5.4-mini
```

- [ ] **Step 4: Write the failing test**

In `backend/tests/env.test.ts`, add (matching the file's existing pattern for required vars):

```typescript
it('fails validation when OPENAI_MODEL is missing', () => {
  const { OPENAI_MODEL, ...rest } = validEnv;
  expect(() => loadEnv(rest)).toThrow(/OPENAI_MODEL/);
});
```

Also add `OPENAI_MODEL: 'gpt-5.4-mini'` to whatever `validEnv` fixture object the file already uses for a passing baseline.

- [ ] **Step 5: Run test to verify it fails, then passes**

Run: `pnpm --filter backend test env.test.ts`
Expected: FAIL before Step 2's edit is present, PASS after (Step 2 is already applied above — run once to confirm PASS).

- [ ] **Step 6: Commit**

```bash
git add backend/src/env.ts backend/package.json pnpm-lock.yaml .env.example backend/tests/env.test.ts
git commit -m "feat(bot): add openai dependency and required OPENAI_MODEL env var"
```

---

### Task 3: Seed the `Other` intent, and `fallbackSubintent.ts`

**Files:**

- Modify: `backend/src/shared/db/seed.ts`
- Create: `backend/src/domain/bot/fallbackSubintent.ts`
- Test: `backend/tests/seed.test.ts`
- Test: `backend/tests/bot.fallbackSubintent.test.ts`

**Interfaces:**

- Produces: `resolveFallbackSubintent(tx: Tx, workspaceId: string): Promise<string>` — returns the seeded `Other` subintent's id, throws if it has not been seeded for that workspace.
- Consumes: `intent`, `subintent` tables (`backend/src/shared/db/schema/taxonomy.ts`), `Tx` from `backend/src/shared/db/withWorkspace.ts`.

- [ ] **Step 1: Write the failing test for `fallbackSubintent.ts`**

Create `backend/tests/bot.fallbackSubintent.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { resolveFallbackSubintent } from '../src/domain/bot/fallbackSubintent.ts';
import { intent, subintent } from '../src/shared/db/schema/index.ts';
import { makeWorkspace } from './helpers/fixtures.ts'; // use whatever fixture helper the existing bot tests already import

describe('resolveFallbackSubintent', () => {
  it('resolves the seeded Other/Other pair', async () => {
    const workspaceId = await makeWorkspace();
    await withWorkspace(workspaceId, async (tx) => {
      const [other] = await tx
        .insert(intent)
        .values({ workspaceId, name: 'Other', isSystem: true })
        .returning({ id: intent.id });
      await tx.insert(subintent).values({ workspaceId, intentId: other!.id, name: 'Other' });
    });

    const id = await withWorkspace(workspaceId, (tx) => resolveFallbackSubintent(tx, workspaceId));
    expect(id).toBeTypeOf('string');
  });

  it('throws when Other has not been seeded for this workspace', async () => {
    const workspaceId = await makeWorkspace();
    await expect(
      withWorkspace(workspaceId, (tx) => resolveFallbackSubintent(tx, workspaceId)),
    ).rejects.toThrow(/Other/);
  });
});
```

(Match the actual fixture helper name used by `backend/tests/bot.turnSeam.test.ts` for creating a workspace — read that file's imports first and reuse the same helper rather than inventing `makeWorkspace`.)

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm --filter backend test bot.fallbackSubintent.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `fallbackSubintent.ts`**

```typescript
// backend/src/domain/bot/fallbackSubintent.ts
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { intent, subintent } from '../../shared/db/schema/index.ts';

/** The one name this slice's `Other` classification carries. Seeded in seed.ts. */
export const OTHER_INTENT_NAME = 'Other';
export const OTHER_SUBINTENT_NAME = 'Other';

/**
 * The subintent `classify` resolves to when the model picks the `Other` index,
 * or when the model's index does not resolve. Never fabricated on the fly —
 * this is a lookup against a seeded row, and its absence is a provisioning
 * bug this throws loudly on rather than silently classifying nothing.
 */
export async function resolveFallbackSubintent(tx: Tx, workspaceId: string): Promise<string> {
  const [row] = await tx
    .select({ id: subintent.id })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(
      and(
        eq(subintent.workspaceId, workspaceId),
        eq(intent.isSystem, true),
        eq(intent.name, OTHER_INTENT_NAME),
        eq(subintent.name, OTHER_SUBINTENT_NAME),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error(
      `resolveFallbackSubintent: workspace ${workspaceId} has no seeded "Other" subintent`,
    );
  }
  return row.id;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter backend test bot.fallbackSubintent.test.ts`
Expected: PASS

- [ ] **Step 5: Seed `Other` in `seed.ts`**

In `backend/src/shared/db/seed.ts`, add the import:

```typescript
const { OTHER_INTENT_NAME, OTHER_SUBINTENT_NAME } =
  await import('../../domain/bot/fallbackSubintent.ts');
```

Immediately after the `for (const intentData of SEED_TAXONOMY) { ... }` loop closes (still inside the same `withWorkspace` block), add:

```typescript
const [otherIntent] = await tx
  .insert(intent)
  .values({ workspaceId, name: OTHER_INTENT_NAME, isSystem: true })
  .onConflictDoNothing()
  .returning({ id: intent.id });
if (otherIntent) {
  await tx
    .insert(subintent)
    .values({ workspaceId, intentId: otherIntent.id, name: OTHER_SUBINTENT_NAME })
    .onConflictDoNothing();
}
```

- [ ] **Step 6: Write the failing test for idempotent seeding**

In `backend/tests/seed.test.ts`, add:

```typescript
it('seeds exactly one is_system intent named Other, and re-running does not duplicate it', async () => {
  await seed();
  await seed();

  const rows = await withWorkspace(workspaceIdUnderTest, (tx) =>
    tx
      .select({ id: intent.id })
      .from(intent)
      .where(
        and(
          eq(intent.workspaceId, workspaceIdUnderTest),
          eq(intent.isSystem, true),
          eq(intent.name, 'Other'),
        ),
      ),
  );
  expect(rows).toHaveLength(1);
});
```

(Match the existing `seed.test.ts` file's actual workspace-lookup pattern — it already re-runs `seed()` for its idempotency assertions on articles; follow that same structure rather than introducing a new one.)

- [ ] **Step 7: Run test, verify it passes**

Run: `pnpm --filter backend test seed.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/shared/db/seed.ts backend/src/domain/bot/fallbackSubintent.ts backend/tests/seed.test.ts backend/tests/bot.fallbackSubintent.test.ts
git commit -m "feat(bot): seed the Other intent/subintent and add resolveFallbackSubintent"
```

---

### Task 4: `botTurn.ts` type deltas

**Files:**

- Modify: `backend/src/domain/bot/botTurn.ts`
- Modify: `backend/tests/bot.turnSeam.test.ts`

**Interfaces:**

- Produces:

  ```typescript
  export type HandoffReason =
    'asked_for_person' | 'article_rejected' | 'no_article' | 'sensitive' | 'unsure' | 'turn_cap';
  export type UnavailableReason = 'not_provisioned' | 'error' | 'timeout' | 'invalid_response';
  export type BotTurnDecision =
    | { kind: 'noop' }
    | { kind: 'answer'; reply: string; subintentId: string | null; articleId?: string }
    | { kind: 'resolve'; subintentId: string | null }
    | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
    | { kind: 'unavailable'; reason: UnavailableReason };
  export type BotTurnInput = {
    workspaceId: string;
    conversationId: string;
    subintentId: string | null;
    botPhase: 'none' | 'article_confirm';
    botMessageCount: number;
    lastPlayerMessageAt: Date | null;
    history: PlayerMessageView[];
  };
  export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>;
  ```

  `stubDecider` and `SILENT_UNAVAILABLE_REASONS` are kept in this task (still referenced by `botTurns.ts`); they are removed/updated in Task 10 once `toolLoopDecider` exists to replace the default.

  Note: `answer.subintentId` widens from `string` to `string | null` — a greeting that triggers no `classify` call still exits `answer` with no classification, per spec's own example (`§8`). This is a real (narrow) behavior correction over spec 1's original signature, required by spec 4's control flow (`No tool call → exit with { kind: 'answer', reply }` — no subintentId at all in that case). `applyBotTurn`'s `classifyIfUnset` call in the `answer` branch must be guarded on non-null, matching the existing guard already written for the `handoff` branch (Task 9 handles this).

- [ ] **Step 1: Update the types**

Replace the top of `backend/src/domain/bot/botTurn.ts` (down through the `BotDecider` type) with:

```typescript
// backend/src/domain/bot/botTurn.ts

import type { PlayerMessageView } from '@support/types';

/**
 * Model-chosen (`asked_for_person`, `no_article`, `sensitive` — passed directly
 * to the `handoff` tool), code-derived from a model choice (`article_rejected`,
 * from `confirm_resolution(false)`), or forced by a budget with no model call
 * involved at all (`unsure`, `turn_cap`).
 */
export type HandoffReason =
  'asked_for_person' | 'article_rejected' | 'no_article' | 'sensitive' | 'unsure' | 'turn_cap';

export type UnavailableReason =
  | 'not_provisioned' // admin has the bot switched off
  | 'error' // a turn failed after its retries were exhausted
  | 'timeout' // callModel exceeded its 15s budget
  | 'invalid_response'; // a refusal or an unparseable tool argument — not retried

export type BotTurnDecision =
  | { kind: 'noop' }
  | { kind: 'answer'; reply: string; subintentId: string | null; articleId?: string }
  | { kind: 'resolve'; subintentId: string | null }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason };

export type BotTurnInput = {
  workspaceId: string;
  conversationId: string;
  subintentId: string | null;
  /** Guards whether confirm_resolution is offered to the model this turn. */
  botPhase: 'none' | 'article_confirm';
  /** Bot-authored messages so far, in this conversation. Drives MAX_BOT_MESSAGES. */
  botMessageCount: number;
  /** Null if the player has never sent a message (should not happen once a turn runs). */
  lastPlayerMessageAt: Date | null;
  history: PlayerMessageView[];
};

export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>;
```

Leave `stubDecider` and `SILENT_UNAVAILABLE_REASONS` below unchanged for now, except `SILENT_UNAVAILABLE_REASONS`'s type annotation still compiles against the narrowed `UnavailableReason` (it already only references `'not_provisioned'` and `'not_implemented'` — `'not_implemented'` is removed from the union in this step, so this line now fails to typecheck).

- [ ] **Step 2: Fix the now-broken `stubDecider`/`SILENT_UNAVAILABLE_REASONS`**

`'not_implemented'` no longer exists on `UnavailableReason`. Update the bottom of the file:

```typescript
/**
 * The scaffolding decider, replaced by `toolLoopDecider` in Task 10. Kept here
 * until that task so `botTurns.ts` still compiles between tasks.
 */
export const stubDecider: BotDecider = async () => ({ kind: 'unavailable', reason: 'error' });

/** Only an admin's deliberate choice is silent. Every other reason gets an internal note. */
export const SILENT_UNAVAILABLE_REASONS: ReadonlySet<UnavailableReason> = new Set([
  'not_provisioned',
]);
```

- [ ] **Step 3: Fix `bot.turnSeam.test.ts`'s now-invalid `reason: 'model'` literals**

`HandoffReason` no longer has a `'model'` member. In `backend/tests/bot.turnSeam.test.ts`, replace every `reason: 'model'` (lines ~131, ~145, ~160, ~169, ~244 as of this writing — grep to confirm) with `reason: 'unsure'`, and update the corresponding `expect(events[1].payload).toEqual({ reason: 'unsure', ... })` assertions to match. These tests exercise `applyBotTurn`'s handoff branch generically — the specific reason value is incidental to what they're testing, so `'unsure'` is a like-for-like substitution.

Also update every call site in that file that constructs `{ kind: 'handoff', reason: ..., subintentId: null }` if any now fail to typecheck for other reasons (they shouldn't — the shape is unchanged, only the `reason` string literal type narrowed).

- [ ] **Step 4: Typecheck and run the affected test files**

Run: `pnpm --filter backend typecheck`
Expected: PASS (no other file references `'not_implemented'` or `reason: 'model'` — confirm with `grep -rn "not_implemented\|reason: 'model'" backend/src backend/tests`)

Run: `pnpm --filter backend test bot.turnSeam.test.ts jobs.botTurns.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/botTurn.ts backend/tests/bot.turnSeam.test.ts
git commit -m "feat(bot): widen BotTurnDecision/BotTurnInput/HandoffReason for the tool loop"
```

---

### Task 5: `contextAssembly.ts` — `buildMessages`

**Files:**

- Create: `backend/src/domain/bot/contextAssembly.ts`
- Test: `backend/tests/bot.contextAssembly.test.ts`

**Interfaces:**

- Consumes: `BotTurnInput` (Task 4), `ResolvedBotConfig.systemPrompt` (existing `resolveBotConfig`), `subintent`/`intent`/`article` tables, `Tx`.
- Produces:

  ```typescript
  export type ChatRole = 'system' | 'user' | 'assistant';
  export type ChatMessage = { role: ChatRole; content: string };
  export type SubintentOption = { index: number; subintentId: string; label: string };
  export type BuildMessagesResult = {
    messages: ChatMessage[];
    /** Ordered options presented in the {{subintents}} block, ending with the Other entry. tools.ts maps classify's subintent_index against this array. */
    subintentOptions: SubintentOption[];
    /** Article ids the player-visible catalogue names — for logging/debug only, never used to validate offer_article (that's this turn's search results, see tools.ts). */
    catalogueArticleCount: number;
  };
  export const MAX_HISTORY_MESSAGES = 20;
  export async function buildMessages(tx: Tx, input: BotTurnInput): Promise<BuildMessagesResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.contextAssembly.test.ts` (read `backend/tests/bot.orchestrator.test.ts` first for the fixture/workspace-setup helper this repo already uses, and reuse it rather than reinventing one):

```typescript
import { describe, it, expect } from 'vitest';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { buildMessages, MAX_HISTORY_MESSAGES } from '../src/domain/bot/contextAssembly.ts';
import { postMessage } from '../src/domain/conversations/postMessage.ts';
// ...import whatever fixture helpers bot.orchestrator.test.ts already uses for workspace/conversation setup

describe('buildMessages', () => {
  it('renders classification and offered/rejected article from event rows, with no model-generated text', async () => {
    // arrange: a conversation classified into a known subintent, with a
    // bot_article_offered then bot_article_rejected event appended
    // act: const { messages } = await withWorkspace(workspaceId, (tx) => buildMessages(tx, input))
    // assert: the rendered state-block message's content contains the subintent
    // name and the article title, and contains no substring that isn't derived
    // from a column/event value the test itself set up
  });

  it('with 40 messages, keeps the first player message, the last 20, and an elision marker with the dropped count', async () => {
    // arrange: post 40 alternating player/bot messages
    // act, assert: messages array contains message #1's body, the last 20
    // bodies, and exactly one content string matching /19 messages? omitted|elided/
    // (assert on MAX_HISTORY_MESSAGES=20, not a hardcoded 20, so this test breaks
    // loudly if the constant changes without the test being updated)
  });

  it('never includes an internal-visibility message, at any window size', async () => {
    // arrange: an internal note among the transcript
    // assert: no returned message's content includes that note's body
  });

  it('emits no system-role message after the first', async () => {
    // assert: messages.filter(m => m.role === 'system').length === 1
  });

  it('produces the same state block after a simulated five-day gap, plus the gap line', async () => {
    // arrange: same conversation twice, one with lastPlayerMessageAt = now,
    // one with lastPlayerMessageAt = 5 days ago
    // assert: the two results' messages are identical except the recent one
    // has no "last here N days ago" line and the old one does
  });
});
```

Fill in the arrange/act/assert bodies using this repo's actual fixture helpers and `appendEvent`/`postMessage` signatures (already read in Tasks above) — do not leave these as comments in the committed test file.

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter backend test bot.contextAssembly.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `contextAssembly.ts`**

```typescript
// backend/src/domain/bot/contextAssembly.ts
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import type { BotTurnInput } from './botTurn.ts';
import { resolveBotConfig } from './botConfig.ts';
import { article, event, intent, message, subintent } from '../../shared/db/schema/index.ts';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };
export type SubintentOption = { index: number; subintentId: string; label: string };
export type BuildMessagesResult = {
  messages: ChatMessage[];
  subintentOptions: SubintentOption[];
  catalogueArticleCount: number;
};

export const MAX_HISTORY_MESSAGES = 20;

const PLAYER_CONTEXT_LINE = 'This message is reported by the game client, not verified.';

async function loadSubintentOptions(tx: Tx, workspaceId: string): Promise<SubintentOption[]> {
  const rows = await tx
    .select({
      subintentId: subintent.id,
      subintentName: subintent.name,
      intentName: intent.name,
      isSystem: intent.isSystem,
    })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(
      and(eq(subintent.workspaceId, workspaceId), eq(intent.archivedAt, null as unknown as Date)),
    )
    .orderBy(asc(intent.name), asc(subintent.name));

  // The seeded Other/Other pair is presented last, under its own fixed label,
  // never mixed alphabetically into the real taxonomy — the model always
  // finds it in the same place.
  const real = rows.filter((r) => !r.isSystem);
  const options: SubintentOption[] = real.map((r, i) => ({
    index: i,
    subintentId: r.subintentId,
    label: `${r.intentName} → ${r.subintentName}`,
  }));

  const other = rows.find((r) => r.isSystem);
  if (other) {
    options.push({
      index: options.length,
      subintentId: other.subintentId,
      label: 'Other (none of these fit)',
    });
  }
  return options;
}

function renderSubintents(options: SubintentOption[]): string {
  return options.map((o) => `${o.index}. ${o.label}`).join('\n');
}

async function renderArticleCatalogue(
  tx: Tx,
  workspaceId: string,
): Promise<{ text: string; count: number }> {
  const rows = await tx
    .select({ title: article.title, intentName: intent.name })
    .from(article)
    .leftJoin(intent, eq(intent.id, article.intentId))
    .where(and(eq(article.workspaceId, workspaceId), eq(article.state, 'published')))
    .orderBy(asc(intent.name), asc(article.title));

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.intentName ?? 'Uncategorized';
    grouped.set(key, [...(grouped.get(key) ?? []), row.title]);
  }

  const text = [...grouped.entries()]
    .map(([intentName, titles]) => `${intentName}:\n${titles.map((t) => `- ${t}`).join('\n')}`)
    .join('\n\n');
  return { text, count: rows.length };
}

async function renderStateBlock(tx: Tx, input: BotTurnInput): Promise<string> {
  const lines: string[] = ['── conversation state ──'];

  if (input.subintentId) {
    const [row] = await tx
      .select({ subintentName: subintent.name, intentName: intent.name })
      .from(subintent)
      .innerJoin(intent, eq(intent.id, subintent.intentId))
      .where(eq(subintent.id, input.subintentId))
      .limit(1);
    if (row) lines.push(`Classified as: ${row.intentName} → ${row.subintentName}`);
  }

  const [lastArticleEvent] = await tx
    .select({ type: event.type, payload: event.payload })
    .from(event)
    .where(
      and(eq(event.conversationId, input.conversationId), eq(event.type, 'bot_article_offered')),
    )
    .orderBy(desc(event.occurredAt))
    .limit(1);
  if (lastArticleEvent) {
    const title =
      (lastArticleEvent.payload as { article_title?: string }).article_title ?? 'an article';
    const [rejection] = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(eq(event.conversationId, input.conversationId), eq(event.type, 'bot_article_rejected')),
      )
      .orderBy(desc(event.occurredAt))
      .limit(1);
    lines.push(`Article offered: "${title}"${rejection ? ' — rejected' : ''}`);
  }

  if (input.lastPlayerMessageAt) {
    const gapMs = Date.now() - input.lastPlayerMessageAt.getTime();
    const gapDays = Math.floor(gapMs / (24 * 60 * 60 * 1000));
    if (gapDays >= 1)
      lines.push(`Player was last here ${gapDays} day${gapDays === 1 ? '' : 's'} ago`);
  }

  return lines.join('\n');
}

function toChatRole(authorType: string): ChatRole | null {
  if (authorType === 'player') return 'user';
  if (authorType === 'bot') return 'assistant';
  return null; // system/agent messages never enter the model's transcript
}

/**
 * Renders every input the model needs from columns and events — never an LLM
 * summarisation pass (spec §7): that costs a call, is non-deterministic
 * against temperature 0, and can hallucinate that the bot asked something it
 * did not, the exact failure this block exists to prevent.
 */
export async function buildMessages(tx: Tx, input: BotTurnInput): Promise<BuildMessagesResult> {
  const config = await resolveBotConfig(tx, input.workspaceId);
  const subintentOptions = await loadSubintentOptions(tx, input.workspaceId);
  const catalogue = await renderArticleCatalogue(tx, input.workspaceId);
  const stateBlock = await renderStateBlock(tx, input);

  const systemPrompt = config.systemPrompt
    .replace('{{subintents}}', renderSubintents(subintentOptions))
    .replace('{{articles}}', catalogue.text);

  const rows = await tx
    .select()
    .from(message)
    .where(eq(message.conversationId, input.conversationId))
    .orderBy(asc(message.seq));

  const transcript = rows
    .filter((r) => r.visibility === 'public')
    .map((r) => ({ role: toChatRole(r.authorType), body: r.body }))
    .filter((m): m is { role: ChatRole; body: string } => m.role !== null);

  const first = transcript[0];
  const rest = transcript.slice(1);
  const windowed =
    rest.length > MAX_HISTORY_MESSAGES ? rest.slice(rest.length - MAX_HISTORY_MESSAGES) : rest;
  const droppedCount = rest.length - windowed.length;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: PLAYER_CONTEXT_LINE },
    { role: 'user', content: stateBlock },
  ];

  if (first) messages.push({ role: first.role, content: first.body });
  if (droppedCount > 0)
    messages.push({ role: 'user', content: `[${droppedCount} messages elided]` });
  for (const m of windowed) messages.push({ role: m.role, content: m.body });

  return { messages, subintentOptions, catalogueArticleCount: catalogue.count };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter backend test bot.contextAssembly.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/contextAssembly.ts backend/tests/bot.contextAssembly.test.ts
git commit -m "feat(bot): add contextAssembly.buildMessages"
```

---

### Task 6: `openaiClient.ts`

**Files:**

- Create: `backend/src/domain/bot/openaiClient.ts`
- Test: `backend/tests/bot.openaiClient.test.ts`

**Interfaces:**

- Consumes: `ChatMessage` (Task 5), `getEnv()` (`OPENAI_APIKEY`, `OPENAI_MODEL`).
- Produces:

  ```typescript
  export type ToolCall = { id: string; name: string; arguments: string };
  export type ModelResponse = { toolCalls: ToolCall[]; text: string | null };
  export class ModelTimeoutError extends Error {}
  export class ModelRefusalError extends Error {}
  export async function callModel(
    messages: ChatMessage[],
    tools: unknown[],
  ): Promise<ModelResponse>;
  ```

  Any other failure (non-2xx, network) throws the SDK's own error type unmodified — `toolLoop` (Task 8) is the layer that maps thrown errors to `unavailable` reasons, not this file.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.openaiClient.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));

import { callModel, ModelTimeoutError, ModelRefusalError } from '../src/domain/bot/openaiClient.ts';

describe('callModel', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns tool calls from the response', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 't1', function: { name: 'search_articles', arguments: '{"query":"x"}' } },
            ],
          },
        },
      ],
    });
    const result = await callModel([{ role: 'user', content: 'hi' }], []);
    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'search_articles', arguments: '{"query":"x"}' },
    ]);
    expect(result.text).toBeNull();
  });

  it('returns text when there is no tool call', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'hello', tool_calls: undefined } }],
    });
    const result = await callModel([{ role: 'user', content: 'hi' }], []);
    expect(result.text).toBe('hello');
    expect(result.toolCalls).toEqual([]);
  });

  it('throws ModelRefusalError on a refusal', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { refusal: 'cannot help', tool_calls: undefined, content: null } }],
    });
    await expect(callModel([], [])).rejects.toThrow(ModelRefusalError);
  });

  it('throws ModelTimeoutError when the call exceeds 15s', async () => {
    mockCreate.mockImplementation(() => new Promise(() => {})); // never resolves
    vi.useFakeTimers();
    const promise = callModel([], []);
    vi.advanceTimersByTime(15_001);
    await expect(promise).rejects.toThrow(ModelTimeoutError);
    vi.useRealTimers();
  });

  it('passes temperature 0 and the configured model', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'ok', tool_calls: undefined } }],
    });
    await callModel([], []);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0, model: expect.any(String) }),
    );
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter backend test bot.openaiClient.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `openaiClient.ts`**

```typescript
// backend/src/domain/bot/openaiClient.ts
import OpenAI from 'openai';
import { getEnv } from '../../env.ts';
import type { ChatMessage } from './contextAssembly.ts';

export type ToolCall = { id: string; name: string; arguments: string };
export type ModelResponse = { toolCalls: ToolCall[]; text: string | null };

export class ModelTimeoutError extends Error {
  constructor() {
    super('OpenAI call exceeded 15000ms');
    this.name = 'ModelTimeoutError';
  }
}

export class ModelRefusalError extends Error {
  constructor(refusal: string) {
    super(`Model refused: ${refusal}`);
    this.name = 'ModelRefusalError';
  }
}

const CALL_TIMEOUT_MS = 15_000;

let client: OpenAI | undefined;
function getClient(): OpenAI {
  client ??= new OpenAI({ apiKey: getEnv().OPENAI_APIKEY });
  return client;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelTimeoutError()), CALL_TIMEOUT_MS);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The only file that imports `openai`. Returns a validated response or
 * throws a typed error — `toolLoop` maps errors to reasons and never
 * inspects an SDK exception shape directly.
 */
export async function callModel(messages: ChatMessage[], tools: unknown[]): Promise<ModelResponse> {
  const response = await withTimeout(
    getClient().chat.completions.create({
      model: getEnv().OPENAI_MODEL,
      temperature: 0,
      messages: messages as never,
      tools: tools as never,
    }) as unknown as Promise<{
      choices: [
        {
          message: {
            content: string | null;
            refusal?: string | null;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
        },
      ];
    }>,
  );

  const msg = response.choices[0].message;
  if (msg.refusal) throw new ModelRefusalError(msg.refusal);

  const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
  return { toolCalls, text: toolCalls.length === 0 ? msg.content : null };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter backend test bot.openaiClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/openaiClient.ts backend/tests/bot.openaiClient.test.ts
git commit -m "feat(bot): add openaiClient.callModel"
```

---

### Task 7: `tools.ts`, and drop the player-context block from `defaultPrompt.ts`

**Files:**

- Create: `backend/src/domain/bot/tools.ts`
- Modify: `backend/src/domain/bot/defaultPrompt.ts`
- Test: `backend/tests/bot.tools.test.ts`
- Test: `backend/tests/bot.config.test.ts` (update)

**Interfaces:**

- Consumes: `SubintentOption[]` (Task 5), `searchArticleIds` (`backend/src/shared/weaviate/articlesIndex.ts`), `resolveFallbackSubintent` (Task 3), `article` schema.
- Produces:

  ```typescript
  export type ToolPhase = 'none' | 'article_confirm';
  export const TOOL_DEFS: Record<string, unknown>; // OpenAI tool-def shape, strict schemas, keyed by tool name
  export function toolsForPhase(phase: ToolPhase): unknown[];
  export type SearchArticlesResult = { id: string; title: string; body: string }[];
  export async function searchArticles(
    tx: Tx,
    workspaceId: string,
    query: string,
  ): Promise<SearchArticlesResult>;
  export function resolveClassifyIndex(
    options: SubintentOption[],
    index: number,
  ): SubintentOption | null;
  export const CONFIRM_RESOLUTION_TOOL_NAME = 'confirm_resolution';
  ```

  `tools.ts` exposes tool _definitions_ and small pure/DB-reading helpers (`searchArticles`, `resolveClassifyIndex`). It does not touch `bot_phase`, budgets, or the fallback-subintent DB write path — `toolLoop.ts` (Task 8) owns sequencing and calls these.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.tools.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  toolsForPhase,
  resolveClassifyIndex,
  CONFIRM_RESOLUTION_TOOL_NAME,
} from '../src/domain/bot/tools.ts';

describe('toolsForPhase', () => {
  it('omits confirm_resolution when phase is none', () => {
    const names = toolsForPhase('none').map((t: any) => t.function.name);
    expect(names).not.toContain(CONFIRM_RESOLUTION_TOOL_NAME);
    expect(names).toEqual(
      expect.arrayContaining(['search_articles', 'classify', 'offer_article', 'handoff']),
    );
  });

  it('includes confirm_resolution when phase is article_confirm', () => {
    const names = toolsForPhase('article_confirm').map((t: any) => t.function.name);
    expect(names).toContain(CONFIRM_RESOLUTION_TOOL_NAME);
  });
});

describe('resolveClassifyIndex', () => {
  const options = [
    { index: 0, subintentId: 'a', label: 'A' },
    { index: 1, subintentId: 'b', label: 'B' },
  ];

  it('resolves a valid index', () => {
    expect(resolveClassifyIndex(options, 1)).toEqual(options[1]);
  });

  it('returns null for an out-of-range index', () => {
    expect(resolveClassifyIndex(options, 99)).toBeNull();
    expect(resolveClassifyIndex(options, -1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter backend test bot.tools.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Remove the player-context block from `defaultPrompt.ts`**

In `backend/src/domain/bot/defaultPrompt.ts`, change `DEFAULT_BOT_PROMPT` to drop the `Context about this player` block (keep `BOT_PROMPT_PLACEHOLDERS` listing all four — it validates what an admin-customised prompt is _allowed_ to reference, not what the default ships):

```typescript
export const DEFAULT_BOT_PROMPT = `You are the first-line support assistant inside a mobile game's help window. You are talking to a player, in the game, right now.

Your job is to do exactly one of two things on every message:

1. Answer the player's question, if one of the help articles below actually answers it.
2. Hand the conversation to a human, if it does not.

Classify the player's problem into one of these categories:
{{subintents}}

Use only these help articles as your source of truth:
{{articles}}

When you hand off, say plainly that you are passing this to the support team, and stop. Do not keep asking questions to fill the gap.`;
```

- [ ] **Step 4: Update `bot.config.test.ts`**

Find the existing assertion that `DEFAULT_BOT_PROMPT` contains all four placeholders and narrow it:

```typescript
it('DEFAULT_BOT_PROMPT contains {{subintents}} and {{articles}}, not {{player_level}} or {{spend_tier}}', () => {
  expect(DEFAULT_BOT_PROMPT).toContain('{{subintents}}');
  expect(DEFAULT_BOT_PROMPT).toContain('{{articles}}');
  expect(DEFAULT_BOT_PROMPT).not.toContain('{{player_level}}');
  expect(DEFAULT_BOT_PROMPT).not.toContain('{{spend_tier}}');
});

it('BOT_PROMPT_PLACEHOLDERS still lists all four', () => {
  expect(BOT_PROMPT_PLACEHOLDERS).toEqual([
    '{{subintents}}',
    '{{articles}}',
    '{{player_level}}',
    '{{spend_tier}}',
  ]);
});
```

- [ ] **Step 5: Implement `tools.ts`**

```typescript
// backend/src/domain/bot/tools.ts
import { eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { article } from '../../shared/db/schema/index.ts';
import { searchArticleIds } from '../../shared/weaviate/articlesIndex.ts';
import type { SubintentOption } from './contextAssembly.ts';

export type ToolPhase = 'none' | 'article_confirm';

export const CONFIRM_RESOLUTION_TOOL_NAME = 'confirm_resolution';
const MAX_ARTICLES_PER_TURN = 3;

const ALWAYS_AVAILABLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_articles',
      description:
        'Search published help articles by natural-language query. No side effects. Call at most 3 times per turn.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'classify',
      description:
        "Record which category the player's problem falls into. Write-once: a second call in this conversation is ignored.",
      strict: true,
      parameters: {
        type: 'object',
        properties: { subintent_index: { type: 'integer' } },
        required: ['subintent_index'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_article',
      description:
        'Post one of the articles returned by search_articles this turn to the player, and ask if it solved their problem.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { article_id: { type: 'string' } },
        required: ['article_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff',
      description: 'End the turn and connect the player to a human support agent.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['asked_for_person', 'no_article', 'sensitive'] },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },
] as const;

const CONFIRM_RESOLUTION_TOOL = {
  type: 'function',
  function: {
    name: CONFIRM_RESOLUTION_TOOL_NAME,
    description:
      'Record whether the offered article solved the player\'s problem. Only call this in direct response to the player answering "did this solve it?".',
    strict: true,
    parameters: {
      type: 'object',
      properties: { helped: { type: 'boolean' } },
      required: ['helped'],
      additionalProperties: false,
    },
  },
} as const;

export const TOOL_DEFS = [...ALWAYS_AVAILABLE_TOOLS, CONFIRM_RESOLUTION_TOOL];

/**
 * confirm_resolution is offered to the model only while bot_phase =
 * 'article_confirm' — a property of the request, not of the prompt (spec §3).
 */
export function toolsForPhase(phase: ToolPhase): unknown[] {
  return phase === 'article_confirm'
    ? [...ALWAYS_AVAILABLE_TOOLS, CONFIRM_RESOLUTION_TOOL]
    : [...ALWAYS_AVAILABLE_TOOLS];
}

export { MAX_ARTICLES_PER_TURN };

export type SearchArticlesResult = { id: string; title: string; body: string }[];

/** Hybrid retrieval fired against the model's own phrased query, not the player's raw words (spec §3). */
export async function searchArticles(
  tx: Tx,
  workspaceId: string,
  query: string,
): Promise<SearchArticlesResult> {
  const ids = await searchArticleIds(query, { workspaceId, limit: 5 });
  if (ids.length === 0) return [];

  const rows = await tx
    .select({ id: article.id, title: article.title, body: article.body })
    .from(article)
    .where(eq(article.workspaceId, workspaceId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is { id: string; title: string; body: string } => r !== undefined);
}

/** Null on an out-of-range index — toolLoop maps that to the Other fallback, same as an explicit Other choice. */
export function resolveClassifyIndex(
  options: SubintentOption[],
  index: number,
): SubintentOption | null {
  return options.find((o) => o.index === index) ?? null;
}
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `pnpm --filter backend test bot.tools.test.ts bot.config.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/domain/bot/tools.ts backend/src/domain/bot/defaultPrompt.ts backend/tests/bot.tools.test.ts backend/tests/bot.config.test.ts
git commit -m "feat(bot): add the five tool definitions and drop the player-context prompt block"
```

---

### Task 8: `toolLoop.ts` — `toolLoopDecider`

This is the core of the slice. Read `docs/specs/2026-08-12-bot-tool-calling-decider-design.md`'s "Control flow" and "Verification → New tests/bot.toolLoop.test.ts" sections again immediately before starting this task.

**Files:**

- Create: `backend/src/domain/bot/toolLoop.ts`
- Test: `backend/tests/bot.toolLoop.test.ts`

**Interfaces:**

- Consumes: `BotTurnInput`/`BotTurnDecision`/`BotDecider` (Task 4), `buildMessages` (Task 5), `callModel`/`ModelTimeoutError`/`ModelRefusalError` (Task 6), `toolsForPhase`/`searchArticles`/`resolveClassifyIndex`/`CONFIRM_RESOLUTION_TOOL_NAME` (Task 7), `resolveFallbackSubintent` (Task 3), `withWorkspace`/`Tx`.
- Produces: `export const toolLoopDecider: BotDecider`, `export const MAX_TOOL_CALLS_PER_TURN = 4`, `export const MAX_BOT_MESSAGES = 8`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.toolLoop.test.ts`. Mock `callModel` from `openaiClient.ts` per-test (`vi.mock('../src/domain/bot/openaiClient.ts', ...)`), and use the same workspace/conversation fixture helper `bot.contextAssembly.test.ts` used in Task 5:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallModel = vi.fn()
vi.mock('../src/domain/bot/openaiClient.ts', () => ({
  callModel: mockCallModel,
  ModelTimeoutError: class ModelTimeoutError extends Error {},
  ModelRefusalError: class ModelRefusalError extends Error {},
}))

import { toolLoopDecider, MAX_TOOL_CALLS_PER_TURN, MAX_BOT_MESSAGES } from '../src/domain/bot/toolLoop.ts'
// ...fixture imports as established in Task 5

describe('toolLoopDecider', () => {
  beforeEach(() => mockCallModel.mockReset())

  it('a greeting with no tool call produces one bot message, no classification, no event', async () => {
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'Hi! How can I help?' })
    const input = /* baseline BotTurnInput fixture, botMessageCount: 0, botPhase: 'none' */
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'answer', reply: 'Hi! How can I help?', subintentId: null })
  })

  it('search_articles then offer_article produces answer with articleId and would set article_confirm', async () => {
    // mock two sequential callModel responses: first a search_articles tool
    // call, then an offer_article tool call naming an id search returned
    // assert decision.kind === 'answer' && decision.articleId === <that id>
  })

  it('offer_article with an id not returned by search_articles this turn is rejected and the loop continues', async () => {
    // mock: offer_article names an id never searched, then (loop continues)
    // a plain text reply on the next call
    // assert the final decision is the plain-text answer, and mockCallModel
    // was called a second time (i.e. the bad offer did not exit the loop)
  })

  it('classify twice in one turn resolves once; the second call is ignored', async () => {
    // mock: classify(0), classify(1), then handoff('asked_for_person')
    // assert decision.subintentId === the FIRST resolved subintent id
  })

  it('handoff from a turn where classify was never called leaves subintentId null', async () => {
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"asked_for_person"}' }], text: null })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'handoff', reason: 'asked_for_person', subintentId: null })
  })

  it('confirm_resolution is absent from the tool set when bot_phase is none, present when article_confirm', async () => {
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok' })
    await toolLoopDecider({ ...input, botPhase: 'none' })
    const toolNames = mockCallModel.mock.calls[0][1].map((t: any) => t.function.name)
    expect(toolNames).not.toContain('confirm_resolution')
  })

  it('a model that calls search_articles forever stops at 4 tool calls and returns handoff(unsure)', async () => {
    mockCallModel.mockResolvedValue({ toolCalls: [{ id: 't', name: 'search_articles', arguments: '{"query":"x"}' }], text: null })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'handoff', reason: 'unsure', subintentId: null })
    // 4 calls to search_articles executed, no 5th model call
  })

  it('with 8 bot messages present, callModel is never called and the result is handoff(turn_cap)', async () => {
    const decision = await toolLoopDecider({ ...input, botMessageCount: MAX_BOT_MESSAGES })
    expect(decision).toEqual({ kind: 'handoff', reason: 'turn_cap', subintentId: null })
    expect(mockCallModel).not.toHaveBeenCalled()
  })

  it('a refusal produces invalid_response and is not retried (throws once, caller does not catch-and-retry internally)', async () => {
    const { ModelRefusalError } = await import('../src/domain/bot/openaiClient.ts')
    mockCallModel.mockRejectedValueOnce(new ModelRefusalError('nope'))
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' })
  })

  it('an unparseable tool argument produces invalid_response', async () => {
    mockCallModel.mockResolvedValueOnce({ toolCalls: [{ id: 't', name: 'classify', arguments: '{not json' }], text: null })
    const decision = await toolLoopDecider(input)
    expect(decision).toEqual({ kind: 'unavailable', reason: 'invalid_response' })
  })

  it('a network error throws rather than returning unavailable', async () => {
    mockCallModel.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(toolLoopDecider(input)).rejects.toThrow('ECONNRESET')
  })

  it('a timeout throws rather than returning unavailable', async () => {
    const { ModelTimeoutError } = await import('../src/domain/bot/openaiClient.ts')
    mockCallModel.mockRejectedValueOnce(new ModelTimeoutError())
    await expect(toolLoopDecider(input)).rejects.toThrow(ModelTimeoutError)
  })

  it('confirm_resolution(true) exits resolve; confirm_resolution(false) exits handoff(article_rejected)', async () => {
    // two sub-cases, phase 'article_confirm'
  })
})
```

Fill in the fixture (`input`) and the two commented sub-tests with real setup using this repo's actual conventions — do not leave placeholder comments in the committed file.

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter backend test bot.toolLoop.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `toolLoop.ts`**

```typescript
// backend/src/domain/bot/toolLoop.ts
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { BotDecider, BotTurnDecision, HandoffReason } from './botTurn.ts';
import { buildMessages, type ChatMessage } from './contextAssembly.ts';
import { callModel, ModelRefusalError, ModelTimeoutError } from './openaiClient.ts';
import {
  CONFIRM_RESOLUTION_TOOL_NAME,
  MAX_ARTICLES_PER_TURN,
  resolveClassifyIndex,
  searchArticles,
  toolsForPhase,
  type SearchArticlesResult,
} from './tools.ts';
import { resolveFallbackSubintent } from './fallbackSubintent.ts';

export const MAX_TOOL_CALLS_PER_TURN = 4;
export const MAX_BOT_MESSAGES = 8;

const MODEL_HANDOFF_REASONS: ReadonlySet<string> = new Set([
  'asked_for_person',
  'no_article',
  'sensitive',
]);

type ParsedToolCall = { id: string; name: string; args: Record<string, unknown> };

function parseToolCall(raw: { id: string; name: string; arguments: string }): ParsedToolCall {
  let args: unknown;
  try {
    args = JSON.parse(raw.arguments);
  } catch {
    throw new InvalidResponseError(`unparseable arguments for ${raw.name}`);
  }
  if (typeof args !== 'object' || args === null)
    throw new InvalidResponseError(`non-object arguments for ${raw.name}`);
  return { id: raw.id, name: raw.name, args: args as Record<string, unknown> };
}

class InvalidResponseError extends Error {}

/**
 * The real BotDecider (spec 4). Never writes — returns a BotTurnDecision for
 * applyBotTurn to write in one transaction. A throw here (network error,
 * timeout) propagates to BullMQ, which retries once; ModelRefusalError and an
 * unparseable tool argument map to `invalid_response` and are swallowed here
 * (not retried — a deterministic input that produced a refusal will produce
 * it again, per spec's Control flow section).
 */
export const toolLoopDecider: BotDecider = async (input) => {
  if (input.botMessageCount >= MAX_BOT_MESSAGES) {
    return { kind: 'handoff', reason: 'turn_cap', subintentId: null };
  }

  try {
    return await withWorkspace(input.workspaceId, async (tx) => {
      const { messages, subintentOptions } = await buildMessages(tx, input);

      let classifiedSubintentId = input.subintentId;
      let searchedArticleIds = new Set<string>();
      let searchCallCount = 0;
      let toolCallCount = 0;
      const conversationMessages: ChatMessage[] = [...messages];

      while (toolCallCount < MAX_TOOL_CALLS_PER_TURN) {
        const response = await callModel(conversationMessages, toolsForPhase(input.botPhase));

        if (response.toolCalls.length === 0) {
          return { kind: 'answer', reply: response.text ?? '', subintentId: classifiedSubintentId };
        }

        for (const raw of response.toolCalls) {
          if (toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
            return { kind: 'handoff', reason: 'unsure', subintentId: classifiedSubintentId };
          }
          toolCallCount++;

          const call = parseToolCall(raw);

          if (call.name === 'search_articles') {
            searchCallCount++;
            if (searchCallCount > MAX_ARTICLES_PER_TURN) {
              conversationMessages.push({
                role: 'user',
                content: `[search_articles limit reached this turn]`,
              });
              continue;
            }
            const query = call.args.query;
            if (typeof query !== 'string')
              throw new InvalidResponseError('search_articles missing query');
            const results: SearchArticlesResult = await searchArticles(
              tx,
              input.workspaceId,
              query,
            );
            for (const r of results) searchedArticleIds.add(r.id);
            conversationMessages.push({
              role: 'assistant',
              content: `[search_articles("${query}")]`,
            });
            conversationMessages.push({
              role: 'user',
              content: JSON.stringify(
                results.map((r) => ({ id: r.id, title: r.title, body: r.body })),
              ),
            });
            continue;
          }

          if (call.name === 'classify') {
            const index = call.args.subintent_index;
            if (typeof index !== 'number')
              throw new InvalidResponseError('classify missing subintent_index');
            if (classifiedSubintentId === null) {
              const resolved = resolveClassifyIndex(subintentOptions, index);
              classifiedSubintentId = resolved
                ? resolved.subintentId
                : await resolveFallbackSubintent(tx, input.workspaceId);
            }
            conversationMessages.push({ role: 'assistant', content: `[classify(${index})]` });
            conversationMessages.push({ role: 'user', content: '[acknowledged]' });
            continue;
          }

          if (call.name === 'offer_article') {
            const articleId = call.args.article_id;
            if (typeof articleId !== 'string')
              throw new InvalidResponseError('offer_article missing article_id');
            if (!searchedArticleIds.has(articleId)) {
              conversationMessages.push({
                role: 'assistant',
                content: `[offer_article(${articleId})]`,
              });
              conversationMessages.push({
                role: 'user',
                content: '[rejected: article_id was not returned by search_articles this turn]',
              });
              continue;
            }
            return {
              kind: 'answer',
              reply: `Here's an article that might help.`,
              subintentId: classifiedSubintentId,
              articleId,
            };
          }

          if (call.name === CONFIRM_RESOLUTION_TOOL_NAME) {
            const helped = call.args.helped;
            if (typeof helped !== 'boolean')
              throw new InvalidResponseError('confirm_resolution missing helped');
            return helped
              ? { kind: 'resolve', subintentId: classifiedSubintentId }
              : { kind: 'handoff', reason: 'article_rejected', subintentId: classifiedSubintentId };
          }

          if (call.name === 'handoff') {
            const reason = call.args.reason;
            if (typeof reason !== 'string' || !MODEL_HANDOFF_REASONS.has(reason))
              throw new InvalidResponseError('handoff missing/invalid reason');
            return {
              kind: 'handoff',
              reason: reason as HandoffReason,
              subintentId: classifiedSubintentId,
            };
          }

          throw new InvalidResponseError(`unknown tool ${call.name}`);
        }
      }

      return { kind: 'handoff', reason: 'unsure', subintentId: classifiedSubintentId };
    });
  } catch (err) {
    if (err instanceof ModelRefusalError || err instanceof InvalidResponseError) {
      return { kind: 'unavailable', reason: 'invalid_response' };
    }
    if (err instanceof ModelTimeoutError) throw err;
    throw err;
  }
};
```

- [ ] **Step 4: Run tests, verify they pass, iterating on the implementation as needed**

Run: `pnpm --filter backend test bot.toolLoop.test.ts`
Expected: PASS. If a specific assertion fails (e.g. message-append shape for search results doesn't matter to any test, but budget/short-circuit ordering does), adjust the implementation, not the test — every test above encodes a Verification bullet directly from the spec.

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/toolLoop.ts backend/tests/bot.toolLoop.test.ts
git commit -m "feat(bot): add toolLoopDecider — the real BotDecider"
```

---

### Task 9: `applyBotTurn.ts` — `resolve`, `bot_phase`, article events, `resolution_source`

**Files:**

- Modify: `backend/src/domain/bot/applyBotTurn.ts`
- Test: `backend/tests/bot.turnSeam.test.ts` (extend)
- Test: `backend/tests/bot.phase.test.ts` (create)

**Interfaces:**

- Consumes: `BotTurnDecision` (Task 4, now includes `resolve` and `answer.articleId`).
- Produces: `applyBotTurn` unchanged signature; writes `bot_phase = 'article_confirm'` when `answer.articleId` is set, `resolution_source = 'bot'` + `status = 'resolved'` + `bot_phase = 'none'` on `resolve`, and the two article events.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.phase.test.ts` (reuse the fixture helpers from `bot.turnSeam.test.ts`):

```typescript
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation } from '../src/shared/db/schema/index.ts'
// ...fixture helpers as in bot.turnSeam.test.ts

describe('applyBotTurn — resolve and article lifecycle', () => {
  it('answer with articleId sets bot_phase to article_confirm and writes bot_article_offered', async () => {
    const { workspaceId, conversationId } = await /* fixture: bot_active conversation */
    const events = await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'answer', reply: 'try this', subintentId: null, articleId: 'article-1' }),
    )
    const [row] = await withWorkspace(workspaceId, (tx) => tx.select({ phase: conversation.botPhase }).from(conversation).where(eq(conversation.id, conversationId)))
    expect(row.phase).toBe('article_confirm')
    // and assert an event of type 'bot_article_offered' with payload {article_id, article_title} was appended
  })

  it('confirm_resolution(true) resolves the conversation, writes conversation_resolved with source bot, sets bot_phase none', async () => {
    const { workspaceId, conversationId } = await /* fixture: bot_active, bot_phase article_confirm */
    await withWorkspace(workspaceId, (tx) => applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'resolve', subintentId: null }))
    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx.select({ status: conversation.status, phase: conversation.botPhase, source: conversation.resolutionSource }).from(conversation).where(eq(conversation.id, conversationId)),
    )
    expect(row).toEqual({ status: 'resolved', phase: 'none', source: 'bot' })
    // and assert conversation_resolved event with payload {source:'bot', confirmed_by:'player'}, and NO message posted
  })

  it('confirm_resolution(false) [i.e. handoff(article_rejected)] writes bot_article_rejected', async () => {
    // arrange, act via applyBotTurn with { kind: 'handoff', reason: 'article_rejected', subintentId: null }
    // assert a bot_article_rejected event was appended, in addition to the existing bot_handoff event
  })
})
```

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter backend test bot.phase.test.ts`
Expected: FAIL — `resolve` case not handled, `articleId` ignored.

- [ ] **Step 3: Implement the changes in `applyBotTurn.ts`**

```typescript
import { and, eq, isNull } from 'drizzle-orm';
import type { BotTurnDecision } from './botTurn.ts';
import { SILENT_UNAVAILABLE_REASONS } from './botTurn.ts';
import { botFailureNote, HANDOFF_PLAYER_MESSAGE } from './messages.ts';
import { assignOnHandoff } from './assignOnHandoff.ts';
import { postMessage, type PostedMessageRow } from '../conversations/postMessage.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { article, conversation, intent, subintent } from '../../shared/db/schema/index.ts';

export type ApplyBotTurnContext = { workspaceId: string; conversationId: string };
export type ApplyBotTurnResult = { posted: PostedMessageRow[]; statusChanged: boolean };

export async function applyBotTurn(
  tx: Tx,
  ctx: ApplyBotTurnContext,
  decision: BotTurnDecision,
): Promise<ApplyBotTurnResult> {
  switch (decision.kind) {
    case 'noop':
      return { posted: [], statusChanged: false };

    case 'answer': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'bot',
        actorId: null,
        body: decision.reply,
        visibility: 'public',
      });
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId);
      if (decision.articleId) {
        await tx
          .update(conversation)
          .set({ botPhase: 'article_confirm' })
          .where(eq(conversation.id, ctx.conversationId));
        const [row] = await tx
          .select({ title: article.title })
          .from(article)
          .where(eq(article.id, decision.articleId))
          .limit(1);
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'bot_article_offered',
          conversationId: ctx.conversationId,
          actorId: null,
          actorType: 'bot',
          payload: { article_id: decision.articleId, article_title: row?.title ?? null },
        });
      }
      return { posted: [posted], statusChanged: false };
    }

    case 'resolve': {
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId);
      await tx
        .update(conversation)
        .set({ status: 'resolved', botPhase: 'none', resolutionSource: 'bot' })
        .where(eq(conversation.id, ctx.conversationId));
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_resolved',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { source: 'bot', confirmed_by: 'player' },
      });
      return { posted: [], statusChanged: true };
    }

    case 'handoff': {
      const posted = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'system',
        actorId: null,
        body: HANDOFF_PLAYER_MESSAGE,
        visibility: 'public',
      });
      if (decision.subintentId) await classifyIfUnset(tx, ctx, decision.subintentId);
      const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId);
      await tx
        .update(conversation)
        .set({ status: 'open', botPhase: 'none', assignedAgentId })
        .where(eq(conversation.id, ctx.conversationId));
      if (decision.reason === 'article_rejected') {
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'bot_article_rejected',
          conversationId: ctx.conversationId,
          actorId: null,
          actorType: 'bot',
          payload: {},
        });
      }
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_handoff',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { reason: decision.reason, assigned_agent_id: assignedAgentId },
      });
      return { posted: [posted], statusChanged: true };
    }

    case 'unavailable': {
      const posted = [
        await postMessage(tx, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          authorType: 'system',
          actorId: null,
          body: HANDOFF_PLAYER_MESSAGE,
          visibility: 'public',
        }),
      ];
      if (!SILENT_UNAVAILABLE_REASONS.has(decision.reason)) {
        posted.push(
          await postMessage(tx, {
            workspaceId: ctx.workspaceId,
            conversationId: ctx.conversationId,
            authorType: 'system',
            actorId: null,
            body: botFailureNote(decision.reason),
            visibility: 'internal',
          }),
        );
      }
      const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId);
      await tx
        .update(conversation)
        .set({ status: 'open', botPhase: 'none', assignedAgentId })
        .where(eq(conversation.id, ctx.conversationId));
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_unavailable',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { reason: decision.reason },
      });
      return { posted, statusChanged: true };
    }
  }
}

async function classifyIfUnset(
  tx: Tx,
  ctx: ApplyBotTurnContext,
  subintentId: string,
): Promise<void> {
  const updated = await tx
    .update(conversation)
    .set({ subintentId, classificationSource: 'bot' })
    .where(and(eq(conversation.id, ctx.conversationId), isNull(conversation.subintentId)))
    .returning({ id: conversation.id });

  if (updated.length === 0) return;

  const [names] = await tx
    .select({ subintentName: subintent.name, intentName: intent.name })
    .from(subintent)
    .innerJoin(intent, eq(intent.id, subintent.intentId))
    .where(eq(subintent.id, subintentId))
    .limit(1);

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'intent_set',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: {
      source: 'bot',
      subintent_name: names?.subintentName ?? null,
      intent_name: names?.intentName ?? null,
    },
  });
}
```

Note: `handoff` and `unavailable` now also reset `botPhase: 'none'` on the way out of `bot_active` — the conversation is leaving the bot entirely, so a stale `article_confirm` phase must not survive into a future bot-active window (there is none, `bot_active` is one-way — spec §10 — but resetting it here is cheap defensive consistency, not required to pass any spec-listed test; keep it, since a bare `bot_phase` state on an `open` conversation would be a confusing artifact for anyone reading the row directly).

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter backend test bot.phase.test.ts bot.turnSeam.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/applyBotTurn.ts backend/tests/bot.phase.test.ts
git commit -m "feat(bot): applyBotTurn resolve outcome, bot_phase writes, article lifecycle events"
```

---

### Task 10: Wire `toolLoopDecider` in as the real decider

**Files:**

- Modify: `backend/src/domain/bot/orchestrator.ts`
- Modify: `backend/src/domain/bot/botTurn.ts` (delete `stubDecider`, `SILENT_UNAVAILABLE_REASONS` stays)
- Modify: `backend/src/domain/bot/messages.ts`
- Modify: `backend/src/shared/jobs/botTurns.ts`
- Modify: `backend/src/domain/bot/index.ts`
- Test: `backend/tests/jobs.botTurns.test.ts` (update)
- Test: `backend/tests/bot.orchestrator.test.ts` (update)

**Interfaces:**

- Consumes: `toolLoopDecider` (Task 8).
- Produces: `gather()` in `orchestrator.ts` returns `botPhase`, `botMessageCount`, `lastPlayerMessageAt` alongside the existing `status`/`subintentId`; `registerBotTurnWorker`'s default decider is `toolLoopDecider`, not `stubDecider`.

- [ ] **Step 1: Extend `gather()` in `orchestrator.ts`**

```typescript
import { asc, desc, eq, sql } from 'drizzle-orm';
// ...

type GatherResult = {
  status: string;
  subintentId: string | null;
  botPhase: 'none' | 'article_confirm';
} | null;

async function gather(
  tx: Tx,
  conversationId: string,
): Promise<{
  conv: GatherResult;
  history: PlayerMessageView[];
  botMessageCount: number;
  lastPlayerMessageAt: Date | null;
}> {
  const [conv] = await tx
    .select({
      status: conversation.status,
      subintentId: conversation.subintentId,
      botPhase: conversation.botPhase,
    })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);

  const rows: PostedMessageRow[] = await tx
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq));

  const history = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null);
  const botMessageCount = rows.filter((r) => r.authorType === 'bot').length;
  const lastPlayer = rows.filter((r) => r.authorType === 'player').at(-1);

  return {
    conv: conv ?? null,
    history,
    botMessageCount,
    lastPlayerMessageAt: lastPlayer?.createdAt ?? null,
  };
}
```

Update `runBotTurn` to pass the new fields through:

```typescript
export async function runBotTurn(
  workspaceId: string,
  conversationId: string,
  decider: BotDecider,
): Promise<void> {
  const { conv, history, botMessageCount, lastPlayerMessageAt } = await withWorkspace(
    workspaceId,
    (tx) => gather(tx, conversationId),
  );

  if (!conv || conv.status !== 'bot_active') return;

  const decision = await decider({
    workspaceId,
    conversationId,
    subintentId: conv.subintentId,
    botPhase: conv.botPhase,
    botMessageCount,
    lastPlayerMessageAt,
    history,
  });

  await applyDecisionIfBotActive(workspaceId, conversationId, decision);
}
```

- [ ] **Step 2: Update `bot.orchestrator.test.ts`**

Wherever the test constructs an expected decider-input object or asserts on the decider's call arguments, add `botPhase`, `botMessageCount`, `lastPlayerMessageAt` to match the new shape. Read the file first to find every such assertion (grep `subintentId:` in that file) and update each one consistently.

- [ ] **Step 3: Delete `stubDecider`**

In `backend/src/domain/bot/botTurn.ts`, remove:

```typescript
export const stubDecider: BotDecider = async () => ({ kind: 'unavailable', reason: 'error' });
```

Keep `SILENT_UNAVAILABLE_REASONS` (still consumed by `applyBotTurn.ts`).

- [ ] **Step 4: Swap the default decider in `botTurns.ts`**

```typescript
import { applyDecisionIfBotActive, runBotTurn } from '../../domain/bot/orchestrator.ts'
import { toolLoopDecider } from '../../domain/bot/toolLoop.ts'
import type { BotDecider } from '../../domain/bot/botTurn.ts'

// ...

export function registerBotTurnWorker(decider: BotDecider = toolLoopDecider): { close: () => Promise<void> } {
```

- [ ] **Step 5: Update `jobs.botTurns.test.ts`**

Read the file's existing "worker executes the decider" test. It currently constructs its own stub decider and passes it explicitly to `registerBotTurnWorker(stub)` (per the survey: "a stubbed answering model produces a bot message and the conversation stays bot_active") — that pattern is unaffected by the default changing, since the test supplies its own decider. Grep the file for any reference to the now-deleted `stubDecider` import and remove/replace it if present; otherwise no change is needed beyond a typecheck pass.

- [ ] **Step 6: Export new modules from `index.ts`**

```typescript
export * from './botTurn.ts';
export * from './applyBotTurn.ts';
export * from './orchestrator.ts';
export * from './assignOnHandoff.ts';
export * from './messages.ts';
export * from './defaultPrompt.ts';
export * from './botConfig.ts';
export * from './contextAssembly.ts';
export * from './openaiClient.ts';
export * from './tools.ts';
export * from './toolLoop.ts';
export * from './fallbackSubintent.ts';
```

(Match whatever export style — `export *` vs named re-exports — the current `index.ts` already uses; keep it consistent rather than mixing styles.)

- [ ] **Step 7: Full typecheck and targeted test run**

Run: `pnpm --filter backend typecheck`
Expected: PASS — confirms nothing else in the backend still references `stubDecider`.

Run: `pnpm --filter backend test bot.orchestrator.test.ts jobs.botTurns.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/domain/bot/orchestrator.ts backend/src/domain/bot/botTurn.ts backend/src/shared/jobs/botTurns.ts backend/src/domain/bot/index.ts backend/tests/bot.orchestrator.test.ts backend/tests/jobs.botTurns.test.ts
git commit -m "feat(bot): wire toolLoopDecider in as the default BotDecider; delete stubDecider"
```

---

### Task 11: Reopen — `HANDOFF_PLAYER_MESSAGE`, §10 assignment, `resolution_source`

**Files:**

- Modify: `backend/src/surface/services/messagesService.ts`
- Test: `backend/tests/bot.reopen.test.ts` (create)

**Interfaces:**

- Consumes: `HANDOFF_PLAYER_MESSAGE` (`messages.ts`), `assignOnHandoff` (`assignOnHandoff.ts`), `agent.status` (`identity.ts` schema).
- Produces: reopen from `resolved`/`closed` posts `HANDOFF_PLAYER_MESSAGE`, assigns per §10, writes `conversation_reopened` with `previous_resolution_source`, and clears `resolution_source`. `awaiting_player → open` is untouched (no message).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/bot.reopen.test.ts` (reuse `sendPlayerMessage`'s existing test fixtures — check `backend/tests/bot.messages.test.ts` or the surface router's own test file for the player-context fixture helper already in use, and reuse it):

```typescript
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { sendPlayerMessage } from '../src/surface/services/messagesService.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, agent } from '../src/shared/db/schema/index.ts'
// ...fixture helpers

describe('reopen', () => {
  it('reopen from resolved posts HANDOFF_PLAYER_MESSAGE and lands on open, never bot_active', async () => {
    const { ctx, conversationId } = await /* fixture: conversation resolved, resolutionSource 'bot' */
    await sendPlayerMessage(ctx, { body: 'hello again' })
    const [row] = await withWorkspace(ctx.workspaceId, (tx) => tx.select({ status: conversation.status }).from(conversation).where(eq(conversation.id, conversationId)))
    expect(row.status).toBe('open')
    // and assert a message with body === HANDOFF_PLAYER_MESSAGE was posted
  })

  it('awaiting_player -> open posts no system message', async () => {
    const { ctx } = await /* fixture: conversation awaiting_player */
    const before = await /* count messages */
    await sendPlayerMessage(ctx, { body: 'reply' })
    const after = await /* count messages */
    expect(after).toBe(before + 1) // only the player's own message
  })

  it('a bot-resolved conversation reopens to assignOnHandoff (no previous owner to keep)', async () => {
    const { ctx, conversationId } = await /* fixture: resolved, resolutionSource 'bot', assignedAgentId null, an active agent exists in the workspace */
    await sendPlayerMessage(ctx, { body: 'hi' })
    const [row] = await withWorkspace(ctx.workspaceId, (tx) => tx.select({ assignedAgentId: conversation.assignedAgentId }).from(conversation).where(eq(conversation.id, conversationId)))
    expect(row.assignedAgentId).not.toBeNull()
  })

  it('an agent-resolved conversation with an active previous owner keeps them', async () => {
    const { ctx, conversationId, previousOwnerId } = await /* fixture: resolved, resolutionSource 'agent', assignedAgentId = previousOwnerId, that agent status active */
    await sendPlayerMessage(ctx, { body: 'hi' })
    const [row] = await withWorkspace(ctx.workspaceId, (tx) => tx.select({ assignedAgentId: conversation.assignedAgentId }).from(conversation).where(eq(conversation.id, conversationId)))
    expect(row.assignedAgentId).toBe(previousOwnerId)
  })

  it('an agent-resolved conversation with a deactivated previous owner falls back to assignOnHandoff', async () => {
    const { ctx, conversationId, deactivatedOwnerId } = await /* fixture: resolved, resolutionSource 'agent', assignedAgentId = deactivatedOwnerId, that agent status deactivated, another active agent exists */
    await sendPlayerMessage(ctx, { body: 'hi' })
    const [row] = await withWorkspace(ctx.workspaceId, (tx) => tx.select({ assignedAgentId: conversation.assignedAgentId }).from(conversation).where(eq(conversation.id, conversationId)))
    expect(row.assignedAgentId).not.toBe(deactivatedOwnerId)
  })

  it('conversation_reopened carries the correct previous_resolution_source', async () => {
    const { ctx, conversationId } = await /* fixture: resolved, resolutionSource 'bot' */
    await sendPlayerMessage(ctx, { body: 'hi' })
    // assert the appended conversation_reopened event's payload === { previous_resolution_source: 'bot' }
  })
})
```

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter backend test bot.reopen.test.ts`
Expected: FAIL — no `HANDOFF_PLAYER_MESSAGE` posted, no assignment logic, no `previous_resolution_source` payload.

- [ ] **Step 3: Implement the reopen branch in `messagesService.ts`**

```typescript
import { postMessage, toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { applyBotTurn, resolveBotConfig } from '../../domain/bot/index.ts'
import { assignOnHandoff, HANDOFF_PLAYER_MESSAGE } from '../../domain/bot/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { agent, conversation, message, session } from '../../shared/db/schema/index.ts'
// ...

// inside the existing `if (!existing) { ... } else { ... }` block, replace the
// REOPENABLE_STATUSES branch:

      if (REOPENABLE_STATUSES.has(existing.status)) {
        const [prior] = await tx
          .select({ assignedAgentId: conversation.assignedAgentId, resolutionSource: conversation.resolutionSource })
          .from(conversation)
          .where(eq(conversation.id, conversationId))
          .limit(1)

        let nextAssignedAgentId: string | null = null
        if (prior?.resolutionSource === 'agent' && prior.assignedAgentId) {
          const [previousOwner] = await tx.select({ status: agent.status }).from(agent).where(eq(agent.id, prior.assignedAgentId)).limit(1)
          nextAssignedAgentId = previousOwner?.status === 'active' ? prior.assignedAgentId : await assignOnHandoff(tx, ctx.workspaceId)
        } else {
          // Bot-resolved (never assigned to anyone), or no resolution_source
          // recorded at all (a `closed` conversation with no bot/agent
          // resolve event behind it — defensive, not expected once this
          // slice ships) — both take the same path.
          nextAssignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
        }

        await tx
          .update(conversation)
          .set({ status: 'open', assignedAgentId: nextAssignedAgentId, resolutionSource: null })
          .where(eq(conversation.id, conversationId))

        const reopenPosted = await postMessage(tx, {
          workspaceId: ctx.workspaceId,
          conversationId,
          authorType: 'system',
          actorId: null,
          body: HANDOFF_PLAYER_MESSAGE,
          visibility: 'public',
        })

        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'conversation_reopened',
          conversationId,
          sessionId,
          actorId: ctx.playerId,
          actorType: 'player',
          payload: { previous_resolution_source: prior?.resolutionSource ?? null },
        })
        inboxStatus = 'open'
      } else if (existing.status === 'awaiting_player') {
```

Note: the reopen system message (`HANDOFF_PLAYER_MESSAGE`) is now posted from inside this function directly, ahead of the player's own message that follows below in the existing code — check the returned/emitted shape: `sendPlayerMessage` currently only emits+returns the _player's_ posted message. The reopen's system message also needs a socket emit. Extend the function's return/apply shape to carry an optional second posted row:

```typescript
return { conversationId, posted, reopenPosted, inboxStatus, shouldEnqueue };
```

(add `let reopenPosted: PostedMessageRow | undefined` alongside the existing `let inboxStatus` declaration, set it in the reopen branch above), and after the existing `emitMessageToRooms(getIo(), result.conversationId, playerView, agentView)` call in the outer function body:

```typescript
if (result.reopenPosted) {
  emitMessageToRooms(
    getIo(),
    result.conversationId,
    toPlayerView(result.reopenPosted),
    toAgentView(result.reopenPosted),
  );
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm --filter backend test bot.reopen.test.ts`
Expected: PASS

Run the full surface message test suite too, since this function's shape changed: `pnpm --filter backend test messagesService`

- [ ] **Step 5: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/tests/bot.reopen.test.ts
git commit -m "feat(bot): reopen posts handoff message and assigns per spec §10"
```

---

### Task 12: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run the full backend test suite**

Run: `pnpm --filter backend test`
Expected: PASS. Postgres must be up (`pnpm dev` or the compose service) per this repo's own `pnpm test` note.

- [ ] **Step 3: Confirm no stray references to removed symbols**

Run: `grep -rn "not_implemented\|stubDecider\|reason: 'model'" backend/src backend/tests`
Expected: no output.

- [ ] **Step 4: Confirm the seed script still runs clean end-to-end**

Run: `pnpm db:setup && pnpm db:seed`
Expected: exits 0, logs include the `Other` seeding (or at least no error) and the existing taxonomy summary line.

- [ ] **Step 5: Update `docs/decisions/spec-contradictions.md` if the `resolution_source` column decision should be recorded there**

Spec 4's own "Deviations" section lists only the pre-existing least-loaded-assignment deviation and calls `bot_phase` an addition, not a contradiction. `resolution_source` is a genuinely new column not named anywhere in the spec text (it exists to resolve the ambiguity Task 9/11 hit). Add one line to `docs/decisions/spec-contradictions.md`'s "Additions" list (matching that file's existing format) noting `conversation.resolution_source` joins the schema, written by the `resolve` outcome and read on reopen.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/spec-contradictions.md
git commit -m "docs: record conversation.resolution_source as a schema addition"
```

---

## Deferred by the spec itself (do not build in this slice)

Per spec's "Out of scope" table: forms (`skip_form`, form builder), the 24h inactivity/resolution-cycle worker, LangChain/LangGraph, streaming, LLM-summarized history, per-workspace model choice/spend caps, and tuning of budgets/`alpha`/temperature/model as anything other than constants and env vars.
