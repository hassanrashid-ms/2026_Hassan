# Bot Article Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot message that cited an article renders as markdown and carries a "Read more" button to that article, in both the webview and the agent console.

**Architecture:** One nullable `message.article_id` column carries the citation from `applyBotTurn` through `postMessage`, both serializers and the wire contract to the client, where a shared `MessageBody` component renders `bot`/`agent` bodies through the existing `ArticleBody` markdown renderer and each surface appends its own "Read more" affordance — a nested route in the webview, a new-tab anchor in the console. `answer_from_article` is unchanged: it still carries the answer text; the article becomes reachable _alongside_ it.

**Tech Stack:** Express 5 + Zod + Drizzle (Postgres 17, RLS), Vitest, React + TanStack Query + react-router-dom, Tailwind v4 utilities, react-markdown (via `ArticleBody`).

**Source spec:** `docs/specs/2026-08-18-bot-article-delivery-design.md` — read it before starting your task.

## Global Constraints

- **Tailwind v4 utilities only.** No hand-written CSS classes anywhere, in any file. If a token is missing, add it to the surface's `@theme` block. Never edit `ArticleBody`'s own classes to fix a bubble.
- **No hard deletes.** The new FK is `ON DELETE RESTRICT`.
- **`article_id` is never client-supplied.** No new scoped `SELECT` guard is needed: `toolLoop` only accepts an id present in `searchedArticles`, which comes from `searchArticles`' workspace-scoped query. Do not add a validation query, and do not accept `article_id` on any request body.
- **`bot_article_offered` is untouched** — including its snapshotted `article_title`. It is the reporting record; the column is delivery. Do not read one from the other.
- **Nothing touches `confirm_phase`**, `confirm_resolution`, or the `bot_article_rejected` → `handoff('article_rejected')` wiring.
- **Player and `system` bodies are never markdown-rendered.** `ArticleBody` omits `rehype-raw` by design; pointing it at adversarial input would make an incidental guarantee load-bearing.
- **Wire contract is frozen additive-only:** add response fields, never remove or retype one.
- **No select-list edits anywhere.** Every thread-read path already selects all columns — `backend/src/surface/services/messagesService.ts:269` and `backend/src/agent/services/conversationsService.ts:90` both use `tx.select().from(message)`. If you find yourself editing a select list to add `article_id`, you are in the wrong file.
- **`@tailwindcss/typography` is not installed and must not be.**
- **Button label is exactly `Read more`.** No article title, no snapshotted label.
- **Never `console.*` in backend code** — use `logger`. (No new logging is required by this change.)
- **Commit message trailers:** do NOT add a `Co-Authored-By: Claude` trailer.

## File Structure

**Backend**

| File                                              | Change                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `backend/src/shared/db/schema/conversations.ts`   | `message.articleId` column, FK to `article`                              |
| `backend/drizzle/0006_*.sql`                      | generated migration (commit it)                                          |
| `backend/src/domain/conversations/postMessage.ts` | `PostMessageInput.articleId`, `PostedMessageRow.articleId`, insert value |
| `backend/src/domain/conversations/serializers.ts` | both views emit `article_id`                                             |
| `packages/types/src/chat.ts`                      | `PlayerMessageView.article_id` (`AgentMessageView` inherits)             |
| `backend/src/docs/openapi.ts`                     | documented message schema carrying `article_id`                          |
| `backend/src/domain/bot/applyBotTurn.ts`          | `answer` branch passes `articleId`                                       |

**Frontend**

| File                                                                         | Change                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `frontend/src/features/chat/components/types.ts`                             | `ChatMessage.articleId`                                                             |
| `frontend/src/features/chat/components/MessageBody.tsx`                      | **new** — author-type-aware body renderer, owns the lazy `ArticleBody` import       |
| `frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx`              | `MessageBody`, thread-level `Suspense`, code/pre background fix, "Read more" `Link` |
| `frontend/src/surfaces/webview/pages/SupportChat.tsx`                        | mapper carries `article_id`; renders `ArticleSheet` from the route param            |
| `frontend/src/surfaces/webview/main.tsx`                                     | nested route `chat/articles/:id`                                                    |
| `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx` | mapper carries `article_id`; `MessageBody`; new-tab "Read more" anchor              |
| `frontend/src/routes/AppRoutes.tsx`                                          | `articles/:id` route                                                                |
| `frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx`  | seed selection from the route param, navigate back on close                         |

`MessageBody.tsx` is the decomposition decision that matters: the author-type → renderer table and the lazy-import comment live in exactly one place, so neither surface can drift into markdown-rendering a player body.

## Parallel Execution Waves

File sets are disjoint within each wave, so agents can run concurrently in the same working tree. **Commit only the files your task lists.**

```
Wave A (3 agents, no deps)      Wave B (3 agents)            Wave C (2 agents)
┌──────────────────────┐        ┌────────────────────┐       ┌──────────────────────┐
│ T1 column + postMsg  │──┬────▶│ T2 wire contract   │──┬───▶│ T6 webview route+map │
└──────────────────────┘  └────▶│ T3 applyBotTurn    │  │    └──────────────────────┘
┌──────────────────────┐        └────────────────────┘  ├───▶┌──────────────────────┐
│ T4 ChatMessage +     │──┬──────────────────────────┐  │    │ T7 console ThreadPanel│
│    MessageBody       │  │                          ├──┘    └──────────────────────┘
└──────────────────────┘  └────▶┌────────────────────┐
┌──────────────────────┐        │ T5 webview bubbles │
│ T8 console /articles │        └────────────────────┘
└──────────────────────┘
```

- **Wave A:** T1, T4, T8 — dispatch together.
- **Wave B:** T2 and T3 need T1 (both read `PostedMessageRow.articleId` / `PostMessageInput.articleId`). T5 needs T4 (`MessageBody`, `ChatMessage.articleId`).
- **Wave C:** T6 and T7 need T2 (the `article_id` wire field must exist for their mappers to typecheck) and T4.

T3's own test asserts the column, so T3 must not be dispatched before T1's migration has been applied to the dev database.

---

### Task 1: `message.article_id` column and `postMessage` plumbing

**Files:**

