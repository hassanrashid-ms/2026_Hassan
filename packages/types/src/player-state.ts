import { z } from 'zod';

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
] as const;

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
] as const;

export type DeclaredFieldType = 'string' | 'number' | 'boolean' | 'timestamp';

export const DECLARED_FIELD_SEED: readonly {
  key: (typeof DECLARED_FIELD_KEYS)[number];
  label: string;
  type: DeclaredFieldType;
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
];

export type DeclaredFieldStatus = 'active' | 'inactive' | 'archived';

export const CreateDeclaredFieldBody = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, numbers and underscores only')
    .min(1)
    .max(64),
  label: z.string().min(1).max(120),
  type: z.enum(['string', 'number', 'boolean', 'timestamp']),
});

export const UpdateDeclaredFieldBody = z
  .object({
    label: z.string().min(1).max(120).optional(),
    type: z.enum(['string', 'number', 'boolean', 'timestamp']).optional(),
  })
  .refine((v) => v.label !== undefined || v.type !== undefined, {
    message: 'At least one of label or type is required.',
  });

export type DeclaredFieldView = {
  id: string;
  key: string;
  label: string;
  type: DeclaredFieldType;
  status: DeclaredFieldStatus;
  declaredAt: string;
  declaredBy: string | null;
  declaredByName: string | null;
};

export type DeclaredFieldsResponse = { fields: DeclaredFieldView[] };
export type CreateDeclaredFieldResponse = DeclaredFieldView;
export type UpdateDeclaredFieldResponse = DeclaredFieldView;
export type DeactivateDeclaredFieldResponse = { id: string; key: string; status: 'inactive' };
export type ReactivateDeclaredFieldResponse = { id: string; key: string; status: 'active' };
export type ArchiveDeclaredFieldResponse = { id: string; key: string; status: 'archived' };
