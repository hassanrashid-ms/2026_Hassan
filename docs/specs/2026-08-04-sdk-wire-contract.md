# SDK wire contract — the backend side

**Date:** 2026-08-04
**Status:** Approved
**Counterpart:** the SDK repo's `docs/specs/sdk-production-implementation.md`, which declares these
endpoints out of scope (§7) and treats them as an external dependency
**Depends on:** [`2026-08-04-database-and-schema-design.md`](2026-08-04-database-and-schema-design.md)

The SDK spec froze a 4-endpoint contract with an explicit rule: _"Add response fields freely; never
remove or retype one — old builds sit in app stores for years and cannot be recalled."_ This document
is the server side of that contract, plus the auth endpoint the game's backend calls.

**Getting this right matters more than getting it fast.** A shipped Unity build cannot be recalled, so
a mistake here is permanent for the lifetime of that build in the store.

## Endpoint map

| Endpoint                   | Caller                 | Auth             |
| -------------------------- | ---------------------- | ---------------- |
| `POST /auth/player-token`  | the **game's** backend | workspace secret |
| `POST /sdk/sessions/start` | SDK (via Outbox)       | player JWT       |
| `POST /sdk/sessions/end`   | SDK (via Outbox)       | player JWT       |
| `POST /sdk/incidents`      | SDK (via Outbox)       | player JWT       |
| `GET /sdk/unread`          | SDK (direct poll)      | player JWT       |

**The SDK never holds a secret.** The workspace secret lives only in the game's own backend, which
mints a short-lived player JWT and hands it to the client. The SDK ships
`UnsafeStaticTokenProvider` for development, which must not reach a release build.

## Headers on every `/sdk/*` request

| Header                     | Use                                                                      |
| -------------------------- | ------------------------------------------------------------------------ |
| `Idempotency-Key`          | Logged, **not load-bearing** — see _Idempotency_ below                   |
| `X-Support-Workspace`      | Workspace slug. Cross-checked against the JWT claim; a mismatch is `403` |
| `X-Support-Sdk`            | SDK version, for `sdk_incident` triage                                   |
| `X-Support-Client-Version` | Game build version                                                       |

## Idempotency

The SDK's Outbox retries with backoff and persists to disk when offline, so **duplicate delivery is
expected, not exceptional.**

**The SDK generates `session_id` itself** — a UUID minted in `Open()` before any network call, because
it has to go in the webview URL. Accepting it as the primary key makes the writes idempotent with no
dedupe store:

```sql
INSERT INTO session (id, workspace_id, player_id, entry_point, started_at)
VALUES (:session_id, :ws, :player_id, :entry_point, :started_at)
ON CONFLICT (id) DO NOTHING;
```

`Idempotency-Key` is still logged for debugging, but no table or Redis key backs it. That is
deliberate — a dedupe store is another thing to operate, and the primary key already does the job
correctly and permanently.

## `POST /auth/player-token`

Called **server-to-server** by the game's backend. Never by the SDK.

```jsonc
// request  — Authorization: Bearer <workspace_secret>
{ "external_player_id": "UserId7661" }

// 200
{ "token": "<jwt>", "expires_in": 900 }
```

Upserts the player on first contact, so a player exists from their first support open:

```sql
INSERT INTO player (id, workspace_id, external_id, first_seen_at, last_seen_at)
VALUES (gen_random_uuid(), :ws, :external_id, now(), now())
ON CONFLICT (workspace_id, external_id)
DO UPDATE SET last_seen_at = now()
RETURNING id;
```

JWT claims: `workspace_id`, `player_id`, `external_player_id`, `iat`, `exp`. **15 minutes.** Short
because it travels in a URL fragment; the web app refreshes against its own session, not by re-reading
the fragment.

| Failure                         | Response |
| ------------------------------- | -------- |
| Bad or missing workspace secret | `401`    |
| Workspace not found or disabled | `404`    |
| Malformed `external_player_id`  | `422`    |

