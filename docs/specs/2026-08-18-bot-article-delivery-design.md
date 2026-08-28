# Bot article delivery — markdown answers with a "Read more" affordance

Date: 2026-08-18
Status: approved, not yet implemented

## Problem

`answer_from_article(article_id, answer)` delivers the bot's answer as a plain
`bot` message and drops the cited `article_id` into a `bot_article_offered`
event. Nothing carries the article to the player:

- `message` has no article column, `PlayerMessageView` no article field.
- `ChatBubbles.tsx` (webview) and `ChatThread.tsx` (agent console) render
  `message.body` as literal text — so the article's own markdown, which the bot
  is instructed to reuse verbatim ("keep every step, number and condition
  exactly as written"), reaches the player as raw `**`, `##` and `1.`.

`CLAUDE.md` anticipates this change explicitly: _"If you ever add real article
delivery, that is an addition to this, not a replacement for it."_ This is that
addition. `answer_from_article` keeps carrying the answer text; the article
becomes reachable alongside it.

## Scope

Two changes, one seam:

1. Bot- and agent-authored message bodies render as markdown in both surfaces.
2. A bot message citing an article gets a **"Read more"** button, appended by
   the client from a persisted `article_id` — never written by the model.

## Decisions

| Decision                           | Choice                                                     | Why not the alternative                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How the article reaches the client | Persisted `message.article_id`                             | A transient socket-only field loses the button on reload; correlating `bot_article_offered` events back onto messages is a fuzzy join between rows with no shared key |
| Renderer                           | Reuse `features/articles/components/ArticleBody.tsx` as-is | A chat-scale variant is a second renderer to keep in sync; `ArticleBody` is already the single place article markdown is rendered                                     |
| Which authors render markdown      | `bot` and `agent`                                          | `player` bodies are untrusted input — see Security below. Agent included so pasted article steps render like the bot's answer                                         |
| Button label                       | Bare "Read more"                                           | A snapshotted `article_title` is a second column and a second staleness question for a label the player does not need                                                 |
| Surfaces                           | Both webview and agent console                             | Both are Tailwind on identical token names, so `ArticleBody` re-themes for free (see Styling)                                                                         |
| Webview destination                | Nested route `/embed/support/chat/articles/:id`            | Reusing `/embed/support/articles/:id` renders `SupportHome`, unmounting a live chat; local state breaks the hardware back button                                      |
| Console destination                | New `/articles/:id` route, opened in a new tab             | In-app navigation hijacks the conversation the agent is reading                                                                                                       |

## Data

One nullable column on `message`:

```
article_id uuid null references article(id) on delete restrict
```

`ON DELETE RESTRICT` per the no-hard-deletes rule. No index: it is read on rows
already fetched by `conversation_id` and is never a filter or join key.

- `PostMessageInput` gains `articleId?: string | null`.
- `PostedMessageRow` gains `articleId: string | null` — satisfied automatically,
  `postMessage` inserts with `.returning()`.
- `applyBotTurn`'s `answer` branch passes `articleId: decision.articleId ?? null`.
  The value is already in scope one line above, where it sets `confirm_phase`.

**No select-list edits anywhere.** Every thread-read path already selects all
columns: `surface/services/messagesService.ts:269` and
`agent/services/conversationsService.ts:90` both use `tx.select().from(message)`.

**The FK-bypasses-RLS rule is already satisfied; no new scoped check is needed.**
`article_id` is not client-supplied. `toolLoop` rejects any `article_id` not
present in `searchedArticles`, which is populated only from `searchArticles`'
workspace-scoped query (`where eq(article.workspaceId, workspaceId)`). An id
reaching `postMessage` has already been proven visible in this workspace.

`bot_article_offered` is **untouched**, including its snapshotted
`article_title`. That event is the reporting record; this column is delivery.
The two are deliberately independent — metrics already group by the event, and
the column must not become a second, divergent source for the same funnel.

## Wire contract

`PlayerMessageView` gains `article_id: string | null`; `AgentMessageView`
inherits it. Purely additive, which the frozen-contract rule permits ("add
response fields freely, never remove or retype one").

Both serializers in `domain/conversations/serializers.ts` set it. `toPlayerView`
still returns `null` for the entire message when `visibility !== 'public'`, so
internal notes are unaffected by this change.

`backend/src/docs/openapi.ts` gets the new field, per the house rule that every
contract change lands in the OpenAPI spec.

## Shared frontend

`ChatMessage` (`features/chat/components/types.ts`) gains
`articleId?: string | null`, mapped in both surfaces' mappers.

Markdown rendering by author type:

| Author   | Rendering     |
| -------- | ------------- |
| `bot`    | `ArticleBody` |
| `agent`  | `ArticleBody` |
| `player` | literal text  |
| `system` | literal text  |

`ArticleBody` is lazy-loaded **once per thread**, not per bubble. Its own comment
records why it must not be static: a static import put ~790KB of react-markdown
on first paint and blew past the SDK's 8s load timeout, so the surface never
opened. A `Suspense` boundary per bubble would instead flash a fallback on every
message, so the boundary sits at the thread.

One styling fix: `ArticleBody`'s `code` and `pre` use `bg-surface`, and the
bot/agent bubble is also `bg-surface` — same colour on same colour. Fixed with a
wrapper class on the bubble, **not** by editing `ArticleBody`, so the article
sheet's rendering is untouched.

"Read more" renders only when `articleId` is non-null, and is appended by the
bubble. The model is never asked to write it — a prompt that asks for the link
would produce prose describing a link, which is the same failure mode
`CLAUDE.md` documents for `handoff` and `answer_from_article`.

## Webview

New nested route in `surfaces/webview/main.tsx`:

```
/embed/support/chat/articles/:id  →  the same lazy SupportChat
```

`SupportChat` reads `useParams`, renders the existing `ArticleSheet`
(`articleId` + `onClose`, unchanged), and closes via
`useCloseOverlay('/embed/support/chat')`.

Chat never unmounts while the sheet is open: the socket stays connected, thread
scroll position survives, and a bot or agent message arriving mid-read still
lands. `ArticleSheet` fires its existing once-per-session `reportArticleRead` and
`article_read` bridge post — correct, a player reading from a bot answer did read
the article, and this simply becomes a third entry point to that signal.

## Agent console

New route `articles/:id` under `AgentConsoleShell` in `routes/AppRoutes.tsx`,
mirroring the existing `inbox/:conversationId`. `KnowledgeBase` currently holds
selection in local `useState` (`selectedId` / `sheetOpen`); it seeds both from
the route param and navigates back to `/articles` on close.

The conversation's "Read more" is an anchor to `/articles/:id` with
`target="_blank" rel="noopener noreferrer"`. The agent keeps the conversation on
screen and reads the article beside it.

Known wart, accepted: `/articles/:id` opens `ArticleEditorSheet`, an editor, so
an agent who wanted to read lands in an edit form. In its own tab this is mild,
and the alternative — a read-only preview drawer — is a new component for a
secondary audience. If agents report it, the fix is a read-only mode on that
sheet, reusing the `ArticleBody` wiring this change already adds to the console.

## Styling

Both surfaces are **Tailwind-only**. `webview.css` and `agent-console.css` are
Tailwind v4 `@theme` blocks defining the same token names
(`--color-surface`, `--color-text`, `--color-accent`, `--color-accent-soft`,
`--color-muted`, `--radius-card`) with per-surface values, plus global
`html`/`body` background and two `@utility` helpers. There are no hand-written
component classes. `styles.css` is `/* deprecated */` — one line.

This is why reusing `ArticleBody` across both surfaces is nearly free: its
utilities (`text-text`, `bg-surface`, `text-accent`, `rounded-card`) resolve in
each surface to that surface's own values.

## Security

**Player-authored text is never markdown-rendered.** `ArticleBody` is safe today
only because it deliberately omits `rehype-raw`, so raw HTML in a body renders as
literal text. That property was reasoned about for _agent-authored_ article
bodies. Pointing the renderer at arbitrary player text would make an incidental
guarantee into one the system depends on against an adversarial input source.
Player and system bodies stay literal text.

## Failure modes

| Case                                        | Behaviour                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `article_id` is null                        | No button. Every pre-existing message is this case                                                                        |
| Article later unpublished                   | The player endpoint 404s; `ArticleSheet` already degrades to _"This article could not be loaded. Close and try another."_ |
| Article read from a months-old conversation | Same as above — contained, not a crash                                                                                    |

No server-side filtering of buttons by published status: that would cost a join
on every thread fetch to prevent a failure the sheet already handles.

**Nothing here touches `confirm_phase`.** Reading the article is not answering
"did this help?", so the confirm banner, `confirm_resolution`, and the
`bot_article_rejected` → `handoff('article_rejected')` wiring are unchanged.

## Tests

Backend:

- `applyBotTurn` persists `article_id` on an `answer` decision, and leaves it
  null on `handoff`, `resolve`, `unavailable` and `noop`.
- `toPlayerView` and `toAgentView` both carry `article_id`.
- `toPlayerView` still returns null for an `internal` message.

Frontend:

- A `bot` bubble renders markdown; a `player` bubble renders `**` literally.
- No button when `articleId` is absent.
- "Read more" navigates to `/embed/support/chat/articles/:id` (webview) and
  targets `/articles/:id` in a new tab (console).
- The webview sheet closes back to chat rather than home.

## Cleanup

The comment atop `ChatBubbles.tsx` states that `ChatThread.tsx` "is styled by
styles.css classes the webview no longer loads." That is stale — `styles.css` is
`/* deprecated */` and `ChatThread` is pure Tailwind. The claim caused a wrong
design call during this spec's own brainstorming (deferring the agent console on
a cost that does not exist), so it is corrected as part of this change.

The same fact is recorded in `CLAUDE.md` under Styling, so the next reader does
not have to rediscover it.
