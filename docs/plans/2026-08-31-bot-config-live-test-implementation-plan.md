# Bot Config live test panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent live-test chat panel to the agent-console Bot Config page, where an admin can play a player and get real bot replies — run through the actual `toolLoopDecider`, against the config currently in the form (unsaved edits included) — with per-reply tool activity (searches, citation, grounding, handoff reason) shown, and nothing persisted to the database.

**Architecture:** Backend gains a small, backward-compatible seam (`BotTurnOverrides`) that lets `toolLoopDecider`/`buildMessages` take an in-memory config and transcript instead of reading them from Postgres, plus a new `POST /agent/bot-config/test-turn` endpoint built on that seam. Frontend gains a `BotConfigDraftContext` so the three existing config tabs (which today hold their edit state locally) can share their live draft with a new `BotTestPanel`, itself built from the existing `features/chat` components (`ChatThread`, `Composer`, `MessageBody`) rather than duplicating chat UI.

**Tech Stack:** Express 5 + TypeScript + Zod (backend), Drizzle ORM, Vitest; React + TanStack Query + Tailwind v4 (frontend), Vitest + @testing-library/react.

## Global Constraints

- No hard deletes, no writes to `conversation`/`message`/`event` for this feature — it must be provably read-only against those tables (spec: "Persistence").
- Backend endpoint is Admin-role only, same guard as `POST /agent/bot-config` (spec: "Backend › New endpoint").
- Every new endpoint is registered in `backend/src/docs/openapi.ts` (repo-wide rule, `app/CLAUDE.md`).
- Tailwind v4 utilities only, styled against the shared `--color-*` token names so components re-theme per surface — no hand-written CSS (repo-wide rule).
- `features/chat/**` components are reused as-is, not forked; `surfaces/webview/**` components are never imported from the agent-console surface (spec: "Frontend › Component reuse").
- `player_level`/`spend_tier` are out of scope — they are inert in production today and the test panel does not build UI for them (spec: "Known gap").

---

## Task 1: Backend seam — `BotTurnOverrides` on the decider

**Files:**
- Modify: `backend/src/domain/bot/botTurn.ts`
- Modify: `backend/src/domain/bot/contextAssembly.ts`
- Modify: `backend/src/domain/bot/toolLoop.ts`
- Modify: `backend/src/domain/bot/botConfig.ts`
- Test: `backend/tests/bot.toolLoop.overrides.test.ts`

**Interfaces:**
- Produces: `BotTurnOverrides` type (`{ config?: ResolvedBotConfig; transcript?: { role: ChatRole; body: string }[] }`), exported from `botTurn.ts`. `BotDecider` becomes `(input: BotTurnInput, overrides?: BotTurnOverrides) => Promise<BotTurnDecision>`. `buildMessages(tx, input, overrides?)` and `toolLoopDecider(input, overrides?)` both accept it, both default to today's DB-read behavior when omitted. `resolved(...)` (in `botConfig.ts`) becomes exported, unchanged signature — `(isProvisioned: boolean, prompt: string, rules: RuleEntry[], toolsConfig: ToolToggle[], limitsConfig: LimitToggle[]) => ResolvedBotConfig`.
- Consumes: nothing new from earlier tasks (this is the first task).

This task changes nothing about production behavior — `orchestrator.ts` calls `decider(input)` with no second argument, so `overrides` is always `undefined` there and every branch below falls through to the exact code that runs today.

- [ ] **Step 1: Add `BotTurnOverrides` type and widen `BotDecider` in `botTurn.ts`**

