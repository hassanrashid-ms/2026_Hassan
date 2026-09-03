/com# Bot Config test chat: show forms on handoff

## Problem

Bot Config's "test chat" (`BotTestPanel.tsx`) lets an admin simulate a conversation with the bot without touching real players or the database. When the bot's decision loop produces a handoff for a subintent that has a real published form (e.g. "Account recovery"), a real player would be shown that form — but the test chat never surfaces it at all. `BotTestPanel.tsx`'s `nextConfirmPhase` hardcodes every handoff to `confirm_phase: 'none'`, with an explicit comment noting this is because the wire decision carries no form data and the endpoint never looks one up. An admin testing the bot's configuration has no way to see whether, or what, form a given subintent hands a player into.

## Goal

When the test chat's bot decision is a handoff and the subintent has a real published form, show that form in the test chat: interactive, styled exactly like the mobile webview, pinned above the composer — the same experience `SupportChat.tsx` gives a real player. Zero persistence: no DB writes, no fake conversation or submission rows, consistent with test chat's existing "never touches real data" guarantee.

## Non-goals

- No change to the real player-facing handoff/form flow (`applyBotTurn.ts`, `resolveSubintentForm.ts` itself, `formSubmission` persistence).
- No support for resuming a test-chat form across a page reload — it's session-local UI state, same as the rest of `BotTestPanel`.

## Design

### 1. Backend: resolve the form on handoff, without persisting anything

`runTestBotTurn` (`backend/src/domain/bot/botTestTurn.ts`) already computes a `BotTurnDecision`. When that decision is `kind: 'handoff'` with a non-null `subintentId`, and the reason isn't `'asked_for_person'` (mirroring `applyBotTurn`'s own guard, since that reason never routes to a form for real players either), look the form up read-only:

```ts
const resolvedForm =
  decision.kind === 'handoff' &&
  decision.subintentId !== null &&
  decision.reason !== 'asked_for_person'
    ? await withWorkspace(ctx.workspaceId, (tx) => resolveSubintentForm(tx, decision.subintentId!))
    : null;
```

`resolveSubintentForm(tx, subintentId)` (`backend/src/domain/forms/resolveSubintentForm.ts`) is already read-only and side-effect-free — it just queries for a published, non-archived form and returns `{ formId, formName, version, fields } | null`. It requires a `Tx`, and RLS's `set_config('app.workspace_id', ...)` is transaction-scoped, so it must run inside `withWorkspace`, not against a bare `db` client or a separate transaction — this is a genuine (if short) transaction, not a schema change or a write.

No `formSubmission` row is created and `conversation.confirmPhase` in the database is never touched — there is no real conversation for a test turn to update.

### 2. Wire contract: carry the resolved form on the handoff decision

Extend `BotTestTurnDecision`'s `handoff` case (`packages/types/src/bot.ts`):

```ts
| {
    kind: 'handoff';
    reason: BotTestTurnHandoffReason;
    subintent_id: string | null;
    form: { form_id: string; form_name: string; version: number; fields: FormField[] } | null;
  }
```

`toWireDecision` in `botTestTurn.ts` populates `form` from the `resolvedForm` lookup above (or `null` when there's no form, same as a real handoff that doesn't route to one).

### 3. Frontend: relocate the shared preview components

`FormLivePreview.tsx` and `MobilePreviewFrame.tsx` currently live under `agent-console/pages/Forms/components/`, built for the Forms builder's live preview. Bot Config now needs the same components. Both move to `frontend/src/surfaces/agent-console/components/` (still inside the `agent-console` surface — no cross-surface import, just promoted from one page's folder to the surface's shared components, the same role `agent-console/components/ui/*` already plays). Three import sites update: `FormEditorSheet.tsx`, and each moved file's own test.

### 4. Frontend: render the form in the test chat

`BotTestPanel.tsx` gains local state:

```ts
const [activeTestForm, setActiveTestForm] = useState<{ formName: string; fields: FormField[] } | null>(null);
```

In the turn handler (`send`, around lines 86-134), when the response decision is `kind: 'handoff'` and carries a non-null `form`, set `activeTestForm` from `{ formName: decision.form.form_name, fields: decision.form.fields }`; otherwise (any other decision kind, or a handoff with `form: null`) clear it to `null`. `nextConfirmPhase` reflects this too — a handoff whose lookup found a form now maps to `'form'` (matching what a real conversation's `confirm_phase` would become), not the previous hardcoded `'none'`; every other case is unchanged.

Render the form between the message list and the composer:

```tsx
{activeTestForm && (
  <div className="border-t border-slate-200 p-4">
    <FormLivePreview formName={activeTestForm.formName} fields={activeTestForm.fields} />
  </div>
)}
<Composer onSend={(body) => void send(body)} disabled={sending || !draft} />
```

`FormLivePreview` already does everything needed here unmodified: builds a synthetic `PlayerFormView`, wires `FormCard` to fully local/mocked handlers (no network calls), remounts on field-set changes, and shows "Preview complete." + restart after submit/skip. Whatever conversation-reset control `BotTestPanel` already has for starting a fresh test conversation also clears `activeTestForm` back to `null`.

### Data flow

```
BotTestPanel: admin sends a test message
        │
        ▼
POST /agent/bot-config/test-turn  →  runTestBotTurn
        │                                   │
        │                       toolLoopDecider → BotTurnDecision
        │                                   │
        │                    kind === 'handoff' && subintentId && reason !== 'asked_for_person'?
        │                                   │
        │                     withWorkspace(tx => resolveSubintentForm(tx, id))  (read-only)
        │                                   │
        ▼                                   ▼
BotTestTurnDecision { kind: 'handoff', ..., form: ResolvedForm | null }
        │
        ▼
BotTestPanel: form !== null → setActiveTestForm({ formName, fields })
        │
        ▼
<FormLivePreview formName fields />  (MobilePreviewFrame + FormCard, fully mocked, no persistence)
```

### Testing

- Backend: `resolveSubintentForm` is already tested; add a case to `botTestTurn`'s existing test(s) confirming a handoff decision for a subintent with a published form returns `form: {...}`, one without a form returns `form: null`, and a handoff with `reason: 'asked_for_person'` never looks a form up at all (no query issued — assert via a spy, matching the real-path guard).
- Frontend: relocate `FormLivePreview.test.tsx`/`MobilePreviewFrame.test.tsx` alongside their moved components, unchanged. Add a `BotTestPanel.test.tsx` case: a mocked `testBotTurn` response with a handoff decision carrying `form` renders the mobile preview panel and the field labels; a handoff with `form: null` renders no such panel.

## Alternatives considered

**Persist a real (flagged) `formSubmission` row for test turns.** Rejected — adds cleanup/flagging burden and contradicts test chat's existing guarantee that it never writes real data; a synthetic in-memory `PlayerFormView`-shaped object (what `FormLivePreview` already builds) is sufficient since the preview is already fully mocked/local by design.

**Build a separate, simpler form renderer scoped to Bot Config only.** Rejected — `FormLivePreview` already does exactly what's needed (mobile-accurate styling, mocked interaction, remount-on-change) with zero new code; a second renderer would duplicate it for no behavioral difference.
