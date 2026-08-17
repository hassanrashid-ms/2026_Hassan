# Article Markdown Rendering (Webview) — Design

**Status:** approved, not yet implemented
**Date:** 2026-08-17

**Goal:** Render article bodies as formatted markdown in the player-facing webview, replacing the
plain-text paragraph that shows agents' markdown syntax to players verbatim. Build the renderer so
inline media (images, GIFs, later video) slots in behind one component boundary without touching any
call site.

---

## Problem

Agents author article bodies in MDXEditor, a WYSIWYG markdown editor, and see formatted output.
Players see the raw string. `ArticleSheet.tsx:67` renders the body as:

```tsx
<p className="text-base leading-relaxed whitespace-pre-wrap text-text">{article.data.body}</p>
```

So a body of `## Refunds\n\nWe refund within **30 days**.` reaches the player with the `##` and the
asterisks intact. Every published article with any formatting is affected.

This is the only place an article body is rendered anywhere in the frontend. `PublicArticleSummary`
carries no body, so search results and the home list are unaffected.

## Non-goals

- **Article media storage.** No S3, no upload endpoint, no `article_attachment` wiring. That is a
  separate project ("B") which this design deliberately prepares a seam for. `article_attachment`
  stays schema-only, exactly as its comment in `schema/articles.ts:27` says.
- **Video.** Markdown has no video syntax and this design does not add raw HTML, so there is no way
  to express a video until attachments provide a handle. Images and GIFs both work today via
  `![]()`, so "inline media" is partly served; video is not.
- **`tablePlugin` in MDXEditor.** The renderer accepts tables; the editor still cannot reliably
  author them. See "Authoring asymmetry" below — this is a known, accepted gap.
- **The bot's grounding scorer.** `scoreGrounding` already scores against a body containing markdown
  syntax. That is pre-existing behaviour, unchanged here.

---

## Decisions

Each of these was chosen against alternatives; the rejected options and their costs are recorded so
a later reader does not re-litigate them blind.

### D1. `react-markdown` + `remark-gfm`, no `rehype-raw`

`react-markdown` parses to a syntax tree and renders React components, rather than producing an HTML
string for `dangerouslySetInnerHTML`.

The XSS argument that usually sells this library is weak here — the input is markdown written by our
own authenticated agents, not untrusted user content. The decisive reason is the `components` prop:
it is the interception point that lets an `img` node route through our own component, which is the
entire mechanism that makes project B cheap. We would choose this library for that alone.

`remark-gfm` adds tables, strikethrough, task lists, and autolinked bare URLs.

**`rehype-raw` is deliberately excluded.** Raw HTML in a body renders as literal text. This keeps a
pasted `<script>` inert and is why video is out of scope.

`react-markdown`'s default `urlTransform` (which strips `javascript:` and other dangerous schemes) is
kept as-is.

### D2. External image URLs render

An agent can already type `![alt](https://cdn.example.com/cat.gif)` into MDXEditor and save it —
nothing validates the body. Those images render.

**Accepted costs, chosen knowingly:** every player device fetches from a third-party host we do not
control, exposing player IPs to that host; and an article breaks silently when a third-party link
rots. Mitigated only by the alt-text fallback in D5.

Rejected: dropping image nodes silently (author sees an image in WYSIWYG, player sees nothing — the
same silent author/player divergence class of bug); a "media coming soon" placeholder; blocking image
nodes at the API until B ships.

### D3. Links open the system browser via the SDK bridge

A bare `<a href>` in a webview navigates in place, replacing the entire support surface with the
target page — no back button, no chrome, no way home. The player is stranded inside the game's help
view. This is the default behaviour and must be prevented.

The `a` component calls `preventDefault()` and posts `{ type: 'open_url', url }` over the existing
bridge. The SDK opens it in the system browser, leaving both the game and the support surface intact.

**This makes the project span two repos.** The SDK-side handler is in scope (see "SDK changes").

**Exception — no bridge present:** if `window.SupportBridge` is absent, the component does *not*
`preventDefault`, and the anchor behaves normally with `target="_blank" rel="noopener noreferrer"`.
A plain desktop browser is a supported development mode per `bridgeService`'s own comment, and links
should work there rather than being dead.

**Accepted cost:** a game shipping an SDK build older than the `open_url` handler hits the `default:`
branch in `OnMessage` and ignores the message, so the tap does nothing. This cannot be feature-
detected from the page — `post()` is fire-and-forget with no acknowledgement. Dead taps on old
builds are accepted; they are strictly better than stranding the player.

### D4. Rendered feature set: GFM, superset of what the editor can author

**Authoring asymmetry.** `ArticleEditorSheet`'s MDXEditor toolbar offers exactly: headings, lists,
links, blockquote, and bold/italic/underline. But MDXEditor is WYSIWYG over real markdown, so an
agent who types `| a | b |` or pastes from another tool can produce a table the toolbar never
offered — and MDXEditor's plugin list has no `tablePlugin`, so the editor itself may mangle it on
round-trip before it ever reaches a player.

The renderer is therefore permissive. It is the last line of defence, and its job is to never show a
player something broken regardless of what is in the column. A wide table renders inside its own
`overflow-x-auto` container, so it scrolls within itself rather than making the drawer scroll
sideways.

### D5. Styling via the `components` map, not `@tailwindcss/typography`

The typography plugin **is not installed** — there is no `@plugin` directive in any stylesheet and
no dependency in `package.json`. (Consequence worth knowing: the `prose prose-sm` classes on
MDXEditor in `ArticleEditorSheet` are silently inert today. Out of scope to fix here.)