Find this block (the file's `HandoffReason`/`UnavailableReason`/`BotSearchRecord`/`BotTurnDecision` types are just above it):

```ts
export type BotTurnInput = {
  workspaceId: string;
  conversationId: string;
  subintentId: string | null;
  confirmPhase: ConfirmPhaseValue;
  botMessageCount: number;
  unhelpedReplyCount: number;
  lastPlayerMessageAt: Date | null;
  history: PlayerMessageView[];
};
```

Add directly after it:

```ts
export type BotTurnOverrides = {
  /** Bypasses the DB read in buildMessages — the draft config a caller wants tested, not what's persisted. */
  config?: ResolvedBotConfig;
  /** Bypasses the DB transcript read in buildMessages — the caller's own synthetic history. */
  transcript?: { role: ChatRole; body: string }[];
};
```

Add these two type-only imports at the top of the file (alongside the existing imports):

```ts
import type { ResolvedBotConfig } from './botConfig.ts';
import type { ChatRole } from './contextAssembly.ts';
```

Then find:

```ts
export type BotDecider = (input: BotTurnInput) => Promise<BotTurnDecision>;
```

Replace with:

```ts
export type BotDecider = (
  input: BotTurnInput,
  overrides?: BotTurnOverrides,
) => Promise<BotTurnDecision>;
```

Also widen the `answer` branch of `BotTurnOutcome` to optionally carry the grounding score, so a caller (the test-turn endpoint, Task 4) can report it without recomputing it. Find:

```ts
type BotTurnOutcome =
  | { kind: 'noop' }
  | { kind: 'answer'; reply: string; subintentId: string | null; articleId?: string }
  | { kind: 'resolve'; subintentId: string | null }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason }
  | { kind: 'confirm_player_resolution'; subintentId: string | null; quotedText: string };
```

Replace with:

```ts
type BotTurnOutcome =
  | { kind: 'noop' }
  | {
      kind: 'answer';
      reply: string;
      subintentId: string | null;
      articleId?: string;
      /** Only set when articleId is — the score computed for that citation. The production path only ever logs this; carried on the decision so a caller like the bot-config test-turn endpoint can report it without rescoring. */
      grounding?: { score: number; ungrounded: string[] };
    }
  | { kind: 'resolve'; subintentId: string | null }
  | { kind: 'handoff'; reason: HandoffReason; subintentId: string | null }
  | { kind: 'unavailable'; reason: UnavailableReason }
  | { kind: 'confirm_player_resolution'; subintentId: string | null; quotedText: string };
```

- [ ] **Step 2: Export `resolved` from `botConfig.ts`**

Find:

```ts
function resolved(
```

Replace with:

```ts
export function resolved(
```

(No other change — same file, same body, same call site inside `resolveBotConfig`.)

- [ ] **Step 3: Thread `overrides` through `buildMessages` in `contextAssembly.ts`**

Find the import line:

```ts
import type { BotTurnInput } from './botTurn.ts';
```

Replace with:

```ts
import type { BotTurnInput, BotTurnOverrides } from './botTurn.ts';
```

Find:

```ts
export async function buildMessages(tx: Tx, input: BotTurnInput): Promise<BuildMessagesResult> {
  const config = await resolveBotConfig(tx, input.workspaceId);
```

Replace with:

```ts
export async function buildMessages(
  tx: Tx,
  input: BotTurnInput,
  overrides?: BotTurnOverrides,
): Promise<BuildMessagesResult> {
  const config = overrides?.config ?? (await resolveBotConfig(tx, input.workspaceId));
```

Find:

```ts
  const rows = await tx
    .select()
    .from(message)
    .where(eq(message.conversationId, input.conversationId))
    .orderBy(asc(message.seq));

  const transcript = rows
    .filter((r) => r.visibility === 'public')
    .map((r) => ({ role: toChatRole(r.authorType), body: r.body }))
    .filter((m): m is { role: ChatRole; body: string } => m.role !== null);
```

Replace with:

```ts
  const transcript =
    overrides?.transcript ??
    (
      await tx
        .select()
        .from(message)
        .where(eq(message.conversationId, input.conversationId))
        .orderBy(asc(message.seq))
    )
      .filter((r) => r.visibility === 'public')
      .map((r) => ({ role: toChatRole(r.authorType), body: r.body }))
      .filter((m): m is { role: ChatRole; body: string } => m.role !== null);
```

- [ ] **Step 4: Thread `overrides` through `toolLoopDecider` in `toolLoop.ts`**

Find:

```ts
export const toolLoopDecider: BotDecider = async (input) => {
  // Declared outside the try so the catch below can still attach whatever
  // retrieval happened before the model refused or returned something
  // unparseable. A turn that searched and *then* failed is the case where
  // knowing what it searched for matters most.
  const searches: BotSearchRecord[] = [];

  try {
    const decision = await withWorkspace(
      input.workspaceId,
      async (tx): Promise<BotTurnDecision> => {
        const { messages, subintentOptions, enabledTools, resolvedLimits } = await buildMessages(
          tx,
          input,
        );
```

Replace with:

```ts
export const toolLoopDecider: BotDecider = async (input, overrides) => {
  // Declared outside the try so the catch below can still attach whatever
  // retrieval happened before the model refused or returned something
  // unparseable. A turn that searched and *then* failed is the case where
  // knowing what it searched for matters most.
  const searches: BotSearchRecord[] = [];

  try {
    const decision = await withWorkspace(
      input.workspaceId,
      async (tx): Promise<BotTurnDecision> => {
        const { messages, subintentOptions, enabledTools, resolvedLimits } = await buildMessages(
          tx,
          input,
          overrides,
        );
```

Find the grounded-answer return (further down the same function):

```ts
              logger.info('bot.grounding', 'answered from article', {
                workspaceId: input.workspaceId,
                conversationId: input.conversationId,
                articleId,
                articleTitle: cited.title,
                score: Number(grounding.score.toFixed(2)),
              });
              return { kind: 'answer', reply, subintentId: classifiedSubintentId, articleId };
```

Replace with:

```ts
              logger.info('bot.grounding', 'answered from article', {
                workspaceId: input.workspaceId,
                conversationId: input.conversationId,
                articleId,
                articleTitle: cited.title,
                score: Number(grounding.score.toFixed(2)),
              });
              return {
                kind: 'answer',
                reply,
                subintentId: classifiedSubintentId,
                articleId,
                grounding: {
                  score: Number(grounding.score.toFixed(2)),
                  ungrounded: grounding.ungrounded,
                },
              };
```

- [ ] **Step 5: Write the failing test for the override seam**

Create `backend/tests/bot.toolLoop.overrides.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallModel, mockSearchArticleIds } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockSearchArticleIds: vi.fn(),
}));

vi.mock('../src/domain/bot/openaiClient.ts', () => ({
  callModel: mockCallModel,
  ModelTimeoutError: class ModelTimeoutError extends Error {},
  ModelRefusalError: class ModelRefusalError extends Error {},
}));

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  searchArticleIds: mockSearchArticleIds,
}));

import { closeDb } from '../src/shared/db/client.ts';
import type { BotTurnInput } from '../src/domain/bot/botTurn.ts';
import { toolLoopDecider } from '../src/domain/bot/toolLoop.ts';
import { resolved } from '../src/domain/bot/botConfig.ts';
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);
beforeEach(() => {
  mockCallModel.mockReset();
  mockSearchArticleIds.mockReset();
  mockSearchArticleIds.mockResolvedValue([]);
});

function baseInput(workspaceId: string, conversationId: string): BotTurnInput {
  return {
    workspaceId,
    conversationId,
    subintentId: null,
    confirmPhase: 'none',
    botMessageCount: 0,
    unhelpedReplyCount: 0,
    lastPlayerMessageAt: null,
    history: [],
  };
}

describe('toolLoopDecider with overrides', () => {
  it('answers from an overridden prompt that a persisted config could never produce, and never queries the message table', async () => {
    const workspaceId = await seedWorkspace();
    // A conversation id with no row anywhere — proves buildMessages never
    // reaches the DB for transcript or config when both are overridden.
    const conversationId = '00000000-0000-0000-0000-000000000000';

    mockCallModel.mockResolvedValueOnce({
      toolCalls: [],
      text: 'MARKER_FROM_OVERRIDDEN_PROMPT',
    });

    const config = resolved(
      true,
      'You always reply with exactly: MARKER_FROM_OVERRIDDEN_PROMPT',
      [],
      [],
      [
        { key: 'max_bot_messages', value: 8 },
        { key: 'max_tool_calls_per_turn', value: 6 },
        { key: 'max_articles_per_turn', value: 3 },
        { key: 'max_unhelped_replies', value: 3 },
      ],
    );

    const decision = await toolLoopDecider(baseInput(workspaceId, conversationId), {
      config,
      transcript: [{ role: 'user', body: 'hello' }],
    });

    expect(decision).toMatchObject({ kind: 'answer', reply: 'MARKER_FROM_OVERRIDDEN_PROMPT' });
  });

  it('falls back to the persisted config and DB transcript when overrides is omitted, unchanged from today', async () => {
    const workspaceId = await seedWorkspace();
    const conversationId = '00000000-0000-0000-0000-000000000001';

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'default path reply' });

    const decision = await toolLoopDecider(baseInput(workspaceId, conversationId));

    expect(decision).toMatchObject({ kind: 'answer', reply: 'default path reply' });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails, then passes**

Run: `pnpm --filter backend exec vitest run tests/bot.toolLoop.overrides.test.ts`

Before Steps 1–4: FAIL (`toolLoopDecider` rejects the second argument / TS error, or the overridden prompt is ignored and the mocked model reply is whatever `resolveBotConfig`'s default prompt would drive).

After Steps 1–4: PASS.

- [ ] **Step 7: Run the full backend bot test suite to confirm no regressions**

Run: `pnpm --filter backend exec vitest run tests/bot.toolLoop.test.ts tests/bot.toolLoop.determinism.test.ts tests/bot.orchestrator.test.ts tests/bot.contextAssembly.test.ts tests/bot.config.test.ts`

Expected: all PASS, unchanged from before this task (overrides is optional and unused by every existing caller).

- [ ] **Step 8: Commit**

```bash
git add backend/src/domain/bot/botTurn.ts backend/src/domain/bot/contextAssembly.ts backend/src/domain/bot/toolLoop.ts backend/src/domain/bot/botConfig.ts backend/tests/bot.toolLoop.overrides.test.ts
git commit -m "Add BotTurnOverrides seam so the decider can run against an in-memory config/transcript"
```

---

## Task 2: Shared types — `TestBotTurnBody` and the wire decision shape

**Files:**
- Modify: `packages/types/src/bot.ts`

**Interfaces:**
- Consumes: `RuleEntrySchema`, `ToolToggleSchema`, `LimitToggleSchema` (already exported from this file, used unchanged).
- Produces: `TestBotTurnBody` (Zod schema), `TestBotTurnBodyValue` (`z.infer`), `BotTestTurnDecision` (TS type — the wire/snake_case mirror of the backend's internal `BotTurnDecision`), consumed by Task 4 (backend service) and Task 8 (frontend API client).

- [ ] **Step 1: Add the request schema and response type**

Append to `packages/types/src/bot.ts` (after the existing `SaveBotConfigBody` export):

```ts
export const TestBotTurnBody = z
  .object({
    config: z.object({
      prompt: z.string().min(1),
      rules: z.array(RuleEntrySchema),
      tools_config: z.array(ToolToggleSchema),
      limits_config: z.array(LimitToggleSchema),
    }),
    subintent_id: z.string().nullable(),
    confirm_phase: z.enum([
      'none',
      'bot_article',
      'agent_ask',
      'form',
      'inactivity_ask',
      'player_stated',
    ]),
    history: z.array(
      z.object({
        author_type: z.enum(['player', 'bot']),
        body: z.string(),
      }),
    ),
    player_message: z.string().min(1),
  })
  .strict();

export type TestBotTurnBodyValue = z.infer<typeof TestBotTurnBody>;

export type BotTestTurnHandoffReason =
  | 'asked_for_person'
  | 'article_rejected'
  | 'no_article'
  | 'sensitive'
  | 'unsure'
  | 'turn_cap'
  | 'unhelped_cap';

export type BotTestTurnUnavailableReason = 'not_provisioned' | 'error' | 'timeout' | 'invalid_response';

export type BotTestTurnSearch = { query: string; results: { id: string; title: string }[] };

export type BotTestTurnDecision = (
  | { kind: 'noop' }
  | {
      kind: 'answer';
      reply: string;
      subintent_id: string | null;
      article_id?: string;
      grounding?: { score: number; ungrounded: string[] };
    }
  | { kind: 'resolve'; subintent_id: string | null }
  | { kind: 'handoff'; reason: BotTestTurnHandoffReason; subintent_id: string | null }
  | { kind: 'unavailable'; reason: BotTestTurnUnavailableReason }
  | { kind: 'confirm_player_resolution'; subintent_id: string | null; quoted_text: string }
) & { searches?: BotTestTurnSearch[] };
```

- [ ] **Step 2: Typecheck the package**

Run: `pnpm --filter @support/types typecheck`

Expected: PASS — this step only adds exports, nothing consumes them yet.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/bot.ts
git commit -m "Add TestBotTurnBody schema and BotTestTurnDecision wire type"
```

---

## Task 3: Backend service — `runTestBotTurn`

**Files:**
- Create: `backend/src/domain/bot/botTestTurn.ts`
- Test: `backend/tests/botTestTurn.test.ts`

**Interfaces:**
- Consumes: `resolved` (Task 1, `botConfig.ts`), `toolLoopDecider`/`BotTurnOverrides`/`BotTurnInput`/`BotTurnDecision` (Task 1, `botTurn.ts`/`toolLoop.ts`), `ChatRole` (`contextAssembly.ts`), `AgentContext` (`shared/middleware/requireAgentSession.ts`), `TestBotTurnBodyValue`/`BotTestTurnDecision` (Task 2, `@support/types`), `PlayerMessageView` (`@support/types`, pre-existing).
- Produces: `runTestBotTurn(ctx: AgentContext, body: TestBotTurnBodyValue): Promise<BotTestTurnDecision>`, consumed by Task 5 (controller).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/botTestTurn.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallModel, mockSearchArticleIds } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockSearchArticleIds: vi.fn(),
}));

