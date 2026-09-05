# Admin Forms Live Mobile Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the admin Forms builder a live, interactive preview that renders a draft form with the exact same component a player sees in the mobile webview, styled to match mobile exactly.

**Architecture:** Extract the player-facing `FormCard` out of the `webview` surface into shared `features/forms/`, wire a new `FormLivePreview` component in `agent-console`'s `FormEditorSheet` that feeds it the in-progress draft fields with fully local/mocked answer handlers, and wrap it in a `MobilePreviewFrame` that scopes webview's real theme colors and mobile type scale via inline CSS variables.

**Tech Stack:** React, TypeScript, Vitest + React Testing Library, Tailwind v4 (utility classes only), `@support/types` shared contract.

## Global Constraints

- Tailwind v4 utilities only — no hand-written CSS classes. Exception: `MobilePreviewFrame` sets webview's literal theme values as **inline CSS custom properties** (a scoped runtime value, not a hand-written stylesheet class), per the design's fidelity approach.
- `frontend/src/surfaces/**` may never cross-import between surfaces — shared code lives in `frontend/src/features/**` (spec: `docs/specs/2026-09-02-admin-forms-live-preview-design.md`).
- No backend changes, no new endpoints — the preview is fully client-local.
- `FormCard`'s public props (`form`, `onAnswer`, `onSubmit`, `onSkip`, `busy`, `onUploadAttachment`, `onSendAttachment`) must not change — the real webview caller depends on them unchanged.
- Test command for this package: `pnpm --filter @support/web test <file-substring>` (runs `vitest run <file-substring>`).

---

### Task 1: Extract `FormCard` into `features/forms/`

**Files:**

- Create: `frontend/src/features/forms/lib/cn.ts`
- Move: `frontend/src/surfaces/webview/components/chat/FormCard.tsx` → `frontend/src/features/forms/components/FormCard.tsx`
- Move: `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx` → `frontend/src/features/forms/components/FormCard.test.tsx`
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx:10`

**Interfaces:**

- Consumes: nothing new.
- Produces: `FormCard` importable from `@/features/forms/components/FormCard`, with an unchanged prop signature (`FormCardProps` in the moved file). `cn` importable from `@/features/forms/lib/cn`. Tasks 3 and 4 import `FormCard` from this new path.

- [ ] **Step 1: Move the two files with git, preserving history**

```bash
mkdir -p frontend/src/features/forms/components frontend/src/features/forms/lib
git mv frontend/src/surfaces/webview/components/chat/FormCard.tsx frontend/src/features/forms/components/FormCard.tsx
git mv frontend/src/surfaces/webview/components/chat/FormCard.test.tsx frontend/src/features/forms/components/FormCard.test.tsx
```

- [ ] **Step 2: Create `features/forms/lib/cn.ts`**

Every surface owns an independent copy of this same tiny wrapper (see `frontend/src/surfaces/webview/lib/cn.ts` and `frontend/src/surfaces/agent-console/lib/cn.ts`) rather than sharing one — `features/forms/` needs its own for the same reason.

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class merger. Lives inside features/forms/, not a surface's own
 *  copy or a shared top-level lib/, so this feature has no dependency on
 *  either surface's Tailwind-shaped helpers. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Update imports at the top of the moved `FormCard.tsx`**

Find:

```ts
import { SupportButton } from '@/surfaces/webview/components/SupportButton';
import { post } from '@/services/bridgeService';
import { cn } from '@/surfaces/webview/lib/cn';
```

Replace with:

```ts
import { post } from '@/services/bridgeService';
import { cn } from '@/features/forms/lib/cn';
```

`SupportButton` is webview-surface-only (hand-built for "no mouse, game-scale touch targets"); `features/` components hand-write token-based Tailwind directly instead of importing a surface's button, matching the existing precedent in `features/chat/components/Composer.tsx`.

- [ ] **Step 4: Replace the `SupportButton` usage with an inline button**

Find (inside the `FormCard` component's return block):

```tsx
<SupportButton
  variant="primary"
  className="w-full"
  // A required field must have a value before Next may advance.
  disabled={disabled || currentRequiredUnanswered}
  onClick={() => void advance()}
>
  {isLast ? 'Submit' : 'Next'}
