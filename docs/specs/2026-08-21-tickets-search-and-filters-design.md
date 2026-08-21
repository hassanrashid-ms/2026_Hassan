# Tickets search and filters

## Context

The Tickets page (`docs/specs/2026-08-20-tickets-page-design.md`) shows four
columns — Mine, Agent Assigned, Unassigned, Bot Handling — each a query
against `conversations` scoped by `status` and `assignedAgentId`. It shipped
with no search or filter capability; that spec explicitly deferred it.

The product spec (`Docs/Customer Support Tool - CRM v2.txt`) separately
describes a fuller vision: free-text search, filters on status, subintent,
label, assignee, priority, age, and any player-state field marked
searchable, plus private/shared saved views. None of that is implemented
today. Two of those pieces — filtering by declared player-state fields, and
full-text search over message bodies — were already called out as future
work in adjacent specs (`docs/plans/2026-08-17-agent-player-context-backend.md`,
`docs/specs/2026-08-17-agent-player-context-frontend-design.md`) and would
require new backend infrastructure (query support over the declared-field
GIN index, and a message-body search index). This spec deliberately excludes
both, along with saved views, to stay scoped to what's cheap: fields and
tables that already exist.

## Goals

- Let an agent find a specific ticket fast, from anywhere on the board, by
  ticket number, player identity, or subintent text.
- Let an agent narrow all four columns at once by priority, label,
  subintent, assignee, or age, without breaking column mutual exclusivity.

## Non-goals

- Filtering by declared player-state fields (spend tier, platform, player
  level, etc.) — needs new query support over `declared_field`, deferred to
  its own spec.
- Full-text search over message bodies — needs a new search index
  (Postgres `tsvector` or similar), deferred to its own spec. No vector
  search of any kind.
- Saved/named filter views (private or shared) — deferred to its own spec.
  Filter state lives only in the URL for this feature.
- Changing column definitions, claim/take-over actions, or per-column
  pagination/real-time architecture from the existing Tickets page design.

## UI

A single filter/search bar sits above the 4-column board, not per-column.
It applies to all four columns simultaneously: each column's own
status/assignee definition is unchanged, search and filters AND on top of
it, narrowing what's visible per column independently. Columns remain
mutually exclusive.

Controls:

| Control | Behavior |
|---|---|
| Search box | Free text. Matches ticket number (`#1042`), player identity (`external_player_id`), and subintent label. Case-insensitive. |
| Priority | Multi-select, p1–p4 |
| Label | Multi-select, from the `tag` table |
| Subintent | Multi-select, from the `subintent` table, scoped to the workspace |
| Assignee | Multi-select of agents. Meaningful mainly within "Agent Assigned"; if selected while another column has no matching rows, that column just renders its normal empty state |
| Age | Threshold ("older than 4 hours", "older than 1 day", etc.), computed from `last_message_at` |

All controls combine with AND — e.g. priority p1 AND label "refund" AND
older-than-4-hours is one filter state, matching the product spec's
"unassigned + refund + spender + waiting over four hours is one view"
example, minus the player-state clause.

**State:** held in URL query params on `/tickets` (e.g.
`?priority=p1,p2&labelIds=...&q=...`). This makes a filtered board state
shareable, bookmarkable, and refresh-safe, and gives a natural on-ramp if
saved views are built later — a saved view becomes "these params, with a
name."

**Empty states:** a column with zero matches under active filters shows a
distinct "no tickets match your filters" message, separate from the
existing "queue is empty" empty state — otherwise an agent can't tell
whether a queue is genuinely empty or just filtered out.

## Data model changes

`AgentConversationSummary` (`packages/types/src/chat.ts:89-107`) gains two
fields, both backed by existing columns that just aren't projected yet:

- `number: number` — from `conversations.number` (`conversations.ts:64`)
- `subintent: { id: string; label: string } | null` — from
  `conversations.subintentId` (`conversations.ts:49`), joined to `subintent`

No schema migration — both columns already exist. This is a query
projection and type change only.

## Backend

`GET /agent/conversations` gains new optional query params, all AND'd with
the existing `status` param's column filter:

| Param | Type | Matches |
|---|---|---|
| `q` | string | `number` (numeric/prefix match), `player.external_player_id`, `subintent.label` — `ILIKE` |
| `priority` | string[] | `conversations.priority IN (...)` |
| `labelIds` | uuid[] | conversation has at least one matching row in `conversation_tag` |
| `subintentIds` | uuid[] | `conversations.subintentId IN (...)` |
| `assigneeIds` | uuid[] | `conversations.assignedAgentId IN (...)` |
| `olderThanHours` | number | `last_message_at < now() - interval` |

`conversationsService.listConversations` (`agent/services/conversationsService.ts:18-76`)
takes these as additional optional filter args and appends the
corresponding `WHERE` clauses. The existing four status/assignment modes
(`unassigned`, `mine`, `agentAssigned`, `botHandling`) are unchanged — these
new params only add conditions on top.

Register the new params in `backend/src/docs/openapi.ts` per repo
convention.

## Real-time updates

Each column already re-evaluates `conversation:changed` events client-side
against its own status/assignee predicate (existing Tickets page design).
Since the socket payload is the same `AgentConversationSummary` shape as
list rows, once `number` and `subintent` are added to it (see Data model
changes), the client extends that same predicate check to also test the
active search/filter state. No server-side change to the event payload
beyond the two new fields, no new fetch on event receipt.

## Pagination interaction

Changing search or any filter resets every column's pagination to page 1
and refetches — filter/search params become part of each column's query
key, the same way the column's own status mode already is.

## Testing

- Backend: unit tests on `listConversations` for each new filter param
  individually and in combination (AND semantics), and for `q` matching
  each of its three targets (number, player id, subintent label).
- Frontend: changing the filter bar updates the URL and resets all four
  columns to page 1. A `conversation:changed` event for a row that now
  matches active filters is added to the right column; one that stops
  matching is removed — reusing the existing per-column reconciliation test
  pattern from the Tickets page design.