vi.mock('../src/domain/bot/openaiClient.ts', () => ({
  callModel: mockCallModel,
  ModelTimeoutError: class ModelTimeoutError extends Error {},
  ModelRefusalError: class ModelRefusalError extends Error {},
}));

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  searchArticleIds: mockSearchArticleIds,
}));

import { closeDb } from '../src/shared/db/client.ts';
import { runTestBotTurn } from '../src/domain/bot/botTestTurn.ts';
import type { TestBotTurnBodyValue } from '@support/types';
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);
beforeEach(() => {
  mockCallModel.mockReset();
  mockSearchArticleIds.mockReset();
  mockSearchArticleIds.mockResolvedValue([]);
});

function baseBody(overrides: Partial<TestBotTurnBodyValue> = {}): TestBotTurnBodyValue {
  return {
    config: {
      prompt: 'You are a test bot. {{subintents}} {{articles}}',
      rules: [],
      tools_config: [
        { tool: 'search_articles', enabled: true },
        { tool: 'classify', enabled: true },
        { tool: 'answer_from_article', enabled: true },
        { tool: 'confirm_resolution', enabled: true },
        { tool: 'player_declared_resolved', enabled: true },
      ],
      limits_config: [
        { key: 'max_bot_messages', value: 8 },
        { key: 'max_tool_calls_per_turn', value: 6 },
        { key: 'max_articles_per_turn', value: 3 },
        { key: 'max_unhelped_replies', value: 3 },
      ],
    },
    subintent_id: null,
    confirm_phase: 'none',
    history: [],
    player_message: 'Hello',
    ...overrides,
  };
}

describe('runTestBotTurn', () => {
  it('answers using the draft config, not any persisted row', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'draft answer' });

    const decision = await runTestBotTurn(
      { agentId, workspaceId, isAdmin: true },
      baseBody(),
    );

    expect(decision).toMatchObject({ kind: 'answer', reply: 'draft answer' });
  });

  it('writes no rows to conversation, message, or event', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'draft answer' });

    await runTestBotTurn({ agentId, workspaceId, isAdmin: true }, baseBody());

    const counts = await ownerPool.query<{ table_name: string; n: string }>(
      `select 'conversation' as table_name, count(*)::text as n from conversation where workspace_id = $1
       union all
       select 'message', count(*)::text from message m join conversation c on c.id = m.conversation_id where c.workspace_id = $1
       union all
       select 'event', count(*)::text from event where workspace_id = $1`,
      [workspaceId],
    );
    for (const row of counts.rows) {
      expect(Number(row.n), `${row.table_name} should have 0 rows`).toBe(0);
    }
  });

  it('carries prior turns from history into the model transcript, oldest first', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(workspaceId);

    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'ok' });

    await runTestBotTurn(
      { agentId, workspaceId, isAdmin: true },
      baseBody({
        history: [
          { author_type: 'player', body: 'first message' },
          { author_type: 'bot', body: 'first reply' },
        ],
        player_message: 'second message',
      }),
    );

    const [, conversationMessages] = mockCallModel.mock.calls[0]!;
    const bodies = conversationMessages.map((m: { content: string }) => m.content);
    expect(bodies).toContain('first message');
    expect(bodies).toContain('first reply');
    expect(bodies).toContain('second message');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter backend exec vitest run tests/botTestTurn.test.ts`

Expected: FAIL — `Cannot find module '../src/domain/bot/botTestTurn.ts'`.

- [ ] **Step 3: Write `backend/src/domain/bot/botTestTurn.ts`**

```ts
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { resolved } from './botConfig.ts';
import { toolLoopDecider } from './toolLoop.ts';
import type { ChatRole } from './contextAssembly.ts';
import type { BotTurnDecision, BotTurnInput } from './botTurn.ts';
import type { BotTestTurnDecision, PlayerMessageView, TestBotTurnBodyValue } from '@support/types';

/**
 * A conversation id no real conversation ever has. buildMessages' DB reads
 * for it — transcript, player state — return nothing, which the pipeline
 * already treats as "no history"/"no known player state", not an error.
 */
const TEST_TURN_CONVERSATION_ID = '00000000-0000-0000-0000-000000000000';

function syntheticPlayerMessageView(
  authorType: 'player' | 'bot',
  body: string,
  seq: number,
): PlayerMessageView {
  return {
    id: `test-${seq}`,
    seq,
    author_type: authorType,
    body,
    delivery_state: 'read',
    read_at: null,
    created_at: new Date().toISOString(),
    article_id: null,
    attachment: null,
  };
}

