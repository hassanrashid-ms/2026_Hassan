# Frontend folder structure & surface isolation

Status: approved design, not yet implemented.

Supersedes the frontend section of `2026-08-05-folder-structure-revamp.md`, which
described the flat single-screen state before the agent console and article/chat
features existed. That spec's backend section is untouched by this doc.

## Why

`frontend/src` now serves two audiences through one app:

- **Agent/admin console** — `AgentLogin`, `AgentInbox`, `AgentConversation`,
  `AdminArticles`. Used by human support agents in a normal browser tab, gated by
  Google OAuth (see `agent-auth-google-oauth-domain-restricted` memory).
- **Webview** — `SupportSurface`, `ArticleList`, `ArticleView`. Embedded inside the
  Unity SDK's in-game webview, opened via a signed token in the URL fragment, no login.

Both audiences' code currently lives flat under `pages/`, `api/`, `components/`,
`lib/`, `services/` with no boundary preventing one surface from reaching into the
other's internals. As both surfaces grow, that boundary needs to be explicit and
enforced, not just conventional.

## Decision: no server/repo split

The webview and agent console ship together — one Vite app, one build, one deploy,
same Express backend. A second server or separate app would add a second dev/build/
deploy target with no isolation benefit, since both surfaces already share the same
API contract (`@support/types`), the same chat primitives, and the same auth
boundary enforcement point (route/component level, not process level). Isolation is
achieved through folder structure and lint-enforced import boundaries instead.

## Target structure

```
frontend/src/
├── assets/               # static files: images, fonts, icons
├── components/           # global, dumb, presentational only (no surface-specific logic)
├── surfaces/
│   ├── agent-console/    # agent + admin only
│   │   ├── api/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── lib/
│   │   ├── pages/
│   │   └── types/
│   └── webview/          # in-game player-facing only
│       ├── api/
│       ├── components/
│       ├── hooks/
│       ├── pages/
│       └── types/
├── features/             # shared across both surfaces
│   ├── chat/
│   │   ├── api/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types/
│   └── articles/         # public read path only — admin write path stays in agent-console
│       ├── api/
│       ├── hooks/
│       └── types/
├── hooks/                # global custom hooks — placeholder, none exist yet
├── layouts/               # page wrappers — placeholder, add only when a real layout emerges
├── routes/
│   └── AppRoutes.tsx      # single router; agent-console and webview routes grouped, not interleaved
├── services/
│   └── bridgeService.ts   # Unity postMessage bridge — global, cross-cutting
├── store/                 # not currently used; add only when real global state emerges
├── types/                 # global TS defs — @support/types covers the wire contract already
├── utils/
├── App.tsx
└── main.tsx
```

### Import boundary rules

- `surfaces/agent-console/**` and `surfaces/webview/**` must never import from each
  other.
- Both surfaces may import from `features/**`, `components/`, `hooks/`, `lib/`,
  `services/`, `utils/`, `types/`, and `@support/types`.
- `features/**` must never import from `surfaces/**` — the dependency arrow is
  one-directional (surfaces depend on features, not vice versa).