- Modify: `backend/src/shared/db/schema/conversations.ts` (the `message` table, around line 94)
- Create: `backend/drizzle/0006_<generated_name>.sql` (via `pnpm db:generate` — do not hand-write)
- Modify: `backend/src/domain/conversations/postMessage.ts`
- Test: `backend/tests/domain.postMessage.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `PostMessageInput.articleId?: string | null`
  - `PostedMessageRow.articleId: string | null`
  - Drizzle column `message.articleId` → SQL `message.article_id uuid null references article(id) on delete restrict`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/domain.postMessage.test.ts`, inside the existing `describe('postMessage', ...)` block. Add `ownerPool`, `seedAgent` and `seedArticle` to the existing import from `./helpers/db.ts`.

```ts
it('persists article_id when given one, and leaves it null when not', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  const agentId = await seedAgent();
  const articleId = await seedArticle({ workspaceId, createdBy: agentId });

  const cited = await withWorkspace(workspaceId, (tx) =>
    postMessage(tx, {
      workspaceId,
      conversationId,
      authorType: 'bot',
      actorId: null,
      body: 'Refunds take 48 hours.',
      articleId,
    }),
  );
  const uncited = await withWorkspace(workspaceId, (tx) =>
    postMessage(tx, {
      workspaceId,
      conversationId,
      authorType: 'bot',
      actorId: null,
      body: 'Anything else?',
    }),
  );

  // The returned row, not just the database: PostedMessageRow is what both
  // serializers read, so a column that persisted but did not come back through
  // .returning() would still reach the client as null.
  expect(cited.articleId).toBe(articleId);
  expect(uncited.articleId).toBeNull();

  const { rows } = await ownerPool.query(
    `select article_id from message where conversation_id = $1 order by seq`,
    [conversationId],
  );
  expect(rows).toEqual([{ article_id: articleId }, { article_id: null }]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && pnpm vitest run tests/domain.postMessage.test.ts -t 'persists article_id'`
Expected: FAIL — TypeScript rejects `articleId` on `PostMessageInput`, or the query errors with `column "article_id" does not exist`.

- [ ] **Step 3: Add the column**

In `backend/src/shared/db/schema/conversations.ts`, add the import:

```ts
import { article } from './articles.ts';
```

and the column immediately after `body: text('body').notNull(),` in the `message` table:

```ts
    /**
     * The article this bot answer was written from, or null. Delivery, not
     * reporting: `bot_article_offered` keeps its own snapshotted title and stays
     * the record every funnel metric groups by. The two must never become two
     * sources for one number.
     *
     * Never client-supplied — toolLoop only accepts an id searchArticles already
     * proved visible in this workspace — so no scoped re-check guards this FK.
     *
     * No index on purpose: it is read on rows already fetched by
     * conversation_id, and is never a filter or a join key.
     */
    articleId: uuid('article_id').references(() => article.id, { onDelete: 'restrict' }),
```

- [ ] **Step 4: Generate and apply the migration**

Run: `pnpm db:generate` then `pnpm db:setup`
Expected: a new `backend/drizzle/0006_*.sql` containing `ALTER TABLE "message" ADD COLUMN "article_id" uuid;` plus the `ON DELETE RESTRICT` FK, and `db:setup` completing without error.

Read the generated SQL before continuing. If it contains any statement that drops or retypes an existing column, stop and report — that is a schema drift, not this change.

No RLS work: `message` already has its policy and a new column inherits it.

- [ ] **Step 5: Plumb it through `postMessage`**

In `backend/src/domain/conversations/postMessage.ts`, add to `PostMessageInput` after `body: string`:

```ts
  /**
   * The article the bot answered from, when it answered from one. Null for every
   * other author and every other decision kind. Not validated here: the only
   * caller that sets it is applyBotTurn's `answer` branch, and toolLoop already
   * refused any id that searchArticles had not returned for this workspace.
   */
  articleId?: string | null
```

Add to `PostedMessageRow` after `body: string`:

```ts
articleId: string | null;
```

And in the `.insert(message).values({...})` call, after `body: input.body,`:

```ts
      articleId: input.articleId ?? null,
```

- [ ] **Step 6: Run the whole file's tests**

Run: `cd backend && pnpm vitest run tests/domain.postMessage.test.ts`
Expected: PASS, all cases including the pre-existing seq and empty-body tests.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: clean. `serializers.ts` does not yet read the new field, so nothing else breaks.

- [ ] **Step 8: Commit**

```bash
git add backend/src/shared/db/schema/conversations.ts backend/drizzle backend/src/domain/conversations/postMessage.ts backend/tests/domain.postMessage.test.ts
git commit -m "feat(db): carry article_id on message"
```

---

### Task 2: Wire contract — serializers, `@support/types`, OpenAPI

**Files:**

- Modify: `packages/types/src/chat.ts:43-52`
- Modify: `backend/src/domain/conversations/serializers.ts`
- Modify: `backend/src/docs/openapi.ts` (schema definitions block near the top; the `/agent/conversations/{id}/messages` GET at ~line 597)
- Test: `backend/tests/domain.serializers.test.ts`

**Depends on:** Task 1 (`PostedMessageRow.articleId`).

**Interfaces:**

- Consumes: `PostedMessageRow.articleId: string | null` from Task 1.
- Produces:
  - `PlayerMessageView.article_id: string | null` (and therefore `AgentMessageView.article_id`)
  - `toPlayerView` / `toAgentView` emit `article_id`

- [ ] **Step 1: Write the failing test**

In `backend/tests/domain.serializers.test.ts`, add `articleId: null,` to the `row()` factory defaults (after `body: 'hello',`), add `article_id: null,` to the two existing `toEqual({...})` expectations so they stay exhaustive, then append:

```ts
describe('article_id on both views', () => {
  it('carries a cited article to the player', () => {
    expect(toPlayerView(row({ authorType: 'bot', articleId: 'art-1' }))?.article_id).toBe('art-1');
  });

  it('carries a cited article to the agent', () => {
    expect(toAgentView(row({ authorType: 'bot', articleId: 'art-1' })).article_id).toBe('art-1');
  });

  it('is null on a message that cited nothing — which is every pre-existing message', () => {
    expect(toPlayerView(row())?.article_id).toBeNull();
    expect(toAgentView(row()).article_id).toBeNull();
  });

  /**
   * The whitelist still decides the whole row, not per-field: an internal note
   * with an article on it must not leak the article either.
   */
  it('still returns null for an internal message, article or not', () => {
    expect(toPlayerView(row({ visibility: 'internal', articleId: 'art-1' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && pnpm vitest run tests/domain.serializers.test.ts`
Expected: FAIL — `article_id` does not exist on `PlayerMessageView`.