export async function runTestBotTurn(
  ctx: AgentContext,
  body: TestBotTurnBodyValue,
): Promise<BotTestTurnDecision> {
  const config = resolved(
    true,
    body.config.prompt,
    body.config.rules,
    body.config.tools_config,
    body.config.limits_config,
  );

  const transcript: { role: ChatRole; body: string }[] = [
    ...body.history.map((m) => ({
      role: (m.author_type === 'player' ? 'user' : 'assistant') as ChatRole,
      body: m.body,
    })),
    { role: 'user' as ChatRole, body: body.player_message },
  ];

  const history: PlayerMessageView[] = [
    ...body.history.map((m, i) => syntheticPlayerMessageView(m.author_type, m.body, i)),
    syntheticPlayerMessageView('player', body.player_message, body.history.length),
  ];

  const botMessageCount = body.history.filter((m) => m.author_type === 'bot').length;

  const input: BotTurnInput = {
    workspaceId: ctx.workspaceId,
    conversationId: TEST_TURN_CONVERSATION_ID,
    subintentId: body.subintent_id,
    confirmPhase: body.confirm_phase,
    botMessageCount,
    // No conversation_resolved event can exist for a conversation that was
    // never created, so every bot message this turn counts toward the
    // unhelped cap the same way it counts toward the message cap.
    unhelpedReplyCount: botMessageCount,
    lastPlayerMessageAt: new Date(),
    history,
  };

  const decision = await toolLoopDecider(input, { config, transcript });
  return toWireDecision(decision);
}

function toWireDecision(decision: BotTurnDecision): BotTestTurnDecision {
  const base: Omit<BotTestTurnDecision, 'searches'> = (() => {
    switch (decision.kind) {
      case 'noop':
        return { kind: 'noop' };
      case 'answer':
        return {
          kind: 'answer',
          reply: decision.reply,
          subintent_id: decision.subintentId,
          ...(decision.articleId !== undefined ? { article_id: decision.articleId } : {}),
          ...(decision.grounding !== undefined ? { grounding: decision.grounding } : {}),
        };
      case 'resolve':
        return { kind: 'resolve', subintent_id: decision.subintentId };
      case 'handoff':
        return { kind: 'handoff', reason: decision.reason, subintent_id: decision.subintentId };
      case 'unavailable':
        return { kind: 'unavailable', reason: decision.reason };
      case 'confirm_player_resolution':
        return {
          kind: 'confirm_player_resolution',
          subintent_id: decision.subintentId,
          quoted_text: decision.quotedText,
        };
    }
  })();
  return decision.searches
    ? { ...base, searches: decision.searches.map((s) => ({ query: s.query, results: s.results })) }
    : base;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter backend exec vitest run tests/botTestTurn.test.ts`

Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/bot/botTestTurn.ts backend/tests/botTestTurn.test.ts
git commit -m "Add runTestBotTurn service — draft-config bot turn with no DB writes"
```

---

## Task 4: Backend endpoint — route, controller, openapi

**Files:**
- Create: `backend/src/agent/controllers/botTestTurnController.ts`
- Modify: `backend/src/agent/routers/botConfigRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.botTestTurn.test.ts`

**Interfaces:**
- Consumes: `runTestBotTurn` (Task 3), `TestBotTurnBody` (Task 2), `requireAdminRole` (existing middleware), `sendError` (existing `errors.ts`).
- Produces: `POST /agent/bot-config/test-turn` — `200 { decision: BotTestTurnDecision }`, `403` (not admin), `422` (invalid payload).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/agent.botTestTurn.test.ts`, modeled on `backend/tests/agent.botConfig.test.ts`'s standalone-app pattern (an agent-router integration test hitting the real Express app), plus `bot.toolLoop.test.ts`'s `vi.mock` of `openaiClient.ts`/`articlesIndex.ts` so no real model or Weaviate call happens:

```ts
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallModel, mockSearchArticleIds } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockSearchArticleIds: vi.fn(),
}));

vi.mock('../src/domain/bot/openaiClient.ts', () => ({
  callModel: mockCallModel,
  ModelTimeoutError: class ModelTimeoutError extends Error {},
  ModelRefusalError: class ModelRefusalError extends Error {},
}));

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  searchArticleIds: mockSearchArticleIds,
}));

import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { botConfigRouter } from '../src/agent/routers/botConfigRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';
import type { TestBotTurnBodyValue } from '@support/types';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, botConfigRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);
beforeEach(() => {
  mockCallModel.mockReset();
  mockSearchArticleIds.mockReset();
  mockSearchArticleIds.mockResolvedValue([]);
});

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name, is_admin) values ($1, 'Test Agent', $2) returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`, role === 'admin'],
  );
  const agentId = rows[0]!.id;
  if (role !== 'admin') {
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
      [workspaceId, agentId, role],
    );
  }
  const token = await signAgentSession({ agent_id: agentId, is_admin: role === 'admin' });
  return { agentId, token };
}

function baseBody(overrides: Partial<TestBotTurnBodyValue> = {}): TestBotTurnBodyValue {
  return {
    config: {
      prompt: 'You are a test bot. {{subintents}} {{articles}}',
      rules: [],
      tools_config: [
        { tool: 'search_articles', enabled: true },
        { tool: 'classify', enabled: true },
        { tool: 'answer_from_article', enabled: true },
        { tool: 'confirm_resolution', enabled: true },
        { tool: 'player_declared_resolved', enabled: true },
      ],
      limits_config: [
        { key: 'max_bot_messages', value: 8 },
        { key: 'max_tool_calls_per_turn', value: 6 },
        { key: 'max_articles_per_turn', value: 3 },
        { key: 'max_unhelped_replies', value: 3 },
      ],
    },
    subintent_id: null,
    confirm_phase: 'none',
    history: [],
    player_message: 'Hello',
    ...overrides,
  };
}

describe('POST /bot-config/test-turn', () => {
  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .post('/bot-config/test-turn')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send(baseBody())
      .expect(403);
  });

  it('returns 422 for a payload missing player_message', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const { player_message: _omit, ...invalid } = baseBody();

    await request(app)
      .post('/bot-config/test-turn')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send(invalid)
      .expect(422);
  });

  it('returns 200 with a decision for a valid payload', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    mockCallModel.mockResolvedValueOnce({ toolCalls: [], text: 'draft answer' });

    const res = await request(app)
      .post('/bot-config/test-turn')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send(baseBody())
      .expect(200);

    expect(res.body.decision).toMatchObject({ kind: 'answer', reply: 'draft answer' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter backend exec vitest run tests/agent.botTestTurn.test.ts`

