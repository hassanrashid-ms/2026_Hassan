# Agent player context rail — frontend design

Status: implemented
Companion: `2026-08-17-agent-player-context-backend-design.md`

## What this is

A slide-over rail in the agent console showing the player-state snapshot for the
open ticket and that player's other tickets, plus read-only viewing of those older
tickets in the panel that already exists.

The product spec (`Docs/Customer Support Tool - CRM v2.txt`, pages 11–12 and 30–31)
draws this as two tabs beside the conversation. It is a rail here instead: the
spec's own argument for the feature is that an agent should _"diagnose most issues
without leaving the conversation view"_, and a tab is leaving it. The judgement
being supported — "third time this month" versus "first contact ever" — is a
comparison against the transcript, so both must be readable at once.

## The rail

A right-hand drawer that slides in over the content. `Inbox.tsx`'s layout is
unchanged: no third column, no breakpoint split, no reflow when it opens.

**Non-modal.** `components/ui/sheet.tsx` is Radix Dialog and `SheetContent`
hardcodes `<SheetOverlay />` — `bg-black/50`, full screen. Used as-is the thread
dims behind a scrim, focus is trapped in the rail, and clicking the transcript
closes it, which reintroduces the read-one-at-a-time problem that ruled out tabs.

So `SheetContent` gains `showOverlay?: boolean`, defaulting to `true`, and the
rail passes `modal={false}` on the root. `ArticleEditorSheet` is unaffected — the
default preserves today's behaviour.

The rail is `w-96`, right side, shadow and left border, no scrim. The thread stays
lit, scrollable and clickable underneath. It closes via its X or the header toggle,
never by an outside click. Open/closed state persists in `localStorage` alongside
the agent session: a rail that re-collapses on every navigation is a rail agents
stop opening.

Toggled from a button in the `ThreadPanel` header.

## Contents

Two stacked sections, both visible, no tabs within the rail.

**Player state** — declared fields first, ordered and labelled as the API returns
them, then a collapsed _"Everything else the game sent"_ holding `raw`.

