# Rate limiting — design

## Problem

The Core API has no rate limiting anywhere. A single abusive game client, compromised player
session, or misbehaving agent-console session can currently send unlimited requests, starving
other tenants or degrading the API for everyone.

## Goals

- Protect the API globally, across all route groups, without waiting for a specific incident.
- Limit both by IP (catches distributed/pre-auth abuse, NAT-tolerant) and by authenticated
  identity (agent id or player/session id — catches one abusive actor without touching everyone
  else on the same network).
- Fail open on infrastructure trouble rather than taking the API down over a Redis blip.

## Non-goals

- Per-workspace override mechanism for trusted high-volume tenants — not needed yet, add later
  if a real tenant needs it.
- Alerting/monitoring dashboard on 429 rate — out of scope for this change. (Every trigger is
  still logged and persisted, per Logging below — a dashboard would consume that data, but
  building one is not part of this work.)
- Pruning/retention job for `rate_limit_hit` rows — not needed yet, add later if volume becomes
  a real problem.
- Anything beyond HTTP routes (Socket.io realtime traffic is not rate limited by this design).

## Architecture

- `backend/src/shared/rateLimit/redisClient.ts` — a lazy-loaded IORedis client dedicated to rate
  limit counters, following the existing pattern in `wsAuthCache.ts` / `presence.ts` (own
  connection, own `closeRateLimitRedis()` teardown). Not reused from the BullMQ or Socket.io
  Redis connections, which are configured for different retry/blocking semantics.
- `backend/src/shared/rateLimit/limiter.ts` — a factory:

  ```ts
  createRateLimiter({ windowMs, max, keyPrefix, keyFn }): RequestHandler
  ```

  built on `express-rate-limit` + `rate-limit-redis`. Every route group gets a configured
  middleware instance from this one factory instead of hand-rolled Redis logic per router.

- Applied per-router, mounted where each router is already registered in `app.ts` — not one
  global blanket middleware. This is what lets each tier carry its own window/max.
- Two limiter instances run per protected route, in sequence (both must pass):
  1. **IP limiter** — keyed on `req.ip`. Coarser ceiling, catches distributed/pre-auth abuse,
     applies even before identity is known.
  2. **Identity limiter** — keyed on agent id (agent-console routes) or player/session id
     (SDK/webview routes), read from whatever auth middleware already attaches to `req` on that
     route. Skipped on routes that run before any identity exists (login, token issuance).

## Route tiers and limits

| Tier | Routes | Identity limit | IP limit |
|---|---|---|---|
| Auth / token issuance | agent OAuth login, `/sdk/auth/player-token` | — (no identity yet) | 60/min |
| Message / ticket / form writes | chat message posting, ticket/form submission | 30/min | 200/min |
| Session start / uploads | `/sdk/sessions/start`, attachment uploads | 10/min | 100/min |
| General reads | conversation/article browsing, admin panel, agent console | 60/min | 300/min |

Numbers are sized against real usage, not arbitrary round numbers: a human can't sustain much
faster than ~1 message per 2 seconds even typing fast (30/min), session start and uploads are
rare per-session actions (10/min), and most live data flows over Socket.io rather than HTTP
polling, so read traffic stays well under 60/min per person in normal use. IP ceilings are set
higher than the identity ceiling they contain, to give NAT'd offices and shared networks
headroom before a whole building gets throttled by one heavy user.

These are starting numbers — each is just an argument to `createRateLimiter`, so retuning a
single tier later is a one-line change, not a redesign.

## Redis-down behavior

Fail **open**: if the Redis store errors, allow the request through and `logger.warn` once,
rather than fail-closed. This matches this repo's existing stance that Redis is "a queue and
pub/sub bus, not a system of record" — rate limiting is best-effort protection, not a
correctness guarantee, and should never be the reason the API goes down.

## Response format

On 429, use the existing error shape via a custom `express-rate-limit` handler that calls the
existing `sendError` helper:

