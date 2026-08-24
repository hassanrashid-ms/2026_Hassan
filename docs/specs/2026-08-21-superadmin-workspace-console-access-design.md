# Superadmin Workspace Console Access — Design

## Purpose

From the admin-console Overview page ([[admin-dashboard-design]]), a superadmin can see every
workspace but has no way to open one's actual agent-console (tickets, chat, takeover) without
losing their admin session. This spec adds that button and, underneath it, fixes the actual gap
that blocks it: an admin's session has no meaningful `workspace_id` to view console data with.

Today an admin JWT either carries no `workspace_id` (`/admin/*` routes, where it's inert — `crm_admin`
bypasses RLS entirely) or an arbitrary one picked at login (`authService.ts`'s "any workspace" hack,
which exists only to satisfy the JWT's shape). Neither lets an admin view a *specific* workspace's
console data, because RLS scopes every query to `current_setting('app.workspace_id')`, which is set
from the JWT — a value fixed at login, not chosen per click.

Out of scope: any impersonation UI (banner, "exit view" control) — this is a plain scoped view, not a
"log in as" flow. Auditing every agent-console route for a missing admin bypass on workspace-role
checks (see Known follow-up) is also out of scope here.

## Session model change

**Admin JWTs drop `workspace_id` entirely.** `{ agent_id, is_admin: true }` — no claim, not even a
placeholder. The login-time "any workspace" hack in `authService.ts` is deleted; there was never a
correct value to put there.

**Regular agent JWTs are unchanged** — `{ agent_id, workspace_id }`, exactly as today.

**Workspace becomes a per-request value for admins**, not a token value. Console API requests from
an admin session pass the target workspace explicitly (`X-Workspace-Id` header, set by the frontend
from the URL — see below). The session-resolution step that currently reads `workspace_id` straight
off the JWT (`withWorkspace.ts`) branches:

- Regular agent session → `workspace_id` from the JWT, as today. The header is never consulted for
  a non-admin session — there is no code path where supplying it changes anything, so it cannot be
  used to escalate into another tenant.
- Admin session → `workspace_id` from `X-Workspace-Id`. Before calling `set_config`, confirm the id
  resolves to a real, non-deleted workspace with an explicit `SELECT` (per the existing FK-bypass-RLS
  rule in CLAUDE.md) — a bad or missing id is `404`, not an empty result set.

This is strictly additive to the existing admin bypasses (`requireAdminAccess`,
`requireTeamLeadOrAdmin`) — those already decide *whether* a route is callable; this decides *which
workspace's rows* the query underneath sees. Both layers are needed; neither substitutes for the
other.

## Frontend surface

Overview page ([[admin-dashboard-design]]'s `surfaces/admin-console/pages/Overview`) gets an "Open
console" action on each workspace card, opening the agent-console in a **new tab** — the admin-console
tab and session are untouched.

The new tab needs the admin's existing token and the target workspace id, without putting either in
a query string (CLAUDE.md: tokens live in the URL fragment, never the query string, so they never
reach a server request line). Reusing that exact convention:

```
<agent-console-base>/#t=<adminToken>&workspace=<workspaceId>
```

A small bootstrap step in agent-console (parallel to how it already handles a fragment-delivered
token) reads both values, stores the token in its own session storage (agent-console and
admin-console deliberately use separate storage keys — [[frontend-surfaces-migration-done]]), stores
the workspace id as "active workspace for this session," strips the fragment, and redirects into the
normal console UI. From then on, every API call the console makes attaches
`X-Workspace-Id: <workspaceId>`.

No new backend endpoint is needed — no token is minted, the admin's own login token is reused as-is.

## Error handling and edge cases

- **Unknown or foreign workspace id in `X-Workspace-Id`**: `404`, consistent with the existing "not
  yours and not there are indistinguishable" RLS convention — never a silent empty page.
- **Header present on a non-admin session**: ignored outright; `workspace_id` always comes from that
  session's own JWT. There is no branch that reads the header for a non-admin, so this can't be
  probed into a leak.
- **Tab closed / session left open**: no server-side effect beyond the JWT's normal expiry — identical
  to any other idle agent-console session today. There's nothing to "exit" because there's no
  impersonation state, per the out-of-scope note above.
- **Attribution**: unaffected by any of this — `message.author_agent_id`, `conversation.assigned_agent_id`,
  `change_log.actor_id`, and `event.actor_id` all reference `agent.id` directly (never
  `workspace_member.id`), so actions taken through this flow already record the admin's real,
  stable `agent_id`. Confirmed by inspecting `postMessage.ts`, `conversationsService.ts`
  (`claimConversation`, `takeOverConversation`), and `appendEvent.ts` — none of them look up or
  require a `workspace_member` row.

## Known follow-up (audited, no gap found)

Audited every role-gated route in `agent/routers/*` for a bare `requireWorkspaceRole` check with no
admin bypass. None exists: `botConfigRouter`, `formsRouter`, and `taxonomyRouter` are the only routers
that gate at all, and every gate they use is `requireAdminRole` or `requireTeamLeadOrAdmin` — both
already check `agent.is_admin` first. `conversationsRouter`, `messagesRouter`, `articlesRouter`,
`tagsRouter`, and `agentsRouter` have no role gate at all. An admin opening a workspace via this flow
hits no unexpected `403`s today. If a future route adds a bare `requireWorkspaceRole(...)` call
without going through one of those two, it would reintroduce this gap — this note is what to check
against.

## Testing

- Admin JWT no longer carries `workspace_id`; login response/shape test updated accordingly.
- Session resolution: admin + valid `X-Workspace-Id` → `app.workspace_id` set to that value; admin +
  unknown/foreign id → `404`; non-admin + header supplied → header has no effect, own JWT workspace
  wins.
- Attribution integration test: admin posts a message / claims / takes over a conversation in a
  workspace they are not a member of → `author_agent_id` / `assigned_agent_id` / `actor_id` all equal
  the admin's real `agent_id`.
- Frontend: Overview button opens a new tab with `#t=`/`workspace=` fragment; bootstrap consumes and
  clears it, landing on the normal console UI scoped to that workspace.