Expected: FAIL — `404` (route doesn't exist yet).

- [ ] **Step 3: Write the controller**

Create `backend/src/agent/controllers/botTestTurnController.ts`:

```ts
import type { RequestHandler } from 'express';
import { sendError } from '../../errors.ts';
import { TestBotTurnBody } from '@support/types';
import { runTestBotTurn } from '../../domain/bot/botTestTurn.ts';

export const testBotTurnHandler: RequestHandler = async (req, res) => {
  const body = TestBotTurnBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid test-turn payload.');
    return;
  }

  const decision = await runTestBotTurn(req.agent!, body.data);
  res.status(200).json({ decision });
};
```

- [ ] **Step 4: Wire the route**

In `backend/src/agent/routers/botConfigRouter.ts`, find:

```ts
import {
  getBotConfigHandler,
  getBotConfigVersionHandler,
  getBotConfigVersionsHandler,
  rollbackBotConfigHandler,
  saveBotConfigHandler,
} from '../controllers/botConfigController.ts';
```

Replace with:

```ts
import {
  getBotConfigHandler,
  getBotConfigVersionHandler,
  getBotConfigVersionsHandler,
  rollbackBotConfigHandler,
  saveBotConfigHandler,
} from '../controllers/botConfigController.ts';
import { testBotTurnHandler } from '../controllers/botTestTurnController.ts';
```

Find:

```ts
botConfigRouter.post('/bot-config/rollback', requireAdminRole, rollbackBotConfigHandler);
```

Replace with:

```ts
botConfigRouter.post('/bot-config/rollback', requireAdminRole, rollbackBotConfigHandler);
// Admin-only, same reasoning as save: this executes arbitrary draft prompt
// text supplied in the request body, not merely a persisted, already-vetted
// config.
botConfigRouter.post('/bot-config/test-turn', requireAdminRole, testBotTurnHandler);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter backend exec vitest run tests/agent.botTestTurn.test.ts`

Expected: PASS.

- [ ] **Step 6: Register the endpoint in openapi.ts**

In `backend/src/docs/openapi.ts`, find the closing of the `/agent/bot-config/rollback` registration (immediately follows the pattern already shown for `/agent/bot-config` POST) and add a new `registry.registerPath` block after it:

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/bot-config/test-turn',
  summary: 'Agent Test Bot Turn',
  description:
    'Runs one bot turn through the real decider against a draft config supplied in the request body — never the persisted bot_config row — and a synthetic, non-persisted conversation. Writes nothing to conversation, message, or event. Used by the Bot Config admin UI to preview behavior before saving. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            config: z.object({
              prompt: z.string(),
              rules: z.array(
                z.object({
                  key: z.string(),
                  text: z.string(),
                  enabled: z.boolean(),
                  locked: z.boolean(),
                  source: z.enum(['builtin', 'custom']),
                }),
              ),
              tools_config: z.array(z.object({ tool: z.string(), enabled: z.boolean() })),
              limits_config: z.array(z.object({ key: z.string(), value: z.number().int().positive() })),
            }),
            subintent_id: z.string().nullable(),
            confirm_phase: z.enum([
              'none',
              'bot_article',
              'agent_ask',
              'form',
              'inactivity_ask',
              'player_stated',
            ]),
            history: z.array(
              z.object({
                author_type: z.enum(['player', 'bot']),
                body: z.string(),
              }),
            ),
            player_message: z.string().openapi({ example: 'How do I reset my password?' }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'The decision the bot made this turn, plus any searches it ran' },
    403: { description: 'Forbidden — admin role required' },
    422: { description: 'Invalid test-turn payload' },
  },
});
```

- [ ] **Step 7: Verify the docs build**

Run: `pnpm --filter backend dev` briefly and open `http://localhost:4000/docs/json`, or run whatever existing script/test asserts the OpenAPI document generates without throwing (check for a `docs` or `openapi` test in `backend/tests/` first — if one exists, run it instead of starting the dev server).

Expected: no throw; the new path appears under `/agent/bot-config/test-turn`.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/controllers/botTestTurnController.ts backend/src/agent/routers/botConfigRouter.ts backend/src/docs/openapi.ts backend/tests/agent.botTestTurn.test.ts
git commit -m "Add POST /agent/bot-config/test-turn endpoint"
```

---

## Task 5: Frontend — `BotConfigDraftContext`

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/BotConfig/BotConfigDraftContext.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/BotConfig.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/BotConfigDraftContext.test.tsx`

**Interfaces:**
- Produces: `BotConfigDraftProvider` (wraps children, takes `config: BotConfigView | undefined`), `useBotConfigDraft()` returning `{ draft: BotConfigDraft | null; setDraftField: <K extends keyof BotConfigDraft>(field: K, value: BotConfigDraft[K]) => void }`, and `BotConfigDraft = { prompt: string; rules: RuleEntryValue[]; toolsConfig: ToolToggleValue[]; limitsConfig: LimitToggleValue[] }`. Consumed by Task 7 (`BotTestPanel`).
- Consumes: `BotConfigView` (`@support/types`, pre-existing).

Each tab already owns local edit state (`prompt`/`rules`/`toolsConfig`/`limitsConfig`) with its own save mutation, unchanged by this task — this only adds a one-line `useEffect` per tab that mirrors that local state into the shared context, so a panel outside the active tab can read it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/BotConfig/BotConfigDraftContext.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BotConfigDraftProvider, useBotConfigDraft } from './BotConfigDraftContext.tsx';
import type { BotConfigView } from '@support/types';

function baseConfig(): BotConfigView {
  return {
    is_provisioned: true,
    prompt: 'base prompt',
    rules: [],
    tools_config: [],
    enabled_tools: [],
    limits_config: [],
    resolved_limits: {
      max_bot_messages: 8,
      max_tool_calls_per_turn: 6,
      max_articles_per_turn: 3,
      max_unhelped_replies: 3,
    },
    system_prompt: 'base prompt',
    is_prompt_customized: false,
    is_rules_customized: false,
    is_tools_customized: false,
    is_limits_customized: false,
    updated_at: null,
  };
}

function DraftReader() {
  const { draft } = useBotConfigDraft();
  return <span>{draft?.prompt ?? 'none'}</span>;
}