- [ ] **Step 3: Add the wire field**

In `packages/types/src/chat.ts`, inside `PlayerMessageView`, after `created_at: string`:

```ts
/**
 * The article this bot answer was written from, or null. Additive — the frozen
 * contract permits new response fields. Clients append their own "Read more"
 * affordance from this; the model is never asked to write a link.
 */
article_id: string | null;
```

- [ ] **Step 4: Emit it from both serializers**

In `backend/src/domain/conversations/serializers.ts`, add to the object literal in `toPlayerView` after `created_at: ...`:

```ts
    article_id: row.articleId,
```

and the identical line in `toAgentView`. Nothing else in either function changes — `toPlayerView`'s `visibility !== 'public'` early return stays exactly where it is.

- [ ] **Step 5: Run the test**

Run: `cd backend && pnpm vitest run tests/domain.serializers.test.ts`
Expected: PASS.

- [ ] **Step 6: Document it in the OpenAPI spec**

`openapi.ts` currently registers the message-list endpoints with a bare `description` and no response schema, so there is no existing field list to extend. Add one for the agent message list — the shape that is exactly `AgentMessagesResponse` — so the new field is documented per the house rule.

In the schema-definitions block near the top of `backend/src/docs/openapi.ts` (after `IncidentBodySchema`):

```ts
const AgentMessageViewSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().nonnegative(),
  author_type: z.enum(['player', 'agent', 'bot', 'system']),
  author_agent_id: z.uuid().nullable(),
  body: z.string(),
  visibility: z.enum(['public', 'internal']),
  delivery_state: z.enum(['sent', 'delivered', 'read']),
  read_at: z.string().nullable(),
  created_at: z.string(),
  article_id: z.uuid().nullable().openapi({
    description:
      'The article a bot answer was written from, or null. Clients render their own "Read more" from it.',
  }),
});
```

Then replace the `responses` block of the `get /agent/conversations/{id}/messages` registration:

```ts
  responses: {
    200: {
      description: 'Messages list',
      content: { 'application/json': { schema: z.object({ messages: z.array(AgentMessageViewSchema) }) } },
    },
  },
```

Leave the player-facing `/surface/conversations/active` registration alone: its envelope (`conversation_id`, `status`, `confirm_phase`, the whole `form` card) is undocumented today, and documenting it is a separate job from this change. Note it in your handoff.

Verify `delivery_state`'s members against `ChatDeliveryState` in `packages/types/src/chat.ts` before committing; if they differ, the type wins.

- [ ] **Step 7: Verify the spec still generates**

Run: `pnpm typecheck` and `cd backend && pnpm vitest run`
Expected: typecheck clean; suite green. Then `pnpm dev` and open `http://localhost:4000/docs/json` — confirm `article_id` appears under the agent messages 200 response, and that the document still parses (a malformed registration throws at generation, not at import).

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/chat.ts backend/src/domain/conversations/serializers.ts backend/src/docs/openapi.ts backend/tests/domain.serializers.test.ts
git commit -m "feat(api): expose message article_id on both message views"
```

---

### Task 3: `applyBotTurn` persists the cited article

**Files:**

- Modify: `backend/src/domain/bot/applyBotTurn.ts:45-71` (the `answer` branch)
- Test: `backend/tests/bot.turnSeam.test.ts`

**Depends on:** Task 1 (`PostMessageInput.articleId`, and the applied migration).

**Interfaces:**

- Consumes: `PostMessageInput.articleId` from Task 1.
- Produces: no new exports. Behaviour: an `answer` decision with `decision.articleId` set writes it onto the message row; every other decision kind leaves `article_id` null.

- [ ] **Step 1: Write the failing test**

In `backend/tests/bot.turnSeam.test.ts`, add a local helper next to the existing `messagesFor` (do not change `messagesFor` — other tests assert its exact column set):

```ts
async function articleIdsFor(conversationId: string) {
  const { rows } = await ownerPool.query(
    `select author_type, article_id from message where conversation_id = $1 order by seq`,
    [conversationId],
  );
  return rows;
}
```

Then add these two cases inside `describe('applyBotTurn', ...)`. `seedArticle` and `seedAgent` are already imported by this file's helper import list — add `seedArticle` if it is missing.

```ts
it('answer persists the cited article on the message it posted', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  const authorId = await seedAgent();
  const articleId = await seedArticle({ workspaceId, createdBy: authorId, title: 'Refund timing' });

  await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(
      tx,
      { workspaceId, conversationId },
      { kind: 'answer', reply: 'Refunds take 48 hours.', articleId },
    ),
  );

  expect(await articleIdsFor(conversationId)).toEqual([
    { author_type: 'bot', article_id: articleId },
  ]);

  // The event is the reporting record and stays exactly as it was — same type,
  // same snapshotted title. Delivery did not replace it.
  const events = await eventsFor(conversationId);
  expect(events.map((e) => e.type)).toEqual(['message_sent', 'bot_article_offered']);
  expect(events[1].payload).toMatchObject({
    article_id: articleId,
    article_title: 'Refund timing',
  });

  // Unchanged: reading an article is not answering "did this help?".
  expect((await conversationRow(conversationId)).status).toBe('bot_active');
});

it('leaves article_id null on an answer that cited nothing', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });

  await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(
      tx,
      { workspaceId, conversationId },
      { kind: 'answer', reply: 'Can you tell me more?' },
    ),
  );

  expect(await articleIdsFor(conversationId)).toEqual([{ author_type: 'bot', article_id: null }]);
});
```

And one case proving the other decision kinds never stamp it. `handoff` posts a player-facing message from `HANDOFF_PLAYER_MESSAGES`; `unavailable` posts `botFailureNote`. Both must land with a null article.

```ts
it('leaves article_id null on handoff and on unavailable', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const availableAgent = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId: availableAgent });

  const handoffConversation = await seedConversation({ workspaceId, playerId });
  await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(
      tx,
      { workspaceId, conversationId: handoffConversation },
      { kind: 'handoff', reason: 'article_rejected' },
    ),
  );

  const unavailableConversation = await seedConversation({ workspaceId, playerId });
  await withWorkspace(workspaceId, (tx) =>
    applyBotTurn(
      tx,
      { workspaceId, conversationId: unavailableConversation },
      { kind: 'unavailable', reason: 'provider_error' },
    ),
  );

  for (const row of [
    ...(await articleIdsFor(handoffConversation)),
    ...(await articleIdsFor(unavailableConversation)),
  ]) {
    expect(row.article_id).toBeNull();
  }
});
```

If `'provider_error'` is not a member of the `unavailable` reason union, use whichever member the existing `unavailable` tests in this file already use — do not widen the union.

- [ ] **Step 2: Run and watch it fail**

Run: `cd backend && pnpm vitest run tests/bot.turnSeam.test.ts -t 'persists the cited article'`
Expected: FAIL — `article_id` comes back `null` because `postMessage` was never told about it.

- [ ] **Step 3: Pass the article id**

In `applyBotTurn.ts`'s `case 'answer'` branch, add one line to the `postMessage` call, after `body: decision.reply,`:

```ts
        articleId: decision.articleId ?? null,
