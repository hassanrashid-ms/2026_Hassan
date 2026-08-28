import { z } from 'zod';

/** Lowercase, because Node lowercases incoming header names. */
export const SDK_HEADERS = {
  idempotencyKey: 'idempotency-key',
  workspace: 'x-support-workspace',
  sdkVersion: 'x-support-sdk',
  clientVersion: 'x-support-client-version',
} as const;

const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);

/**
 * Device clocks lie. A timestamp that is unparseable, more than 24h in the future,
 * or from before 2020 is replaced by the fallback rather than rejected — the
 * request is still a real visit and must still be recorded.
 */
export function coerceInstant(input: unknown, fallback: Date = new Date()): Date {
  if (typeof input !== 'string' && !(input instanceof Date)) return fallback;
  const candidate = input instanceof Date ? input : new Date(input);
  const ms = candidate.getTime();
  if (Number.isNaN(ms)) return fallback;
  if (ms > fallback.getTime() + MAX_FUTURE_SKEW_MS) return fallback;
  if (ms < EARLIEST_PLAUSIBLE_MS) return fallback;
  return candidate;
}

/** Free text, never an enum, so a game can add an entry point with no server release. */
const entryPoint = z.string().min(1).max(120).catch('unknown');

/**
 * `snapshot` is z.unknown(): anything the SDK sends survives to the splitter, and
 * a malformed snapshot is a state rather than a 422. Only `session_id` is
 * load-bearing enough to fail on — it is the primary key.
 */
export const SessionStartBody = z.object({
  session_id: z.uuid(),
  entry_point: entryPoint,
  started_at: z.unknown().optional(),
  snapshot: z.unknown().optional(),
});
export type SessionStartBody = z.infer<typeof SessionStartBody>;

/**
 * duration_ms, conversation_created and articles_read are recorded but not trusted —
 * all three are derivable server-side. They exist for cross-checking a suspected
 * bug, so an absent or wrong-typed value becomes null/[] rather than a rejection.
 *
 * Deliberately `.nullable().catch(...)`, not `.nullish().catch(...)`. In Zod 4,
 * `.optional()` (which `.nullish()` includes) treats a *missing* key as valid
 * `undefined` and never invokes the schema at all, so `.catch()` never gets a
 * chance to fire and the key comes out `undefined` instead of the fallback.
 * `.nullable()` alone does not accept `undefined`, so a missing key is treated as
 * an invalid input and `.catch()` fires — giving the same fallback for "missing"
 * and "present but wrong-typed" alike, which is what this field means by "not
 * trusted". Verified empirically; see task-2-report.md.
 */
export const SessionEndBody = z.object({
  session_id: z.uuid(),
  duration_ms: z.number().int().nonnegative().nullable().catch(null),
  conversation_created: z.boolean().nullable().catch(null),
  articles_read: z.array(z.string().max(200)).max(500).catch([]),
});
export type SessionEndBody = z.infer<typeof SessionEndBody>;

/**
 * Always 200 if the body parses: an incident report that itself errors is worse
 * than useless. `incident_id`/`session_id` use `.nullable().catch(null)` (not
 * `.nullish()`), same reasoning as SessionEndBody above, so an incident sent
 * before a session_id exists — with the key omitted entirely, not sent as
 * literal `null` — still falls back to `null` instead of surfacing as `undefined`.
 */
export const IncidentBody = z.object({
  incident_id: z.uuid().nullable().catch(null),
  session_id: z.uuid().nullable().catch(null),
  kind: z.string().min(1).max(120).catch('unknown'),
  // `.max(2000).catch('')` would fire on the WHOLE parse failure for an over-length
  // string, discarding 100% of the diagnostic content rather than truncating it.
  // Validate the type first (falls back to '' only when it isn't a string at all),
  // then truncate — so an abusive detail keeps its first 2000 characters instead of
  // being wiped.
  detail: z
    .string()
    .catch('')
    .transform((s) => s.slice(0, 2000)),
  sdk_version: z.string().max(60).catch(''),
  client_version: z.string().max(60).catch(''),
});
export type IncidentBody = z.infer<typeof IncidentBody>;

export type UnreadResponse = { unread_count: number };

export const PlayerTokenRequest = z.object({
  external_player_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
});
export type PlayerTokenRequest = z.infer<typeof PlayerTokenRequest>;

export type PlayerTokenResponse = { token: string; expires_in: number };
