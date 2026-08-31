# Tickets filter bar and list view: shadcn date-range picker, reset filters, more columns, sortable headers

## Problem

`TicketsFilterBar.tsx` uses two native `<input type="date">` fields for the
created-date range, inconsistent with every other control in the bar
(`Select`, `MultiSelectFilter`, both shadcn-based). There's also no way to
clear an applied filter set in one action — an agent has to unwind each
`MultiSelectFilter`, the age dropdown, and both date fields individually.

Separately, the List view table (`TicketsListView` in `Tickets.tsx`) is
missing fields agents currently have to open a ticket to see (created time,
subintent, ticket number), and its sort order is fixed server-side with no
way for an agent to change it.

## Scope

`TicketsFilterBar.tsx`, `TicketsListView` (in `Tickets.tsx`), and the backend
`listAllConversations` query + `AgentConversationSummary` type it fills.
Does not touch:

- `useTicketsFilters.ts`'s filter shape or the `createdFrom`/`createdTo`
  URL query-param contract (`YYYY-MM-DD` value format is unchanged)
- The webview surface's `FormCard.tsx` date/time inputs — those stay native.
  That surface renders inside a mobile WebView, where the OS-native date/time
  picker is the better experience (native wheel/Material picker, no extra
  taps for a DOM calendar widget), and a single form field isn't a "filter"
  the reset concept applies to.
- The Board view's per-status columns (`QueueColumn`/`SortableQueueColumn`)
  — not a table, no headers to click; they keep their existing fixed
  priority→createdAt ordering, sourced from the separate per-status
  `listConversations` query path, which this change does not touch.

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

### 3. New table columns: Created, Subintent, Ticket #

