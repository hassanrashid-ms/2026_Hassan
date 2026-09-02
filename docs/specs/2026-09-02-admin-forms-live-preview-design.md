# Admin forms builder: live mobile preview

## Problem

The admin Forms builder (`frontend/src/surfaces/agent-console/pages/Forms/components/FormEditorSheet.tsx`) lets an admin configure a form's fields, but never shows what the form will actually look like to a player. The only real rendering of a form exists in `FormCard.tsx`, which lives entirely inside the `webview` surface (in-game, mobile-width, player-facing chat UI) and is not reusable from `agent-console` today — `frontend/src/surfaces/**` may never cross-import between surfaces per `app/CLAUDE.md`.

Admins currently have no way to check field ordering, required-field gating, choice-button layout, or attachment-field behavior without publishing the form and testing it in a real game client.

## Goal

While editing a form in `FormEditorSheet`, show a live, interactive preview that renders with the exact same component, styling, and mobile-width layout a player sees in the webview — not a re-implementation, not an approximation.

## Non-goals

- No changes to the real player-facing flow, endpoints, or `PlayerFormView`/`FormField` contracts.
- No dry-run/preview endpoint on the backend — the preview never talks to the network.
- No iframe-based embedding of the actual webview app (evaluated and rejected — see Alternatives).

## Design

### 1. Extract `FormCard` into `features/forms/`

Move `FormCard.tsx` and its internal `FieldInput`/`AttachmentField` from `surfaces/webview/components/chat/FormCard.tsx` to `features/forms/components/FormCard.tsx`, following the existing cross-surface precedent set by `features/chat/components/Composer.tsx`:

- Replace the `SupportButton` import (webview-surface-only) with an inline `<button>` styled directly with the same raw token utility classes `Composer.tsx` already uses for its own action buttons (e.g. `bg-accent text-accent-fg rounded-card`) — `features/` components hand-write token-based Tailwind rather than importing either surface's button component, matching the established pattern.
- Add `features/forms/lib/cn.ts` — a local `clsx` + `tailwind-merge` wrapper, mirroring the fact that `agent-console`, `admin-console`, and `webview` each already own an independent copy rather than sharing one from a common `lib/`.
- `bridgeService.post()` (used only to emit `expect_native_dialog` before the attachment file picker opens) is untouched — it's already a safe no-op outside the Unity webview.
- `FormCard`'s props (`form`, `onAnswer`, `onSubmit`, `onSkip`, `busy`, `onUploadAttachment`, `onSendAttachment`) are unchanged. It was already decoupled from the network — the caller supplies the behavior.

The webview page that currently renders `<FormCard>` updates its import path only. Behavior for real players is byte-for-byte identical — same component, same wiring to `/surface/form/answer|submit|skip`.

### 2. Live preview panel in `FormEditorSheet`

Add a side-by-side layout to `FormEditorSheet`: the existing field editor on the left, a new preview pane on the right. The preview pane builds a `PlayerFormView`-shaped object from the sheet's current in-progress draft fields (synthetic `submission_id`/`form_id`, no answers), and renders `FormCard` from `features/forms/` inside a `MobilePreviewFrame`.

### 3. Mocked, local-only interaction

The preview wires `FormCard`'s callback props to fully local handlers — no network call is ever made:

- `onAnswer(fieldKey, value)` / `onSendAttachment(fieldKey, attachment)` — resolve immediately, updating only in-memory preview state.
- `onUploadAttachment(file, onProgress)` — skips real storage entirely; resolves with a fake `UploadedAttachment` built from a local `URL.createObjectURL(file)` blob, so the attachment field is fully exercisable offline.
- `onSubmit()` / `onSkip()` — reset the preview back to the first field (e.g. a small "Preview complete — restart" affordance), since there is no real conversation to hand off to.
- `busy` — always `false`; there is nothing in flight to wait on.

### 4. Preview stays in sync with edits

`FormCard` deliberately seeds its progress/draft state once from props and never re-reads it on prop changes (by design, for the real player flow — a reconnect must resume, not reset, mid-form). The preview pane must therefore force a full remount of `FormCard` whenever the admin's draft field list changes (add/remove/reorder/edit a field) — e.g. `key={JSON.stringify(fields)}` — so the preview always reflects the latest edits instead of stale state from before the edit.

### 5. Mobile-accurate rendering via a scoped frame

`agent-console` and `webview` define the same Tailwind token names (`--color-bg`, `--color-surface`, `--color-accent`, etc., per `app/CLAUDE.md`) with **different** values, and `webview.css` is imported only by `WebviewShell` — importing it into `agent-console` would leak Tailwind's preflight reset across surfaces. So the preview cannot simply sit in an `agent-console`-themed container; it needs `webview`'s actual look without importing `webview.css`.

`MobilePreviewFrame` (new, lives alongside the preview panel) renders a fixed-width (~375px), rounded-corner container with `webview.css`'s theme values hardcoded as inline CSS custom properties scoped to that one container:

```
--color-bg: #ffffff;
--color-surface: #f5f3fd;
--color-accent: #7c3aed;
--color-accent-deep: #5b21b6;
--color-accent-soft: #ede9fe;
--color-accent-fg: #ffffff;
--color-text: #1a1720;
--color-muted: #6b6577;
--radius-card: 1rem;
```

`webview.css`'s type scale is `clamp(14px, 4.27vw, 22px)` — driven by actual viewport width, which is meaningless inside a fixed-width box embedded in a wider desktop page. The frame instead sets `font-size: 16px` directly, the exact value that formula resolves to at its 375px reference width. Everything inside — including `FormCard`, which is entirely rem-based and Tailwind-utility-styled against these token names — then renders pixel-faithful to the real mobile webview, with no dependency on `webview.css` itself and no risk to `agent-console`'s own theme.

### Data flow

```
FormEditorSheet (draft fields, local state)
        │
        ▼
  build synthetic PlayerFormView (no answers)
        │
        ▼
  MobilePreviewFrame (scoped webview theme vars, 375px, 16px base)
        │
        ▼
  FormCard  (from features/forms/)  ◄── key = hash(draft fields), forces remount on edit
        │
        ▼
  mocked onAnswer / onUploadAttachment / onSendAttachment / onSubmit / onSkip
  (all local state only — no network)
```

### Testing

- Relocate `FormCard`'s existing tests alongside the moved component; assert no behavior change (same props, same rendering) — this is a pure move plus a button-markup swap.
- New tests for the preview panel: renders the shared `FormCard`; cycling through fields via Next/Back/Submit works against mocked handlers with no network calls; editing a field in the sheet (add/remove/reorder/relabel) remounts the preview with the updated field set; attachment field accepts a picked file and reflects it locally without a real upload.

## Alternatives considered

**Duplicate `FormCard` into `agent-console` instead of extracting.** Rejected — the two copies would drift out of sync over time as the real player-facing card evolves, defeating the point of "exact same UI/UX."

**Render the real webview app in an iframe pointed at a dedicated preview route.** Higher fidelity in theory (actual app, actual CSS/JS) but requires a new preview mode in the webview app, cross-frame messaging to relay mocked answers, and iframe sizing/scroll handling — substantially more infrastructure for the same visual result the scoped-CSS-vars approach already achieves. Rejected for this iteration.
