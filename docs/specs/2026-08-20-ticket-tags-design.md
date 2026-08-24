# Ticket tags

## Why

The product spec calls this concept a "label": _"a flat marker an agent or rule attaches to a
ticket. Unlike a subintent, a ticket can carry many."_ It's referenced in the queue and
conversation-view mockups but never built — `conversations.ts` even carries a comment noting
`labels` will arrive "once the taxonomy tables exist." This spec builds it, calling it **tags**
(the two terms name the same feature; this doc uses "tag" throughout).

v1 is deliberately narrow: an agent can create, attach, and remove tags on a single conversation
from its header, next to where status already renders. Queue-level filtering, a tag column in the
conversation list, and rule-engine auto-tagging are explicitly out of scope for this pass — this
just needs to exist before any of that can be built on top of it.

## Deviation from an earlier decision, and why

Attach/detach/rename/"delete" were discussed as simple, fully-destructive operations — deleting a
tag removes it everywhere, no history. That's off the table under this repo's blanket rule: **"No
hard deletes anywhere. Don't even write the route."** (`CLAUDE.md`) — the same rule intent/subintent
already follow (`archivedAt`, never a row deletion).

So "delete" here means **archive**, exactly like intent/subintent:

- An archived tag disappears from the create/search picker for new attachments.
- It is _not_ stripped off conversations that already carry it — the badge keeps rendering, same
  as an archived subintent stays visible on the tickets that already had it.
- Typing the same name again un-archives it instead of creating a duplicate, so from the agent's
  seat it still feels like "delete, then just make it again if you need it" — the simplicity you
  asked for is preserved at the UI/behavior level; only the storage mechanics changed.

Detaching a tag from one conversation is a soft removal (`removedAt`) on the join row for the same
reason — never a row delete.

## Data model

New file `backend/src/shared/db/schema/tags.ts`, same shape and conventions as
`taxonomy.ts` (composite FKs for tenancy, per docs/decisions/2026-08-04-composite-foreign-keys-for-tenancy.md).

```ts
export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    name: text('name').notNull(), // as typed, for display
    normalizedName: text('normalized_name').notNull(), // trim + lowercase, for dedup/lookup
    colorIndex: integer('color_index').notNull(), // 0..N-1 into the fixed palette, set once at creation
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tag_workspace_normalized_name_uk').on(t.workspaceId, t.normalizedName),
    unique('tag_workspace_id_uk').on(t.workspaceId, t.id), // composite-FK parent key
  ],
);

export const conversationTag = pgTable(
  'conversation_tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    removedAt: timestamp('removed_at', tz), // null = currently attached
  },
  (t) => [
    uniqueIndex('conversation_tag_pair_uk').on(t.conversationId, t.tagId), // one row per pair, ever
    foreignKey({
      name: 'conversation_tag_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_tag_tag_fk',
      columns: [t.workspaceId, t.tagId],
      foreignColumns: [tag.workspaceId, tag.id],
    }).onDelete('restrict'),
  ],
);
```

One row per `(conversation, tag)` pair for the life of the conversation — attach clears
`removedAt` (or inserts, if the pair never existed before); detach sets `removedAt = now()`.
Nothing is ever deleted, matching the rest of the schema.

**Color.** `colorIndex` is computed once at tag creation: hash `normalizedName` (e.g. a simple
string hash) modulo the size of a fixed ~8-10 entry palette shared with the existing `Badge`
component's variants. Same tag → same color everywhere, forever. No color picker, no admin
screen, no per-tag color storage beyond this one integer.

**Permissions.** No `requireAdminRole` gate — any authenticated agent session can create, attach,
detach, rename, or archive a tag, per your call that tags stay agent-self-service like the rest of
this feature.

## Backend

New `backend/src/agent/routers/tagsRouter.ts`, mounted in `agent/router.ts` alongside the others.
New `tagsController.ts` / `tagsService.ts` following the existing controller→service split.

