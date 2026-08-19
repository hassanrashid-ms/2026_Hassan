# Intents & Subintents admin tab

## Why

The taxonomy (intent → subintent) already exists in the schema and is read by the bot, Forms, and
the article editor, but it has no real admin surface. Today the only UI is
`KnowledgeBase/components/CategorySidebar.tsx`, which lets an admin create an intent (labelled
"Category" in that UI on purpose — see
`docs/specs/2026-08-07-surface-categories-endpoint-design.md`) but has no way to create, rename,
archive, move, or merge a subintent, and no way to rename or archive an intent. This spec completes
that: a dedicated admin tab for full taxonomy management, plus the backend endpoints it needs.

`CategorySidebar` is unaffected — it keeps doing exactly what it does today (intent picker for
articles) and will simply reflect whatever the new tab manages, since both read `GET /agent/intents`.

## Rules this must honor (from the product spec)

- Nothing is ever deleted. Archive only. `isSystem` (the "Other" intent) and the "Other" subintent
  can never be archived, merged, or moved — the bot's fallback classification depends on it existing.
- Rename is free at any level, at any time.
- Archiving an intent must be blocked while it still has non-archived subintents or published
  articles pointing at it — archiving must never silently orphan either.
- Moving or merging a subintent must be dated and recorded, because a volume trend can't otherwise
  distinguish real behaviour change from someone reorganising the list.
- Merge picks a survivor: every conversation referencing the loser is reassigned to the survivor,
  then the loser is archived with `mergedIntoId` set. The loser is never deleted — it stays visible
  in reporting, pointing at its replacement.
- View (intent/subintent list) is available to Agent, Team Lead, and Admin. Create, rename, archive,
  move, and merge are Admin-only, per the permission matrix.
- Every taxonomy change is recorded to the change log with before/after values.

## Known gap (not built in this pass)

There's no live "create workspace" API yet — only a dev seed script seeds a workspace's "Other"
intent/subintent. Wiring "every workspace always has an Other" into a real workspace-provisioning
flow is out of scope here, because that flow doesn't exist yet to hook into. This is a deliberate
gap, not an oversight — do not add lazy-seeding or other workarounds to paper over it.

## Backend

Extends `backend/src/agent/routers/taxonomyRouter.ts`, `taxonomyController.ts`,
`taxonomyService.ts`. All mutating routes gated with the existing `requireAdminRole` middleware; the
existing `GET /agent/intents` stays available to any authenticated agent-session role. Every
mutation writes an entry via the existing `appendChangeLog` helper (entity_type `'intent'` /
`'subintent'`, before/after values).

| Endpoint | Behaviour |
|---|---|
| `PATCH /agent/intents/:id` | Body `{ name }`. Renames the intent. 409 if the name collides with another intent in the workspace (existing unique index). |
| `POST /agent/intents/:id/archive` | Sets `archivedAt`. 409 if `isSystem`, or if any subintent under it has `archivedAt IS NULL`, or if any published article still has `intentId` pointing at it. |
| `PATCH /agent/subintents/:id` | Body `{ name?, defaultPriority? }`. Renames and/or sets default priority. 409 on name collision within the same intent (existing unique index). |
| `POST /agent/subintents/:id/archive` | Sets `archivedAt`. 409 if this is the workspace's "Other" subintent. |
| `POST /agent/subintents/:id/move` | Body `{ intentId }`. Updates `subintent.intentId` to the new parent. 404 if the target intent doesn't exist or is archived. |
| `POST /agent/subintents/:id/merge` | Body `{ intoId }`. One transaction: reassign every `conversation.subintent_id` equal to the loser over to `intoId`, then set the loser's `mergedIntoId = intoId` and `archivedAt = now()`. 409 if `intoId` is archived, is the loser itself, or belongs to a different workspace. 409 if the loser is the "Other" subintent. |

Response bodies for the new endpoints follow the existing pattern in `taxonomyService.ts` — return
the updated row's `{ id, name, ... }`, not the full tree; the frontend already refetches
`GET /agent/intents` after a mutation via its existing query invalidation.

### Types (`packages/types/src/articles.ts`)

- Extend `IntentSubintentView` with `defaultPriority: ConversationPriority | null` and
  `mergedIntoId: string | null`.
- Add request/response types for each new endpoint (rename intent/subintent, archive, move, merge)
  following the existing `CreateIntentResponse` / `CreateSubintentResponse` naming pattern.

## Frontend

New top-level admin page: `frontend/src/surfaces/agent-console/pages/Taxonomy/`, added to the admin
nav alongside Knowledge Base, Forms, and Bot. Visible to Agent/Team Lead/Admin (read-only for the
first two); mutating controls rendered only for Admin, matching how role-gating is already done
elsewhere in the agent console.

- **Tree view**: intents with their subintents nested underneath. Archived items render visually
  distinct (dimmed, "Archived" badge) but are never hidden — they still need to be visible for
  reporting continuity.
- **Intent row**: inline rename, "Archive" action (disabled with a tooltip for the "Other" intent,
  or when it still has active subintents/articles — the tooltip states which).
- **Subintent row**: inline rename, a default-priority selector (p1–p4, matching
  `conversationPriority`), "Archive", "Move to…" (dropdown of non-archived intents), "Merge into…"
  (dropdown of non-archived subintents across the workspace, excluding itself). All four disabled
  with an explanatory tooltip for the "Other" subintent.
- **Add intent** action at the top of the tree; **Add subintent** action per intent row — both
  reuse the existing create endpoints, no schema change needed there.
- Uses TanStack Query against `GET /agent/intents`, invalidated after every mutation, same pattern
  `CategorySidebar` already uses.

## Out of scope

- Linking a form to a subintent — already handled by `Forms/components/ShownForPicker.tsx` via
  `PATCH /forms/{id}/subintents`; not duplicated in this tab.
- Workspace-provisioning / "Other" auto-seeding (see Known gap above).
- Bulk import/export of taxonomy.
