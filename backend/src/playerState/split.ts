import { PROVIDER_FIELD_KEYS } from '@support/types'

export type SnapshotSplit = {
  declared: Record<string, unknown>
  raw: Record<string, unknown>
  isMissing: boolean
  degradedReason: string | null
}

const MAX_DEGRADED_REASON = 500

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Null-prototype so a wire key literally named `__proto__` (parsed from JSON, where
// it is an ordinary own property, not the parser special-case a `{ __proto__: ... }`
// object literal gets) lands as real, visible data instead of being swallowed by
// Object.prototype's `__proto__` accessor. Object.keys, `in` and JSON.stringify all
// behave identically on a null-prototype object, so this changes nothing else.
const emptyBucket = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>

/**
 * Splits one SDK snapshot into the two jsonb columns of player_state_snapshot.
 *
 * `declaredKeys` must be the declared_field set read inside the SAME transaction as
 * the write. The split happens at write time and is permanent — promote a field
 * later and old snapshots keep it in `raw`. There is no backfill, ever. Passing a
 * cached or process-wide set would quietly break that.
 *
 * Nothing is ever dropped: every key the game sent lands in `declared` or `raw`.
 */
export function splitSnapshot(
  input: unknown,
  declaredKeys: ReadonlySet<string>,
  authenticatedExternalPlayerId: string,
): SnapshotSplit {
  if (!isPlainObject(input)) return { declared: emptyBucket(), raw: emptyBucket(), isMissing: true, degradedReason: null }

  const { extra, degraded_reason: degradedRaw, ...topLevel } = input

  const degradedReason =
    typeof degradedRaw === 'string' && degradedRaw.length > 0
      ? degradedRaw.slice(0, MAX_DEGRADED_REASON)
      : null

  // `extra` first so a top-level key of the same name wins.
  const candidates: Record<string, unknown> = {
    ...(isPlainObject(extra) ? extra : {}),
    ...topLevel,
  }

  if (Object.keys(candidates).length === 0) {
    return { declared: emptyBucket(), raw: emptyBucket(), isMissing: true, degradedReason }
  }

  const declared = emptyBucket()
  const raw = emptyBucket()
  for (const [key, value] of Object.entries(candidates)) {
    if (declaredKeys.has(key)) declared[key] = value
    else raw[key] = value
  }

  // `extra` arrived but in the wrong shape (array, string, number...) — it contributed
  // nothing to `candidates` above, so record that something arrived malformed rather
  // than silently discarding it. `null`/absent `extra` is a normal "no extra data"
  // signal, not malformed. Written after the partition, like the mismatch key below.
  if (extra !== undefined && extra !== null && !isPlainObject(extra)) {
    raw.__extra_malformed = extra
  }

  // snapshot.player_id is advisory only — the authoritative player comes from the
  // JWT. A mismatch is recorded and does not fail the request; the SDK cannot be
  // trusted to identify the player it is authenticated as. Compare stringified so a
  // numeric (or other primitive) player_id still triggers the diagnostic — the wire
  // contract documents player_id as a string, but the whole point of this check is
  // catching an SDK that is confused about who it is. The original, non-stringified
  // value is what gets recorded.
  const claimed = candidates.player_id
  if (claimed !== undefined && claimed !== null && String(claimed) !== authenticatedExternalPlayerId) {
    raw.__player_id_mismatch = { claimed, authenticated: authenticatedExternalPlayerId }
  }

  // Judged on the provider fields only: the SDK's DeviceProbe fills the device
  // fields with no game involvement, so a provider that throws on all six still
  // yields five populated keys. Including them would make is_missing unreachable.
  const isMissing = PROVIDER_FIELD_KEYS.every(
    (key) => candidates[key] === undefined || candidates[key] === null,
  )

  return { declared, raw, isMissing, degradedReason }
}
