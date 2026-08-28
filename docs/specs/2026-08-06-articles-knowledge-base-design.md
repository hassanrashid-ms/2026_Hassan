# Articles knowledge base — design

**Date:** 2026-08-06
**Status:** Draft
**Supersedes:** nothing
**Related:** [`2026-08-04-database-and-schema-design.md`](2026-08-04-database-and-schema-design.md) (Taxonomy and Knowledge table shapes originate there)

## Scope

A basic knowledge base: agents author and publish articles from a console page; players view
published articles on an unauthenticated public page. No bot, no retrieval, no self-serve funnel
reporting — those are later slices that reuse this schema.

**In scope:** `intent`/`subintent` taxonomy tables, `article`, `article_attachment` (schema only),
agent CRUD + publish workflow, public read + keyword search, OpenAPI registration.

> The article search/data model described in this doc is superseded by
> [`docs/specs/2026-08-07-weaviate-faq-search-design.md`](2026-08-07-weaviate-faq-search-design.md)
> — see that doc for the current article `keywords` field and Weaviate-backed search. The
> `article_phrasing`/`article_embedding` tables described below no longer exist.

**Out of scope:** `taxonomy_change` audit log, intent archive guards, subintent merge, embedding
generation, file upload (S3/R2), `article_feedback`, bot retrieval.

## Data model

Table shapes are taken from the approved schema design doc; this slice builds the subset needed
for authoring and viewing articles, ahead of the features (bot, forms, merge, reporting) that will
consume the rest.

### Taxonomy

```
intent
  id             uuid PK
  workspace_id   uuid NOT NULL REFERENCES workspace(id)
  name           text NOT NULL
  is_system      boolean NOT NULL DEFAULT false   -- guards 'Other'
  archived_at    timestamptz
  created_at     timestamptz NOT NULL DEFAULT now()
  UNIQUE (workspace_id, name)

subintent
  id                 uuid PK
  workspace_id       uuid NOT NULL REFERENCES workspace(id)
  intent_id          uuid NOT NULL REFERENCES intent(id) ON DELETE RESTRICT
  name               text NOT NULL
  default_priority   conversation_priority            -- nullable; no consumer yet
  form_id            uuid                             -- nullable; no form table yet, no FK yet
  merged_into_id     uuid REFERENCES subintent(id)     -- nullable; no merge flow yet
  archived_at        timestamptz
  created_at         timestamptz NOT NULL DEFAULT now()
  UNIQUE (workspace_id, intent_id, name)
```

`subintent` has no consumer in this slice — no conversation, form, or merge feature reads or
writes `default_priority`, `form_id`, or `merged_into_id` yet. The table exists now, matching the
already-approved shape, so conversation-routing work later needs no migration. This mirrors
`conversation.subintent_id` already being anticipated in the conversations schema before the
taxonomy tables existed.

**Articles reference `intent`, never `subintent`** — same rule as the approved schema doc.

No `taxonomy_change` audit table and no archive guards in this slice: nothing except this KB
feature edits the taxonomy yet, so there is no merge/cascade risk to guard against. Add the audit
table and guards when subintent gains a real consumer (conversation classification) or an admin
UI for editing intents ships.

### Knowledge

```
article
  id             uuid PK
  workspace_id   uuid NOT NULL REFERENCES workspace(id)
  intent_id      uuid REFERENCES intent(id) ON DELETE RESTRICT   -- nullable = uncategorized
  title          text NOT NULL
  body           text NOT NULL
  keywords       text[] NOT NULL DEFAULT '{}'
  state          article_state NOT NULL DEFAULT 'draft'   -- draft | published | archived
  created_by     uuid NOT NULL REFERENCES agent(id) ON DELETE RESTRICT
  published_by   uuid REFERENCES agent(id) ON DELETE RESTRICT
  published_at   timestamptz
  created_at     timestamptz NOT NULL DEFAULT now()

article_attachment
  id             uuid PK
  workspace_id   uuid NOT NULL REFERENCES workspace(id)
  article_id     uuid NOT NULL REFERENCES article(id) ON DELETE RESTRICT
  filename       text NOT NULL
  storage_key    text                   -- nullable; unset until S3/R2 upload lands
  status         text NOT NULL DEFAULT 'pending'
  created_at     timestamptz NOT NULL DEFAULT now()
```