| Endpoint                                      | Behaviour                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /agent/tags?query=`                      | Search active (non-archived) workspace tags by `normalizedName` prefix. `query` optional — empty returns all active tags, alphabetical. Response: `{id, name, colorIndex}[]`. Backs the popover's live search.                                                                   |
| `POST /agent/tags`                            | Body `{name}`. Normalizes. If an active tag with that `normalizedName` exists, returns it (200, no-op create). If an archived one matches, un-archives it and returns it (200). Otherwise creates a new one with a freshly computed `colorIndex` (201).                          |
| `PATCH /agent/tags/:id`                       | Body `{name}`. Renames (updates both `name` and `normalizedName`). 409 if the new `normalizedName` collides with a _different_ active tag in the workspace.                                                                                                                      |
| `POST /agent/tags/:id/archive`                | Sets `archivedAt`. No preconditions — any tag can be archived at any time, including ones currently attached to conversations (their badges keep rendering; see Deviation section).                                                                                              |
| `POST /agent/conversations/:id/tags`          | Body `{tagId}`. Attaches: upserts the `conversation_tag` row, clearing `removedAt` if the pair already existed. 404 if `tagId` isn't visible in this workspace (confirmed with an explicit scoped `SELECT` first, per the FK-bypasses-RLS rule). Idempotent if already attached. |
| `DELETE /agent/conversations/:id/tags/:tagId` | Sets `removedAt = now()` on the active row. No-op (200) if it wasn't attached.                                                                                                                                                                                                   |

Every new route registered in `backend/src/docs/openapi.ts` per repo convention.

### Types (`packages/types/src/tags.ts`, new file)

`TagView = {id: string; name: string; colorIndex: number}`, plus request bodies
(`CreateTagBody`, `RenameTagBody`, `AttachTagBody`) as Zod schemas, matching the
`CreateIntentResponse`-style naming already used in `articles.ts`.

`GET /agent/conversations/:id` (or `/context`, wherever the header's data already comes from)
gains a `tags: TagView[]` field — the currently-attached (non-removed) tags for that conversation.

## Frontend

**Where:** `ThreadPanel.tsx`, in the header row that currently renders the player id and the
status `Badge` (line ~264-265). Also adds a subintent badge to that same row — the header
currently shows none, but you asked for it here; it reads from whatever the conversation's
`context` query already returns (`agent-context.ts`'s `subintent: {intent_name, subintent_name}`),
sharing that query's cache key rather than fetching it twice.

Layout, left to right after the player id: subintent badge (fixed distinct color, not part of the
tag palette — it's a different kind of thing) → one `Badge` per attached tag (colored by
`colorIndex` via the palette) → a small `+` icon button.

**The `+` popover** (shadcn `Popover` + `Command`, consistent with the rest of the console):

- Opens with a text input, live-searches `GET /agent/tags?query=` as the agent types (debounced).
- Already-attached tags are excluded from the results.
- If nothing matches the exact typed text, a `Create "<query>"` row appears at the bottom;
  selecting it calls `POST /agent/tags` then `POST /agent/conversations/:id/tags` in sequence
  (or the backend could do both in one call — either is fine, keep it to whichever is less code).
- Selecting an existing result attaches it and closes the input (stays open for adding another,
  agent's choice via a "done" affordance — match whatever `Command` pattern is already in use
  elsewhere in the console, if any).

**Removing a tag:** an `×` on each tag `Badge` itself (no need to reopen the popover just to
remove one), calling the `DELETE` endpoint.

Both mutations use TanStack Query, invalidating the conversation detail/context query on success —
same pattern the rest of the console already follows.

## Error handling

- Attach/detach are idempotent by design (see table above) — no error surfaced for
  double-attach or double-detach, since two agents editing tags on the same ticket concurrently is
  expected, not exceptional.
- Create with a name that collides (after normalization) with an existing tag never errors — it
  resolves to the existing tag. There is no user-facing "duplicate tag" error state in this
  feature.
- `tagId` not visible in the workspace (wrong workspace, or nonexistent) → 404, per the
  RLS/FK-bypass convention already used everywhere else (`404`, never `403` — "not yours" and "not
  there" are indistinguishable).

## Testing

- Backend: normalization + reuse-on-create (exact dup, case/whitespace variants, archived-tag
  revival); rename collision 409; archive leaves existing `conversation_tag` rows intact and
  visible; attach/detach idempotency; cross-workspace tag id rejected with 404 on attach.
- Frontend: popover search-then-create-then-attach flow; removing a tag via its badge `×`;
  subintent badge renders from the context query without an extra fetch; color is stable across
  remounts for the same tag id.

## Out of scope

- Queue/list-level tag chips and filtering by tag (deliberate — first iteration is header-only).
- Rule-engine auto-tagging (the spec's "Labelling" ruleset action) — needs the rules engine itself,
  which doesn't exist yet.
- Any admin screen for managing the workspace's tag list (rename/archive exist as API endpoints
  now so nothing blocks adding that screen later, but there's no UI for it in this pass).
  **Archiving is therefore unreachable in v1** — nothing in the header calls
  `POST /agent/tags/:id/archive`; the `×` on a badge only detaches that one conversation
  (`DELETE /agent/conversations/:id/tags/:tagId`), it never archives the tag itself. Confirmed
  as acceptable: the endpoint exists so a future management screen needs no backend work, but nothing
  wires it up yet.
- Merge ("combine these two tags into one") — not requested; add if duplicate-but-differently-typed
  tags turn out to be a real problem despite normalization.
