# Webview Game UI — Design

**Date:** 2026-08-10
**Status:** Implemented (2026-08-10). Two clauses diverged in practice — see
"Implementation notes" at the end.
**Scope:** `frontend/src/surfaces/webview/**`, plus one backend field

---

## Purpose

The in-game player surface is a functional prototype: one 350-line component, a
developer-facing diagnostic panel at the top of the screen, and hand-written CSS shared
with the agent console. It is opened only from a mobile game, on a phone, over a paused
game — and it does not look like it.

This design replaces that presentation layer with a mobile-only, game-scale UI built on
Tailwind v4 and shadcn/ui. It is a presentation rewrite. The API surface, the search
path, the chat transport, and the bridge protocol are unchanged.

**Out of scope:** the agent console (keeps its existing `styles.css`), per-workspace
banner uploads, dark mode, E2E tests.

---

## Constraints

1. **Mobile only.** The surface opens in a Unity webview on a phone. There is no desktop
   layout, no hover state, no mouse.
2. **Responsive units only.** Reference canvas is 1080×1920, but no fixed pixel sizes.
   `dvh`, `rem`, `%`. The sole exception is hairline borders, which stay `1px` — a
   scaling border is a bug.
3. **Weaviate search is untouched.** See "Search must not regress" below.
4. **Webview only.** Nothing in this design may alter how the agent console renders.
5. **CLAUDE.md rules hold**, in particular: missing player state is a state and not an
   error; there are no dead ends; new endpoints register in `openapi.ts`.

---

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Webview only; agent console untouched | Console migration is a separate project with its own spec |
| 2 | Game name from `BootstrapResponse`, fallback `"Game Support"` | `workspace.name` already exists; surface contract is explicitly not frozen; no SDK change; cannot drift |
| 3 | Real React Router routes per screen | Android hardware back works; screens testable in isolation; breaks up the 350-line component |
| 4 | Light mode, purple accent, semantic tokens | Token layer makes dark mode and per-game rebranding configuration, not a rewrite |
| 5 | Hero: bundled asset if present, else gradient | Ships now; `<SupportHero imageUrl?>` makes a future server-driven banner a prop, not a redesign |
| 6 | Root `font-size: clamp()`, everything in `rem` | One line scales Tailwind's entire rem-based scale; no per-component clamp expressions |
| 7 | shadcn wherever its behaviour is good; hand-built where its look is not | Radix gives focus trapping, scroll locking, ARIA — hard to get right by hand. Game-scale visuals are ours |
| 8 | Debug button always rendered, small and low-contrast | A dev-only button is useless exactly when field debugging needs it |

---

## Foundation

### Tailwind v4

Config-less. Install `tailwindcss` and `@tailwindcss/vite`; register the plugin in
`vite.config.ts`.

New `frontend/src/webview.css`:

```css
@import "tailwindcss";

@theme {
  --color-bg:          #ffffff;
  --color-surface:     #f5f3fd;  /* purple-tinted card background */
  --color-accent:      #7c3aed;  /* primary purple */
  --color-accent-soft: #ede9fe;  /* chips, selected tab background */
  --color-accent-fg:   #ffffff;
  --color-text:        #1a1720;
  --color-muted:       #6b6577;
  --radius-card:       1rem;
}

html { font-size: clamp(14px, 4.27vw, 22px); }
```

`4.27vw` is `16/375` — 16px at a 375px-wide phone, scaling up, capped at 22px so tablets
do not get absurd type. Every Tailwind spacing and type utility is rem-based, so the
whole scale rides on this one rule.

The hero gradient runs `--color-accent` → a deeper violet (`#5b21b6`). These values are
the starting palette, not a brand commitment — changing the accent means editing this one
block, and every component follows.

### Isolation from the agent console

`main.tsx` continues to import `styles.css` only. **`webview.css` is imported by
`WebviewShell`**, not by `main.tsx`. Console pages therefore never load Tailwind and
cannot be affected by its preflight reset. This is what makes "webview only" structural
rather than aspirational.