Enforced with `eslint-plugin-boundaries` (or `import/no-restricted-paths` if adding a
new dependency isn't wanted), configured with three zones — `agent-console`,
`webview`, `shared` (everything else) — and the rule above. No ESLint config
currently exists in this repo; this spec introduces the first one, scoped to this
boundary rule. Runs as part of `pnpm typecheck`/CI.

### Why chat and articles are shared features, not per-surface

Chat: the agent sees `AgentConversation`, the player sees `SupportSurface`'s chat.
Both go through the same socket/reconcile logic today (`chatReconcile.ts`,
`ChatThread.tsx`, `Composer.tsx`). Splitting this into two parallel implementations
would duplicate real logic (socket handling, message reconciliation) for no benefit —
the surfaces differ only in the UI shell around the shared chat feature, not in how
chat itself works.

Articles: the public read path (`fetchPublicArticles`/`fetchPublicArticle`) is used
by both the webview's `ArticleList`/`ArticleView` and could be reused by future
agent-console read views. The admin write path (create/edit/publish) is
agent-console-only and stays inside `surfaces/agent-console/api/agentApi.ts` — it is
not part of the shared `features/articles` feature.

## Migration mapping

| Current file                                                      | New location                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/AgentLogin.tsx`                                            | `surfaces/agent-console/pages/AgentLogin.tsx`                                                                                                                                                   |
| `pages/AgentInbox.tsx`                                            | `surfaces/agent-console/pages/AgentInbox.tsx`                                                                                                                                                   |
| `pages/AgentConversation.tsx`                                     | `surfaces/agent-console/pages/AgentConversation.tsx`                                                                                                                                            |
| `pages/AdminArticles.tsx`                                         | `surfaces/agent-console/pages/AdminArticles.tsx`                                                                                                                                                |
| `pages/articleForm.ts` + `.test.ts`                               | `surfaces/agent-console/pages/articleForm.ts`                                                                                                                                                   |
| `lib/agentSession.ts`                                             | `surfaces/agent-console/lib/agentSession.ts` (plain module today — a dummy session read; becomes real OAuth token handling later, may move to `hooks/` at that point if it becomes hook-shaped) |
| `api/agentApi.ts`                                                 | `surfaces/agent-console/api/agentApi.ts`                                                                                                                                                        |
| `pages/SupportSurface.tsx`                                        | `surfaces/webview/pages/SupportSurface.tsx`                                                                                                                                                     |
| `pages/ArticleList.tsx`                                           | `surfaces/webview/pages/ArticleList.tsx`                                                                                                                                                        |
| `pages/ArticleView.tsx`                                           | `surfaces/webview/pages/ArticleView.tsx`                                                                                                                                                        |
| `pages/articleSearch.ts` + `.test.ts`                             | `surfaces/webview/pages/articleSearch.ts`                                                                                                                                                       |
| `api/surfaceApi.ts`                                               | `surfaces/webview/api/surfaceApi.ts`                                                                                                                                                            |
| `api/playerChatApi.ts`                                            | `features/chat/api/playerChatApi.ts`                                                                                                                                                            |
| `components/chat/ChatThread.tsx`, `Composer.tsx`, `types.ts`      | `features/chat/components/`                                                                                                                                                                     |
| `pages/chatReconcile.ts` + `.test.ts`                             | `features/chat/hooks/chatReconcile.ts`                                                                                                                                                          |
| `lib/socket.ts`                                                   | `features/chat/api/socket.ts` (chat-only realtime; move to global `lib/` if a future non-chat consumer needs sockets)                                                                           |
| `api/articlesApi.ts` (`fetchPublicArticles`/`fetchPublicArticle`) | `features/articles/api/articlesApi.ts`                                                                                                                                                          |
| `api/httpClient.ts`                                               | stays global: `lib/httpClient.ts`                                                                                                                                                               |
| `services/bridgeService.ts`                                       | stays global: `services/bridgeService.ts` (unchanged)                                                                                                                                           |
| `boot.ts` + `.test.ts`                                            | stays global: `lib/boot.ts`                                                                                                                                                                     |
| `routes.tsx`                                                      | `routes/AppRoutes.tsx`, routes visually grouped by surface                                                                                                                                      |

## Out of scope

- Any behavior change — same routes, same components, same logic, pure file moves
  plus import path updates.
- Backend folder structure (already covered by `2026-08-05-folder-structure-revamp.md`,
  untouched here).
- Splitting the build into independent deploy targets — confirmed both surfaces ship
  together; revisit only if that changes (e.g. SDK team needs to release the webview
  independently of console releases).
- `store/` and `layouts/` — scaffolded as placeholders per the target convention, not
  populated until a real need exists (YAGNI).
