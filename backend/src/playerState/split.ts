import { PROVIDER_FIELD_KEYS } from '@support/types'

export type SnapshotSplit = {
  declared: Record<string, unknown>
  raw: Record<string, unknown>
  isMissing: boolean
  degradedReason: string | null
}

const MAX_DEGRADED_REASON = 500
const EMPTY: SnapshotSplit = { declared: {}, raw: {}, isMissing: true, degradedReason: null }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
  if (!isPlainObject(input)) return { ...EMPTY, declared: {}, raw: {} }

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
    return { declared: {}, raw: {}, isMissing: true, degradedReason }
  }

  const declared: Record<string, unknown> = {}
  const raw: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(candidates)) {
    if (declaredKeys.has(key)) declared[key] = value
    else raw[key] = value
  }

  // snapshot.player_id is advisory only — the authoritative player comes from the
  // JWT. A mismatch is recorded and does not fail the request; the SDK cannot be
  // trusted to identify the player it is authenticated as.
  const claimed = candidates.player_id
  if (typeof claimed === 'string' && claimed !== authenticatedExternalPlayerId) {
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