```

Nothing else in the branch moves. The `if (decision.articleId)` block below — `confirmPhase: 'bot_article'`, the title lookup, `bot_article_offered` — stays byte-identical.

- [ ] **Step 4: Run the whole file**

Run: `cd backend && pnpm vitest run tests/bot.turnSeam.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Run the bot suite**

Run: `cd backend && pnpm vitest run tests/bot.*.test.ts`
Expected: PASS. Nothing here changes a prompt, so `bot.config.test.ts`'s guarded phrases are untouched.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/applyBotTurn.ts backend/tests/bot.turnSeam.test.ts
git commit -m "feat(bot): persist the cited article on the answer message"
```

---

### Task 4: Shared `MessageBody` and `ChatMessage.articleId`

**Files:**

- Modify: `frontend/src/features/chat/components/types.ts`
- Create: `frontend/src/features/chat/components/MessageBody.tsx`
- Test: `frontend/src/features/chat/components/MessageBody.test.tsx`

**Depends on:** nothing. Dispatch in Wave A.

**Interfaces:**

- Consumes: `ArticleBody` from `@/features/articles/components/ArticleBody` (exists, unchanged).
- Produces:
  - `ChatMessage.articleId?: string | null`
  - `MessageBody({ authorType, body }: { authorType: ChatAuthorType; body: string })` — renders markdown for `bot` and `agent`, literal text for `player` and `system`. **Suspends on first use**: the caller must provide the `Suspense` boundary, one per thread.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/chat/components/MessageBody.test.tsx`:

```tsx
import { Suspense } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MessageBody } from './MessageBody.tsx';

const MARKDOWN = 'Refunds take **48 hours**.\n\n1. Open Settings\n2. Tap Support';

/** The boundary belongs to the thread in real callers; a test supplies its own. */
function renderBody(props: { authorType: 'player' | 'agent' | 'bot' | 'system'; body: string }) {
  return render(
    <Suspense fallback={null}>
      <MessageBody {...props} />
    </Suspense>,
  );
}

describe('MessageBody', () => {
  it('renders a bot body as markdown', async () => {
    const { container } = renderBody({ authorType: 'bot', body: MARKDOWN });

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'));
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.textContent).not.toContain('**');
  });

  it('renders an agent body as markdown, so pasted article steps read like the bot answer', async () => {
    const { container } = renderBody({ authorType: 'agent', body: MARKDOWN });

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'));
  });

  /**
   * The security property, not a formatting preference: ArticleBody is safe only
   * because it omits rehype-raw, and that was reasoned about for agent-authored
   * article bodies — not for an adversarial input source.
   */
  it('renders a player body as literal text, asterisks and all', async () => {
    const { container } = renderBody({ authorType: 'player', body: 'my **game** crashed' });

    await waitFor(() => expect(screen.getByText('my **game** crashed')).toBeInTheDocument());
    expect(container.querySelector('strong')).toBeNull();
  });

  it('renders a system body as literal text', async () => {
    renderBody({ authorType: 'system', body: 'Did this **solve** it?' });

    await waitFor(() => expect(screen.getByText('Did this **solve** it?')).toBeInTheDocument());
  });

  it('does not render raw HTML in a bot body as markup', async () => {
    const { container } = renderBody({ authorType: 'bot', body: '<img src=x onerror="alert(1)">' });

    await waitFor(() => expect(container.textContent).toContain('<img'));
    expect(container.querySelector('img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && pnpm vitest run src/features/chat/components/MessageBody.test.tsx`
Expected: FAIL — cannot resolve `./MessageBody.tsx`.

- [ ] **Step 3: Write `MessageBody`**

Create `frontend/src/features/chat/components/MessageBody.tsx`:

```tsx
import { lazy } from 'react';
import type { ChatAuthorType } from './types.ts';

/*
 * Lazy, and lazy HERE rather than at each call site, so both surfaces share one
 * chunk and one reason.
 *
 * ArticleSheet's own comment records why it must not be static: a static import
 * put ~790KB of react-markdown and remark-gfm on the webview's first paint and
 * blew past the SDK's 8s load timeout, so the surface never opened at all.
 *
 * This component therefore SUSPENDS the first time a bot or agent bubble renders.
 * The boundary belongs to the thread, not the bubble: one per bubble would flash
 * a fallback on every message as the list scrolls.
 */
const ArticleBody = lazy(() =>
  import('@/features/articles/components/ArticleBody').then((m) => ({ default: m.ArticleBody })),
);

/*
 * The whole rule, in one place so neither surface can drift.
 *
 * `player` is absent deliberately and permanently. ArticleBody is safe today only
 * because it omits rehype-raw, so raw HTML renders as literal text — a property
 * that was reasoned about for agent-authored article bodies. Pointing the renderer
 * at arbitrary player text would turn an incidental guarantee into one the system
 * depends on against an adversarial input source. `system` bodies are server copy
 * with no markdown in them, and get the same literal treatment.
 */
const MARKDOWN_AUTHORS: ReadonlySet<ChatAuthorType> = new Set(['bot', 'agent']);

export function MessageBody({ authorType, body }: { authorType: ChatAuthorType; body: string }) {
  if (!MARKDOWN_AUTHORS.has(authorType)) return <>{body}</>;
  return <ArticleBody markdown={body} />;
}
```

- [ ] **Step 4: Add `articleId` to `ChatMessage`**

In `frontend/src/features/chat/components/types.ts`, add after `visibility?: 'public' | 'internal'`:

```ts
  /**
   * The article a bot answer was written from, or null/absent. Drives the
   * client-appended "Read more" button — the model never writes the link itself,
   * because a prompt asking for one produces prose describing a link instead.
   */
  articleId?: string | null
```

- [ ] **Step 5: Run the test**

