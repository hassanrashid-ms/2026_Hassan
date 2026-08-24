# Admin Dashboard — Design

## Purpose

Admins operate across every workspace, not one: creating workspaces, rotating SDK secrets, and
granting/revoking access for agents, team leads, and other admins. Today `admin` is a per-workspace
`workspace_member.role`, which doesn't match how the role is actually used — an admin at one game
studio manages all of that studio's workspaces, not a single one they're a "member" of. This spec
promotes admin to a global property of the agent and adds the screens/API to manage it.

Out of scope: the real Google OAuth sign-in flow and the post-login "pick a workspace" screen for
agents entering the agent-console to work tickets. Those are referenced as an existing seam but
belong to a separate spec ([[agent-auth-google-oauth-domain-restricted]] in memory covers the OAuth
constraint itself).

## Data model changes

**`agent`** — two new global flags:

```
is_admin        boolean NOT NULL DEFAULT false
is_super_admin  boolean NOT NULL DEFAULT false
```

`agent.status` gains a fourth value: `invited` (alongside `active` / `on_leave` / `deactivated`), for
agents an admin has granted access to by email before they've ever signed in with Google.

**`workspace_member.role`** shrinks from `agent | team_lead | admin` to `agent | team_lead`. These are
the only two roles that are meaningfully scoped to one workspace — an agent can be `agent` in
workspace 1 and `team_lead` in workspace 2, and that per-workspace distinction stays exactly as it
is today. `admin` is removed from this enum because it was never really workspace-scoped; it's
promoted to `agent.is_admin` above.

Migration for existing data: for every `workspace_member` row with `role = 'admin'`, set
`agent.is_admin = true` for that `agent_id`, then delete the row (an admin has implicit access to
every workspace — see Authz below — so a leftover per-workspace row for them is meaningless), then
drop `'admin'` from the `workspace_member.role` enum.

**New `workspace_secret`** table, replacing the single implied secret on `workspace`:

```
workspace_secret
  id           uuid PK
  workspace_id uuid NOT NULL REFERENCES workspace(id)
  secret_hash  text NOT NULL
  created_at   timestamptz NOT NULL DEFAULT now()
  expires_at   timestamptz            -- null = no expiry (current active secret)
  revoked_at   timestamptz            -- set if manually revoked before expiry
```

`POST /auth/player-token` (existing SDK endpoint) accepts any secret matching a row where
`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`. Rotating a secret inserts a new
row with `expires_at = null` and sets the previously-active row's `expires_at = now() + 24h` — a
24-hour grace window so a game studio can redeploy their backend with the new secret without a hard
outage. After the window, the old row simply stops matching; no cleanup job is required for
correctness (an index on `(workspace_id, expires_at)` keeps the lookup cheap regardless of how many
expired rows accumulate).

`workspace.name` and `workspace.slug` already exist in the schema and are unchanged — `name` is the
studio-facing game name (editable, see API below), `slug` is the SDK-facing identifier
(`X-Support-Workspace` header, URLs) and is immutable once created.

## Authz and cross-workspace access

Admin endpoints need to read/write tenant-scoped tables across every workspace in one request (e.g.
"list all workspaces with member counts"), but RLS on every scoped table keys off a single
`app.workspace_id` set per transaction. Rather than loop per-workspace under normal RLS, admin
endpoints use a **dedicated bypass role**:

1. All admin endpoints live under a distinct route prefix, `/admin/*`, with dedicated middleware.
2. The middleware resolves the caller's `agent` row and rejects with `403` unless `is_admin = true`
   (endpoints that manage the admin/super-admin flags themselves additionally require
   `is_super_admin = true` — see the API table below).
3. Only after that check passes does the request run against a separate Postgres role, `crm_admin`,
   granted `BYPASSRLS`, via its own connection pool. Every other endpoint in the system continues to
   use the existing `crm_app` role under RLS, completely unchanged.