</SupportButton>
```

Replace with:

```tsx
<button
  type="button"
  className={cn(
    'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-card px-5 py-3',
    'text-base font-semibold transition-colors outline-none disabled:opacity-50',
    'bg-accent text-accent-fg active:bg-accent-deep',
  )}
  // A required field must have a value before Next may advance.
  disabled={disabled || currentRequiredUnanswered}
  onClick={() => void advance()}
>
  {isLast ? 'Submit' : 'Next'}
</button>
```

This reproduces `SupportButton`'s `primary` variant classes exactly (compare `frontend/src/surfaces/webview/components/SupportButton.tsx`), so rendered output is unchanged.

- [ ] **Step 5: Run the moved test file to confirm nothing broke**

Run: `pnpm --filter @support/web test FormCard.test.tsx`
Expected: PASS — all existing `FormCard` tests pass unchanged (they only assert on rendered text/roles, not on which component supplied the button).

- [ ] **Step 6: Update the webview caller's import path**

In `frontend/src/surfaces/webview/pages/SupportChat.tsx`, find:

```ts
import { FormCard } from '@/surfaces/webview/components/chat/FormCard';
```

Replace with:

```ts
import { FormCard } from '@/features/forms/components/FormCard';
```

- [ ] **Step 7: Run the webview page's own test suite to confirm the rewire didn't break it**

Run: `pnpm --filter @support/web test SupportChat.test.tsx`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/forms frontend/src/surfaces/webview/pages/SupportChat.tsx
git status --short frontend/src/surfaces/webview/components/chat
git commit -m "Extract FormCard into features/forms for cross-surface reuse"
```

---

### Task 2: `MobilePreviewFrame` — scoped webview theming

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.test.tsx`

**Interfaces:**

- Consumes: nothing new.
- Produces: `MobilePreviewFrame({ children }: { children: ReactNode })` — a React component, default export not used (named export). Renders a `data-testid="mobile-preview-frame"` root element. Task 3 wraps its rendered `FormCard` in this.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobilePreviewFrame } from './MobilePreviewFrame.tsx';

describe('MobilePreviewFrame', () => {
  it('renders its children', () => {
    render(
      <MobilePreviewFrame>
        <p>Hello</p>
      </MobilePreviewFrame>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('scopes webview theme colors and the mobile base font size to the frame', () => {
    render(
      <MobilePreviewFrame>
        <p>Hello</p>
      </MobilePreviewFrame>,
    );
    const frame = screen.getByTestId('mobile-preview-frame');
    expect(frame.style.getPropertyValue('--color-accent')).toBe('#7c3aed');
    expect(frame.style.getPropertyValue('--color-bg')).toBe('#ffffff');
    expect(frame.style.fontSize).toBe('16px');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @support/web test MobilePreviewFrame.test.tsx`
Expected: FAIL — `MobilePreviewFrame.tsx` does not exist yet.

- [ ] **Step 3: Implement `MobilePreviewFrame`**

```tsx
import type { ReactNode } from 'react';

/**
 * webview.css's actual `@theme` values (frontend/src/webview.css), duplicated
 * here rather than imported: importing webview.css into agent-console would
 * leak Tailwind's preflight reset across surfaces (see app/CLAUDE.md's
 * Styling section), so this is the deliberate exception to "utilities only" —
 * a scoped runtime value, not a hand-written stylesheet class.
 */
const WEBVIEW_THEME_VARS: Record<string, string> = {
  '--color-bg': '#ffffff',
  '--color-surface': '#f5f3fd',
  '--color-accent': '#7c3aed',
  '--color-accent-deep': '#5b21b6',
  '--color-accent-soft': '#ede9fe',
  '--color-accent-fg': '#ffffff',
  '--color-text': '#1a1720',
  '--color-muted': '#6b6577',
  '--radius-card': '1rem',
};

/**
 * Renders children with the webview surface's real colors and mobile type
 * scale, scoped to this container. webview.css sizes its root font with
 * `clamp(14px, 4.27vw, 22px)`, driven by actual viewport width — meaningless
 * inside a fixed-width box on a wide desktop page — so this frame hardcodes
 * 16px, the value that formula resolves to at its 375px reference width.
 */
export function MobilePreviewFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="mobile-preview-frame"
      style={{ ...WEBVIEW_THEME_VARS, fontSize: '16px' }}
      className="mx-auto flex max-h-[700px] w-[375px] flex-col gap-4 overflow-y-auto rounded-[2rem] border border-black/10 bg-[var(--color-bg)] p-4 text-[var(--color-text)]"
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/web test MobilePreviewFrame.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.tsx frontend/src/surfaces/agent-console/pages/Forms/components/MobilePreviewFrame.test.tsx
git commit -m "Add MobilePreviewFrame for pixel-faithful admin form previews"
```