Installing it would be the wrong move regardless: `webview.css` drives the entire type scale from a
single `clamp()` on `html`, and the plugin ships absolute font sizes that would fight it.

Block elements get explicit Tailwind classes using existing theme tokens (`text-text`, `text-muted`,
`rounded-card`), so the body inherits the viewport-scaled ramp.

---

## Architecture

### `ArticleBody`

New component at `features/articles/components/ArticleBody.tsx`.

It lives in `features/`, not `surfaces/webview/`, because `features/articles/` is already the home of
player-facing article code — `articlesApi.ts` there calls the player `/surface/articles` endpoints.
Rendering belongs next to fetching.

**Its entire public interface is one prop: the markdown string.** No slots, no config, no render
props. Everything else is internal. This is what lets project B change image behaviour without
touching a single call site.

```tsx
<ArticleBody markdown={article.data.body} />
```

`components` map:

| Node | Behaviour |
|---|---|
| `a` | `preventDefault` + `post({ type: 'open_url', url })` when the bridge exists; normal `target="_blank" rel="noopener noreferrer"` anchor when it does not (D3). |
| `img` | `<img>` with the agent's URL, `loading="lazy"`, `max-w-full h-auto`; on error, swaps to the alt text styled as a muted caption. **This is project B's seam.** |
| `table` | Wrapped in an `overflow-x-auto` container. |
| `h1`–`h3`, `p`, `ul`/`ol`, `blockquote`, `code` | Explicit Tailwind classes on theme tokens (D5). |

### Call site

`ArticleSheet.tsx:67`'s `<p>` becomes `<ArticleBody markdown={article.data.body} />`. The existing
loading skeleton, error state, and `article_read` emit are untouched.

### Data flow

**Unchanged, end to end.** No migration, no schema change, no API change, no `@support/types`
change. `article.body` is already a `text` column holding markdown; `PublicArticleDetail.body`
already carries it; `useArticleDetail` already fetches it. Only what the last few lines do with the
string changes.

### Bridge changes (spans both repos)

1. `BridgeMessage` union in `frontend/src/services/bridgeService.ts` gains
   `{ type: 'open_url'; url: string }`. (This half is in the app repo.)
2. A new `case "open_url":` in `OnMessage`'s switch at
   `Assets/Support/Surface/UnityWebViewSupportSurface.cs:227`, delegating to `Application.OpenURL`.
   `Assets/Support/Surface/ExternalBrowserSupportSurface.cs:13` already demonstrates the pattern.

**Security requirement on the SDK side.** The handler **must validate the scheme is `http` or
`https` and drop anything else.** `Application.OpenURL` honours custom schemes — `tel:`, `mailto:`,
and arbitrary registered app deep-links. `react-markdown`'s `urlTransform` sanitizes on the page
side, but the bridge is a plain string channel and the SDK must not assume the page is the only
thing that can post to it. Without this guard, `open_url` is a path from article content to any URI
handler registered on the player's device.

The guard should be a plain static helper so it is unit-testable independently of the
gree/unity-webview `#if` that wraps the surface class.

---

## Failure modes

| Failure | Behaviour |
|---|---|
| Broken/slow external image (likeliest real failure, given D2) | `loading="lazy"`; `onError` swaps the broken-image glyph for alt text as a muted caption. Degrades to a caption, not a broken icon. |
| Raw HTML in a body | Renders as literal text. No `rehype-raw`, so no path from content to executing markup. |
| Malformed markdown | `react-markdown` does not throw on bad input; worst case is literal text. No error boundary needed. |
| Link tap on an SDK build predating `open_url` | Ignored by `OnMessage`'s `default:` branch — a dead tap. Accepted (D3). |
| No bridge (desktop dev) | Anchor behaves normally, opening a new tab (D3). |

---

## Testing

- **`ArticleBody.test.tsx`** (new)
  - Headings, emphasis, and lists render as real elements, with no literal `#` or `*` in the output.
  - A GFM table renders inside an `overflow-x-auto` container.
  - Raw HTML renders as text, not markup.
  - An image gets `loading="lazy"` and falls back to alt text on `error`.
  - A link tap posts `{ type: 'open_url', url }` and does **not** navigate.
  - With no `window.SupportBridge`, a link keeps its `href` and `target="_blank"`.
- **`ArticleSheet`** — a body containing `**bold**` renders a `<strong>` and no literal asterisks.
  This is the test that closes the user-facing bug.
- **SDK** — a unit test that a non-`http(s)` scheme is dropped by the guard helper. Extracting the
  guard as a static helper (above) exists precisely so this test does not depend on the
  gree/unity-webview define.

**Pre-existing unrelated failures.** `TopBar`, `SupportHero`, `SupportChat`, and `ChatThread` have
5 failing tests on `main` as of this date, verified failing with these changes stashed. They are out
of scope and must not be mistaken for regressions from this work.

---

## What project B inherits

When article media ships, the changes are contained:

1. `ArticleBody`'s `img` component learns to recognise an attachment handle and resolve it to a
   signed URL. No other component, and no call site, changes.
2. A `video` renderer is added to the same map — which requires B to also decide how a video is
   expressed in markdown, since markdown has no syntax for one.
3. Media position is already preserved for free: media lives inline in the markdown body, so an
   agent's placement *is* the stored order. `article_attachment` rows carry storage and metadata;
   they never carry position.
