# Surface categories endpoint design

Status: approved
Date: 2026-08-07
Related: `docs/specs/2026-08-06-articles-knowledge-base-design.md` (intent/subintent taxonomy, `/surface/articles`)

## Problem

The webview surface UI needs to render category tabs above the article list. Categories map 1:1 to the existing `intent` taxonomy, but there is no public endpoint that lists intents. The UI calls this concept "category"; the codebase calls it "intent" — this doc uses "intent" for backend/DB terms and "category" only when describing what the player sees.

## Scope

- New endpoint: `GET /surface/intents`.
- No changes to `GET /surface/articles` — its existing `?intentId=` filter already supports per-category fetching, and omitting `intentId` already returns all published articles workspace-wide. This doc documents that contract explicitly so the two endpoints are read together.

## Endpoint: `GET /surface/intents`

**Auth:** `requirePlayerToken` only (same as `articlesRouter`, `articleReadRouter`). No `requireSdkHeaders` — a webview has no reason to know the workspace slug. Workspace comes from the player token's `workspace_id` claim.

**Query params:** none.

**Response:**
```json
{ "intents": [ { "id": "uuid", "name": "Billing" } ] }
```

**Selection rules, in order:**
1. Exclude intents where `archivedAt IS NOT NULL`.
2. Exclude intents with zero `article` rows in `state = 'published'` referencing them. An intent with only draft/archived articles does not appear — no point opening a tab to an empty list.
3. Include `isSystem` intents (the "Other" catch-all) for now — no special-casing.
4. Sort alphabetically by `name`.
5. No qualifying intents → `{ "intents": [] }`, not an error. Matches the existing public-route rule: "no matching articles is an empty list, not an error" applies equally here.

**Query shape:** single query — join `intent` to `article` on `article.intentId = intent.id`, filter `article.state = 'published' AND intent.archivedAt IS NULL`, `SELECT DISTINCT intent.id, intent.name`, `ORDER BY intent.name`. One round trip; rejected alternative was fetching all intents then a second existence-check query per intent — two round trips for no benefit.

**Errors:** only the standard 401 from `requirePlayerToken`. No other failure mode — empty result replaces "not found".

## Category → article fetching (existing behavior, documented for completeness)

The webview builds tabs as: one "All" tab (frontend-only, no backend representation) + one tab per item returned by `/surface/intents`.

| Tab selected | Request |
|---|---|
| "All" | `GET /surface/articles` — no `intentId` param. Existing behavior: returns all published articles in the workspace. |
| A category | `GET /surface/articles?intentId=<id>` — existing behavior in `articlesService.listPublicArticles`, unchanged. |

No synthetic `{ id: "all", name: "All" }` entry is added to the `/surface/intents` response — "All" is a frontend concept only. `articlesService` does not need to special-case any sentinel value.

## Files touched

- `backend/src/surface/services/intentsService.ts` (new) — `listPublicIntents(ctx: PlayerContext)`, implements the query above via `withWorkspace(ctx.workspaceId, ...)`.
- `backend/src/surface/controllers/intentsController.ts` (new) — thin controller: call service, `sendError` on failure, return JSON. Same shape as `articlesController.ts`.
- `backend/src/surface/routers/intentsRouter.ts` (new) — `GET /` wired to the controller.
- `backend/src/surface/router.ts` — mount `intentsRouter` at `/intents`, alongside the existing `articlesRouter`, `articleReadRouter`, `bootstrapRouter`, `messagesRouter`, behind the shared `requirePlayerToken` middleware.
- `packages/types/src/intents.ts` (new) — Zod response schema `{ intents: { id: string, name: string }[] }`, the shared SDK↔server contract for this response.
- `backend/src/docs/openapi.ts` — register `GET /surface/intents` and its schema, per the CLAUDE.md rule that every new endpoint stays in sync with the Swagger docs.

## Testing

Unit tests on `listPublicIntents` covering:
- Excludes an archived intent even if it has published articles.
- Excludes an intent whose only articles are draft/archived.
- Includes an intent with at least one published article.
- Includes an `isSystem` ("Other") intent when it qualifies.
- Results sorted alphabetically by name.
- Empty workspace / no qualifying intents → `{ intents: [] }`.

No integration test changes needed for `/surface/articles` — its behavior is unchanged; this doc only documents its existing contract.
