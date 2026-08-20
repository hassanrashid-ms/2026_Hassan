# Tickets page design

## Context

Today the Inbox page (`surfaces/agent-console/pages/Inbox/`) has a two-tab click-to-switch view: "Unassigned" and "Mine". "Unassigned" is defined as `assignedAgentId IS NULL`, which currently also captures `bot_active` conversations that the bot hasn't handed off yet — there's no way for an agent to see, at a glance, work the bot is still handling versus work actually waiting to be claimed.

This design adds a new **Tickets** page: a 4-column overview board, and narrows Inbox down to a single Mine list.

## Goals

- Give agents a single screen showing all queue states at once, instead of switching tabs.
- Separate "bot still owns this" from "nobody has claimed this yet" — these are currently conflated.
- Let an agent take over a bot-handled conversation directly from the board.

## Non-goals

- Changing the saved-filter/saved-view system described in the product spec (`Docs/Customer Support Tool - CRM v2.txt`) — this page is additive, not a replacement for filters.
- Changing the assignment/routing logic (auto-assign round robin, claim race handling) — unchanged.

## Pages affected

### Inbox (`surfaces/agent-console/pages/Inbox/`)
- Drops the `Tabs`/`TabsList` switcher and the "Unassigned" tab.
- Becomes a single list scoped to `assignedAgentId = currentAgent.id`, status in (`open`, `awaiting_player`, `escalated`).
- Behavior otherwise unchanged (thread view, claim/reply/etc. still live here for the agent's own tickets).

### Tickets (new page, new nav item)
Four columns, always shown side by side, in this order:

| Column | Filter | Notes |
|---|---|---|
| Mine | `assignedAgentId = currentAgent.id`, status in (open, awaiting_player, escalated) | Same data as Inbox; duplicated here intentionally so Tickets is a full overview |
| Agent Assigned | `assignedAgentId IS NOT NULL`, status in (open, awaiting_player, escalated) | Team-wide; a ticket appears here **and** in Mine if it's the current agent's — overlap is intentional |
| Unassigned | `assignedAgentId IS NULL`, status in (open, escalated) | Changed from today's definition — excludes `bot_active` |
| Bot Handling | `status = bot_active` | Bot owns these; no claim action; read access only, with a takeover path (below) |

Row content matches the existing queue row shape from the product spec: Player, Subintent, Status, Priority, Assignee, Labels, Age. Default sort per column: priority first, then oldest player message (same default as the product spec's queue).

## Layout

Responsive CSS grid: 4 columns on wide viewports, reflowing to 2x2 then a single stacked column as width shrinks. Each column has a fixed height with its own internal vertical scroll — columns never share a scroll position or a pager.

## Pagination

Each column paginates independently via infinite scroll: reaching the bottom of a column's scroll area fetches and appends the next page for that column only. No column's scroll state affects another's.

## Real-time updates

Each column subscribes to the existing `conversation:changed` socket event and re-evaluates whether the changed conversation belongs in its own filter (add/remove/update the row), rather than the whole board doing a global refetch. This keeps a claim in one column from causing a full-board reload.

## Actions

- **Claim** (Unassigned only): existing atomic claim endpoint (`POST /agent/conversations/:id/claim`). On success the row leaves Unassigned and appears in Mine/Agent Assigned via the socket event.
- **Take over** (Bot Handling only): clicking a Bot Handling row opens the conversation detail view read/write, with a "Take over" button shown above the composer. Take over transitions `bot_active → open` and assigns the conversation to the acting agent in one step. This is a new agent-initiated transition, additional to the existing `bot_active → open` triggers in the product spec (form submitted/skipped, player asks for a person, bot error/timeout) — all of which are system-triggered, not agent-triggered.
- All other row actions (reply, note, label, priority, resolve, escalate) are unchanged from the existing conversation detail view and apply once a conversation is `open`.

## Backend changes

- `conversationsService.listConversations` gains two new filter modes (currently only `unassigned` and `mine` exist): `agentAssigned` and `botHandling`. `unassigned` gets a status filter added (`open`, `escalated`) so it no longer matches `bot_active`.
- New endpoint or extended existing claim-adjacent endpoint for "take over": transitions `bot_active → open` and sets `assignedAgentId` to the acting agent, in one atomic operation (same race-safety requirement as claim — two agents can't both take over the same bot-handled conversation).
- No schema changes — all four columns are queries against the existing `conversations` table (`status`, `assignedAgentId`).

## Permissions

No change to the permission matrix: all four columns are visible to Agent, Team Lead, and Admin roles, matching "View all in workspace" and "View unassigned queue" already being ✓ for Agent in the product spec.

## Testing

- Backend: unit tests for the four `listConversations` filter modes, especially that `unassigned` now excludes `bot_active` and that `agentAssigned` includes the current agent's own tickets.
- Backend: race-safety test for take over (two concurrent take-over calls on the same conversation — exactly one succeeds), mirroring the existing claim race test.
- Frontend: each column renders its own paginated, independently-scrolling list; a `conversation:changed` event updates only the column(s) whose filter now matches.