Run: `cd frontend && pnpm vitest run src/features/chat/components/MessageBody.test.tsx`
Expected: PASS, all five cases.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: clean — `articleId` is optional, so no existing mapper breaks.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/chat/components/MessageBody.tsx frontend/src/features/chat/components/MessageBody.test.tsx frontend/src/features/chat/components/types.ts
git commit -m "feat(chat): shared author-aware message body renderer"
```

---

### Task 5: Webview bubbles — markdown and "Read more"

**Files:**

- Modify: `frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx`
- Test: `frontend/src/surfaces/webview/components/chat/ChatBubbles.test.tsx` (create)

**Depends on:** Task 4.

**Interfaces:**

- Consumes: `MessageBody`, `ChatMessage.articleId` from Task 4.
- Produces: a bot/agent bubble whose body is markdown, and — when `articleId` is set — a `Read more` link to `/embed/support/chat/articles/${articleId}`. Task 6 creates that route.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/webview/components/chat/ChatBubbles.test.tsx`. The `beforeAll` block is copied verbatim from `frontend/src/features/chat/components/ChatThread.test.tsx` — jsdom lays out nothing, so without it Virtuoso measures a zero-height viewport and mounts no items:

```tsx
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatBubbles } from './ChatBubbles.tsx';
import type { ChatMessage } from '@/features/chat/components/types';

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

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    authorType: 'bot',
    body: 'hello',
    createdAt: '2026-08-18T10:00:00.000Z',
    deliveryState: 'sent',
    ...overrides,
  };
}

function renderBubbles(messages: ChatMessage[]) {
  return render(
    <MemoryRouter initialEntries={['/embed/support/chat']}>
      <ChatBubbles messages={messages} onRetry={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ChatBubbles markdown', () => {
  it('renders a bot body as markdown', async () => {
    const { container } = renderBubbles([message({ body: 'Refunds take **48 hours**.' })]);

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'));
    expect(container.textContent).not.toContain('**');
  });

  it('renders a player body literally — asterisks stay asterisks', async () => {
    const { container } = renderBubbles([
      message({ authorType: 'player', body: 'my **game** crashed' }),
    ]);

    await waitFor(() => expect(screen.getByText('my **game** crashed')).toBeInTheDocument());
    expect(container.querySelector('strong')).toBeNull();
  });
});

describe('ChatBubbles read-more', () => {
  it('links to the article when the message cited one', async () => {
    renderBubbles([message({ articleId: 'art-1' })]);

    const link = await screen.findByRole('link', { name: 'Read more' });
    expect(link).toHaveAttribute('href', '/embed/support/chat/articles/art-1');
  });

  it('renders no button when the message cited nothing — every pre-existing message', async () => {
    renderBubbles([message()]);

    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Read more' })).not.toBeInTheDocument();
  });

  it('renders no button on a player bubble even if one somehow carried an id', async () => {
    renderBubbles([message({ authorType: 'player', body: 'thanks', articleId: 'art-1' })]);

    await waitFor(() => expect(screen.getByText('thanks')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Read more' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && pnpm vitest run src/surfaces/webview/components/chat/ChatBubbles.test.tsx`
Expected: FAIL — the bot body renders `**48 hours**` literally and no link exists.

- [ ] **Step 3: Add the thread-level `Suspense` boundary**

In `ChatBubbles.tsx`, add to the imports:

```tsx
import { Suspense } from 'react';
import { Link } from 'react-router-dom';
import { MessageBody } from '@/features/chat/components/MessageBody';
```

Wrap the `<Virtuoso .../>` element — not the outer `div`, which owns the jump button's positioning context — in a boundary:

```tsx
      {/*
        One boundary for the whole thread, because MessageBody's ArticleBody is
        lazy: per-bubble boundaries would flash a fallback on every message as the
        list scrolls. `null` matches every other fallback in this surface — a
        spinner flashing over a paused game is worse than nothing. The list mounts
        fresh once the chunk resolves, which initialTopMostItemIndex and
        followOutput already put at the bottom.
      */}
      <Suspense fallback={null}>
        <Virtuoso
          ...unchanged...
        />
      </Suspense>
```

- [ ] **Step 4: Render the body through `MessageBody` and fix the background collision**

In `ChatBubble`, replace `{message.body}` with `<MessageBody authorType={message.authorType} body={message.body} />`.

`ArticleBody`'s `code` and `pre` are `bg-surface`, and this bubble is also `bg-surface` — same colour on same colour. Fix it with a wrapper class on the bubble, never by editing `ArticleBody`, so the article sheet's own rendering is untouched. Add these two utilities to the non-own branch of the bubble's `cn(...)`:

```tsx
          own
            ? 'rounded-br-sm bg-accent text-accent-fg'
            : 'rounded-bl-sm bg-surface text-text [&_code]:bg-bg [&_pre]:bg-bg',
```

`--color-bg` is defined in `webview.css`'s `@theme` alongside `--color-surface`, and the descendant selector these arbitrary variants generate outranks `ArticleBody`'s own single-class `bg-surface` — no `!important` needed.

- [ ] **Step 5: Append the "Read more" link**

Inside `ChatBubble`, immediately after the bubble `div` closes and before the timestamp row, add:

```tsx
{
  /*
          Client-appended, always — never model output. A prompt that asks for the
          link produces prose describing a link, which is the same failure mode
          CLAUDE.md documents for `handoff` and `answer_from_article`.

          A nested route, not the shared /embed/support/articles/:id: that one
          renders SupportHome, which would unmount a live chat and break the
          hardware back button.
        */
}
{
  !own && message.articleId && (
    <Link
      to={`/embed/support/chat/articles/${message.articleId}`}
      className="inline-flex min-h-9 items-center rounded-card bg-accent-soft px-3 py-1.5 text-sm font-semibold text-accent"
    >
      Read more
    </Link>
  );
}
```

`!own` is the guard that keeps this off a player bubble, matching `MessageBody`'s author rule rather than restating it.

- [ ] **Step 6: Run the test**

Run: `cd frontend && pnpm vitest run src/surfaces/webview/components/chat/ChatBubbles.test.tsx`
Expected: PASS, all five cases.

- [ ] **Step 7: Confirm the stale-comment cleanup is already in place**

The spec's Cleanup section asks for the `ChatBubbles.tsx` header comment claiming `ChatThread` is "styled by styles.css classes the webview no longer loads" to be corrected, and for the same fact to be in `CLAUDE.md` § Styling.