describe('BotConfigDraftContext', () => {
  it('seeds the draft from the loaded config once it arrives', async () => {
    render(
      <BotConfigDraftProvider config={baseConfig()}>
        <DraftReader />
      </BotConfigDraftProvider>,
    );
    expect(await screen.findByText('base prompt')).toBeInTheDocument();
  });

  it('has no draft yet while config is undefined', () => {
    render(
      <BotConfigDraftProvider config={undefined}>
        <DraftReader />
      </BotConfigDraftProvider>,
    );
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend exec vitest run src/surfaces/agent-console/pages/BotConfig/BotConfigDraftContext.test.tsx`

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `BotConfigDraftContext.tsx`**

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BotConfigView, LimitToggleValue, RuleEntryValue, ToolToggleValue } from '@support/types';

export type BotConfigDraft = {
  prompt: string;
  rules: RuleEntryValue[];
  toolsConfig: ToolToggleValue[];
  limitsConfig: LimitToggleValue[];
};

type BotConfigDraftContextValue = {
  draft: BotConfigDraft | null;
  setDraftField: <K extends keyof BotConfigDraft>(field: K, value: BotConfigDraft[K]) => void;
};

const BotConfigDraftContext = createContext<BotConfigDraftContextValue | null>(null);

/**
 * Seeded once from the loaded config, then only ever updated by the tabs'
 * own useEffects below — never re-seeded from `config` again, so a save on
 * one tab (which refetches `config`) doesn't clobber unsaved edits a admin
 * is mid-typing on another tab.
 */
export function BotConfigDraftProvider({
  config,
  children,
}: {
  config: BotConfigView | undefined;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<BotConfigDraft | null>(null);

  useEffect(() => {
    if (config && draft === null) {
      setDraft({
        prompt: config.prompt,
        rules: config.rules,
        toolsConfig: config.tools_config,
        limitsConfig: config.limits_config,
      });
    }
  }, [config, draft]);

  const setDraftField = useCallback(
    <K extends keyof BotConfigDraft>(field: K, value: BotConfigDraft[K]) => {
      setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
    },
    [],
  );

  return (
    <BotConfigDraftContext.Provider value={{ draft, setDraftField }}>
      {children}
    </BotConfigDraftContext.Provider>
  );
}

export function useBotConfigDraft(): BotConfigDraftContextValue {
  const ctx = useContext(BotConfigDraftContext);
  if (!ctx) throw new Error('useBotConfigDraft must be used within BotConfigDraftProvider');
  return ctx;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend exec vitest run src/surfaces/agent-console/pages/BotConfig/BotConfigDraftContext.test.tsx`

Expected: PASS.

- [ ] **Step 5: Wire the provider into `BotConfig.tsx`**

Find:

```tsx
import { useQuery } from '@tanstack/react-query';
import { fetchBotConfig } from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx';
import { PromptTab } from './components/PromptTab.tsx';
import { RulesTab } from './components/RulesTab.tsx';
import { ToolsTab } from './components/ToolsTab.tsx';
import { VersionHistoryTab } from './components/VersionHistoryTab.tsx';

export function BotConfig() {
  const session = loadAgentSession();

  const configQuery = useQuery({
    queryKey: ['bot-config'],
    queryFn: () => fetchBotConfig(session!.token),
    enabled: session !== null,
  });

  if (!session) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Bot Config</span>
      </div>
      <Tabs defaultValue="prompt" className="min-h-0 flex-1 gap-0 p-3">
        <TabsList>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="prompt" className="min-h-0 overflow-auto pt-3">
          <PromptTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="rules" className="min-h-0 overflow-auto pt-3">
          <RulesTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="tools" className="min-h-0 overflow-auto pt-3">
          <ToolsTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="history" className="min-h-0 overflow-auto pt-3">
          <VersionHistoryTab token={session.token} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

Replace with:

```tsx
import { useQuery } from '@tanstack/react-query';
import { fetchBotConfig } from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx';
import { PromptTab } from './components/PromptTab.tsx';
import { RulesTab } from './components/RulesTab.tsx';
import { ToolsTab } from './components/ToolsTab.tsx';
import { VersionHistoryTab } from './components/VersionHistoryTab.tsx';
import { BotConfigDraftProvider } from './BotConfigDraftContext.tsx';
import { BotTestPanel } from './components/BotTestPanel.tsx';

export function BotConfig() {
  const session = loadAgentSession();

  const configQuery = useQuery({
    queryKey: ['bot-config'],
    queryFn: () => fetchBotConfig(session!.token),
    enabled: session !== null,
  });

  if (!session) return null;

  return (
    <BotConfigDraftProvider config={configQuery.data}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-slate-200 p-3">
          <span className="text-sm font-semibold">Bot Config</span>
        </div>
        <div className="flex min-h-0 flex-1">
          <Tabs defaultValue="prompt" className="min-h-0 min-w-0 flex-1 gap-0 p-3">
            <TabsList>
              <TabsTrigger value="prompt">Prompt</TabsTrigger>
              <TabsTrigger value="rules">Rules</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="prompt" className="min-h-0 overflow-auto pt-3">
              <PromptTab token={session.token} config={configQuery.data} />
            </TabsContent>
            <TabsContent value="rules" className="min-h-0 overflow-auto pt-3">
              <RulesTab token={session.token} config={configQuery.data} />
            </TabsContent>
            <TabsContent value="tools" className="min-h-0 overflow-auto pt-3">
              <ToolsTab token={session.token} config={configQuery.data} />
            </TabsContent>
            <TabsContent value="history" className="min-h-0 overflow-auto pt-3">
              <VersionHistoryTab token={session.token} />
            </TabsContent>
          </Tabs>
          <div className="w-96 shrink-0 border-l border-slate-200">
            <BotTestPanel token={session.token} />
          </div>
        </div>
      </div>
    </BotConfigDraftProvider>
  );
}
```

(`BotTestPanel` is created in Task 7 — this file will not compile until that task lands. That's expected within this plan's sequencing; Task 5's own test above doesn't touch `BotConfig.tsx`, so it isn't blocked by this forward reference. Run the frontend typecheck at the end of Task 7, not here.)

- [ ] **Step 6: Wire `PromptTab.tsx` into the draft context**

Find:

```tsx
import { useEffect, useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { Textarea } from '../../../components/ui/textarea.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';

export function PromptTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(config?.prompt ?? '');
```

Replace with:

```tsx
import { useEffect, useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { Textarea } from '../../../components/ui/textarea.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';

export function PromptTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const { setDraftField } = useBotConfigDraft();
  const [prompt, setPrompt] = useState(config?.prompt ?? '');

  useEffect(() => {
    setDraftField('prompt', prompt);
  }, [prompt, setDraftField]);
```

- [ ] **Step 7: Wire `RulesTab.tsx` into the draft context**

Find:

```tsx
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView, RuleEntryView } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
```

Replace with:

```tsx
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView, RuleEntryView } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';
```

Find:

```tsx
export function RulesTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const [newRuleText, setNewRuleText] = useState('');
  const [rules, setRules] = useState<RuleEntryView[]>(config?.rules ?? []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  useEffect(() => {
    if (config) setRules(config.rules);
  }, [config?.rules]);
```

Replace with:

```tsx
export function RulesTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const { setDraftField } = useBotConfigDraft();
  const [newRuleText, setNewRuleText] = useState('');
  const [rules, setRules] = useState<RuleEntryView[]>(config?.rules ?? []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  useEffect(() => {
    if (config) setRules(config.rules);
  }, [config?.rules]);

  useEffect(() => {
    setDraftField('rules', rules.map(stripView));
  }, [rules, setDraftField]);
```

(`stripView` is the function already defined at the top of this file — it drops the derived `enforcement` field, which is exactly the shape the test-turn endpoint's `rules` needs, matching what this file already does before every save.)

- [ ] **Step 8: Wire `ToolsTab.tsx` into the draft context**

Find:

```tsx
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView, LimitToggleValue, ToolToggleValue } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
```

Replace with:

```tsx
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BotConfigView, LimitToggleValue, ToolToggleValue } from '@support/types';
import { saveBotConfig } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Switch } from '../../../components/ui/switch.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';
```

Find:

```tsx
export function ToolsTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const [toolsConfig, setToolsConfig] = useState<ToolToggleValue[]>(config?.tools_config ?? []);
  const [limitsConfig, setLimitsConfig] = useState<LimitToggleValue[]>(config?.limits_config ?? []);
  const [toolsConfirmOpen, setToolsConfirmOpen] = useState(false);
  const [limitsConfirmOpen, setLimitsConfirmOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  useEffect(() => {
    if (config) setToolsConfig(config.tools_config);
  }, [config?.tools_config]);

  useEffect(() => {
    if (config) setLimitsConfig(config.limits_config);
  }, [config?.limits_config]);
```

Replace with:

```tsx
export function ToolsTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient();
  const { setDraftField } = useBotConfigDraft();
  const [toolsConfig, setToolsConfig] = useState<ToolToggleValue[]>(config?.tools_config ?? []);
  const [limitsConfig, setLimitsConfig] = useState<LimitToggleValue[]>(config?.limits_config ?? []);
  const [toolsConfirmOpen, setToolsConfirmOpen] = useState(false);
  const [limitsConfirmOpen, setLimitsConfirmOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] });

  useEffect(() => {
    if (config) setToolsConfig(config.tools_config);
  }, [config?.tools_config]);

  useEffect(() => {
    if (config) setLimitsConfig(config.limits_config);
  }, [config?.limits_config]);

  useEffect(() => {
    setDraftField('toolsConfig', toolsConfig);
  }, [toolsConfig, setDraftField]);

  useEffect(() => {
    setDraftField('limitsConfig', limitsConfig);
  }, [limitsConfig, setDraftField]);
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/BotConfigDraftContext.tsx frontend/src/surfaces/agent-console/pages/BotConfig/BotConfigDraftContext.test.tsx frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.tsx frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.tsx frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.tsx
git commit -m "Share live config draft across Bot Config tabs via BotConfigDraftContext"
```

(`BotConfig.tsx` is intentionally left uncommitted here — Step 5's edit references `BotTestPanel`, which doesn't exist until Task 7. Stage it together with Task 7's commit instead.)

---

## Task 6: Frontend — API client function

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**
- Consumes: `call<T>(path, token, init?)` (existing wrapper in this file), `TestBotTurnBodyValue`/`BotTestTurnDecision` (Task 2, `@support/types`).
- Produces: `testBotTurn(token: string, body: TestBotTurnBodyValue): Promise<{ decision: BotTestTurnDecision }>`, consumed by Task 7.

- [ ] **Step 1: Add the function**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, find the existing `saveBotConfig` export (it sits near `fetchBotConfig`) and add `testBotTurn` immediately after it, matching its exact call style:

```ts
export function testBotTurn(
  token: string,
  body: TestBotTurnBodyValue,
): Promise<{ decision: BotTestTurnDecision }> {
  return call('/agent/bot-config/test-turn', token, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
```

Add `TestBotTurnBodyValue` and `BotTestTurnDecision` to this file's existing `@support/types` import line (find the line importing `BotConfigView`/`SaveBotConfigBodyValue`/etc from `@support/types` and add these two names to it).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter frontend typecheck`

Expected: PASS (nothing calls `testBotTurn` yet, but the function itself must compile against `call`'s generic signature).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Add testBotTurn API client function"
```

---

## Task 7: Frontend — `ToolActivityStrip`

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolActivityStrip.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolActivityStrip.test.tsx`

**Interfaces:**
- Consumes: `BotTestTurnDecision` (Task 2, `@support/types`).
- Produces: `ToolActivityStrip({ decision }: { decision: BotTestTurnDecision })`, consumed by Task 8 (`BotTestPanel`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolActivityStrip.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolActivityStrip } from './ToolActivityStrip.tsx';
import type { BotTestTurnDecision } from '@support/types';

describe('ToolActivityStrip', () => {
  it('shows the cited article and grounding score for a grounded answer', () => {
    const decision: BotTestTurnDecision = {
      kind: 'answer',
      reply: 'Go to settings and tap reset.',
      subintent_id: null,
      article_id: 'art-1',
      grounding: { score: 0.95, ungrounded: [] },
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText(/art-1/)).toBeInTheDocument();
    expect(screen.getByText(/95%/)).toBeInTheDocument();
  });

  it('shows an answer with no citation as unsourced', () => {
    const decision: BotTestTurnDecision = {
      kind: 'answer',
      reply: 'Sure!',
      subintent_id: null,
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText('Answered without a citation')).toBeInTheDocument();
  });

  it('renders a plain-language reason for a handoff', () => {
    const decision: BotTestTurnDecision = {
      kind: 'handoff',
      reason: 'unhelped_cap',
      subintent_id: null,
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText('Gave up after too many unhelpful replies')).toBeInTheDocument();
  });

  it('renders an error state for an unavailable decision', () => {
    const decision: BotTestTurnDecision = { kind: 'unavailable', reason: 'timeout' };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText(/timeout/)).toBeInTheDocument();
  });

  it('renders searches when present, regardless of kind', () => {
    const decision: BotTestTurnDecision = {
      kind: 'handoff',
      reason: 'no_article',
      subintent_id: null,
      searches: [{ query: 'refund', results: [{ id: 'a1', title: 'Refund policy' }] }],
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText(/refund/)).toBeInTheDocument();
    expect(screen.getByText(/Refund policy/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend exec vitest run src/surfaces/agent-console/pages/BotConfig/components/ToolActivityStrip.test.tsx`

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `ToolActivityStrip.tsx`**

```tsx
import type { BotTestTurnDecision } from '@support/types';

const HANDOFF_COPY: Record<string, string> = {
  asked_for_person: 'Player asked for a human',
  article_rejected: 'Player said the cited article did not help',
  no_article: 'No article answered the question',
  sensitive: 'Flagged as sensitive — handed off without searching',
  unsure: 'Ran out of tool-call budget this turn',
  turn_cap: 'Hit the max-bot-messages limit for this conversation',
  unhelped_cap: 'Gave up after too many unhelpful replies',
};

const UNAVAILABLE_COPY: Record<string, string> = {
  not_provisioned: 'Bot is not provisioned for this workspace',
  error: 'The model call failed',
  timeout: 'The model call timed out',
  invalid_response: 'The model returned neither a tool call nor any text',
};

export function ToolActivityStrip({ decision }: { decision: BotTestTurnDecision }) {
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-md border border-muted/20 bg-accent-soft/50 p-2 text-xs text-muted">
      {decision.kind === 'answer' &&
        (decision.article_id ? (
          <p>
            Cited article <span className="font-mono">{decision.article_id}</span>
            {decision.grounding && (
              <>
                {' '}
                — grounding {Math.round(decision.grounding.score * 100)}%
                {decision.grounding.ungrounded.length > 0 && (
                  <> (ungrounded: {decision.grounding.ungrounded.join(', ')})</>
                )}
              </>
            )}
          </p>
        ) : (
          <p>Answered without a citation</p>
        ))}
      {decision.kind === 'resolve' && <p>Marked resolved</p>}
      {decision.kind === 'handoff' && <p>{HANDOFF_COPY[decision.reason]}</p>}
      {decision.kind === 'confirm_player_resolution' && (
        <p>Confirming the player&apos;s own words: &quot;{decision.quoted_text}&quot;</p>
      )}
      {decision.kind === 'unavailable' && (
        <p className="border-l-2 border-red-500 pl-2 text-red-600">
          Unavailable — {UNAVAILABLE_COPY[decision.reason]}
        </p>
      )}
      {decision.searches?.map((s, i) => (
        <p key={i} className="pl-2">
          Searched: <span className="font-mono">{s.query}</span> → {s.results.length} result
          {s.results.length === 1 ? '' : 's'}
          {s.results.length > 0 && <> ({s.results.map((r) => r.title).join(', ')})</>}
        </p>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend exec vitest run src/surfaces/agent-console/pages/BotConfig/components/ToolActivityStrip.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolActivityStrip.tsx frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolActivityStrip.test.tsx
git commit -m "Add ToolActivityStrip for the bot test panel"
```

---

## Task 8: Frontend — `BotTestPanel`

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx`

**Interfaces:**
- Consumes: `useBotConfigDraft` (Task 5), `testBotTurn` (Task 6), `ToolActivityStrip` (Task 7), `ChatThread`/`Composer`/`MessageBody`-family types (`ChatMessage`, `ChatAuthorType`) from `features/chat/components/types.ts` and `ChatThread`/`Composer` components (pre-existing, unmodified), `fetchIntents` (pre-existing, `agentApi.ts`).
- Produces: `BotTestPanel({ token }: { token: string })`, consumed by `BotConfig.tsx` (wired in Task 5, Step 5 — this task supplies the file that reference needs).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx`. It needs the same jsdom/Virtuoso shims as `frontend/src/features/chat/components/ChatThread.test.tsx`, copied verbatim, since `BotTestPanel` renders `ChatThread` internally. Mock `testBotTurn` and `fetchIntents` from `../../../api/agentApi.ts` with `vi.mock`, and wrap the render in `BotConfigDraftProvider` with a seeded config:

```tsx
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BotTestPanel } from './BotTestPanel.tsx';
import { BotConfigDraftProvider } from '../BotConfigDraftContext.tsx';
import type { BotConfigView } from '@support/types';

// jsdom never lays out real pixels and the global ResizeObserver stub never
// calls back, so Virtuoso's viewport measurement always reads 0 and it mounts
// no items. Give elements a non-zero size and fire the observer once so
// Virtuoso's measurement effect actually runs. Copied verbatim from
// frontend/src/features/chat/components/ChatThread.test.tsx — BotTestPanel
// renders ChatThread and needs the identical shim to mount any message.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  Element.prototype.getBoundingClientRect = () =>
    ({
      width: 600,
      height: 600,
      top: 0,
      left: 0,
      right: 600,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

vi.mock('../../../api/agentApi.ts', () => ({
  testBotTurn: vi.fn(),
  fetchIntents: vi.fn().mockResolvedValue({ intents: [] }),
}));

import { testBotTurn } from '../../../api/agentApi.ts';

function baseConfig(): BotConfigView {
  return {
    is_provisioned: true,
    prompt: 'base prompt',
    rules: [],
    tools_config: [],
    enabled_tools: [],
    limits_config: [],
    resolved_limits: {
      max_bot_messages: 8,
      max_tool_calls_per_turn: 6,
      max_articles_per_turn: 3,
      max_unhelped_replies: 3,
    },
    system_prompt: 'base prompt',
    is_prompt_customized: false,
    is_rules_customized: false,
    is_tools_customized: false,
    is_limits_customized: false,
    updated_at: null,
  };
}

function renderPanel() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <BotConfigDraftProvider config={baseConfig()}>
        <BotTestPanel token="test-token" />
      </BotConfigDraftProvider>
    </QueryClientProvider>,
  );
}

describe('BotTestPanel', () => {
  beforeEach(() => {
    vi.mocked(testBotTurn).mockReset();
  });

  it('sends the typed message plus the draft config, and renders the bot reply', async () => {
    vi.mocked(testBotTurn).mockResolvedValueOnce({
      decision: { kind: 'answer', reply: 'Here you go', subintent_id: null },
    });

    renderPanel();
    const input = await screen.findByLabelText('Message');
    await userEvent.type(input, 'How do I reset my password?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(testBotTurn).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(testBotTurn).mock.calls[0]!;
    expect(body.config.prompt).toBe('base prompt');
    expect(body.player_message).toBe('How do I reset my password?');

    expect(await screen.findByText('Here you go')).toBeInTheDocument();
  });

  it('shows an error card when the request fails', async () => {
    vi.mocked(testBotTurn).mockRejectedValueOnce(new Error('network error'));

    renderPanel();
    const input = await screen.findByLabelText('Message');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/Test turn failed/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend exec vitest run src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx`

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write `BotTestPanel.tsx`**

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConfirmPhaseValue } from '@support/types';
import { testBotTurn, fetchIntents } from '../../../api/agentApi.ts';
import { useBotConfigDraft } from '../BotConfigDraftContext.tsx';
import { ChatThread } from '@/features/chat/components/ChatThread.tsx';
import { Composer } from '@/features/chat/components/Composer.tsx';
import type { ChatMessage } from '@/features/chat/components/types.ts';
import { ToolActivityStrip } from './ToolActivityStrip.tsx';

const CONFIRM_PHASES: ConfirmPhaseValue[] = [
  'none',
  'bot_article',
  'agent_ask',
  'form',
  'inactivity_ask',
  'player_stated',
];

type TestMessage = ChatMessage & { toolActivity?: React.ReactNode };

export function BotTestPanel({ token }: { token: string }) {
  const { draft } = useBotConfigDraft();
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [subintentId, setSubintentId] = useState<string | null>(null);
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhaseValue>('none');
  const [sending, setSending] = useState(false);

  const intentsQuery = useQuery({ queryKey: ['intents'], queryFn: () => fetchIntents(token) });
  const subintentOptions = (intentsQuery.data?.intents ?? []).flatMap((intent) =>
    intent.subintents.map((sub) => ({ value: sub.id, label: `${intent.name} / ${sub.name}` })),
  );

  const send = async (body: string) => {
    if (!draft) return;
    const playerMessage: TestMessage = {
      id: `test-player-${messages.length}`,
      authorType: 'player',
      body,
      createdAt: new Date().toISOString(),
    };
    const history = messages.map((m) => ({
      author_type: m.authorType === 'player' ? ('player' as const) : ('bot' as const),
      body: m.body,
    }));
    setMessages((prev) => [...prev, playerMessage]);
    setSending(true);
    try {
      const { decision } = await testBotTurn(token, {
        config: {
          prompt: draft.prompt,
          rules: draft.rules,
          tools_config: draft.toolsConfig,
          limits_config: draft.limitsConfig,
        },
        subintent_id: subintentId,
        confirm_phase: confirmPhase,
        history,
        player_message: body,
      });
      const botMessage: TestMessage = {
        id: `test-bot-${messages.length}`,
        authorType: 'bot',
        body: decision.kind === 'answer' ? decision.reply : `[${decision.kind}]`,
        createdAt: new Date().toISOString(),
        toolActivity: <ToolActivityStrip decision={decision} />,
      };
      setMessages((prev) => [...prev, botMessage]);
    } catch {
      const errorMessage: TestMessage = {
        id: `test-error-${messages.length}`,
        authorType: 'system',
        body: 'Test turn failed — check server logs.',
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Test the bot</span>
      </div>
      <div className="flex flex-col gap-2 border-b border-slate-200 p-3 text-xs">
        <label className="flex items-center justify-between gap-2">
          <span>Subintent</span>
          <select
            value={subintentId ?? ''}
            onChange={(e) => setSubintentId(e.target.value || null)}
            className="rounded border border-slate-200 px-1 py-0.5"
          >
            <option value="">None</option>
            {subintentOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Confirm phase</span>
          <select
            value={confirmPhase}
            onChange={(e) => setConfirmPhase(e.target.value as ConfirmPhaseValue)}
            className="rounded border border-slate-200 px-1 py-0.5"
          >
            {CONFIRM_PHASES.map((phase) => (
              <option key={phase} value={phase}>
                {phase}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="min-h-0 flex-1">
        <ChatThread messages={messages} currentAuthorType="agent" />
        {messages.map((m) => m.toolActivity && <div key={`activity-${m.id}`}>{m.toolActivity}</div>)}
      </div>
      <Composer onSend={(body) => void send(body)} disabled={sending || !draft} />
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend exec vitest run src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx`

Expected: PASS. If `ChatThread`'s Virtuoso rendering makes the tool-activity strip's placement fail to assert cleanly (Virtuoso only mounts measured items in jsdom, per the note in `ChatThread.test.tsx`), move the `toolActivity` rendering to read from the *last* message only rather than mapping every message, and adjust the test to assert against the last strip. Prefer the simplest passing version; do not iterate more than twice on this layout detail.

- [ ] **Step 5: Typecheck the whole frontend workspace**

Run: `pnpm --filter frontend typecheck`

Expected: PASS — this is the step where `BotConfig.tsx`'s forward reference to `BotTestPanel` (Task 5, Step 5) finally resolves.

- [ ] **Step 6: Run the full frontend test suite for this feature area**

Run: `pnpm --filter frontend exec vitest run src/surfaces/agent-console/pages/BotConfig`

Expected: all PASS (`BotConfigDraftContext.test.tsx`, `ToolActivityStrip.test.tsx`, `BotTestPanel.test.tsx`, and any pre-existing tests in this directory).

- [ ] **Step 7: Manually verify in the browser**

Run `pnpm dev`, sign in as an Admin, open Bot Config, and confirm: the test panel renders beside the tabs; typing a player message and sending it shows a bot reply with a tool-activity strip; editing the prompt in the Prompt tab (without saving) and sending another test message reflects the edit in the bot's behavior/wording.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.tsx frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx frontend/src/surfaces/agent-console/pages/BotConfig/BotConfig.tsx
git commit -m "Add BotTestPanel — live bot test chat inside Bot Config"
```

---

## Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full backend suite**

Run: `pnpm --filter backend test`

Expected: PASS. (Requires Postgres up per `app/CLAUDE.md`.)

- [ ] **Step 2: Run the full frontend suite**

Run: `pnpm --filter frontend test`

Expected: PASS.

- [ ] **Step 3: Run the workspace typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Run lint**

Run: `pnpm lint`

Expected: PASS, or only the pre-existing warnings this repo already tolerates.
