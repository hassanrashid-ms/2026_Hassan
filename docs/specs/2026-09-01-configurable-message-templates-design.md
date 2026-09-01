# Configurable message templates

## Problem

Player-facing system copy is hardcoded and can't be changed per workspace:

- `NO_AGENTS_ONLINE_MESSAGE` (`backend/src/domain/bot/messages.ts:51-52`)
- `HANDOFF_PLAYER_MESSAGES`, 5 variants picked at random via `pickHandoffMessage()` (`backend/src/domain/bot/messages.ts:18-24, 36-38`)
- `FORM_SUMMARY_MESSAGES` — completed/partial/skipped (`backend/src/domain/forms/messages.ts:12-16`)

Separately, agents have no library of canned replies (e.g. an intro message) they can drop into a chat with one click — every message is typed from scratch.

## Goals

- Every string above becomes an editable, workspace-scoped template.
- Handoff keeps its "pick one of N variants at random" behavior; admins manage the variant list.
- A shared, workspace-wide library of canned replies agents can insert into the chat composer.
- Hot-path reads (every bot turn, every handoff) never hit Postgres directly — Redis-backed.

## Non-goals

- Personal/per-agent templates (workspace-shared only, per decision).
- Auto-send on template click (inserts into composer; agent still reviews and sends).
- A version-history/audit UI for template edits (out of scope for this pass; `updated_at` is enough for now).

## Data model

One table, discriminated by `kind`, RLS-scoped to `workspace`:

```
message_template
  id                   uuid PK
  workspace_id         uuid FK -> workspace, RLS scoped
  kind                 enum('system', 'canned')
  key                  text, nullable
                         -- required when kind='system':
                         -- 'no_agents_online' | 'handoff' | 'form_summary_completed'
                         -- | 'form_summary_partial' | 'form_summary_skipped'
                         -- null when kind='canned'
  label                text, nullable   -- display name for canned replies, e.g. "Intro"
  body                 text, not null
  sort_order           integer, not null default 0
                         -- orders handoff variants and the canned-reply list
  is_active            boolean, not null default true   -- soft-delete only
  created_by_agent_id  uuid FK -> agent, nullable
  created_at           timestamptz, not null default now()
  updated_at           timestamptz, not null default now()
```

Rules:
- `no_agents_online`, `form_summary_completed`, `form_summary_partial`, `form_summary_skipped` each have exactly one active row per workspace.
- `handoff` has N active rows per workspace (today: 5); the system picks one at random per send, same as `pickHandoffMessage()` today.
- `canned` rows have no `key`; `label` + `body` are both required.
- No hard deletes anywhere in this feature — deactivating a template sets `is_active = false`.

A migration adds the table + RLS policy and backfills every existing workspace with the current hardcoded strings as active rows, so behavior is unchanged until an admin edits something.

## Redis caching (cache-aside)

- **Key**: `templates:{workspaceId}` — one JSON blob per workspace holding all its active templates, grouped by `kind`/`key`. One key per workspace; the full set per workspace is small, so no need for finer-grained keys.
- **Read** — `getTemplates(workspaceId)`:
  1. `GET templates:{workspaceId}` from Redis.
  2. On miss, `SELECT * FROM message_template WHERE workspace_id = $1 AND is_active` from Postgres, build the JSON, `SET` it in Redis with a 24h TTL (a safety net, not the primary invalidation path — Redis is a cache here, never the system of record, per repo convention).
  3. Return the parsed blob either way.
- **Write** — any admin create/update/deactivate:
  1. Write the row to Postgres.
  2. `DEL templates:{workspaceId}` in the same request handler.
  3. Next read repopulates from Postgres. No update-in-place in Redis — simpler, avoids drift bugs between partial cache updates and the DB.
- New module `backend/src/domain/templates/templateCache.ts`, following the shape of `shared/auth/wsAuthCache.ts` (get/set helpers, workspace-scoped key, `ioredis` client).

## Service layer

New module `backend/src/domain/templates/templateService.ts`:

- `getSystemMessage(workspaceId, key)` → single string, for `no_agents_online` and the three `form_summary_*` keys.
- `getHandoffMessage(workspaceId)` → random pick among active `handoff` variants (replaces `pickHandoffMessage()`).
- `listCannedReplies(workspaceId)` → ordered list of `{id, label, body}` for the composer picker.
- `createTemplate`, `updateTemplate`, `deactivateTemplate` — write path, each followed by cache invalidation.

All read helpers go through `getTemplates()` (which hits the Redis cache-aside path above) rather than querying Postgres directly.

Call sites that change:
- `backend/src/domain/bot/applyBotTurn.ts` — `pickHandoffMessage()` / `NO_AGENTS_ONLINE_MESSAGE` become `await getHandoffMessage(workspaceId)` / `await getSystemMessage(workspaceId, 'no_agents_online')`.
- `backend/src/domain/forms/completeFormAndHandoff.ts` — same pattern for form summary messages.
- `backend/src/domain/bot/messages.ts` and `backend/src/domain/forms/messages.ts` are deleted once callers are migrated (their content lives on as seeded rows).

## API & permissions

New router `backend/src/routes/templates.ts`, registered in `backend/src/docs/openapi.ts` per repo rule:

| Route | Method | Access |
|---|---|---|
| `/agent/templates` | GET | team_lead + admin (same gate as Bot Config / Workspace Settings) |
| `/agent/templates` | POST | admin only |
| `/agent/templates/:id` | PATCH | admin only (edit body/label/sort_order, or set `is_active: false`) |

No DELETE route — deactivation is a PATCH, consistent with the no-hard-deletes rule.

## Frontend

- New page `frontend/src/surfaces/agent-console/pages/Templates/Templates.tsx`, added to the `Manage` nav group in `AgentConsoleShell.tsx` alongside Bot Config / Workspace Settings / Team — same visibility gate (team_lead+admin can view, admin can edit).
- Two sections on the page:
  - **System Messages** — no-agents-online (single), handoff (list of variants: add/edit/remove/reorder), form summaries (completed/partial/skipped).
  - **Canned Replies** — label + body list; admin add/edit/deactivate.
- Inbox chat composer gets an "Insert Template" picker (`listCannedReplies`, fetched via TanStack Query and cached client-side). Selecting one inserts `body` into the composer's text input for the agent to review/edit before sending — it does not auto-send.

## Rollout

1. Drizzle migration: create `message_template` + RLS policy; backfill script seeds every existing workspace with today's hardcoded strings.
2. Add `templateService` + `templateCache`, switch `applyBotTurn.ts` / `completeFormAndHandoff.ts` to the async calls, delete the old `messages.ts` files.
3. Add `templates` router + OpenAPI registration.
4. Add the Templates page, nav entry, and composer picker.
