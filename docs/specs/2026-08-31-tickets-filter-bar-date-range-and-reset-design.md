# Tickets filter bar: shadcn date-range picker + reset filters

## Problem

`TicketsFilterBar.tsx` uses two native `<input type="date">` fields for the
created-date range, inconsistent with every other control in the bar
(`Select`, `MultiSelectFilter`, both shadcn-based). There's also no way to
clear an applied filter set in one action — an agent has to unwind each
`MultiSelectFilter`, the age dropdown, and both date fields individually.

## Scope

`TicketsFilterBar.tsx` and its immediate dependencies only. Does not touch:

- `useTicketsFilters.ts`'s shape or the URL query-param contract
  (`createdFrom`/`createdTo` keys and `YYYY-MM-DD` value format are unchanged)
- The webview surface's `FormCard.tsx` date/time inputs — those stay native.
  That surface renders inside a mobile WebView, where the OS-native date/time
  picker is the better experience (native wheel/Material picker, no extra
  taps for a DOM calendar widget), and a single form field isn't a "filter"
  the reset concept applies to.

## Design

### 1. Date-range picker

Replace the two separate `<input type="date">` fields with a single
range-mode picker, following the standard shadcn Calendar + Popover pattern.

**New dependencies:** `react-day-picker`, `date-fns` (shadcn's Calendar
wrapper needs both; neither is currently installed).

**New primitive:** `frontend/src/surfaces/agent-console/components/ui/calendar.tsx`
— the standard shadcn `Calendar` component wrapping `DayPicker`, styled with
this surface's existing Tailwind tokens (no hand-written CSS, per this repo's
styling rule). Reuses the existing `Popover`/`Button` primitives already in
`components/ui/`.

**New component:** `DateRangeFilter`, colocated in
`frontend/src/surfaces/agent-console/pages/Tickets/` alongside
`MultiSelectFilter.tsx`:

- A `Popover` whose trigger is a `Button` (variant `outline`, same sizing as
  the adjacent `Select`) showing:
  - `"Created date"` when both `createdFrom` and `createdTo` are empty
  - `"Aug 1 – Aug 15"` when both are set (formatted with `date-fns`)
  - `"From Aug 1"` / `"Until Aug 15"` if only one bound is set
- Popover content renders `<Calendar mode="range" />`.
- `onSelect` receives a `{ from?: Date; to?: Date }` range; converts each
  bound to `YYYY-MM-DD` (matching the existing local-date format — see
  `today()` in `FormCard.tsx` for the same conversion already used
  elsewhere) and calls `onChange({ createdFrom, createdTo })`.
- The manual non-inverted-range guards in the current `onChange` handlers
  (swapping `to` up when `from` is dragged past it) are deleted —
  `react-day-picker`'s range mode enforces `from <= to` natively.

`TicketsFilterBar.tsx` swaps its two `<label>`/`<Input type="date">` blocks
for one `<DateRangeFilter value={{ from: filters.createdFrom, to: filters.createdTo }} onChange={...} />`.

### 2. Reset filters button

A `Button` (variant `ghost`) appended after the date-range picker in the
filter bar's flex row, label "Reset filters".

- `onClick`:
  ```ts
  setSearchInput('');
  onChange({
    q: '',
    priority: [],
    labelIds: [],
    subintentIds: [],
    assigneeIds: [],
    olderThanHours: '',
    statuses: [],
    createdFrom: '',
    createdTo: '',
  });
  ```
  `view` is never included — it's a display mode (board/list), not a filter,
  and stays whatever the agent had it set to.
- `disabled` when every field above is already at its empty default —
  computed inline as a plain boolean in `TicketsFilterBar`, no new hook:
  ```ts
  const hasActiveFilters =
    filters.q !== '' ||
    filters.priority.length > 0 ||
    filters.labelIds.length > 0 ||
    filters.subintentIds.length > 0 ||
    filters.assigneeIds.length > 0 ||
    filters.olderThanHours !== '' ||
    filters.statuses.length > 0 ||
    filters.createdFrom !== '' ||
    filters.createdTo !== '';
  ```
  Button is `disabled={!hasActiveFilters}` — always visible, so agents always
  know it's there, but inert at rest rather than a jumpy show/hide.

## Testing

Extend `TicketsFilterBar.test.tsx`:

- Selecting a range in the calendar sets both `createdFrom` and `createdTo`
  in one `onChange` call, in `YYYY-MM-DD` format.
- Trigger button label reflects empty / partial / full range states.
- "Reset filters" is disabled with no filters active.
- Setting any single filter (e.g. one `MultiSelectFilter` selection) enables
  the button.
- Clicking "Reset filters" clears every filter field, resets the local
  search input, and leaves `view` untouched.

## Out of scope / explicitly not doing

- Not converting `FormCard.tsx`'s native date/time inputs (see Scope above).
- Not changing the URL param contract, so no changes needed anywhere that
  reads `createdFrom`/`createdTo` outside this file (e.g. `Tickets.tsx`'s
  query building stays as-is).