Run: `grep -n "styles.css" frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx CLAUDE.md`
Expected: the `ChatBubbles.tsx` header already says the earlier claim was wrong and that `styles.css` styles nothing, and `CLAUDE.md` § Styling already records it. **Both are already done — change nothing.** If either is missing, correct it in this task and say so in your handoff.

- [ ] **Step 8: Run the surface's suite and typecheck**

Run: `cd frontend && pnpm vitest run src/surfaces/webview && pnpm typecheck`
Expected: PASS and clean. `SupportChat.test.tsx` renders real `ChatBubbles`, so its existing assertions on message text are the regression check that the `Suspense` boundary did not blank the thread.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx frontend/src/surfaces/webview/components/chat/ChatBubbles.test.tsx
git commit -m "feat(webview): render bot answers as markdown with a Read more link"
```

---

### Task 6: Webview article route and mapper

**Files:**

- Modify: `frontend/src/surfaces/webview/main.tsx`
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx`
- Test: `frontend/src/surfaces/webview/pages/SupportChat.test.tsx`

**Depends on:** Task 2 (`PlayerMessageView.article_id`), Task 4 (`ChatMessage.articleId`).

**Interfaces:**

- Consumes: `article_id` on the player message view; `ChatMessage.articleId`; the existing `ArticleSheet({ articleId, onClose })` and `useCloseOverlay(fallback)` — both unchanged.
- Produces: route `/embed/support/chat/articles/:id`, which mounts the same lazy `SupportChat` with the article sheet open over the live thread.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/surfaces/webview/pages/SupportChat.test.tsx`. Extend the existing mocks: add `import { Route, Routes } from 'react-router-dom'`, `import { fetchArticleDetail } from '@/surfaces/webview/api/surfaceApi'`, and `vi.mock('@/surfaces/webview/api/surfaceApi')` beside the existing `vi.mock` calls. In the existing `beforeEach`, add:

```ts
vi.mocked(fetchArticleDetail).mockResolvedValue({
  id: 'art-1',
  title: 'Refund timing',
  body: 'Refunds take **48 hours**.',
  keywords: [],
  intent_id: null,
  published_at: null,
});
```

Add a route-aware render helper next to `renderChat`, mounting `SupportChat` under a real `Route` so `useParams` resolves:

```tsx
function renderChatAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SupportContextProvider value={contextValue}>
          <Routes>
            <Route path="/embed/support/chat" element={<SupportChat />} />
            <Route path="/embed/support/chat/articles/:id" element={<SupportChat />} />
          </Routes>
        </SupportContextProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

Then the cases:

```tsx
describe('SupportChat article delivery', () => {
  it('carries article_id from the wire onto the bubble as a Read more link', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(
      messages({
        messages: [
          {
            id: 'm1',
            seq: 1,
            author_type: 'bot',
            body: 'Refunds take 48 hours.',
            created_at: '2026-08-18T10:00:00.000Z',
            delivery_state: 'sent',
            read_at: null,
            article_id: 'art-1',
          },
        ],
      }),
    );

    renderChatAt('/embed/support/chat');

    const link = await screen.findByRole('link', { name: 'Read more' });
    expect(link).toHaveAttribute('href', '/embed/support/chat/articles/art-1');
  });

  it('opens the article sheet over the thread when mounted at the nested route', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}));

    renderChatAt('/embed/support/chat/articles/art-1');

    // The sheet is open...
    expect(await screen.findByText('Refund timing')).toBeInTheDocument();
    // ...and the thread underneath it never unmounted: the player's own message
    // is still on screen, which is what a route that rendered SupportHome would
    // have destroyed along with the socket.
    expect(screen.getByText('my game crashed')).toBeInTheDocument();
  });

  it('leaves the sheet closed on the plain chat route', async () => {
    vi.mocked(fetchPlayerMessages).mockResolvedValue(messages({}));

    renderChatAt('/embed/support/chat');

    await waitFor(() => expect(screen.getByText('my game crashed')).toBeInTheDocument());
    expect(screen.queryByText('Refund timing')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && pnpm vitest run src/surfaces/webview/pages/SupportChat.test.tsx -t 'article delivery'`
Expected: FAIL — the mapper drops `article_id`, and nothing renders the sheet.

- [ ] **Step 3: Carry `article_id` through the mapper**

In `SupportChat.tsx`, extend `toChatMessage`'s parameter type and body:

```tsx
function toChatMessage(m: {
  id: string;
  author_type: ChatMessage['authorType'];
  body: string;
  created_at: string;
  delivery_state: NonNullable<ChatMessage['deliveryState']>;
  read_at: string | null;
  article_id: string | null;
}): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    readAt: m.read_at,
    articleId: m.article_id,
  };
}
```

- [ ] **Step 4: Render the sheet from the route param**

Add to `SupportChat.tsx`'s imports:

```tsx
import { useParams } from 'react-router-dom';
import { ArticleSheet } from '@/surfaces/webview/components/ArticleSheet';
import { useCloseOverlay } from '@/surfaces/webview/hooks/useCloseOverlay';
```

Inside the component, next to the existing hooks:

```tsx
/*
 * The article sheet is a route, not state, so Android's back button closes it —
 * and it is a route NESTED under chat so that opening it never unmounts this
 * screen. The socket stays connected, the thread keeps its scroll position, and
 * a bot or agent message arriving mid-read still lands.
 */
const { id: articleId } = useParams<{ id: string }>();
const closeArticle = useCloseOverlay('/embed/support/chat');
```

And render it just before the closing `</>` of the main return, after `<DebugDialog ... />`:

```tsx
{
  /* ArticleSheet fires its own once-per-session reportArticleRead and
          `article_read` bridge post. Correct: a player reading from a bot answer
          did read the article, and this is simply a third entry point to that
          signal. */
}
<ArticleSheet articleId={articleId ?? null} onClose={closeArticle} />;
```

Add the same element to the `unreachable` early-return branch **only if** the deep link should survive a backend outage — it should not: without the API there is no article to fetch, and `ArticleSheet` already renders its own failure copy. Leave that branch alone.

- [ ] **Step 5: Register the route**

In `frontend/src/surfaces/webview/main.tsx`, replace the single `chat` route with a nested pair:

