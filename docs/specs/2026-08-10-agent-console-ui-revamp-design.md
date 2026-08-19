# Agent Console UI Revamp

## Context

The webview surface (player-facing SDK UI) was recently revamped with Tailwind v4 + shadcn/ui (`docs/specs/2026-08-10-webview-game-ui-design.md`). The agent-console surface — Inbox, Conversation, and Admin Articles — still renders bare HTML elements with plain class names and no design system. This revamp brings the same visual quality to the agent-facing side.

## Scope

In scope: Inbox, Conversation view, Admin Articles.
Out of scope: `AgentLogin` — it's a temporary dev picker standing in for Google OAuth ([[agent-auth-google-oauth-domain-restricted]] in memory) and will be redesigned when real auth ships.

No backend or API changes. This is purely a frontend restructure and restyle; `agentApi.ts` and `@support/types` contracts are unchanged.

## Foundation

- New `components.json` for the agent-console surface: `ui` alias → `agent-console/components/ui`, `utils` → `agent-console/lib/cn`, base color **slate** (distinct from webview's violet, so the two surfaces are visually distinguishable), CSS variables on, icon library lucide.
- New `agent-console.css`, scoped and imported only by the agent-console entry point — mirrors how `webview.css` is isolated today (per the comment in `AppRoutes.tsx`, static imports would leak Tailwind's preflight reset into whichever surface didn't ask for it).
- shadcn primitives are added under `agent-console/components/ui` as needed: `button`, `input`, `textarea`, `select`, `tabs`, `badge`, `card`, `sheet`, `table`, `dialog`, `avatar`, `dropdown-menu`, `separator`, `scroll-area`.
- New `AgentConsoleShell` (`surfaces/agent-console/components/AgentConsoleShell.tsx`): persistent layout with a left sidebar (nav: Inbox, Knowledge Base) and a topbar (signed-in agent name, logout). Rendered as a layout route wrapping all agent-console pages.

## Routing changes

- `/inbox` and `/inbox/:conversationId` — merged inbox + conversation split view (see below), replacing the current separate `/inbox` and `/conversations/:id` routes.
- `/articles` — Knowledge Base (renamed from Admin Articles).
- Both routes render inside `AgentConsoleShell`.
- `/login` is untouched and stays outside the shell.

## Inbox + Conversation (merged split view)

Single page: `pages/Inbox/Inbox.tsx`.

**Left rail** — `pages/Inbox/components/ConversationList.tsx`:
- shadcn `Tabs`: **Unassigned** / **Mine** (matches `fetchInbox(token, 'unassigned' | 'mine')`).
- Each row (`ConversationRow.tsx`): player's `external_player_id`, a status `Badge` color-coded per `ConversationStatusValue` (`new`, `bot_active`, `open`, `awaiting_player`, `escalated`, `resolved`, `closed`), truncated `last_message_preview`, relative `last_message_at`.
- Selected row is visually highlighted and drives the URL (`/inbox/:conversationId`).
- Claim button appears on hover for unassigned rows; reuses the existing `claimConversation` mutation and `conversation:changed` socket invalidation, unchanged in behavior.

**Right panel** — `pages/Inbox/components/ThreadPanel.tsx`:
- Empty state ("Select a conversation") when no conversation is selected.
- Otherwise renders the existing `ChatThread` / `Composer` from `features/chat`, restyled with shadcn primitives. Header shows player id + status badge.
- Existing socket logic (`join_conversation` / `message:new` / mark-as-read) moves into this component unchanged.
- **Every counterpart bubble is labelled with who spoke.** `ChatThread` sided a bubble on `authorType === currentAuthorType`, which makes *own* and *not own* the only two states — so in the agent console a **bot** reply and a **player** message rendered as the same bubble on the same side, and an agent could only tell them apart by reading the words and guessing. Bot bubbles now carry a `Bot` label and a dashed, muted treatment. Both counterparts are labelled rather than just the bot: labelling one makes the other's identity depend on an absence, which is exactly the inference that was going wrong. The agent's own messages stay unlabelled — the side they sit on already says it. `data-author` carries the raw `authorType` for tests.
- **Side is "whose side of the conversation", not "who typed it".** The bot answers on support's behalf, so to an agent it belongs on their own side; rendering it opposite the agent's replies misrepresents who the player is talking to. `onOwnSide = isOwn || (isBot && currentAuthorType === 'agent')` drives alignment, kept separate from `isOwn`, which still means *I typed this* and remains the sole gate on the read receipt — the agent must not be shown a receipt for a message they did not send. The condition is on the reader, not the message: to a player the bot stays the counterparty.
- **Player bubbles are labelled with the player's `external_player_id`**, passed down as `playerLabel` from `ThreadPanel` (which already shows it in the header) — a `player` row has no display name, so the external id is the only identity there is. Rendered `normal-case` rather than the uppercase used for the `Bot` / `Agent` labels, because an id is data and may be case-sensitive. Falls back to the generic `Player` when the caller has not resolved one yet, so a bubble is never left unlabelled mid-load.
- The player-facing webview (`surfaces/webview/components/chat/ChatBubbles.tsx`) has the same structural gap — bot and human agent both render as "not the player" — but whether a player is *told* they are talking to a bot is a product decision, not a UI defect, so it is deliberately left alone here.

**Responsive behavior:** below a breakpoint, selecting a conversation replaces the list with a full-screen thread (with a back affordance) since side-by-side doesn't fit narrow viewports.

## Knowledge Base (formerly Admin Articles)

Single page: `pages/KnowledgeBase/KnowledgeBase.tsx`.

**Left rail:**
- `CategorySidebar.tsx` — intents/subintents tree (unchanged data/behavior), add-category input.
- `ArticleTable.tsx` — shadcn `Table` of articles (title, state `Badge`, updated date), "+ New" button.

**Editor:** `ArticleEditorSheet.tsx` — a shadcn `Sheet` sliding in from the right, replacing the current inline editor column. Contains:
- Title `Input`, Keywords `Input`, Category `Select` — same fields, same validation as today.
- Body: **MDXEditor** WYSIWYG in place of the plain `textarea`. Toolbar covers headings, bold/italic, lists, links, code blocks, blockquote. MDXEditor reads and writes markdown source directly, so the `body: string` field and its contract with the backend are unchanged — the article body was already stored as markdown text; this just gives agents a rich editing surface over the same string instead of a raw textarea.
- Actions (Create Draft / Save / Publish / Archive) as `Button`s. Enablement logic (`canEditFields`, `canPublish` from `articleForm.ts`) is unchanged — it moves into `pages/KnowledgeBase/` alongside its test file but the functions themselves aren't touched.
- Opening "+ New" or selecting an existing article opens/updates the Sheet; closing it deselects (same state model as today's `selectedId`).

## File structure

```
surfaces/agent-console/
├── components/
│   ├── AgentConsoleShell.tsx
│   └── ui/                          (shadcn primitives)
├── pages/
│   ├── Inbox/
│   │   ├── Inbox.tsx
│   │   └── components/
│   │       ├── ConversationList.tsx
│   │       ├── ConversationRow.tsx
│   │       └── ThreadPanel.tsx
│   ├── KnowledgeBase/
│   │   ├── KnowledgeBase.tsx
│   │   ├── articleForm.ts
│   │   ├── articleForm.test.ts
│   │   └── components/
│   │       ├── CategorySidebar.tsx
│   │       ├── ArticleTable.tsx
│   │       └── ArticleEditorSheet.tsx
│   └── AgentLogin.tsx                (untouched, out of scope)
├── lib/
│   ├── cn.ts
│   └── agentSession.ts
├── types/
└── api/
    └── agentApi.ts                    (unchanged)
```

`AgentInbox.tsx`, `AgentConversation.tsx`, and `AdminArticles.tsx` are deleted; their logic is redistributed into the structure above.

## Testing

- `articleForm.test.ts` moves as-is with its module.
- Add component-level coverage for the claim flow in `ConversationList` and for MDXEditor round-tripping markdown in `ArticleEditorSheet` (write markdown in, confirm the same markdown comes back out on save) — nice-to-have, not blocking the revamp.
- No changes to backend tests; no API surface changed.

## Out of scope / explicitly not doing

- No backend/API changes.
- No changes to `AgentLogin`.
- No dark mode toggle (clean/neutral light theme only, per the chosen visual direction).
- No new conversation-priority or SLA features — this is a visual/structural revamp of what exists today, not new functionality.