## `POST /sdk/sessions/start`

```jsonc
{
  "session_id": "b3f1…", // client-generated, becomes session.id
  "entry_point": "settings_menu", // context only, NEVER classification
  "started_at": "2026-08-04T09:12:00Z",
  "snapshot": {
    "player_id": "UserId7661",
    "client_version": "6.2.01",
    "platform": "ios",
    "os_version": "26.5.2",
    "device_model": "iPhone 13 Pro Max",
    "locale": "en-GB",
    "player_level": 34,
    "total_spend": 0.0,
    "spend_tier": "non-payer",
    "account_created_at": "2026-07-27T09:12:00Z",
    "last_session_at": "2026-08-03T08:40:00Z",
    "extra": { "ab_bucket": "B", "collection_status": "event_in_progress" },
    "degraded_reason": null, // set when provider fields threw
  },
}
```

Server does, in one transaction:

1. Upsert `session` — `ON CONFLICT (id) DO NOTHING`.
2. **Split the snapshot** against the `declared_field` set _current at this moment_. Declared keys go
   to `declared`; everything else, including all of `extra`, goes to `raw`. **The split is permanent —
   no backfill, ever.** This is what makes promotion non-retroactive.
3. Upsert `player_state_snapshot` on `session_id`.
4. Append a `session_start` event.

```
200 { "ok": true }
```

**Never `4xx` for a bad snapshot.** A malformed, empty or absent snapshot is a _state_: write the row
with `is_missing = true` or `degraded_reason` set and return `200`. Rejecting it would mean the
conversations where something is broken are the ones that fail to attach context.

`snapshot.player_id` is treated as **advisory only** — the authoritative player comes from the JWT. A
mismatch is recorded in `raw` and does not fail the request; the SDK cannot be trusted to identify the
player it is authenticated as.

**Arrival order does not matter.** This call is non-blocking in the SDK, so it can land after the web
app has already created a conversation. Because the snapshot is keyed to `session_id` and the
conversation reaches it via `conversation.session_id`, a late snapshot simply becomes visible — no
repair step, no ordering requirement.

## `POST /sdk/sessions/end`

```jsonc
{
  "session_id": "b3f1…",
  "duration_ms": 184200,
  "conversation_created": false,
  "articles_read": ["a_123", "a_456"],
}
```

Sets `session.ended_at` and appends a `session_end` event. `duration_ms`, `conversation_created` and
`articles_read` are **recorded but not trusted** — all three are derivable server-side
(`ended_at − started_at`; a join on `conversation.session_id`; and the `article_read` events for the
session). The derived values are what reporting uses; the client's numbers go in the payload only for
cross-checking a suspected bug.

**`article_read` events are emitted by the web surface, not the SDK.** The player browses articles
inside the webview, so the web app writes one `article_read` event per article opened, against the
authenticated session. The SDK's `articles_read` array is a client-side echo of the same thing — it
exists because the SDK's bridge already receives `article_read` messages, and having both lets you
detect a bridge that has silently stopped firing. **Reporting reads the events**, never the array,
because the array only arrives if `sessions/end` arrives.

```
200 { "ok": true }
```

**If this never arrives, the session has no `ended_at`.** The SDK spec flags the same risk from the
other side: _"The web surface must call `close`, or the session never ends and the visit is missing
from the self-serve denominator."_ Two mitigations, both needed:

- A repeatable job closes sessions with no `ended_at` older than 30 minutes, marking them
  `ended_by = 'timeout'`.
- Self-serve rate counts sessions by `started_at`, never by `ended_at`, so an unclosed session still
  appears in the denominator. **A missing end must never silently shrink the denominator** — that
  would inflate self-serve rate exactly when the SDK is misbehaving.

## `POST /sdk/incidents`