Two of the three new columns need a backend field that doesn't exist on the
wire today — `AgentConversationSummary` (`packages/types/src/chat.ts:149`)
has no `created_at` or `subintent` field, and `conversation.number` is only
ever used server-side to match a numeric search term
(`extraFilterConditions`'s `numMatch`), never selected into a response row.

**`AgentConversationSummary` gains:**
```ts
created_at: string;        // ISO timestamp
subintent: { id: string; name: string } | null;
number: number;
```

**Backend (`listAllConversations` only — `listConversations` and
`listResolvedOrClosedConversations`, which feed Board view, are untouched):**
- Add `createdAt: conversation.createdAt`, `subintentId: subintent.id`,
  `subintentName: subintent.name`, `number: conversation.number` to the
  existing `rows` select (the `subintent` join is already present, just
  unused in the select list today).
- Populate the three new `AgentConversationSummary` fields from those columns
  when building `summaries`.

**Frontend (`TicketsListView`):** three new `<th>`/`<td>` pairs —
"Created" (formatted with `date-fns`, e.g. `Aug 15, 2:30 PM`), "Subintent"
(`conversation.subintent?.name ?? '—'`), "Ticket #" (`conversation.number`,
right-aligned, monospace, matching how `Search` already looks up tickets by
number).

### 4. Sortable column headers

All nine data columns (Player, Status, Priority, Assignee, Last message,
Tags, Created, Subintent, Ticket #) get clickable headers with a sort-arrow
indicator, capped at two simultaneously active sort keys (primary +
secondary). Default on load: **Priority ascending (primary) → Created
ascending (secondary)** — most urgent first, then longest-waiting within a
priority.

**Two columns don't have a natural sort value and get a defined proxy
instead of an arbitrary one:**
- **Last message** sorts by `last_message_at` (recency) — sorting by the
  message text itself isn't meaningful, and recency is what "Last message"
  already implies to an agent scanning the column.
- **Tags** sorts by tag count — there's no canonical order across an array
  of tags; count is the one sortable property agents would plausibly want
  ("tickets with the most labels").

**Click behavior:**
- Clicking a column not currently in the sort: it becomes the new primary
  sort key (ascending by default), the previous primary demotes to
  secondary, and any previous secondary is dropped.
- Clicking a column that's already active (primary or secondary): flips its
  direction (asc ↔ desc) in place, without changing which two columns are
  active or which is primary/secondary.
- Header shows an up/down arrow on both active columns; the primary column's
  arrow is visually distinguished (e.g. solid vs. muted) from the secondary's.

**State:** sort state is two new URL params on `useTicketsFilters`,
`sortBy`/`sortDir` for primary and `sortBy2`/`sortDir2` for secondary (only
present in the URL when they differ from the default, consistent with how
every other filter field already round-trips through the URL) — a sorted
list view is bookmarkable/shareable the same way a filtered one already is.

**Backend — generalized keyset pagination:** `listAllConversations`'s cursor
logic today is hardcoded to the one fixed sort (priority ASC, activity DESC,
id DESC as final tiebreaker) via the three-branch `cursorCondition` OR at
`conversationsService.ts:376-382`. This becomes a small sort-key registry:

```ts
type SortKey = 'player' | 'status' | 'priority' | 'assignee' | 'lastMessage'
  | 'tags' | 'created' | 'subintent' | 'number';

const SORT_COLUMNS: Record<SortKey, { expr: SQL; nullsLast?: boolean }> = {
  player: { expr: player.externalId },
  status: { expr: conversation.status },
  priority: { expr: conversation.priority },
  assignee: { expr: agent.displayName, nullsLast: true },
  lastMessage: { expr: lastMessageAt, nullsLast: true },
  tags: { expr: tagCount },
  created: { expr: conversation.createdAt },
  subintent: { expr: subintent.name, nullsLast: true },
  number: { expr: conversation.number },
};
```

`lastMessageAt` and `tagCount` become correlated subqueries selected
alongside the existing `activity` column (the per-row "last message" lookup
already happening in the loop below the query stays as-is for the preview
text; this is a separate lightweight subquery just for the timestamp used to
sort). The generic two-key tuple comparison generalizes the existing
mixed-direction OR pattern (`conversationsService.ts:376-382`) from one
hardcoded pair to any `(primary, secondary, id)` triple, respecting each
key's independent asc/desc — the same shape, just parameterized instead of
inlined. `id` (`conversation.id`) remains the unconditional final tiebreaker
so the keyset is always total, same as every other query in this file.
`nullsLast: true` on assignee/lastMessage/subintent ensures unassigned tickets
or ones with no messages/subintent don't unpredictably jump to the top on
ascending sorts.

Cursor payload becomes `{ primary: string; secondary: string; id: string }`
(replacing `AllCursor`'s fixed `{ priority, activity, id }` shape) — opaque
either way, so this is not a breaking change to anything that treats the
cursor as an opaque string, which is everything outside this file.

`fetchInbox`/`buildTicketsQuery` (`agentApi.ts`) gain `sortBy`/`sortDir`/
`sortBy2`/`sortDir2` query params, only appended when set (same pattern as
every other optional filter param there).

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

Extend `Tickets.test.tsx` / add a `TicketsListView`-focused test file:

- New columns render the expected formatted values (Created, Subintent
  name-or-`—`, Ticket #).
- Default sort on load is Priority asc (primary) → Created asc (secondary),
  reflected in both arrow indicators.
- Clicking an inactive column header makes it primary, demotes the old
  primary to secondary, and drops the old secondary.
- Clicking an already-active header (both primary and secondary cases)
  flips only that column's direction, leaving the other active column and
  the primary/secondary assignment unchanged.
- Sort state round-trips through the URL (`sortBy`/`sortDir`/`sortBy2`/
  `sortDir2`) the same way filters already do.

Backend: extend `conversationsService`'s existing test coverage for
`listAllConversations` —

- Querying with no sort params returns the priority-asc/created-asc default.
- Querying with an explicit two-key sort (e.g. `assignee desc, number asc`)
  orders correctly, including the nulls-last cases for assignee/lastMessage/
  subintent.
- Keyset pagination (cursor round-trip) is stable under a non-default sort —
  paging through page 2+ doesn't skip or repeat rows.

## Out of scope / explicitly not doing

- Not converting `FormCard.tsx`'s native date/time inputs (see Scope above).
- Not changing the `createdFrom`/`createdTo` filter param contract — only
  the new `sortBy`/`sortDir`/`sortBy2`/`sortDir2` params are added alongside
  it.
- Not adding sort or the three new columns to the Board view's per-status
  queue queries (`listConversations`, `listResolvedOrClosedConversations`) —
  those stay exactly as they are today.