`article_attachment` is schema-only: the console shows an "Attachments — coming soon"
control, disabled, with no upload endpoint. `storage_key` stays nullable until the presigned-PUT
upload flow (S3/R2) is built, following the same pattern already decided for message attachments
in the approved schema doc.

Both tables: `workspace_id` + RLS policy, `ON DELETE RESTRICT`, no hard-delete route. Removing
an article means transitioning `state` to `archived`, never deleting the row.

## API surface

### Agent (console), behind `requireAgentSession`

| Method | Path                            | Notes                                                        |
| ------ | ------------------------------- | ------------------------------------------------------------ |
| GET    | `/agent/intents`                | List intents with nested subintents, for the category picker |
| POST   | `/agent/intents`                | Create an intent inline. Admin-only, enforced server-side    |
| POST   | `/agent/intents/:id/subintents` | Create a subintent under an intent. Admin-only               |
| GET    | `/agent/articles`               | List articles (all states) for this workspace                |
| GET    | `/agent/articles/:id`           | Fetch one article for editing                                |
| POST   | `/agent/articles`               | Create a draft                                               |
| PATCH  | `/agent/articles/:id`           | Edit title/body/keywords/intent while in `draft`             |
| POST   | `/agent/articles/:id/publish`   | `draft` → `published`, stamps `published_by`/`published_at`  |
| POST   | `/agent/articles/:id/archive`   | Any state → `archived`. No delete route exists               |

Permission check ("Admin-only" above) happens in the controller, not just hidden in the console UI
— per the existing non-negotiable that permission checks run at the API.

### Public surface, unauthenticated

| Method | Path                    | Notes                                                                                             |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/surface/articles`     | `?intentId=` filter, `?q=` keyword search (`ILIKE` over title + body). `state = 'published'` only |
| GET    | `/surface/articles/:id` | Single published article. 404 if draft/archived or wrong workspace                                |

RLS supplies the workspace predicate on every query above; the public routes still run inside a
transaction with `app.workspace_id` set, resolved from the surface's existing workspace-routing
(same as other unauthenticated surface endpoints).

### OpenAPI

Every route above gets a Zod schema in `packages/types/src/articles.ts` and a
`registry.registerPath(...)` entry in `backend/src/docs/openapi.ts`, so `/docs` and `/docs/json`
stay in sync — per the CLAUDE.md rule that this is done for every new endpoint, not a follow-up
step.

## Frontend

- **Agent:** `frontend/src/pages/AdminArticles.tsx` — list view + editor, draft/publish/archive
  actions, intent/subintent picker (create-new inline), a disabled "Attachments — coming soon"
  section. Calls added to `frontend/src/api/agentApi.ts`. Follows the existing
  `AgentInbox.tsx`/`AgentConversation.tsx` structure and bearer-token `httpClient`.
- **Public:** `frontend/src/pages/ArticleList.tsx` (search box + category filter + list) and
  `ArticleView.tsx` (single article), under the surface routes, no auth header attached. New
  `frontend/src/api/articlesApi.ts` for the two public calls.

## Error handling

- Publishing requires non-empty `title` and `body`; `PATCH`/`publish` on a non-`draft` article
  (except `archive`, which accepts any state) returns `409`.
- `intent_id` pointing at another workspace's row is invisible under RLS — the standard `404`, not
  `403`.
- Public routes never 500 on an empty result set — no matching articles is an empty list, not an
  error.

## Testing

- Backend: Vitest coverage for the taxonomy create endpoints (Admin-only enforcement), the
  article draft → publish → archive state machine, workspace isolation (the day-one RLS isolation
  test pattern from the schema doc — hit another workspace's article id, expect `404`), and the
  public search/filter query.
- Manual: exercise `/docs` Swagger UI to confirm the new paths render and match the Zod schemas.

## Migration

New Drizzle schema files: `shared/db/schema/taxonomy.ts` (`intent`, `subintent`) and
`shared/db/schema/articles.ts` (`article`, `article_attachment`), plus the `article_state` enum in
`enums.ts`. RLS policies added per table in
the existing migration SQL alongside the other tenant-scoped tables. `pnpm db:setup` picks them up
as usual.