---

### Task 3: `FormLivePreview` — mocked, self-resetting preview session

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.test.tsx`

**Interfaces:**

- Consumes: `MobilePreviewFrame` from Task 2 (`./MobilePreviewFrame.tsx`); `FormCard` from Task 1 (`@/features/forms/components/FormCard`); `FormField`, `PlayerFormView` types from `@support/types`.
- Produces: `FormLivePreview({ formName, fields }: { formName: string; fields: FormField[] })`. Task 4 renders this with `FormEditorSheet`'s live `name`/`fields` state.

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FormField } from '@support/types';
import { FormLivePreview } from './FormLivePreview.tsx';

const CHOICE_FIELD: FormField = {
  key: 'store',
  label: 'Store',
  type: 'choice',
  isRequired: true,
  position: 0,
  options: ['Apple App Store', 'Google Play'],
};

const TEXT_FIELD: FormField = {
  key: 'order_id',
  label: 'Order ID',
  type: 'short_text',
  isRequired: false,
  position: 0,
};

describe('FormLivePreview', () => {
  it('shows a prompt to add a field when the draft has none yet', () => {
    render(<FormLivePreview formName="New form" fields={[]} />);
    expect(screen.getByText('Add a field to see the live preview.')).toBeInTheDocument();
  });

  it('renders the shared FormCard inside the mobile frame for the current draft fields', () => {
    render(<FormLivePreview formName="Purchase receipt" fields={[CHOICE_FIELD]} />);
    expect(screen.getByTestId('mobile-preview-frame')).toBeInTheDocument();
    expect(screen.getByText('Store')).toBeInTheDocument();
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('resets to the edited field set when the admin changes the draft fields', () => {
    const { rerender } = render(<FormLivePreview formName="Form" fields={[CHOICE_FIELD]} />);
    expect(screen.getByText('Store')).toBeInTheDocument();

    rerender(<FormLivePreview formName="Form" fields={[TEXT_FIELD]} />);
    expect(screen.queryByText('Store')).not.toBeInTheDocument();
    expect(screen.getByText('Order ID')).toBeInTheDocument();
  });

  it('completes locally with no network call, and can restart from the top', () => {
    render(<FormLivePreview formName="Form" fields={[TEXT_FIELD]} />);
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(screen.getByText('Preview complete.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /restart preview/i }));
    expect(screen.getByText('Order ID')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @support/web test FormLivePreview.test.tsx`
Expected: FAIL — `FormLivePreview.tsx` does not exist yet.

- [ ] **Step 3: Implement `FormLivePreview`**

```tsx
import { useState } from 'react';
import type { FormField, PlayerFormView } from '@support/types';
import { FormCard } from '@/features/forms/components/FormCard';
import { MobilePreviewFrame } from './MobilePreviewFrame.tsx';

/**
 * Renders the same FormCard a player sees, wired to fully local, mocked
 * handlers — no network call is ever made. The whole session remounts (via
 * `key={fieldsKey}`) whenever the admin's draft fields change: FormCard seeds
 * its progress state once from props and never re-reads it, by design, so a
 * real player's reconnect resumes mid-form instead of resetting. That same
 * behavior would otherwise leave a stale preview after every edit here.
 */
export function FormLivePreview({ formName, fields }: { formName: string; fields: FormField[] }) {
  if (fields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        Add a field to see the live preview.
      </div>
    );
  }

  return (
    <MobilePreviewFrame>
      <PreviewSession key={JSON.stringify(fields)} formName={formName} fields={fields} />
    </MobilePreviewFrame>
  );
}

function PreviewSession({ formName, fields }: { formName: string; fields: FormField[] }) {
  const [finished, setFinished] = useState(false);
  const [restartToken, setRestartToken] = useState(0);

  if (finished) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm text-[var(--color-text)]">Preview complete.</p>
        <button
          type="button"
          className="text-sm text-[var(--color-accent)] underline"
          onClick={() => {
            setFinished(false);
            setRestartToken((t) => t + 1);
          }}
        >
          Restart preview
        </button>
      </div>
    );
  }

  const form: PlayerFormView = {
    submission_id: 'preview-submission',
    form_id: 'preview-form',
    form_name: formName || 'Untitled form',
    version: 1,
    fields,
    answers: [],
  };

  return (
    <FormCard
      key={restartToken}
      form={form}
      busy={false}
      onAnswer={async () => ({ ok: true })}
      onSubmit={() => setFinished(true)}
      onSkip={() => setFinished(true)}
      onUploadAttachment={async (file) => ({
        key: `preview/${file.name}`,
        filename: file.name,
        mimeType: file.type,
        byteSize: file.size,
      })}
      onSendAttachment={async () => undefined}
    />
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @support/web test FormLivePreview.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.tsx frontend/src/surfaces/agent-console/pages/Forms/components/FormLivePreview.test.tsx
git commit -m "Add FormLivePreview: local, mocked FormCard session for the admin builder"
```