### styles.css cleanup

Delete only the webview rules: `.surface`, `.surface-articles__*`, `.surface-modal-*`,
`.chat-panel`, `.notice`, `.read-badge`, `.summary-snippet`.

Before deleting any class, grep for its use across `surfaces/agent-console/**` and
`features/**`. A class the console also uses stays, whatever its name suggests. Removal
is verified by usage, not inferred from the prefix.

### shadcn

`components.json` at the frontend root; components generated into
`src/surfaces/webview/components/ui/`. Adds the `@/` path alias.

**The alias must not weaken the existing boundary.** `eslint-plugin-boundaries` currently
enforces that the two surfaces never cross-import. Its config gains a rule so that
`@/surfaces/webview/*` is unreachable from `surfaces/agent-console/**` and vice versa —
the alias is a convenience, not a hole.

Components taken from shadcn: `Sheet`, `Dialog`, `Tabs`, `ScrollArea`, `Skeleton`,
`Input`, `Badge`. More may be taken where their input behaviour is good; the test is
whether the component's *behaviour* is worth more than its *default styling* costs.

Hand-built: `SupportButton`, `ArticleCard`, `TopBar`, `SearchField`, `SupportHero`,
chat bubbles.

### Backend — one field

`BootstrapResponse` in `packages/types/src/surface.ts` gains:

```ts
workspace: { name: string }
```

Populated in `backend/src/surface/services/bootstrapService.ts` from `workspace.name`.
Registered in `backend/src/docs/openapi.ts` per CLAUDE.md.

This is additive to a contract the file's own header marks as not frozen. No SDK change.

---

## Routes and shell

```
/embed/support                 SupportHome
/embed/support/search          SupportSearch
/embed/support/articles/:id    home + ArticleSheet open (deep link)
/embed/support/chat            SupportChat
```

The existing unlinked stubs `ArticleList.tsx` and `ArticleView.tsx` are deleted; these
routes replace them. `SupportSurface.tsx` is deleted, its logic distributed as below.

### WebviewShell

Wraps all four routes. Owns exactly:

- boot parse (`readBoot`) and token scrub (`scrubToken`)
- the `startedRef` idempotence guard — **preserved verbatim**. StrictMode double-invokes
  mount effects; without the guard the second invocation reads an already-scrubbed URL
  and sets a false "no session token" error. It fixes a real bug and is not scaffolding.
- the bootstrap fetch and the retry-until-session-lands poll (15 attempts, 800ms)
- `SupportContext` providing `{ boot, data, error, retry }`
- layout: `100dvh` flex column, `env(safe-area-inset-*)` padding, `overflow-hidden` so
  only inner regions scroll
- the `webview.css` import

Screens consume context. No screen re-fetches bootstrap.

### TopBar

One component, prop-driven per variant:

| Screen | Left | Centre | Right |
|---|---|---|---|
| Home | `✕` close | game name | 🔍 search · 💬 chat (unread badge) |
| Search | — | `Input` (autofocus) | `Cancel` |
| Chat | `←` back | "Support" | — |
| Article (deep link) | `←` back | article title | — |

`✕` posts `{ type: 'close' }` over the bridge, unchanged. `←` is `navigate(-1)`.

Game name reads `data.workspace.name` from context, falling back to `"Game Support"`.
It renders the fallback string during the bootstrap gap rather than a skeleton — the
fallback *is* the placeholder.

The debug `⋯` sits in the top bar corner on every screen.

---

## Screens

### SupportHome

- `TopBar` (home variant)
- `SupportHero` — `25dvh`. Resolves a bundled asset via
  `import.meta.glob('/src/assets/hero.*', { eager: true })`; renders the purple gradient
  when the glob is empty. Game name overlaid. Accepts an optional `imageUrl` prop so a
  future server-driven banner is a prop change.
  - The overlaid search control is a **button styled as an input**. Tapping it navigates
    to `/search`. It never focuses in place — that would open the keyboard under a hero
    about to scroll away, and it keeps exactly one real search input in the app.