```tsx
<Route
  path="chat"
  element={
    <Suspense fallback={null}>
      <SupportChat />
    </Suspense>
  }
>
  {/*
                Nested under chat, and rendering the SAME SupportChat element, so
                the sheet opens over a thread that never unmounted. Reusing
                /embed/support/articles/:id would render SupportHome instead —
                killing the socket and leaving the hardware back button stepping
                through local state that no longer exists.
              */}
  <Route path="articles/:id" element={null} />
</Route>
```

`element={null}` on the child is deliberate: `SupportChat` renders no `<Outlet />`, and the child exists only so the URL matches and `useParams` resolves inside the parent. If React Router logs a warning about it, use `<Route path="articles/:id" element={<Suspense fallback={null}><SupportChat /></Suspense>} />` as a sibling of `chat` instead — a sibling remounts `SupportChat`, so verify the "thread never unmounted" test still passes before choosing it.

- [ ] **Step 6: Run the test**

Run: `cd frontend && pnpm vitest run src/surfaces/webview/pages/SupportChat.test.tsx`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 7: Verify in the running app**

Run: `pnpm dev`, open `http://localhost:4000/docs` is not needed here — instead open the webview at `/embed/support/chat`, drive the bot to an `answer_from_article` turn, and confirm: the answer renders as markdown, "Read more" opens the sheet over the chat, closing it returns to chat (not home), and the composer/thread state survives.
Expected: all four. Record what you actually saw.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/webview/main.tsx frontend/src/surfaces/webview/pages/SupportChat.tsx frontend/src/surfaces/webview/pages/SupportChat.test.tsx
git commit -m "feat(webview): open the cited article over a live chat"
```

---

### Task 7: Agent console thread — markdown and "Read more"

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx` (`toChatMessage` at ~line 20)
- Modify: `frontend/src/features/chat/components/ChatThread.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx`
- Test: `frontend/src/features/chat/components/ChatThread.test.tsx`

**Depends on:** Task 2 (`AgentMessageView.article_id`), Task 4 (`MessageBody`, `ChatMessage.articleId`).

**Interfaces:**

- Consumes: `MessageBody`, `ChatMessage.articleId`, `AgentMessageView.article_id`.
- Produces: `ChatThread` renders bot/agent bodies as markdown and appends a new-tab `Read more` anchor to `/articles/:id`. Task 8 creates that route; the anchor is a plain `href` with `target="_blank"`, so it does not depend on Task 8 to render or to be tested.

