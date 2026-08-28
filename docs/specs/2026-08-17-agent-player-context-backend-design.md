# Agent player context — backend design

Status: approved, not implemented
Companion: `2026-08-17-agent-player-context-frontend-design.md`

## What this is

Two read endpoints and one schema change, serving the agent console's context rail:
the player-state snapshot captured when a ticket was raised, and the player's other
tickets in this workspace.

The data already exists. `player_state_snapshot` is written by
`sdk/services/sessionsService.ts`; `declared_field` is seeded from
`DECLARED_FIELD_SEED`. Nothing on the agent side reads either — only
`surface/services/bootstrapService.ts`, on the webview side. This slice is the
agent-side reader, plus the ticket number the rail needs to name a ticket.

## Schema change: `conversation.number`

A per-workspace ticket number, displayed as `#1042`.

`conversation.id` is a uuid. A rail listing five past tickets as `a3f1c8e2-…` is
unreadable, and unreadable is useless for the "is this the third time this month"
judgement the rail exists to support.

**Per-workspace, not a global sequence.** A `bigserial` would make `#1042` a count
of every ticket across every tenant: each workspace would see a sparse sequence
jumping by its neighbours' volume, and could infer that volume from the gaps. The
repo already solves this once — `conversation.message_seq`, an integer bumped
inside the writing transaction. This mirrors it.

- `workspace.ticket_seq integer not null default 0`
- `conversation.number integer not null`, unique per `(workspace_id, number)`
- Allocated with `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
  in the same transaction as the conversation insert

That serialises conversation creation per workspace. At this scale it is free.

**Both creation paths get it**, or rows will exist that violate the `NOT NULL`:

- `surface/services/newTicketService.ts:84`
- the auto-create in `surface/services/messagesService.ts:79`

**Migration order matters.** The backfill runs against databases that already hold
conversations, and `db:baseline` exists for stamping already-correct schemas. So:

1. add `workspace.ticket_seq`, default 0
2. add `conversation.number` **nullable**
3. backfill per workspace by `created_at` ascending, numbering from 1
4. set each `workspace.ticket_seq` to that workspace's max
5. `SET NOT NULL` on `conversation.number`, add the unique index

Not a `NOT NULL` column added in one step.

## Endpoints

Both on the existing `agent/routers/conversationsRouter.ts`. Both registered in
`docs/openapi.ts`, per the repo rule that a new endpoint without a Swagger entry
is incomplete.

### `GET /agent/conversations/:id`

One conversation's header row: number, player external id, status, subintent
(intent → subintent names), assigned agent, `resolution_source` and the resolving
agent's display name.

This exists because of a structural gap on the frontend. `Inbox.tsx` finds the
selected conversation by searching the `unassigned` and `mine` lists. An older
ticket — resolved, owned by another agent — is in neither list and never will be,
so opening one by URL yields no header data at all. A detail fetch is the fix; a
third list filter is not.

### `GET /agent/conversations/:id/context`

The whole rail in one payload:

```ts
type AgentConversationContextResponse = {
  player_state: AgentPlayerStateView;
  tickets: AgentTicketSummary[];
  summary: {
    total_tickets: number; // excludes the current one
    total_reopened: number;
    first_contact_at: string; // player.first_seen_at, ISO 8601
  };
};
```

One endpoint rather than two, because the rail is one thing, always fetched
together, and its two halves have the same cache lifetime.

## `player_state` is a tagged union

```ts
type AgentPlayerStateView =
  | { status: 'no_session' }
  | { status: 'not_captured' }
  | { status: 'missing' }
  | {
      status: 'captured';
      declared: { key: string; label: string; type: DeclaredFieldType; value: unknown }[];
      raw: Record<string, unknown>;
      degraded_reason: string | null;
      captured_at: string;
    };
