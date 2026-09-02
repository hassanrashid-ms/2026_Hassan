# Bot Config Test Chat Forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Bot Config's test chat produces a handoff decision for a subintent with a real published form, resolve that form read-only and render it interactively in the test chat, same as a real player sees it.

**Architecture:** Backend resolves the form via `resolveSubintentForm` inside a `withWorkspace` transaction (read-only, no persistence) and adds it to the wire decision. Frontend relocates the existing `FormLivePreview`/`MobilePreviewFrame` components to the surface's shared `components/` folder and renders `FormLivePreview` in `BotTestPanel` when a handoff decision carries a form.

**Tech Stack:** Express/TypeScript/Drizzle backend, React/Vite frontend, Vitest.

## Global Constraints

- No DB writes for test-turn requests — `formSubmission` is never inserted, `conversation.confirmPhase` in the database is never touched (per spec's Non-goals).
- `resolveSubintentForm` must be called with a `Tx` from `withWorkspace(workspaceId, ...)` — RLS's `set_config` is transaction-scoped.
- A handoff with `reason: 'asked_for_person'` never resolves a form, mirroring `applyBotTurn.ts`'s own guard.
- Frontend surfaces convention: no cross-surface imports; `FormLivePreview`/`MobilePreviewFrame` move to `frontend/src/surfaces/agent-console/components/`, still inside the `agent-console` surface.
- No hand-written CSS; Tailwind v4 utilities only.

---

### Task 1: Extend `BotTestTurnDecision`'s handoff variant with a resolved form

**Files:**
- Modify: `packages/types/src/bot.ts:150`

**Interfaces:**
- Produces: `BotTestTurnDecision`'s `handoff` case gains `form: { form_id: string; form_name: string; version: number; fields: FormField[] } | null`.

- [ ] **Step 1: Add the `FormField` import and extend the type**

At the top of `packages/types/src/bot.ts`, add:

```ts
import type { FormField } from './forms.ts';
```

Change line 150 from:

```ts
| { kind: 'handoff'; reason: BotTestTurnHandoffReason; subintent_id: string | null }
```

to:

```ts
| {
    kind: 'handoff';
    reason: BotTestTurnHandoffReason;
    subintent_id: string | null;
    form: { form_id: string; form_name: string; version: number; fields: FormField[] } | null;
  }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: fails in `backend/src/domain/bot/botTestTurn.ts` (the `handoff` case in `toWireDecision` no longer matches the type) and possibly in `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.tsx` / `ToolActivityStrip.tsx` if either destructures the handoff shape exhaustively. This is expected — Task 2 and Task 4 fix these. Confirm the only failures are in those files.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/bot.ts
git commit -m "Add resolved form to BotTestTurnDecision's handoff variant"
```

---

### Task 2: Resolve the subintent's form in `runTestBotTurn`, without persisting anything

**Files:**
- Modify: `backend/src/domain/bot/botTestTurn.ts`
- Test: `backend/tests/botTestTurn.test.ts`

**Interfaces:**
- Consumes: `resolveSubintentForm(tx: Tx, subintentId: string): Promise<ResolvedForm | null>` from `backend/src/domain/forms/resolveSubintentForm.ts` (`ResolvedForm = { formId: string; formName: string; version: number; fields: FormField[] }`); `withWorkspace(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T>` from `backend/src/shared/db/withWorkspace.ts`.
- Produces: `runTestBotTurn`'s `handoff` decisions now carry `form`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/botTestTurn.test.ts`. First add these imports at the top, alongside the existing ones:

```ts
import { seedForm, seedFormVersion, seedIntent, seedSubintent } from './helpers/db.ts';
```

Then, inside the `describe('runTestBotTurn', ...)` block, add:

```ts
it('resolves and attaches a published form when the handoff subintent has one', async () => {
  const workspaceId = await seedWorkspace();
  const agentId = await seedAgent(workspaceId);
  const intentId = await seedIntent(workspaceId);
  const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
  await seedFormVersion({
    workspaceId,
    formId,
    version: 1,
    fields: [
      { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['A', 'B'] },
    ],
    publishedAt: new Date(),
  });
  const subintentId = await seedSubintent({ workspaceId, intentId, formId });

  mockCallModel.mockResolvedValueOnce({
    toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"no_article"}' }],
    text: null,
  });

  const decision = await runTestBotTurn(
    { agentId, workspaceId, isAdmin: true },
    baseBody({ subintent_id: subintentId }),
  );

  expect(decision).toMatchObject({
    kind: 'handoff',
    reason: 'no_article',
    subintent_id: subintentId,
    form: { form_id: formId, form_name: 'Purchase receipt', version: 1 },
  });
});

it('returns form: null when the handoff subintent has no published form', async () => {
  const workspaceId = await seedWorkspace();
  const agentId = await seedAgent(workspaceId);
  const intentId = await seedIntent(workspaceId);
  const subintentId = await seedSubintent({ workspaceId, intentId });

  mockCallModel.mockResolvedValueOnce({
    toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"no_article"}' }],
    text: null,
  });

  const decision = await runTestBotTurn(
    { agentId, workspaceId, isAdmin: true },
    baseBody({ subintent_id: subintentId }),
  );

  expect(decision).toMatchObject({ kind: 'handoff', form: null });
});

it('never attaches a form when the handoff reason is asked_for_person, even with a published form', async () => {
  const workspaceId = await seedWorkspace();
  const agentId = await seedAgent(workspaceId);
  const intentId = await seedIntent(workspaceId);
  const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
  await seedFormVersion({
    workspaceId,
    formId,
    version: 1,
    fields: [
      { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['A', 'B'] },
    ],
    publishedAt: new Date(),
  });
  const subintentId = await seedSubintent({ workspaceId, intentId, formId });

  mockCallModel.mockResolvedValueOnce({
    toolCalls: [{ id: 't1', name: 'handoff', arguments: '{"reason":"asked_for_person"}' }],
    text: null,
  });

  const decision = await runTestBotTurn(
    { agentId, workspaceId, isAdmin: true },
    baseBody({ subintent_id: subintentId }),
  );

  expect(decision).toMatchObject({ kind: 'handoff', reason: 'asked_for_person', form: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test botTestTurn.test.ts`
Expected: FAIL — `decision.form` is `undefined`, not matching `form: {...}` / `form: null`.

- [ ] **Step 3: Implement**

In `backend/src/domain/bot/botTestTurn.ts`, add imports:

```ts
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { resolveSubintentForm, type ResolvedForm } from '../forms/resolveSubintentForm.ts';
```

Change `runTestBotTurn` to resolve the form after getting `decision`, and pass it into `toWireDecision`:

```ts
const decision = await toolLoopDecider(input, { config, transcript });

const resolvedForm =
  decision.kind === 'handoff' &&
  decision.subintentId !== null &&
  decision.reason !== 'asked_for_person'
    ? await withWorkspace(ctx.workspaceId, (tx) => resolveSubintentForm(tx, decision.subintentId!))
    : null;

return toWireDecision(decision, resolvedForm);
```

Update `toWireDecision`'s signature and its `handoff` case:

```ts
function toWireDecision(
  decision: BotTurnDecision,
  resolvedForm: ResolvedForm | null,
): BotTestTurnDecision {
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
        return {
          kind: 'handoff',
          reason: decision.reason,
          subintent_id: decision.subintentId,
          form: resolvedForm
            ? {
                form_id: resolvedForm.formId,
                form_name: resolvedForm.formName,
                version: resolvedForm.version,
                fields: resolvedForm.fields,
              }
            : null,
        };
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
  return (
    decision.searches
      ? {
          ...base,
          searches: decision.searches.map((s) => ({ query: s.query, results: s.results })),
        }
      : base
  ) as BotTestTurnDecision;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test botTestTurn.test.ts`
Expected: PASS (all tests in the file, including the three pre-existing ones).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: still fails only in the frontend files touched by Task 4 (`BotTestPanel.tsx`), not in backend.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/bot/botTestTurn.ts backend/tests/botTestTurn.test.ts
git commit -m "Resolve subintent form on test-chat handoff decisions"
```

---

### Task 3: Relocate `FormLivePreview` and `MobilePreviewFrame` to the surface's shared components

**Files:**
- Move: `frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.tsx` → `frontend/src/surfaces/agent-console/components/FormLivePreview.tsx`
- Move: `frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.test.tsx` → `frontend/src/surfaces/agent-console/components/FormLivePreview.test.tsx`
- Move: `frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.tsx` → `frontend/src/surfaces/agent-console/components/MobilePreviewFrame.tsx`
- Move: `frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.test.tsx` → `frontend/src/surfaces/agent-console/components/MobilePreviewFrame.test.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx:43`

**Interfaces:**
- Produces: `FormLivePreview` and `MobilePreviewFrame` importable from `frontend/src/surfaces/agent-console/components/FormLivePreview.tsx` / `MobilePreviewFrame.tsx`. No change to either component's props or behavior.

- [ ] **Step 1: Move the four files**

```bash
git mv frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.tsx frontend/src/surfaces/agent-console/components/FormLivePreview.tsx
git mv frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.test.tsx frontend/src/surfaces/agent-console/components/FormLivePreview.test.tsx
git mv frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.tsx frontend/src/surfaces/agent-console/components/MobilePreviewFrame.tsx
git mv frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.test.tsx frontend/src/surfaces/agent-console/components/MobilePreviewFrame.test.tsx
```

No import paths inside these four files need to change: `FormLivePreview.tsx`'s import of `MobilePreviewFrame.tsx` is `./MobilePreviewFrame.tsx` and both moved together; each test's import of its component is also `./<Component>.tsx`.

- [ ] **Step 2: Update the one remaining import site**

In `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx:43`, change:

```ts
import { FormLivePreview } from './FormLivePreview.tsx';
```

to:

```ts
import { FormLivePreview } from '../../../components/FormLivePreview.tsx';
```

- [ ] **Step 3: Run the moved tests and the Forms suite**

Run: `pnpm --filter frontend test FormLivePreview MobilePreviewFrame FormEditorSheet`
Expected: PASS, no changes needed to test content.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: no errors from these files (backend/Task-2 pieces already clean; only `BotTestPanel.tsx` from Task 1 may still fail, fixed in Task 4).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/FormLivePreview.tsx frontend/src/surfaces/agent-console/components/FormLivePreview.test.tsx frontend/src/surfaces/agent-console/components/MobilePreviewFrame.tsx frontend/src/surfaces/agent-console/components/MobilePreviewFrame.test.tsx frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx
git commit -m "Relocate FormLivePreview and MobilePreviewFrame to agent-console/components"
```

---

### Task 4: Render the resolved form in the test chat

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx`

**Interfaces:**
- Consumes: `FormLivePreview({ formName: string; fields: FormField[] })` from `frontend/src/surfaces/agent-console/components/FormLivePreview.tsx` (Task 3); `BotTestTurnDecision`'s `handoff.form: { form_id, form_name, version, fields } | null` (Task 1/2).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx`, inside the `describe('BotTestPanel', ...)` block:

```ts
it('renders the resolved form when a handoff decision carries one', async () => {
  vi.mocked(testBotTurn).mockResolvedValueOnce({
    decision: {
      kind: 'handoff',
      reason: 'no_article',
      subintent_id: 'sub-1',
      form: {
        form_id: 'form-1',
        form_name: 'Purchase receipt',
        version: 1,
        fields: [
          { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['A', 'B'] },
        ],
      },
    },
  });

  renderPanel();
  const input = await screen.findByLabelText('Message');
  await userEvent.type(input, 'my purchase is missing');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(await screen.findByTestId('mobile-preview-frame')).toBeInTheDocument();
  expect(screen.getByText('Store')).toBeInTheDocument();
});

it('renders no form panel when a handoff decision carries none', async () => {
  vi.mocked(testBotTurn).mockResolvedValueOnce({
    decision: { kind: 'handoff', reason: 'unsure', subintent_id: null, form: null },
  });

  renderPanel();
  const input = await screen.findByLabelText('Message');
  await userEvent.type(input, 'hello');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(testBotTurn).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('mobile-preview-frame')).not.toBeInTheDocument();
});

it('clears the form panel on reset', async () => {
  vi.mocked(testBotTurn).mockResolvedValueOnce({
    decision: {
      kind: 'handoff',
      reason: 'no_article',
      subintent_id: 'sub-1',
      form: {
        form_id: 'form-1',
        form_name: 'Purchase receipt',
        version: 1,
        fields: [
          { key: 'store', label: 'Store', type: 'choice', isRequired: true, position: 0, options: ['A', 'B'] },
        ],
      },
    },
  });

  renderPanel();
  const input = await screen.findByLabelText('Message');
  await userEvent.type(input, 'my purchase is missing');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByTestId('mobile-preview-frame');

  await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(screen.queryByTestId('mobile-preview-frame')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter frontend test BotTestPanel.test.tsx`
Expected: FAIL — no `mobile-preview-frame` is ever rendered, and (for the first two tests) a TypeScript error on the `form` field of the mocked decision until Task 1's type change is picked up (it already is, from Task 1) — the runtime failure is the missing render.

- [ ] **Step 3: Implement**

In `frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.tsx`:

Add imports:

```ts
import type { FormField } from '@support/types';
import { FormLivePreview } from '../../../components/FormLivePreview.tsx';
```

Update `nextConfirmPhase`'s doc comment and `handoff` branch — replace the whole function with:

```ts
/**
 * Mirrors applyBotTurn.ts's confirm_phase transitions. The `handoff` branch now
 * matches the real path exactly: a handoff whose subintent resolved to a
 * published form maps to 'form', same as a real conversation's column: any
 * other handoff maps to 'none'.
 */
function nextConfirmPhase(
  decision: BotTestTurnDecision,
  current: ConfirmPhaseValue,
): ConfirmPhaseValue {
  switch (decision.kind) {
    case 'answer':
      return decision.article_id ? 'bot_article' : current;
    case 'confirm_player_resolution':
      return 'player_stated';
    case 'handoff':
      return decision.form ? 'form' : 'none';
    case 'resolve':
    case 'unavailable':
      return 'none';
    case 'noop':
      return current;
  }
}
```

Add state, alongside the existing `useState` calls in `BotTestPanel`:

```ts
const [activeTestForm, setActiveTestForm] = useState<{ formName: string; fields: FormField[] } | null>(null);
```

In `reset`, clear it too:

```ts
const reset = () => {
  setMessages([]);
  setSubintentId(null);
  setConfirmPhase('none');
  setActiveTestForm(null);
};
```

In `send`, right after `setConfirmPhase((prev) => nextConfirmPhase(decision, prev));`, add:

```ts
setActiveTestForm(
  decision.kind === 'handoff' && decision.form
    ? { formName: decision.form.form_name, fields: decision.form.fields }
    : null,
);
```

In the JSX, render the form between the message list `div` and `<Composer>`:

```tsx
      <div className="min-h-0 flex-1">
        <ChatThread messages={messages} currentAuthorType="agent" isTyping={sending} />
        {messages.map(
          (m) =>
            m.toolActivity && (
              <div key={`activity-${m.id}`} className="px-3">
                {m.toolActivity}
              </div>
            ),
        )}
      </div>
      {activeTestForm && (
        <div className="border-t border-slate-200 p-4">
          <FormLivePreview formName={activeTestForm.formName} fields={activeTestForm.fields} />
        </div>
      )}
      <Composer onSend={(body) => void send(body)} disabled={sending || !draft} />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter frontend test BotTestPanel.test.tsx`
Expected: PASS (all tests in the file, including the three pre-existing ones).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS, no errors anywhere.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.tsx frontend/src/surfaces/agent-console/pages/BotConfig/components/BotTestPanel.test.tsx
git commit -m "Show the resolved form in Bot Config's test chat on handoff"
```

---

### Final validation

After all four tasks are committed, run the full suite once and confirm against the spec's Goal/Non-goals:

Run: `pnpm typecheck && pnpm test`

Checklist against `docs/specs/2026-09-02-bot-config-test-chat-forms-design.md`:
- [ ] A handoff to a subintent with a published form shows an interactive `FormCard` in the test chat, styled via `MobilePreviewFrame` — Task 4.
- [ ] No `formSubmission` row is written and no real `conversation` row's `confirmPhase` is touched for a test turn — Task 2 never opens a mutating transaction; `withWorkspace` here only reads.
- [ ] A handoff with `reason: 'asked_for_person'` never resolves or attaches a form — Task 2's guard, tested.
- [ ] `FormLivePreview`/`MobilePreviewFrame` live in `agent-console/components/`, not `pages/Forms/components/` — Task 3.
- [ ] Resetting the test conversation clears the shown form — Task 4.