---

### Task 4: Wire the preview into `FormEditorSheet`

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx`

**Interfaces:**

- Consumes: `FormLivePreview` from Task 3 (`./FormLivePreview.tsx`), fed `FormEditorForm`'s existing `name` and `fields` state (`frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx:134-135`).
- Produces: nothing new for other tasks — this is the final integration point.

- [ ] **Step 1: Add the import**

Find (top of file, near the other relative imports):

```ts
import { ShownForPicker } from './ShownForPicker.tsx';
```

Replace with:

```ts
import { FormLivePreview } from './FormLivePreview.tsx';
import { ShownForPicker } from './ShownForPicker.tsx';
```

- [ ] **Step 2: Split the editor body into a side-by-side layout**

Find the opening of `FormEditorForm`'s returned JSX:

```tsx
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {archived && (
```

Replace with:

```tsx
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {archived && (
```

- [ ] **Step 3: Close the new layout wrapper and add the preview column**

Find the end of that same block, right before the footer:

```tsx
        <ShownForPicker
          intents={intents}
          selected={shownFor}
          onChange={setShownFor}
          currentFormId={formId}
          disabled={archived}
        />
      </div>

      <SheetFooter className="flex-row justify-end gap-2 border-t border-slate-200">
```

Replace with:

```tsx
        <ShownForPicker
          intents={intents}
          selected={shownFor}
          onChange={setShownFor}
          currentFormId={formId}
          disabled={archived}
        />
        </div>

        <div
          data-testid="form-live-preview-panel"
          className="w-[375px] shrink-0 overflow-y-auto border-l border-slate-200 p-4"
        >
          <FormLivePreview formName={name} fields={fields} />
        </div>
      </div>

      <SheetFooter className="flex-row justify-end gap-2 border-t border-slate-200">
```

- [ ] **Step 4: Run the existing suite to confirm the layout change didn't break anything**

Run: `pnpm --filter @support/web test FormEditorSheet.test.tsx`
Expected: PASS — the existing tests query specific roles/labels (e.g. `getByRole('button', { name: 'Save' })`, `within(dialog)`), none of which collide with the new preview panel's content.

- [ ] **Step 5: Write a test confirming the preview panel is live and scoped**

Add this new `describe` block to `frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.test.tsx` (the file has no shared top-level `describe` — each scenario adds its own, following the existing `'FormEditorSheet — publish visibility'` block's exact pattern of inline `vi.spyOn` calls per test):

```tsx
describe('FormEditorSheet — live preview', () => {
  it('shows a live mobile preview of the current draft that updates as fields change', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);
    vi.spyOn(agentApi, 'fetchForm').mockResolvedValue(FORM_WITH_DRAFT);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={ADMIN_SESSION}
        formId="form-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refund request');
    const panel = within(screen.getByTestId('form-live-preview-panel'));
    expect(panel.getByText('Order ID')).toBeInTheDocument();

    await userEvent.type(screen.getByDisplayValue('Order ID'), ' updated');
    expect(panel.getByText('Order ID updated')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @support/web test FormEditorSheet.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the full frontend suite and typecheck once, to confirm nothing else regressed**

Run: `pnpm --filter @support/web test`
Run: `pnpm typecheck`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.test.tsx
git commit -m "Show a live mobile preview alongside the admin forms field editor"
```