This keeps the bypass narrowly reachable: it is a distinct connection pool selected only by
`/admin/*` handlers, only after the `is_admin` check has already passed — a tenant-scoped handler has
no path to it. The existing isolation test posture ("authenticate as workspace A, hit workspace B's
IDs, expect 404") gets a companion test here: a non-admin hitting any `/admin/*` route must get `403`,
and `crm_admin` must never be reachable from a non-`/admin` route.

## Admin API

All routes below are under `/admin/*` and require `is_admin = true` unless marked super-admin-only.

| Endpoint                                       | Purpose                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/workspaces`                        | List all workspaces with member counts and created date — powers the Overview page                                                                                       |
| `POST /admin/workspaces`                       | Create a workspace (`name`, `slug`); `422` on duplicate slug                                                                                                             |
| `PATCH /admin/workspaces/:id`                  | Rename (`name` only — `slug` is immutable after creation)                                                                                                                |
| `GET /admin/workspaces/:id/members`            | List `workspace_member` rows (`agent` / `team_lead`) for one workspace                                                                                                   |
| `POST /admin/workspaces/:id/members`           | Grant access: `{ email, role: agent\|team_lead }`. If no `agent` row exists for that email, create one with `status = 'invited'`, then upsert the `workspace_member` row |
| `PATCH /admin/workspaces/:id/members/:agentId` | Change role (`agent` ↔ `team_lead`), or set `deactivated_at` to remove access                                                                                            |
| `GET /admin/workspaces/:id/secret`             | Secret metadata (`created_at`, `expires_at`) — never the raw value after creation                                                                                        |
| `POST /admin/workspaces/:id/secret/rotate`     | Rotate: insert new `workspace_secret` row, set the previous row's `expires_at`. Raw secret is returned **once**, in this response body only                              |
| `GET /admin/agents`                            | Directory of all agents (search by email/name), with `is_admin` / `is_super_admin` flags — used when granting admin                                                      |
| `PATCH /admin/agents/:id/admin`                | **Super-admin only.** Grant or revoke `is_admin`                                                                                                                         |
| `PATCH /admin/agents/:id/super-admin`          | **Super-admin only.** Grant or revoke `is_super_admin`                                                                                                                   |

On first Google sign-in (existing/future OAuth flow, out of scope here — this is the integration
seam it must honor): match the incoming email against `agent`. If a row exists with
`status = 'invited'`, populate identity fields and flip `status` to `active` instead of creating a
new row.

## Frontend surface

New `surfaces/admin-console`, kept separate from `surfaces/agent-console` and `surfaces/webview` —
same isolation pattern already established between those two ([[frontend-surfaces-migration-done]]):
its own lazily-imported `admin-console.css`, its own shadcn `components.json` with a distinct base
color (`zinc`, so all three surfaces — violet webview, slate agent-console, zinc admin-console — are
visually distinguishable at a glance).

```
surfaces/admin-console/
├── components/
│   └── AdminConsoleShell.tsx        -- left nav (Overview), topbar (admin name, logout)
├── pages/
│   ├── Overview/
│   │   ├── Overview.tsx             -- workspace cards: name, member count, created date; "Create Workspace"
│   │   └── components/
│   │       ├── CreateWorkspaceDialog.tsx
│   │       └── RenameWorkspaceDialog.tsx
│   └── WorkspaceDetail/
│       ├── WorkspaceDetail.tsx      -- tabs: Members, Secret
│       └── components/
│           ├── MembersTable.tsx     -- list, add-by-email, role change, remove access
│           ├── SecretPanel.tsx      -- metadata, rotate button, one-time reveal dialog
│           └── AdminGrantDialog.tsx -- super-admin only: grant/revoke is_admin / is_super_admin,
│                                       reachable from an agent's row in the directory
├── lib/
│   └── adminSession.ts              -- parallels agent-console's agentSession.ts
└── api/
    └── adminApi.ts
```

The Overview page is the "see all your workspaces, pick one to act on" surface described in the
original ask. It is distinct from the agent-console's post-login workspace picker (future spec) —
this one is for an admin managing workspaces, not an agent choosing where to work tickets.

Routing (`/admin` mount path, auth guard wiring) is an implementation detail left to the plan.

## Error handling and edge cases

- **Secret reveal**: raw value returned once, at creation/rotation time only. Lost secret → rotate
  again, there is no recovery path by design.
- **Self-demotion guard**: a super admin cannot revoke their own `is_admin` or `is_super_admin`.
- **Last super admin**: revoking `is_super_admin` from an agent is rejected if it would leave zero
  super admins in the system.
- **Invited, not yet signed in**: shows as `status = 'invited'` in `MembersTable` and the agent
  directory. Removing access on an invited agent deletes the pending `workspace_member` row directly
  (nothing to deactivate).
- **Duplicate invite**: granting access to an email already invited or active in that workspace is an
  upsert on `workspace_member` (updates role if different), not an error.
- **Workspace slug collision**: `422` on `POST /admin/workspaces`, enforced by the existing
  `UK(slug)` constraint.

## Testing

- Isolation: non-admin hitting any `/admin/*` route gets `403`; `crm_admin` role is unreachable from
  any non-`/admin` route; an admin's single-query read genuinely spans multiple workspaces.
- Secret rotation: old secret authenticates within the grace window, fails after `expires_at`; new
  secret works immediately after rotation.
- Self-demotion and last-super-admin guards.
- Invited → active transition on matching email at sign-in.
- Role change and remove-access on `workspace_member`; workspace rename; duplicate invite upsert;
  duplicate slug rejection.
