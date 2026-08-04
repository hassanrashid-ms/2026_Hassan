/**
 * The declared set expected on every conversation, per CLAUDE.md.
 * Order matters only for the readability of the seed.
 */
export const DECLARED_FIELD_KEYS = [
  'player_id',
  'client_version',
  'platform',
  'os_version',
  'device_model',
  'locale',
  'player_level',
  'total_spend',
  'spend_tier',
  'account_created_at',
  'last_session_at',
] as const

/**
 * The six the game's IPlayerStateProvider supplies. The rest come from the SDK's
 * DeviceProbe with no game involvement, so they are present even when the provider
 * throws on everything — which is exactly why `is_missing` is judged on these six
 * alone. See splitSnapshot() in the backend.
 */
export const PROVIDER_FIELD_KEYS = [
  'player_id',
  'player_level',
  'total_spend',
  'spend_tier',
  'account_created_at',
  'last_session_at',
] as const

export type DeclaredFieldType = 'string' | 'number' | 'boolean' | 'timestamp'

export const DECLARED_FIELD_SEED: readonly {
  key: (typeof DECLARED_FIELD_KEYS)[number]
  label: string
  type: DeclaredFieldType
}[] = [
  { key: 'player_id', label: 'Player ID', type: 'string' },
  { key: 'client_version', label: 'Client version', type: 'string' },
  { key: 'platform', label: 'Platform', type: 'string' },
  { key: 'os_version', label: 'OS version', type: 'string' },
  { key: 'device_model', label: 'Device model', type: 'string' },
  { key: 'locale', label: 'Locale', type: 'string' },
  { key: 'player_level', label: 'Player level', type: 'number' },
  { key: 'total_spend', label: 'Total spend', type: 'number' },
  { key: 'spend_tier', label: 'Spend tier', type: 'string' },
  { key: 'account_created_at', label: 'Account created', type: 'timestamp' },
  { key: 'last_session_at', label: 'Last session', type: 'timestamp' },
]