- `CategoryTabs` — shadcn `Tabs`, horizontally scrollable. "All" plus `fetchIntents()`.
  Sets `intentId`.
- `ArticleList` — `ArticleCard` each: large title, keywords as chips, read state.
  Tapping opens `ArticleSheet`.

### SupportSearch

- `TopBar` (search variant): shadcn `Input`, autofocused, and `Cancel` → `navigate(-1)`.
- Results below using the same `ArticleCard`.
- Debounce **250ms**, down from the current 800ms. 800ms on a dedicated search screen
  reads as broken.
- Three distinct states: idle (nothing typed), no results, results.

### ArticleSheet

shadcn `Sheet` from the bottom, ~90dvh, own scroll region. Title, keywords, body.

Fires `reportArticleRead(token, sessionId, articleId)` and posts
`{ type: 'article_read', id }` over the bridge — once per article, exactly as today.

### SupportChat

Full screen. `ChatThread`, `Composer`, `createSocket`, `reconcilePending`, the mutation's
optimistic `pending` handling, and the read-receipt effect all move over **unchanged in
behaviour**, restyled only:

- player bubbles accent-purple, right-aligned
- agent bubbles surface-grey, left-aligned
- composer pinned bottom with safe-area padding; `dvh` keeps it above the keyboard

The `onSuccess` handler still does not clear `pending` — `reconcilePending` drops an
entry only once the refetched server list contains a match, so the optimistic bubble
never flickers. The resolved/closed "still facing issues?" prompt is preserved.

### DebugDialog

shadcn `Dialog`, opened from `⋯`. Content is today's diagnostic panel, relocated and
restyled, not redesigned:

- session id, entry point, started at, external player id, unread count
- `AVAILABILITY_COPY` sentence for `player_state.availability`
- `degraded_reason` when present
- `captured_at` — shown prominently, because a reopened conversation keeps its original
  snapshot and a stale client version otherwise reads as current
- `declared` JSON, and `raw` JSON when present

Rendered in production. `raw` is PII by default, but this is the player reading their own
data, and a readable session id is a support feature.

---

## Search must not regress

`GET /surface/articles?q=&intentId=` routes through `searchArticleIds` (Weaviate BM25) in
`backend/src/surface/services/articlesService.ts`, then hydrates from Postgres and
**reconstructs Weaviate's ranked order** via `rankedIds.map(...)`.

Therefore:

- The frontend calls the same `surfaceApi.ts` functions with the same arguments. No
  change to the article or search API path.
- **Never re-sort or client-side-filter the returned array.** Sorting it in a component
  silently discards BM25 relevance and looks like nothing is wrong. This is the one easy
  way to break search while "only touching the UI."
- `CategoryTabs` passes `intentId` through to the same call so it composes with the query
  server-side; Weaviate receives the intent filter rather than the UI filtering after.
- Empty results render an empty state. There is no local-filter fallback.

`features/articles/lib/articleSearch.ts` is a query-param builder used by the agent
console's `articlesApi.ts`. It is not a client-side matcher, and nothing in the codebase
filters articles locally today. The new UI does not introduce it.

---

## Data flow

`WebviewShell` fetches bootstrap once and provides it via context.

Articles, intents, article detail, and messages remain TanStack Query with today's query
keys (which include `boot.token`). Cached results therefore survive navigation, and
moving home → search → home does not refetch.

---

## Error and empty states

Every screen renders one of these. No blank regions.

| State | Rendering |
|---|---|
| No token | Full-screen message: "This page must be opened by the game." No top bar — there is no session to close. |
| Bootstrap failed (15 attempts exhausted) | Full-screen message with a **retry** button. New: today the poll simply stops with no way back. |
| Loading | shadcn `Skeleton` in the shape of the content. Not a spinner. |
| Empty | Per-screen copy: "No articles yet", "No results for …". |

Two behaviours preserved deliberately:

