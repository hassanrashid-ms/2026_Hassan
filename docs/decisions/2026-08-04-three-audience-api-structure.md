# One API, three audiences: audience is a security boundary

**Date:** 2026-08-04
**Status:** Accepted
**Context:** the Core API serves the Unity SDK, the player web surface and the agent/admin console. Settled during the SDK-seam slice, before any console code exists.

## The situation

`CLAUDE.md`'s architecture is one API behind three clients:

```
Unity SDK ─┐
Web surface┼──▶ Core API (Express, Socket.io, RLS) ──▶ Postgres · Redis · object storage
Console ───┘
```

Those three clients do **not** have the same trust level, and the spec names the failure that follows
from confusing them:

> one bug leaks internal notes to a player

An agent may read internal notes, every conversation in the workspace, other agents' throughput and
the full freeform player-state blob. A player may read their own thread, minus anything internal. The
same `conversation` row serves both. So the structure has to make the audience of every request
explicit and impossible to mix up — not merely conventional.

## Decision

**Audience is a top-level routing boundary with its own token type, its own middleware and its own
mount point.** Three of them:

| Mount        | Caller                              | Credential                                        | Frozen?                          |
| ------------ | ----------------------------------- | ------------------------------------------------- | -------------------------------- |
| `/sdk/*`     | Unity SDK inside a shipped game     | player JWT + `X-Support-*` header cross-check     | **Yes — additive only, forever** |
| `/surface/*` | the player web surface in a webview | player JWT only                                   | No — ships with the web app      |
| `/console/*` | the agent and admin console         | agent session (Google OAuth) + per-workspace role | No — ships with the console      |

Only `/sdk/*` is frozen, because only it is consumed by builds sitting in app stores that cannot be
recalled. The other two deploy together with their clients and may change freely.

```
backend/src/
  auth/
    playerToken.ts          sign/verify, aud = support-player
    workspaceSecret.ts      the game backend's server-to-server credential
    requirePlayerToken.ts   player JWT  → req.player
    requireSdkHeaders.ts    X-Support-Workspace cross-check   (/sdk/* only)
    agentSession.ts         Google OAuth verify + org check, aud = support-agent   [console]
    requireAgent.ts         agent session → req.agent                              [console]
    requireRole.ts          per-workspace role gate from workspace_member          [console]

  sdk/        the four frozen endpoints
  surface/    the player web surface's endpoints
  console/    agent + admin endpoints                                             [console]

  domain/     shared business rules, called by all three audiences                [console]
    conversations/   state machine · message seq · toAgentView / toPlayerView
    taxonomy/ · forms/ · rules/ · reporting/

  db/ · events/ · playerState/ · jobs/
```

## Four rules that make it hold

**1. The audience claim is the enforcement, not the routing.** Player tokens carry
`aud: 'support-player'` and verification pins it; agent sessions will carry `aud: 'support-agent'`.
So an agent token presented to `/sdk/*` fails signature verification outright — a router mounted
under the wrong middleware cannot become a privilege escalation. `jwtVerify` also pins
`algorithms: ['HS256']`, without which verification would accept whatever algorithm the token's own
header names.

**2. Serializers live in `domain/`, and player-facing routers may import only the player one.**
`toPlayerView` is an explicit field **whitelist** returning `null` for any message whose
`visibility <> 'public'`; `toAgentView` is the permissive one. Filtering in the query is forbidden —
the row is fetched whole and the serializer decides.

Enforce it mechanically: a test that greps `src/sdk` and `src/surface` for `toAgentView` and fails if
it appears. A rule nobody can forget beats a rule everybody is told. The same split applies to
Socket.io rooms — `conv:{id}:agents` and `conv:{id}:player` are separate rooms, so a player socket
cannot receive an internal-note event.

**3. Business rules live in `domain/`, never in a router.** A conversation can be resolved by an
agent, by a player confirming the bot's answer, or by the inactivity worker. All three must go through
one function that writes the `resolution_cycle` row _and_ the `conversation_resolved` event in one
transaction. Three routers each doing it their own way is how the mutable row and the event stream
drift apart, and reporting reads the events.

**4. `withWorkspace` stays the common floor.** Player routes take the workspace from the verified JWT
claim. Console routes take it from the agent's selected workspace **after** checking
`workspace_member` — and an agent with no membership gets `404`, not `403`, because RLS makes the rows
invisible and the handler genuinely cannot distinguish "not yours" from "not there". Both audiences
funnel into the same helper, so tenant isolation is identical and there is no second enforcement path
to drift.

## Consequences

- Two authentication mechanisms coexist permanently. They share nothing but `withWorkspace`: the
  player credential is minted by a game's backend from a workspace secret, the agent credential comes
  from Google. Neither can be used where the other belongs.
- `domain/` is empty during the SDK-seam slice, and that is correct — the four SDK endpoints are
  genuinely thin (upsert a session, split a snapshot, append an event). It appears with conversations,
  where the first rule shared by two audiences appears.
- **`auth/jwt.ts` should be renamed `auth/playerToken.ts`.** It is player-specific today (it sets
  `aud: 'support-player'`) but the generic name will attract agent-token code, which is exactly the
  audience mixing this decision exists to prevent. Deferred to the SDK-seam slice's final cleanup
  task rather than done mid-flight, to avoid churning every in-progress task's imports.
- Reporting and Socket.io are console-audience concerns and belong under `console/` and `domain/`
  respectively, not beside the SDK endpoints.

## Rejected

**One router with per-endpoint permission checks.** The conventional shape, and the one that produces
the leak the spec warns about: a permission check is something a handler can forget, whereas a mount
point under the wrong middleware is visible in one file. Hiding a control in the UI is not enforcement
either — checks run at the API.

**A separate service per audience.** It would enforce the boundary at the network layer, but it splits
the transaction boundary that "publish an article and write its embeddings atomically" and "write the
row and append the event atomically" both depend on, and it doubles the ops surface on a self-hosted
Docker deployment. The same reasoning that rejected polyglot persistence applies.

**Sharing request handlers between audiences with a role flag.** `if (isAgent) { … }` inside a handler
means the player path and the agent path are one code path with a branch, and the branch is one
inverted boolean away from serving internal notes to a player.
