# Inbox visual polish

## Problem

The agent-console Inbox page (conversation list, thread header/toolbar, chat
bubbles, composer, context rail) is functional but visually flat: thin
uniform borders, minimal depth, a busy single-row toolbar, and chat bubbles
that read plainer than the webview's own (separate) bubble renderer.

## Scope

`frontend/src/surfaces/agent-console/pages/Inbox/**`,
`frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`,
`frontend/src/features/chat/components/ChatThread.tsx`,
`frontend/src/agent-console.css`.

Explicitly **not** touched: `surfaces/webview/**` (its `ChatBubbles.tsx` is a
separate component — confirmed via grep, not shared with `ChatThread.tsx`).

This is a polish pass, not a redesign: same layout, same component
boundaries, same accent palette. Tailwind v4 utilities on theme tokens only,
per `CLAUDE.md` § Styling — no hand-written CSS classes, no new deps.

## Design

**1. Theme tokens (`agent-console.css`)**
Add `--shadow-card` (a soft `0 1px 2px` neutral shadow) for bubbles/cards.
Slightly warm `--color-border` if needed once applied — otherwise leave as
is.

**2. `ConversationRow.tsx`**

- `py-3` → `py-3.5` for more breathing room.
- Selected row gets a 2px accent-colored left border in addition to the
  existing `bg-accent-soft` tint, so selection reads at a glance without
  relying on background contrast alone.
- Priority/status badge cluster: tighten gap so it doesn't visually compete
  with the player id line.

**3. `ConversationList.tsx` section headers**
"My tickets" / "Escalated tickets" become `sticky top-0` bars with a subtle
background (`bg-surface`) and a trailing count badge, so they stay legible
while scrolling a long list. No new data — count is `array.length`.

**4. `ThreadPanel.tsx` header/toolbar**
Keep the existing flex-row structure (metadata left via natural order,
actions right via `ml-auto` — already true today). Add a vertical divider
between the two clusters and normalize spacing/button sizing so the row
reads as two groups instead of one flat strip. No control is added, removed,
or reordered across the divider.

**5. `ChatThread.tsx` bubbles**

- `rounded-2xl` → `rounded-card` (the shared token, consistent with the
  webview's own bubble shape without sharing the component).
- Padding `px-3 py-2` → `px-3.5 py-2.5`.
- `shadow-sm` → the new `--shadow-card` token.
- Avatar ring: `size-8` → `size-8` unchanged, ring/background slightly
  more pronounced (`bg-*/20` → `bg-*/25`) for contrast against the new
  shadow.
- Internal-note (amber) and bot (dashed) styling untouched aside from
  inheriting the new shape/padding.

**6. Composer / ContextRail**
Padding-only alignment with the new spacing scale where it's visibly
inconsistent (e.g. composer's outer padding vs. the new bubble padding).
No structural or behavioral change.

## Out of scope

- Webview chat bubbles (`ChatBubbles.tsx`) — separate component, untouched.
- New color tokens beyond `--shadow-card`.
- Any change to data fetching, sockets, or interaction behavior.
- `BotConfig/BotTestPanel.tsx`'s use of `ChatThread` inherits the bubble
  change for free (same component) — not a separate scope item, but worth
  a visual glance after implementation since it wasn't asked for explicitly.

## Testing

Existing tests (`ConversationList.test.tsx`, `ThreadPanel.test.tsx`, etc.)
assert behavior, not exact class strings — expect them to keep passing
unchanged. Run `pnpm test` and `pnpm typecheck` in `frontend/` after.
Manual check: run the dev server, open Inbox, confirm layout/selection/
scroll behavior unchanged and only visuals shifted.