- **Missing player state is a state, not an error.** The `AVAILABILITY_COPY` sentences
  move into the debug dialog intact. A degraded or absent snapshot never blocks the UI.
- **Chat is always reachable.** The chat icon works even when bootstrap failed —
  "no dead ends" outranks having complete data.

---

## Testing

Vitest is configured; component testing is not. Adds `@testing-library/react` and
`jsdom`.

| Test | Proves |
|---|---|
| `chatReconcile.test.ts` passes untouched | The chat logic move was a move, not a rewrite |
| `articleSearch.test.ts` passes untouched | Console search path undisturbed |
| `readBoot` / `scrubToken` | Already-testable pure functions, currently untested |
| `SupportHero` | Asset when the glob resolves, gradient when it does not |
| `TopBar` | Fallback game name before bootstrap lands; real name after |
| Article list order | Renders in API order — the regression guard on Weaviate ranking |

Not included: visual regression and E2E. Low value relative to setup cost on a surface
about to change again.

---

## Risks

| Risk | Mitigation |
|---|---|
| Tailwind preflight leaks into the console | `webview.css` imported by `WebviewShell`, never `main.tsx` |
| Deleting a `styles.css` class the console uses | Grep each class before deleting; verify by usage, not prefix |
| `@/` alias bypasses surface boundaries | Add the boundaries rule in the same change as the alias |
| Chat regressions during the move | Behaviour moves unchanged; `chatReconcile.test.ts` must pass untouched |
| Search relevance silently lost | Explicit no-re-sort rule plus an order test |

---

## Implementation notes

Two clauses above did not survive contact, both in the direction of the design
being right and its stated mechanism being insufficient.

### The import location does not isolate the console — the chunk boundary does

"`webview.css` is imported by `WebviewShell`, not by `main.tsx`" is necessary but
not sufficient. Vite concatenates every *statically reachable* stylesheet into one
bundle, so with a plain `import` the console still received Tailwind's preflight in
production even though no console module mentions it. Being the only importer means
nothing if the importer is in the same chunk.

`AppRoutes.tsx` therefore loads the webview through `React.lazy`. That puts
`webview.css` in its own chunk, fetched only when an `/embed/support` route renders.
The guarantee is now checkable in the build output rather than by inspection:

```
dist/assets/WebviewShell-*.css   preflight yes   console rules no
dist/assets/index-*.css          preflight no    console rules yes
```

If a future change makes the webview statically reachable again, those two files
collapse back into one — that is the regression signal to watch.

### `.notice` stays

It is on the deletion list under "styles.css cleanup", but `AgentInbox.tsx` and
`AgentLogin.tsx` both use it. The spec's own rule — "a class the console also uses
stays, whatever its name suggests" — outranks its own list. `.chat-message*` and
`.composer*` stayed for the same reason: `features/chat/components/` renders in the
console. `styles.css` went 628 → 405 lines.

### Smaller things worth knowing

- `index.html` gained `viewport-fit=cover`. Without it `env(safe-area-inset-*)`
  resolves to `0` and the shell's safe-area padding is inert — the layout looked
  correct in a desktop browser and would have been wrong on every notched phone.
- The search query lives in the URL (`/embed/support/search?q=…`), not in component
  state. Opening an article is a real navigation, so the screen unmounts; without
  this, returning from an article lost the query.
- The webview hand-builds its chat bubbles and composer rather than restyling
  `features/chat/components/`. Those shared components are styled by `styles.css`
  classes the webview no longer loads, and the console renders them. What is
  actually shared is what matters: the `ChatMessage` shape, `reconcilePending`, the
  socket, and the API module.
- The `@/` alias is fenced with per-zone `no-restricted-imports` patterns rather
  than an import resolver. `boundaries/dependencies` classifies by resolving to a
  file on disk and does not see `@/…` without a resolver configured, so the alias
  would otherwise have been a one-line bypass of every arrow it enforces. All three
  directions were probed and confirmed to error.
