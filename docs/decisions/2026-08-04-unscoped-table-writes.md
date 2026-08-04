# The app role may write `agent` but not `workspace`

**Date:** 2026-08-04
**Status:** Accepted
**Context:** the Task 4 tenancy review of the SDK-seam slice found the application role could rewrite any workspace's secret

## The problem

`workspace` and `agent` are the only two tables in the product with no `workspace_id`, so
Row-Level Security cannot protect them — there is no tenant column to scope on. That is correct by
design: a workspace row *defines* a tenant, and an agent is one login per person, global across
workspaces, with the role held per workspace in `workspace_member`.

But the original grant was `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public`, which
included both. Verified against the live database as the application role:

```sql
UPDATE workspace SET secret_hash = 'attacker-controlled' WHERE slug = 'game-b';  -- UPDATE 1
SELECT id, slug, secret_hash FROM workspace;                                     -- every game
```

`workspace.secret_hash` is the credential a game's own backend presents to `POST /auth/player-token`
to mint player tokens. Rewriting it **locks that game's players out of support entirely** — they open
the support screen, the token fetch fails, and the SDK reports an incident rather than a
conversation. Setting `disabled_at` achieves the same thing more directly.

That is a cross-tenant availability attack reachable from any handler bug in any other workspace, and
it survives every RLS policy because RLS is not in play on these two tables.

## Decision

The two unscoped tables are treated **asymmetrically**, because their write patterns genuinely
differ:

```sql
REVOKE INSERT, UPDATE ON workspace FROM support_app;
-- agent deliberately keeps INSERT and UPDATE
```

**`workspace` — read-only to the application.** The request path only ever *reads* it: the auth
endpoint looks up a workspace by slug to verify a secret, and the player-token middleware looks one
up by id to cross-check the `X-Support-Workspace` header. Nothing in the request path has a
legitimate reason to write a workspace row. Creating and configuring workspaces is admin-console
work, and when that ships it should get a narrowly-scoped grant — not a restoration of table-wide
UPDATE.

**`agent` stays writable.** Agent authentication is Google OAuth restricted to the
`mindstormstudios.com` organisation (see
[`2026-08-04-agent-auth-google-oauth.md`](2026-08-04-agent-auth-google-oauth.md)), and the console's
**first-login flow upserts an `agent` row** — a genuine request-path write. Revoking here would
break that slice, and re-granting it later is churn. When the console ships, narrow it to columns
rather than the table: `GRANT UPDATE (display_name, status, google_subject) ON agent`.

Write the asymmetry down and comment it in the SQL, because it looks like an inconsistency and
someone will otherwise "tidy" it into symmetry.

## Consequence for the seed

The seed script previously wrote its `workspace` row through the application pool, which is the only
reason the app role needed that grant. It now opens a **dedicated owner connection** for that one
insert.

This is the right shape independently of the grant: seeding is local ops tooling, not request-path
code, so the owner credential belongs there. The rest of the seed deliberately stays on the
application pool so it continues to exercise the real RLS path — a seed that ran wholly as the owner
would silently bypass every policy (the owner is a superuser) and would stop catching the mistake of
writing a scoped table from an unscoped context.

## Rejected

**Revoking on both tables and moving all seed writes to the owner.** Symmetrical and briefly
tempting, but it would break the console's OAuth first-login upsert, which is a real request-path
write to `agent`. Symmetry is not the goal; matching the grant to the actual access pattern is.

**Leaving both writable and relying on handler correctness.** This is the position the review found,
and it makes a cross-tenant availability attack reachable from any single handler bug. The spec is
explicit that tenancy must not depend on handler correctness, and while RLS cannot help on these two
tables, a grant can.