```json
{ "error": { "code": "rate_limited", "message": "Too many requests, try again later." } }
```

Standard `RateLimit-*` and `Retry-After` headers are also set (express-rate-limit's default
draft-7 headers), so well-behaved clients can back off automatically.

No OpenAPI changes are needed — `openapi.ts` does not currently document per-route error
responses beyond the happy path, and this doesn't add or change any endpoint.

## Logging

Every rate limit trigger is logged via `logger.warn` under a dedicated `rateLimit` tag, the same
pattern as `bot.grounding`/`bot.search` — one line per 429, not sampled, since a rising trigger
rate on one tier is exactly the signal that catches a real attack or a misbehaving client early.
The custom `express-rate-limit` handler (the same one that builds the `sendError` response) logs:

- `tier` — which limiter tier fired (`auth`, `writes`, `sessionsUploads`, `reads`)
- `keyType` — `ip` or `identity`
- `key` — the IP or identity value that hit the ceiling (agent id / player session id are not
  PII in the way `state.raw` is, so these are safe to log as-is; IPs are logged as normal request
  metadata, consistent with `requestLoggerMiddleware`)
- `path` and `method` of the request that got blocked

This is a log, not a `db/event` row — it's for watching abuse happen in real time and it does
not fit the conversation-scoped, RLS-workspace-scoped shape of `event` (IP-keyed triggers on
pre-auth routes have no workspace or conversation to attach to at all). Durable persistence for
later querying is handled separately, by the `rate_limit_hit` table below.

## Persistence: `rate_limit_hit` table

Triggers are also written to a dedicated, **unscoped** table (like `workspace`/`agent`, not RLS
row-scoped — a rejected pre-auth login attempt has no workspace to scope to, and an identity-keyed
hit shouldn't require joining through RLS just to be queried for abuse analysis later):

```sql
create table rate_limit_hit (
  id           uuid primary key default gen_random_uuid(),
  tier         text not null,        -- 'auth' | 'writes' | 'sessionsUploads' | 'reads'
  key_type     text not null,        -- 'ip' | 'identity'
  key_value    text not null,        -- the IP or identity value that hit the ceiling
  path         text not null,
  method       text not null,
  created_at   timestamptz not null default now()
);
create index rate_limit_hit_tier_created_at_idx on rate_limit_hit (tier, created_at);
create index rate_limit_hit_key_value_created_at_idx on rate_limit_hit (key_value, created_at);
```

**Write path is fire-and-forget**: the 429 handler logs first (per Logging above), then issues
the insert without awaiting it, catching and `logger.warn`-ing any insert failure. A rate-limit
bookkeeping write must never add latency to an already-throttled response, and must never become
a new failure mode — if Postgres is unhappy, the request was already rejected correctly by Redis;
losing one audit row is an acceptable trade-off, silently swallowing another user's response is
not.

No retention/pruning job is added now (see Non-goals) — the table is expected to stay small
relative to `event`/`message` volume, since it only grows on actual triggers, not on every
request.

## Testing

- Unit tests for the limiter factory (mocked Redis store): under-limit passthrough, over-limit
  429 with correct body/headers, Redis-down fail-open, and a `logger.warn` call with the
  `rateLimit` tag firing on trigger.
- One integration test per tier hitting a real route with a stubbed low `max`, confirming the
  429 fires with correct body/headers end-to-end, and that a matching `rate_limit_hit` row is
  eventually written (poll/await the fire-and-forget insert rather than asserting on the
  response). Fits the existing `pnpm test` setup, which already requires Postgres and Redis.

## Rollout

No feature flag or gradual rollout — ship live across all tiers at once. The limits are sized
well above real usage, so there's no expected impact on legitimate traffic to stage.

## Dependencies

- Add `express-rate-limit` and `rate-limit-redis` to the root `package.json`.
- Add the `rate_limit_hit` table to `backend/src/shared/db/schema/**` and generate the migration
  with `pnpm db:generate`; run `pnpm db:setup` afterward.
