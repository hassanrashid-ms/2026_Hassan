# Cross-tenant foreign keys need composite FKs, not a convention

**Date:** 2026-08-04
**Status:** Accepted — decision now, implementation in migration `002`
**Context:** found by behavioural probing during the SDK-seam slice's RLS review, on the live database

## The problem

**PostgreSQL runs referential-integrity checks with row security suspended.** A foreign-key check is
performed by the system, not by the querying role, so a `tenant` RLS policy does not constrain it.

Consequence, verified against the live database as the application role:

```sql
SET LOCAL app.workspace_id = '<workspace A>';
INSERT INTO conversation (workspace_id, player_id)
VALUES ('<workspace A>', '<workspace B''s player id>');
-- INSERT 0 1   -- accepted
```

Both checks pass legitimately. The FK check finds B's player row because RI ignores RLS. The policy's
`WITH CHECK` passes because `workspace_id` genuinely _is_ A. Nothing is violated, and a row now exists
whose parent belongs to another tenant.

**This is an integrity vector, not a confidentiality one.** Workspace A still cannot read B's player
row — RLS filters the join — so no data leaks. What it produces is corrupt graph edges: a conversation
whose player is invisible to the workspace that owns the conversation. It also yields a weak existence
oracle, since a nonexistent id errors with a FK violation while a real foreign id succeeds.

It needs a valid foreign UUID to exploit, so it is not trivially reachable. It is, however, reachable
by any handler that trusts a client-supplied id.

## Why the current mitigation is not enough

The plan mitigates this by having every handler that accepts a client-supplied id **pre-verify it with
an RLS-scoped `SELECT`** before using it as a foreign key. `POST /sdk/incidents`, `POST
/sdk/sessions/start` and both `/surface/*` routes all do this, and `appendEvent`'s docblock states the
rule.

That is a **convention enforced by comments and reviewer attention** — precisely the ORM-level
enforcement the schema spec says tenancy must not depend on:

> Tenancy is the highest-risk thing in the build, and it is enforced by the database, not the ORM.

One forgotten check in one handler writes a cross-tenant edge, and no test would catch it unless
someone thought to write that specific test for that specific handler.

## Decision

**Composite foreign keys.** Each scoped parent gets a redundant unique key on
`(workspace_id, id)`, and each child FK carries `workspace_id` as part of the reference:

```sql
ALTER TABLE player ADD CONSTRAINT player_ws_id_uk UNIQUE (workspace_id, id);

ALTER TABLE conversation
  DROP CONSTRAINT conversation_player_id_player_id_fk,
  ADD  CONSTRAINT conversation_player_fk
       FOREIGN KEY (workspace_id, player_id) REFERENCES player (workspace_id, id)
       ON DELETE RESTRICT;
```

The database then refuses the insert above, because no `player` row exists with
`(workspace_id = A, id = B's player)`. **No handler can get it wrong, and no test needs to remember.**

Applies to every FK between two scoped tables: `session → player`, `conversation → player`,
`conversation → session`, `player_state_snapshot → session`, `message → conversation`,
`event → conversation`, `event → session`. FKs to the two _unscoped_ tables (`workspace`, `agent`) are
unaffected — there is no tenant to cross.

## Timing: decide now, implement in migration `002`

Ten tables exist; the full schema is 33. Retrofitting now means reopening a reviewed schema mid-seam
for a vector that is not a data leak and has no handler yet able to reach it. Retrofitting after the
schema grows means roughly 60 foreign keys instead of 7.

So the decision is made now and lands with migration `002`, at the start of the conversation slice —
before any of the remaining 23 tables are written, so they are authored with composite FKs from the
start rather than converted.

**Until then the handler-side pre-verification stays mandatory**, and the comments saying so must not
be removed as redundant until the composite FKs actually exist.

## Consequences

- One extra unique index per scoped parent. Negligible write cost at this scale, and several are
  useful for tenant-scoped lookups anyway.
- Child tables must carry `workspace_id` — they already all do, by the tenancy rule.
- `ON DELETE RESTRICT` is preserved on every converted FK; "nothing is ever deleted" is unaffected.
- Migration `002` must add the unique keys **before** re-pointing the FKs, in one transaction.

## Rejected

**Relying on a database trigger** to validate that parent and child share a workspace. It would work,
but it is a per-table hand-written check that can be forgotten exactly like the handler convention,
with worse performance and no declarative record in the schema. A composite FK _is_ the constraint,
visible in `\d` and in the Drizzle schema.
