# Resolved & Closed ticket queues, and pagination for all queues

## Problem

The Tickets board (`frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx`) shows four
columns — Unassigned, Bot Handling, Agent Assigned, Escalated — all "active work" queues. There is
no way for an agent to see what was recently resolved or closed without leaving the board.

Separately, no column on the board paginates today — every column's query fetches its *entire*
result set in one round trip. That was tolerable while every queue was implicitly bounded to
"currently active" tickets, but it doesn't hold once Resolved/Closed queues exist (unbounded,
ever-growing history) and isn't great practice for the existing four either. This design adds
cursor-based pagination, 25 per page with scroll-triggered load-more, to all six queues.

## Background: how queues work today

There is no queue table. A "queue" is a virtual filter computed at query time from
`conversation.status` (and, for `mine`/`agentAssigned`, `assignedAgentId`). The filter value is a
literal union type duplicated in four places:

- `backend/src/agent/services/conversationsService.ts` — `ConversationsFilter` type + the switch
  in `listConversations` that builds the where clause
- `backend/src/agent/controllers/conversationsController.ts` — the `status` zod enum
- `frontend/src/surfaces/agent-console/api/agentApi.ts` — `ConversationListFilter` type
- `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx` — the `COLUMNS` array

`conversation` has `status` and `createdAt` but no `updatedAt`/`resolvedAt`/`closedAt`. Those
timestamps live on `resolutionCycle` (`resolutionCycle.resolvedAt`, `resolutionCycle.closedAt`),
one row per resolution attempt.

The board has no pagination anywhere — every column's `useQuery` fetches its entire result set and
renders it. The existing `olderThanHours` filter is applied in JS after the query runs, not in
SQL, and only supports "older than" on `last_message_at`.

All five existing filters share one `.orderBy(conversation.priority, conversation.createdAt)` —
ascending priority (p1 first), then ascending `createdAt` as tiebreaker. No filter sorts
differently and no JS-level re-sort happens afterward.

## Design

Two independent changes to `listConversations` and the Tickets board:

1. Add two more virtual queues, `resolved` and `closed`, following the same computed-filter
   pattern as the existing four — no new table.
2. Add cursor-based (keyset) pagination, 25 per page, to all six queues, with scroll-triggered
   load-more on each column.

### Backend

`conversationsService.ts`:

- Extend `ConversationsFilter` with `'resolved' | 'closed'`.
- Add two new branches to the filter switch. Unlike the status-only branches, these join
  `resolutionCycle` on `conversation.id` and filter on its timestamp column, since `conversation`
  itself carries no "entered this status at" timestamp:
  - `resolved` → `conversation.status = 'resolved' AND resolutionCycle.resolvedAt >= now() - interval '7 days'`
  - `closed` → `conversation.status = 'closed' AND resolutionCycle.closedAt >= now() - interval '7 days'`
- Sort order for these two: `resolutionCycle.resolvedAt` / `resolutionCycle.closedAt` `DESC`, with
  `conversation.id DESC` as a tiebreaker (needed for a stable keyset — two rows can share the same
  timestamp). The five existing filters keep their current
  `ORDER BY conversation.priority ASC, conversation.createdAt ASC`, with `conversation.id ASC`
  added as a tiebreaker for the same reason.
- The 7-day cutoff is a SQL `WHERE` clause, evaluated at query time — not a post-fetch JS filter
  like `olderThanHours` — so the query itself stays bounded independent of pagination.
- The 7-day window is a fixed default, not user-configurable. No new filter-bar control.

**Pagination** (all six filters):

- `ConversationsListFilters` gains an optional `cursor?: string` field. A cursor is an opaque,
  base64-encoded JSON tuple of that queue's sort columns from the last row of the previous page
  (e.g. `{ priority, createdAt, id }` for the five status queues; `{ resolvedAt, id }` /
  `{ closedAt, id }` for the two new ones).
- When a cursor is present, add a keyset `WHERE` condition — e.g. for the default queues:
  `(priority, createdAt, id) > (:cursorPriority, :cursorCreatedAt, :cursorId)` — expressed as
  Drizzle's row-comparison via nested `or`/`and`, matching the existing `orderBy` columns exactly.
- Query always runs with `LIMIT 26` (page size 25 + 1 lookahead row). If 26 rows come back, trim
  to 25 and set `nextCursor` from row 25; otherwise return all rows with `nextCursor: null`.
- `listConversations` return type becomes `{ conversations: AgentConversationSummary[], nextCursor: string | null }`
  instead of a bare array — every existing caller updates to unwrap `.conversations`.
- The N+1 per-row lookup (last message + tags, currently lines 120-141) now runs over at most 26
  rows per call instead of the full queue, which is a meaningful side benefit for the large
  existing queues, not just the new ones.

`conversationsController.ts`:
- Extend the `status` zod enum with `'resolved' | 'closed'`.
- Add an optional `cursor` query-string param, passed through to the service. Response body adds
  `nextCursor`.

`openapi.ts`:
- Register the updated enum and the `cursor`/`nextCursor` fields per the existing "new
  endpoint/param → openapi.ts" rule.

### Frontend

`agentApi.ts`:
- Extend `ConversationListFilter` with `'resolved' | 'closed'`.
- `fetchInbox` takes an optional `cursor` param and the response type gains `nextCursor`.

`Tickets.tsx`:
- Add two entries to `COLUMNS`:
  - `{ title: 'Resolved', filter: 'resolved' }`
  - `{ title: 'Closed', filter: 'closed' }`
- Neither is `claimable` (only Unassigned is, today).
- Each column switches from `useQuery` to TanStack Query's `useInfiniteQuery`, keyed by
  `[filter, queryFilters]`, `getNextPageParam` reading `nextCursor` from the last page.
  `queue.data?.pages.flatMap(p => p.conversations)` replaces the current
  `queue.data?.conversations` when rendering.
- Each column's existing scrollable container (already resizable, already has a fixed
  height/overflow per the per-column `queueHeight_${filter}` localStorage value) gets a scroll
  listener that calls `fetchNextPage()` when scrolled within ~200px of the bottom, guarded by
  `hasNextPage && !isFetchingNextPage`. A small loading row renders at the bottom while
  `isFetchingNextPage` is true.
- `columnOrder` persistence, per-column resizable height, and auto-hide-when-empty are unaffected
  and continue working as-is; they're generic over `COLUMNS` and the first page's emptiness.

## Out of scope

- Adjustable date range / custom window for Resolved/Closed (fixed 7-day default only).
- Surfacing resolved/closed in Inbox or Global Inbox — those stay "active work" views.
- Changing sort order/criteria beyond adding the `id` tiebreaker needed for keyset stability.

## Testing

- Backend: unit test `listConversations('resolved', ...)` and `listConversations('closed', ...)`
  return only conversations whose `resolutionCycle` row has the matching timestamp within 7 days,
  and exclude ones outside the window or without a `resolutionCycle` row.
- Backend: pagination — a queue with 30 matching conversations returns 25 + a non-null
  `nextCursor` on page one, and the remaining 5 + `nextCursor: null` when paged with that cursor;
  no row appears on both pages and no row is skipped (insert a row between page fetches in the
  test to confirm keyset stability vs. offset drift).
- Frontend: Tickets board renders six columns; Resolved/Closed columns auto-hide when empty like
  the others; scrolling a column with >25 results near its bottom triggers exactly one
  `fetchNextPage` call and appends rather than replacing existing rows.