```

Four distinguishable cases, not one nullable object:

| Case           | Condition                                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| `no_session`   | `conversation.session_id` is null                                                     |
| `not_captured` | session exists, no `player_state_snapshot` row                                        |
| `missing`      | snapshot exists with `is_missing: true` — the game's provider returned nothing usable |
| `captured`     | everything else                                                                       |

`session_id` is genuinely nullable in practice: both creation paths write
`verifiedSession?.id ?? null`. A single nullable field would collapse "the SDK
never delivered a session" and "the game had nothing to say" into one blank panel.
Those are different bugs, and the agent looking at the panel is the one who would
report them.

Per CLAUDE.md, none of these is an error: _"Missing player state is a state, not an
error — never reject a conversation because of it."_ All four return `200`.

**No fallback to a later snapshot.** When this ticket has no snapshot, the response
says so and carries nothing else. Synthesising state from a different session
would manufacture exactly the misleading current-level number the product spec
rejects — the snapshot answers "what was true when this broke", and a label under
a number does not stop anyone reading the number.

**`declared` is ordered and labelled** by joining `declared_field` on key, giving
`label` and `type`. Keys present in the blob with no matching row cannot normally
occur — nothing is ever deleted — but any that appear are appended rather than
dropped.

**`raw` is returned in full.** It is PII by default per CLAUDE.md, handled as
personal data for access and retention purposes regardless of contents. It is not
role-gated and viewing it writes no event; the frontend renders it collapsed. This
was a deliberate decision, not an oversight — gating it would block the ordinary
agent from the diagnostic data the rail exists to provide.

## `tickets`

```ts
type AgentTicketSummary = {
  id: string;
  number: number;
  created_at: string;
  status: ConversationStatusValue;
  subintent: { intent_name: string; subintent_name: string } | null;
  resolution_source: 'bot' | 'agent' | null;
  resolved_by_agent_name: string | null;
  reopen_count: number;
};
```

This player's other conversations in this workspace, current one excluded, newest
first, capped at 20 with the true count in `summary.total_tickets`. There is no
cross-workspace history: a player of two of your games has two unrelated records.

**Two queries regardless of ticket count.** `listConversations` in
`agent/services/conversationsService.ts` currently runs one preview query per row
and says so in a comment; this does not repeat that.

1. Ticket rows, joined to `subintent`/`intent` for names, left-joined to `agent`
   for the resolver's display name
2. One grouped count of `conversation_reopened` events across all returned ids

**No message bodies.** The product spec asks for outcomes, not previews, and
leaving them out means this endpoint never touches the `message` table — so there
is no path by which an internal note reaches a preview string. `toAgentView` is
not involved.

**Outcome labels are composed in the frontend.** The API returns the facts —
`status`, `resolution_source`, `resolved_by_agent_name`, `reopen_count` — and the
UI turns them into "Resolved by Sam · reopened twice". Copy belongs where copy
lives.

**Only what the schema knows.** No "refund granted": there is no compensation
model, no labels and no custom-fields table. That is a separate feature, not a
label.

## Files

| Path                                                       | Change                                |
| ---------------------------------------------------------- | ------------------------------------- |
| `backend/src/shared/db/schema/identity.ts`                 | `workspace.ticket_seq`                |
| `backend/src/shared/db/schema/conversations.ts`            | `conversation.number` + unique index  |
| `backend/drizzle/`                                         | generated migration, five steps above |
| `backend/src/agent/services/conversationContextService.ts` | new                                   |
| `backend/src/agent/controllers/conversationsController.ts` | two handlers                          |
| `backend/src/agent/routers/conversationsRouter.ts`         | two routes                            |
| `backend/src/surface/services/newTicketService.ts`         | allocate number                       |
| `backend/src/surface/services/messagesService.ts`          | allocate number on auto-create        |
| `backend/src/docs/openapi.ts`                              | both routes + Zod schemas             |
| `packages/types/src/agent-context.ts`                      | new; the three types above            |

A new service file rather than growing `conversationsService.ts`, which is ~100
lines of claim/list/messages and would roughly double with unrelated concerns.

## Tenancy

Everything runs inside `withWorkspace`, so RLS scopes every read and a
cross-workspace id yields `404`, not `403` — "not yours" and "not there" are
indistinguishable by design.

The `:id` path parameter is used only in scoped `SELECT`s, never as a foreign key,
so the FK-bypass rule does not apply here.

## Tests

`backend/tests/`, Postgres required.

- Cross-workspace `:id` returns `404` on both endpoints
- All four `player_state` branches, each `200`
- `degraded_reason` surfaces on a `captured` response
- Tickets exclude the current conversation
- `reopen_count` matches the `conversation_reopened` events written
- Cap at 20 with `summary.total_tickets` holding the true total
- Ticket numbers assigned on both creation paths
- Two workspaces number independently from 1
- Backfill migration produces contiguous per-workspace numbers and leaves
  `workspace.ticket_seq` at each max

## Out of scope

- Custom fields — no per-conversation custom-field table exists
- Compensation tracking
- Filtering or saved views over the `declared` GIN index; that is a queue feature
- Cross-workspace player history
