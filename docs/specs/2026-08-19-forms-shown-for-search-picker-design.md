# Forms builder — searchable "Shown for" picker

**Date:** 2026-08-19
**Status:** Proposed
**Scope:** Frontend-only UX change to the form editor's subintent picker. No schema or API changes.
**Relates to:** `2026-08-19-forms-builder-admin-design.md` (this replaces one control inside that
editor, once it ships).

---

## Problem

`FormEditorSheet.tsx`'s "Shown for" section renders every non-archived subintent across every
intent as a flat, ungrouped row of toggle buttons (`FormEditorSheet.tsx:402-419`). With more than a
handful of intents this becomes an unscannable wall of buttons, has no search, and gives no
indication that a subintent might already belong to another form.

## What this slice changes

- Replace the flat button grid with: a row of removable chips for the current selection, plus a
  `+` button that opens a dialog containing a search box and a list of intents grouped with their
  subintents nested underneath.
- Enforce, in the picker itself, that a subintent already mapped to a _different_ form cannot be
  selected here, and that "select this whole intent" is unavailable when any of its subintents are
  taken that way.

### Out of scope

- Any backend/API change. `GET /agent/intents` already returns `formId` per subintent
  (`IntentSubintentView.formId`), which is all the locking logic needs; `setFormSubintents` is
  unchanged.
- Server-side enforcement of "one subintent, one form." This spec is a client-side UX guard against
  picking a conflict in the first place; whether the server already rejects a conflicting call is a
  property of the existing forms API, not something this slice adds or changes.
- Any change to `resolveSubintentForm`, the player-side form, or the agent context rail.

---

## Component

New file: `frontend/src/surfaces/agent-console/pages/Forms/components/ShownForPicker.tsx`.

```ts
function ShownForPicker({
  intents, // IntentView[] — same data FormEditorSheet already fetches
  selected, // string[] — subintent ids, i.e. the `shownFor` state
  onChange, // (ids: string[]) => void
  currentFormId, // string | null — the form being edited (null = new form)
  disabled, // boolean — archived forms can't be edited
}: ShownForPickerProps);
```

`FormEditorSheet.tsx:402-419` is replaced with:

```tsx
<ShownForPicker
  intents={intents}
  selected={shownFor}
  onChange={setShownFor}
  currentFormId={formId}
  disabled={archived}
/>
```

### Pure helper (unit-testable independent of rendering)

```ts
type SubintentRow = {
  id: string;
  name: string;
  locked: boolean; // formId set to a *different* form
};
type IntentGroup = {
  id: string;
  name: string;
  subintents: SubintentRow[]; // already filtered by the current query
  bulkLocked: boolean; // true if any subintent in this intent is locked
};

function buildGroupedSubintents(
  intents: IntentView[],
  query: string,
  currentFormId: string | null,
): IntentGroup[];
```

Rules:

- Archived subintents are dropped entirely (same as today's `nonArchivedSubintents`).
- `locked = subintent.formId !== null && subintent.formId !== currentFormId`.
- `bulkLocked = subintents.some(s => s.locked)` — computed over the intent's _full_ subintent set,
  not just the filtered/matching ones, so bulk-select stays disabled even when a search query hides
  the locked row.
- Query matching (case-insensitive substring):
  - empty query → every intent, with all its non-archived subintents.
  - intent name matches → intent shown with **all** its subintents.
  - intent name doesn't match but ≥1 subintent name matches → intent shown with **only the
    matching** subintents.
  - neither matches → intent omitted.
- An intent with an empty resulting `subintents` array after filtering is omitted from the result.

---

## UI

### Chip row (always visible, replaces the button grid)

```
Shown for
[ Password reset ✕ ] [ 2FA locked out ✕ ] [ + ]
```

- One `Badge` (existing component) per selected subintent, name only, with a trailing `✕` that
  removes it from `selected` directly — no dialog needed to remove.
- Trailing icon `Button` (`variant="ghost"`, `size="icon"`, `aria-label="Add sub-intents"`) opens
  the dialog. Disabled when `disabled` (archived form).
- No selection → chip row is empty, just the `+` button and, if there are zero subintents in the
  workspace at all, the existing "No subintents available." message.

### Dialog (opens on `+`)

Reuses `Dialog`/`DialogContent`/`DialogHeader`/`DialogFooter` already imported in this file.

```
┌─────────────────────────────────────────────┐
│ Shown for                                    │
│ [ Search intents or sub-intents...        ]  │
│ ───────────────────────────────────────────  │
│ [ ] Billing                                  │
│      ↳ [ ] Refund request                    │
│      ↳ [x] Payment failed                    │
│      ↳ [ ] Subscription cancel   [assigned]  │
│ [x] Account Access                           │
│      ↳ [x] Password reset                    │
│      ↳ [x] 2FA locked out                    │
│ ───────────────────────────────────────────  │
│                                        [Done]│
└─────────────────────────────────────────────┘
```

- Intent row: checkbox + bold name, no indent. Tri-state: unchecked (no children selected), checked
  (all _unlocked_ children selected), indeterminate (some selected). `bulkLocked` intents render
  the checkbox `disabled`.
  - Clicking toggles all unlocked children at once: if not all are currently selected, select all
    of them; otherwise clear all of them. Locked children are never touched by this action.
- Subintent row: indented (`pl-6`), preceded by a small `CornerDownRight` icon (`lucide-react`,
  already a dependency) in `text-muted`. `locked` rows render the checkbox `disabled`, dimmed
  (`opacity-50`), with a small trailing `Badge` (`variant="outline"`) reading "assigned".
- Checking/unchecking any row calls `onChange` immediately — the dialog holds no draft state of its
  own, so closing it (via `Done`, the dialog's own close control, or clicking outside) never needs
  a save/cancel distinction.
- No matches for the current query → "No matching intents or sub-intents." in place of the list.
- Search input is a plain controlled `Input`; no keyboard-shortcut or typeahead handling needed
  since this is a modal dialog, not an anchored popover.

---

## Testing

- `buildGroupedSubintents` (pure function, e.g. `ShownForPicker.test.ts`):
  - empty query returns every intent with all non-archived subintents, in existing order.
  - archived subintents never appear regardless of query.
  - query matching an intent name returns that intent with all its subintents.
  - query matching only a subintent name returns the parent intent with just that subintent.
  - query matching nothing returns `[]`.
  - `locked` is true only when `formId` is set and differs from `currentFormId`; false when
    `formId` equals `currentFormId` or is `null`.
  - `bulkLocked` is true if any subintent (matching or not) in the intent is locked.
- `ShownForPicker` component test:
  - removing a chip updates `selected` without opening the dialog.
  - opening the dialog and checking an unlocked subintent adds it to `selected`.
  - checking a locked subintent's checkbox is a no-op (disabled).
  - toggling an intent's checkbox when unlocked selects/deselects exactly its unlocked children.
  - an intent with one locked child renders its bulk checkbox disabled, while the other,
    unlocked children remain individually checkable.