Note the seam: `ChatThread` is shared code, but only the agent console mounts it — the webview has its own `ChatBubbles`. Editing it here is not a cross-surface change.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/features/chat/components/ChatThread.test.tsx`, add:

```tsx
describe('ChatThread article delivery', () => {
  it('renders a bot body as markdown', async () => {
    const { container } = render(
      <ChatThread
        messages={[message({ authorType: 'bot', body: 'Refunds take **48 hours**.' })]}
        currentAuthorType="agent"
      />,
    );

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'));
    expect(container.textContent).not.toContain('**');
  });

  it('renders a player body literally', async () => {
    const { container } = render(
      <ChatThread
        messages={[message({ authorType: 'player', body: 'my **game** crashed' })]}
        currentAuthorType="agent"
      />,
    );

    await waitFor(() => expect(screen.getByText('my **game** crashed')).toBeInTheDocument());
    expect(container.querySelector('strong')).toBeNull();
  });

  it('opens the cited article in a new tab, so the conversation stays on screen', async () => {
    render(
      <ChatThread
        messages={[message({ authorType: 'bot', body: 'answer', articleId: 'art-1' })]}
        currentAuthorType="agent"
      />,
    );

    const link = await screen.findByRole('link', { name: 'Read more' });
    expect(link).toHaveAttribute('href', '/articles/art-1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders no button when nothing was cited', async () => {
    render(
      <ChatThread
        messages={[message({ authorType: 'bot', body: 'answer' })]}
        currentAuthorType="agent"
      />,
    );

    await waitFor(() => expect(screen.getByText('answer')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Read more' })).not.toBeInTheDocument();
  });
});
```

Add `waitFor` and `screen` to that file's `@testing-library/react` import if absent.

In `ThreadPanel.test.tsx`, add `article_id: null` to the `agentMessage()` factory defaults, and one mapper test:

```tsx
it('carries article_id from the wire through to a Read more link', async () => {
  vi.mocked(fetchConversationMessages).mockResolvedValue({
    messages: [
      agentMessage({ author_type: 'bot', body: 'Refunds take 48 hours.', article_id: 'art-1' }),
    ],
  });

  renderThread();

  const link = await screen.findByRole('link', { name: 'Read more' });
  expect(link).toHaveAttribute('href', '/articles/art-1');
});
```

Use whatever render helper the file already defines in place of `renderThread()` and match its existing prop set.

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && pnpm vitest run src/features/chat/components/ChatThread.test.tsx src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx`
Expected: FAIL — literal `**`, no link.

- [ ] **Step 3: Carry `article_id` through the console mapper**

In `ThreadPanel.tsx`, add to `toChatMessage`'s returned object:

```ts
    articleId: m.article_id,
```

- [ ] **Step 4: Render markdown in `ChatThread`**

Add to `ChatThread.tsx`'s imports:

```tsx
import { Suspense } from 'react';
import { MessageBody } from './MessageBody.tsx';
```

Wrap the `<Virtuoso .../>` element in `<Suspense fallback={null}>` — one boundary for the thread, same reasoning as the webview: MessageBody's `ArticleBody` is lazy, and a per-bubble boundary would flash a fallback on every message as the list scrolls.

Replace the body paragraph:

```tsx
<p className="m-0">{chatMessage.body}</p>
```

with:

```tsx
{
  /* `agent` renders as markdown too, so article steps an agent
                    pasted read exactly like the bot's own answer. */
}
<div className="m-0">
  <MessageBody authorType={chatMessage.authorType} body={chatMessage.body} />
</div>;
```

Leave the `system` branch above untouched — it returns early and stays literal text.

No background fix is needed here: this bubble is `bg-accent-soft` / `bg-muted/10` / `bg-accent`, never `bg-surface`, so `ArticleBody`'s `code` and `pre` do not collide. Do not add the webview's wrapper utilities speculatively.

- [ ] **Step 5: Append the new-tab link**

In `ChatThread.tsx`, immediately after the `<time>` element inside the bubble:

```tsx
{
  /*
                  A plain anchor in a new tab, not in-app navigation: routing the
                  console to the article would hijack the conversation the agent
                  is reading. Client-appended from articleId — the model is never
                  asked to write a link.
                */
}
{
  chatMessage.articleId && (
    <a
      href={`/articles/${chatMessage.articleId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-flex items-center rounded-md border border-muted/30 px-2 py-0.5 text-xs font-medium underline underline-offset-2"
    >
      Read more
    </a>
  );
}
```

`articleId` is only ever non-null on a `bot` message, so no author guard is needed — but if a future path sets it on a player message, `MessageBody` still refuses to render that body as markdown, which is the property that matters.

- [ ] **Step 6: Run the tests**

Run: `cd frontend && pnpm vitest run src/features/chat src/surfaces/agent-console`
Expected: PASS, including every pre-existing `ChatThread` and `ThreadPanel` case.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/chat/components/ChatThread.tsx frontend/src/features/chat/components/ChatThread.test.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx
git commit -m "feat(console): render bot answers as markdown with a Read more link"
```

---

### Task 8: Agent console `/articles/:id` route

**Files:**

- Modify: `frontend/src/routes/AppRoutes.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.test.tsx` (create)

**Depends on:** nothing. Dispatch in Wave A.

**Interfaces:**

- Consumes: the existing `ArticleEditorSheet({ token, articleId, open, onOpenChange, onCreated })` — unchanged.
- Produces: route `/articles/:id` under `AgentConsoleShell`, mounting `KnowledgeBase` with the sheet already open on that article. Task 7's anchor targets it.

**Known wart, accepted (from the spec):** `/articles/:id` opens `ArticleEditorSheet`, an editor — so an agent who wanted to read lands in an edit form. In its own tab this is mild, and the alternative (a read-only preview drawer) is a new component for a secondary audience. Do not build the read-only mode in this task.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.test.tsx`. Mock whatever module `loadAgentSession`, `CategorySidebar`, `ArticleTable` and `ArticleEditorSheet` reach for data — read the four files first and mock only their API modules, not the components themselves:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { KnowledgeBase } from './KnowledgeBase.tsx';
import { loadAgentSession } from '../../lib/agentSession.ts';

vi.mock('../../lib/agentSession.ts');

beforeEach(() => {
  vi.mocked(loadAgentSession).mockReturnValue({ token: 't' } as never);
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/articles" element={<KnowledgeBase />} />
          <Route path="/articles/:id" element={<KnowledgeBase />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('KnowledgeBase route-driven selection', () => {
  it('opens the sheet on the article named by the route', async () => {
    renderAt('/articles/art-1');

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('leaves the sheet closed on the plain list route', async () => {
    renderAt('/articles');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
```

If `ArticleEditorSheet` does not expose `role="dialog"` in jsdom, assert on its heading text or on a mocked API call for `art-1` instead — read the component and pick an assertion that reflects "the sheet is open on this article", not an implementation detail.

- [ ] **Step 2: Run and watch it fail**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.test.tsx`
Expected: FAIL — no dialog on the `:id` route; selection lives only in local state.

- [ ] **Step 3: Seed selection from the route param**

Rewrite `KnowledgeBase.tsx` to seed both pieces of state from the param and navigate back to the list on close:

```tsx
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { CategorySidebar } from './components/CategorySidebar.tsx';
import { ArticleTable } from './components/ArticleTable.tsx';
import { ArticleEditorSheet } from './components/ArticleEditorSheet.tsx';

export function KnowledgeBase() {
  const session = loadAgentSession();
  /*
   * Route param seeds selection so /articles/:id is a real deep link — that is
   * what a conversation's "Read more" opens, in its own tab, and it is also what
   * lets an agent share an article by URL. In-page selection still works exactly
   * as before: it sets state and does not touch the URL, so nothing about the
   * list's own behaviour changes.
   */
  const { id: routeArticleId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(routeArticleId ?? null);
  const [sheetOpen, setSheetOpen] = useState(routeArticleId !== undefined);

  if (!session) return null;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0">
        <CategorySidebar token={session.token} />
      </div>
      <div className="min-w-0 flex-1">
        <ArticleTable
          token={session.token}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setSheetOpen(true);
          }}
          onNew={() => {
            setSelectedId(null);
            setSheetOpen(true);
          }}
        />
      </div>
      <ArticleEditorSheet
        token={session.token}
        articleId={selectedId}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          if (!open) {
            setSelectedId(null);
            // Closing a deep-linked sheet must also leave the deep link, or the
            // URL still names an article that is no longer on screen — and a
            // reload would reopen it.
            if (routeArticleId) navigate('/articles', { replace: true });
          }
        }}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Register the route**

In `frontend/src/routes/AppRoutes.tsx`, add below the existing `articles` route, mirroring how `inbox/:conversationId` sits beside `inbox`:

```tsx
<Route path="articles/:id" element={<KnowledgeBase />} />
```

- [ ] **Step 5: Run the test**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and run the console suite**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console && pnpm typecheck`
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/routes/AppRoutes.tsx frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.test.tsx
git commit -m "feat(console): deep-linkable /articles/:id"
```

---

## Final Verification (after all waves)

- [ ] `pnpm typecheck` — clean across the workspace
- [ ] `pnpm test` — every package green (the API suite needs Postgres up and `pnpm db:setup` run since Task 1)
- [ ] `pnpm dev`, then end to end: ask the bot something an article answers → the answer renders as markdown in the webview with "Read more" → the sheet opens over the live chat → closing returns to chat → the same conversation in the agent console shows the same markdown answer with a "Read more" that opens `/articles/:id` in a new tab
- [ ] `http://localhost:4000/docs/json` contains `article_id`
- [ ] `grep -rn "rehype-raw" frontend/src` returns nothing
- [ ] Confirm no pre-existing message broke: an old thread with `article_id` null renders exactly as before, with no button

## Deliberately Not In Scope

Named here so nobody adds them "while they're in there":

- A `message.article_title` column, or any snapshotted label for the button.
- Server-side filtering of buttons by published status. An unpublished article 404s at the player endpoint and `ArticleSheet` already degrades to _"This article could not be loaded. Close and try another."_ — a join on every thread fetch to prevent a handled failure is the wrong trade.
- Any change to `bot_article_offered`, `confirm_phase`, `confirm_resolution`, or the `bot_article_rejected` → `handoff('article_rejected')` wiring.
- A read-only mode on `ArticleEditorSheet` (see Task 8's accepted wart).
- Any index on `message.article_id`.
- Documenting the `/surface/conversations/active` response envelope in OpenAPI (Task 2 leaves it as it is today and flags it).