```jsonc
{
  "incident_id": "c7a2…", // client-generated → idempotent
  "session_id": "b3f1…", // nullable: may fail before a session exists
  "kind": "token_timeout",
  "detail": "5s elapsed, no response",
  "sdk_version": "1.0.2",
  "client_version": "6.2.01",
}
```

Appends one `sdk_incident` row to `event` with `actor_type = 'system'`. No dedicated table — volume is
low and it inherits workspace scoping, the BRIN index and append-only enforcement.

```
200 { "ok": true }
```

**Always `200` if the body parses.** An incident report that itself errors is worse than useless. And
**something must watch this stream**: a rising incident count is how you learn a release broke support
entry for an entire platform. Per _"failure is never silent"_, an unwatched incident stream is the
silent failure it was built to prevent.

## `GET /sdk/unread`

```
200 { "unread_count": 2 }
```

Derived, not stored:

```sql
SELECT count(*) FROM message m
  JOIN conversation c ON c.id = m.conversation_id
 WHERE c.player_id     = :player
   AND m.visibility    = 'public'
   AND m.author_type  <> 'player'
   AND m.delivery_state <> 'read';
```

Polled coarsely — on foreground/resume only, never per frame. **Push is best effort; this is the
guaranteed path.** No requirement may depend on push alone, which is why a poll exists at all.

## Forward compatibility

The rule from the SDK spec, restated as a server obligation:

- **Add response fields freely. Never remove or retype one.**
- **Unknown request fields are ignored, never rejected** — a newer SDK may send fields this server
  doesn't know yet, and it must still succeed.
- **Unknown `entry_point` values are accepted as-is.** It is a free-text label, not an enum, precisely
  so a game can add an entry point without a server release.
- Every `/sdk/*` endpoint returns `200` for anything recoverable. Reserve `4xx` for auth failures and
  unparseable bodies.

## Tenancy

Every handler opens a transaction and sets the tenant before touching a table:

```sql
SET LOCAL app.workspace_id = '<from the JWT claim>';
```

The workspace comes from the **JWT**, never from `X-Support-Workspace` — the header is only
cross-checked so a misconfigured build fails loudly rather than writing to the wrong game. RLS then
makes a cross-workspace write impossible regardless of handler bugs.

## Build order

Solo, sequential. The seam is what needs proving first, so it comes before any real UI.

| Step  | Work                                                                                                                                       | Done when                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | pnpm workspace, Drizzle schema, RLS policies, docker-compose (Postgres + Redis), seed one workspace and the `Other` taxonomy               | `drizzle-kit push` runs clean; the cross-workspace isolation test passes with `404`                                                     |
| **2** | `POST /auth/player-token` + the four `/sdk/*` endpoints                                                                                    | curl mints a token, starts a session, and a `player_state_snapshot` row appears with the split correct                                  |
| **3** | Web surface **stub** — reads `#t=`, calls the API, renders the player state, calls `SupportBridge.post({type:'close'})`. Deliberately ugly | Opening the URL by hand shows the right player's state and ends the session                                                             |
| **4** | SDK `Assets/Support/` per its own spec, pointed at the real endpoint                                                                       | A button in Unity opens an embedded webview showing that player's state; killing the network still opens it and queues `sessions/start` |
| **5** | Only now: `POST /conversations`, `POST /messages`, the real chat UI, the agent inbox                                                       | The core loop — player message → agent reply → player sees it                                                                           |

Steps 1–4 prove the seam: token issuance, the fragment handoff, snapshot delivery, the bridge, and
`close` ending the session. That seam spans both repos and is where the surprises live, so it gets
proven while it is still cheap to change. Step 5 is the loop the whole product hangs off, and the
README is right that it ships before the bot is touched.

**Note on the existing SDK code.** `Assets/Scripts/SupportSdkDemo.cs` is a learning artifact, not a
foundation — it uses `Application.OpenURL` (external browser, which the production spec forbids),
hand-rolled JSON, no token, and no Outbox. Step 4 replaces it with `Assets/Support/` rather than
extending it.