`raw` is shown to every agent, collapsed by default. It is PII (CLAUDE.md: _"Treat
`state.raw` as PII by default"_), honoured here by labelling and retention rather
than access control. Expanding it writes no event. If `raw` is `{}` the section is
omitted entirely rather than opening onto nothing.

The four `player_state` cases each get their own copy. Nothing is synthesised from
a later session:

| `status`                       | Copy                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `no_session`                   | "No session was attached to this ticket"                                |
| `not_captured`                 | "No player state was captured"                                          |
| `missing`                      | "The game returned no player data"                                      |
| `captured` + `degraded_reason` | Fields render normally, with a note above them that capture was partial |

**Tickets** — this player's other tickets, newest first, each showing its number,
date, subintent and outcome. A summary line above: _"5 earlier tickets · 2 reopened
· first contact 12 Apr 2026"_.

Called "tickets" throughout the UI, not "conversations" or "issues".

## Outcome labels

`ticketOutcome.ts` — a pure function, `(status, resolution_source,
resolved_by_agent_name, reopen_count) → string`:

- "Resolved by Sam"
- "Resolved by the bot"
- "Resolved by Sam · reopened twice"
- "Closed" when `resolution_source` is null

Split out because it is the one piece with real branching, and this surface
already has the pattern (`articleForm.ts` / `articleForm.test.ts`). Testable
without mounting anything.

## Data

One query, keyed `['conversation', id, 'context']`, with a long `staleTime`.

The snapshot is immutable by construction and ticket history changes on the order
of days. This is the opposite of the messages query and is wired to **no socket
events**. Nothing invalidates it except navigating to a different ticket.

Header data for the open ticket comes from `GET /agent/conversations/:id`. This is
required, not an optimisation: `Inbox.tsx:29` derives the selected conversation by
searching the `unassigned` and `mine` lists, and an older ticket — resolved, owned
by another agent — is in neither and never will be.

The rail is its own query, so its failure is contained. If `/context` errors the
thread keeps working and the rail shows a retry. A `404` reads as "Ticket not
found".

## Navigating to an older ticket

Plain `navigate('/inbox/:id')`. No modal, no second route, no navigation state of
its own.

The rail then re-fetches for the newly selected ticket, which gives the property
worth stating: **the rail always describes the ticket currently on screen.** Open a
ticket from June and the rail shows June's snapshot and June's sibling tickets —
one of which is the ticket you came from. Navigation works in both directions and
the browser back button does the obvious thing.

## Read-only tickets

`ThreadPanel` gains a `readOnly` boolean. No new panel, no forked component.

**Read-only means `status === 'resolved' || status === 'closed'`.** Deliberately
not "assigned to another agent": an unassigned live ticket currently lets an agent
reply without claiming, and changing that is a claim-flow decision unrelated to
this rail.

Four behaviours change:

1. **Composer disabled**, placeholder naming the resolver. `Composer` gains an
   optional `placeholder` prop defaulting to today's `"Type a message…"`. Text
   from `resolution_source` and the resolver's name: "Resolved by Sam", "Resolved
   by the bot", or "Closed".
2. **"Ask if resolved" hidden.** `askable` is already gated on
   `open`/`awaiting_player`, so it is dead in this state; hiding it removes a
   disabled control that explains nothing.
3. **`markAgentMessagesRead` skipped.** The load-bearing one. That effect fires on
   every load (`ThreadPanel.tsx:158`) and `message.read_at` is _"set once, by the
   first mark-read that matches this row. Never rewritten."_ Glancing at a June
   ticket for context would permanently stamp read receipts the player is shown.
   Reading history must not write history.
4. **A banner** at the top of the panel: _"Viewing an earlier ticket · #1039 ·
   resolved 2 Jun 2026"_. Without it an agent lands on June's transcript and
   reasonably concludes the live ticket changed under them. Same slot and
   treatment as the existing amber "Waiting on the player" strip, so it reads as a
   panel-wide state rather than decoration.

The socket stays connected: it costs one existing effect and means a ticket
reopened by someone else while you are looking at it updates rather than going
stale.

## Files

| Path                                                  | Change                                          |
| ----------------------------------------------------- | ----------------------------------------------- |
| `pages/Inbox/components/ContextRail.tsx`              | new; container, owns the context query          |
| `pages/Inbox/components/context/PlayerStatePanel.tsx` | new                                             |
| `pages/Inbox/components/context/TicketList.tsx`       | new                                             |
| `pages/Inbox/components/context/ticketOutcome.ts`     | new; pure                                       |
| `pages/Inbox/components/ThreadPanel.tsx`              | `readOnly`, banner, rail toggle                 |
| `pages/Inbox/Inbox.tsx`                               | detail query, rail mount, open/closed state     |
| `components/ui/sheet.tsx`                             | `showOverlay?: boolean`, default `true`         |
| `../../features/chat/components/Composer.tsx`         | `placeholder?: string`                          |
| `api/agentApi.ts`                                     | `fetchConversation`, `fetchConversationContext` |

`Composer` is shared with the webview surface. Both new props are optional and
defaulted, so that surface is untouched.

## Tests

- `ticketOutcome.test.ts` — pure, every branch, no mounting
- `ContextRail` renders each of the four `player_state` states
- `ContextRail` omits the raw section when `raw` is `{}`
- `ThreadPanel.test.tsx`, extended: read-only disables the composer with the
  resolver placeholder, hides "Ask if resolved", renders the banner, and — the
  assertion that matters — **does not call `markAgentMessagesRead`**

## Out of scope

- Custom fields (the product spec's fourth tab; no data model behind it)
- Compensation / "refund granted" outcomes
- Filtering or saved views over declared fields — a queue feature
- Reopening an older ticket from the rail
