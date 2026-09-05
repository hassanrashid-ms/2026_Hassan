import { randomUUID } from 'node:crypto';
import pg, { Pool } from 'pg';
import { getEnv } from '../../src/env.ts';

// pg_enum.enumlabel is type `name`, so array_agg over it returns `name[]` (OID 1003).
// The pg driver ships `noParse` for this OID, returning a raw postgres array string.
// Register a proper array parser so query results come back as JS string[].
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(pg.types as any).setTypeParser(1003, (v: string) =>
  (pg.types as any).arrayParser.create(v, (s: string) => s).parse(),
);

/**
 * Tests connect as the owner for setup and teardown: TRUNCATE is an owner-only
 * privilege and support_app is deliberately never granted DELETE.
 */
export const ownerPool = new Pool({ connectionString: getEnv().MIGRATION_DATABASE_URL, max: 4 });

const SCOPED_TABLES = [
  'article_attachment',
  'attachment',
  'resolution_cycle',
  'form_answer',
  'form_submission',
  'form_version',
  'form',
  'message_template',
  'change_log',
  'bot_config',
  'notification',
  'event',
  'message',
  'conversation',
  'subintent',
  'intent',
  'player_state_snapshot',
  'declared_field',
  'session',
  'player',
  'workspace_secret',
  'workspace_member',
  'agent',
  'workspace',
  'rate_limit_hit',
];

export async function truncateAll(): Promise<void> {
  await ownerPool.query(`truncate table ${SCOPED_TABLES.join(', ')} restart identity cascade`);
}

export async function closeOwnerPool(): Promise<void> {
  await ownerPool.end();
}

export async function seedWorkspace(
  overrides: {
    id?: string;
    slug?: string;
    name?: string;
    disabledAt?: Date | null;
    autoCloseDays?: number;
    formTimeoutMinutes?: number;
    inactivityWindowHours?: number;
    maxAssignedTickets?: number;
  } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const slug = overrides.slug ?? `ws-${id.slice(0, 8)}`;
  await ownerPool.query(
    `insert into workspace (id, name, slug, disabled_at, auto_close_days, form_timeout_minutes, inactivity_window_hours, max_assigned_tickets)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      overrides.name ?? slug,
      slug,
      overrides.disabledAt ?? null,
      overrides.autoCloseDays ?? 7,
      overrides.formTimeoutMinutes ?? 30,
      overrides.inactivityWindowHours ?? 24,
      overrides.maxAssignedTickets ?? 5,
    ],
  );
  return id;
}

export async function seedWorkspaceSecret(args: {
  workspaceId: string;
  secretHash: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into workspace_secret (id, workspace_id, secret_hash, expires_at, revoked_at) values ($1, $2, $3, $4, $5)`,
    [id, args.workspaceId, args.secretHash, args.expiresAt ?? null, args.revokedAt ?? null],
  );
  return id;
}

export async function seedAgent(
  email = `a-${randomUUID().slice(0, 8)}@example.test`,
  options: {
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
    status?: 'active' | 'on_leave' | 'deactivated' | 'invited';
  } = {},
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into agent (id, email, display_name, is_admin, is_super_admin, status)
     values ($1, $2, 'Test Agent', $3, $4, coalesce($5::agent_status, 'active'))`,
    [id, email, options.isAdmin ?? false, options.isSuperAdmin ?? false, options.status ?? null],
  );
  return id;
}

export async function seedPlayer(
  workspaceId: string,
  externalId = `p-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into player (id, workspace_id, external_id) values ($1, $2, $3)`, [
    id,
    workspaceId,
    externalId,
  ]);
  return id;
}

export async function seedDeclaredFields(
  workspaceId: string,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await ownerPool.query(
      `insert into declared_field (workspace_id, key, label, type) values ($1, $2, $2, 'string')
         on conflict (workspace_id, key) do nothing`,
      [workspaceId, key],
    );
  }
}

export async function seedSession(args: {
  workspaceId: string;
  playerId: string;
  id?: string;
  entryPoint?: string;
  startedAt?: Date;
  endedAt?: Date | null;
}): Promise<string> {
  const id = args.id ?? randomUUID();
  await ownerPool.query(
    `insert into session (id, workspace_id, player_id, entry_point, started_at, ended_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      args.workspaceId,
      args.playerId,
      args.entryPoint ?? 'settings_menu',
      args.startedAt ?? new Date(),
      args.endedAt ?? null,
    ],
  );
  return id;
}

export async function seedConversation(args: {
  workspaceId: string;
  playerId: string;
  sessionId?: string | null;
  createdAt?: Date;
  status?: 'new' | 'bot_active' | 'open' | 'awaiting_player' | 'escalated' | 'resolved' | 'closed';
  confirmPhase?: 'none' | 'bot_article' | 'agent_ask' | 'form' | 'inactivity_ask' | 'player_stated';
  assignedAgentId?: string | null;
  resolutionSource?:
    'bot' | 'agent' | 'player_confirmed' | 'timed_out' | 'player_stated' | 'admin_forced' | null;
  priority?: 'p1' | 'p2' | 'p3' | 'p4';
  priorityManuallySet?: boolean;
  subintentId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  // Bumped the same way the request path bumps it, so a test that seeds three
  // conversations sees #1, #2, #3 rather than three rows fighting over one number.
  const { rows } = await ownerPool.query<{ ticket_seq: number }>(
    `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
    [args.workspaceId],
  );
  const number = rows[0]!.ticket_seq;
  await ownerPool.query(
    `insert into conversation
       (id, workspace_id, player_id, session_id, number, created_at, status, confirm_phase, assigned_agent_id, resolution_source, priority, priority_manually_set, subintent_id)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($7::conversation_status, 'bot_active'), coalesce($8::confirm_phase, 'none'), $9, $10::resolution_source, coalesce($11::conversation_priority, 'p3'), coalesce($12, false), $13)`,
    [
      id,
      args.workspaceId,
      args.playerId,
      args.sessionId ?? null,
      number,
      args.createdAt ?? null,
      args.status ?? null,
      args.confirmPhase ?? null,
      args.assignedAgentId ?? null,
      args.resolutionSource ?? null,
      args.priority ?? null,
      args.priorityManuallySet ?? null,
      args.subintentId ?? null,
    ],
  );
  return id;
}

export async function seedMessage(args: {
  workspaceId: string;
  conversationId: string;
  seq: number;
  authorType: 'player' | 'agent' | 'bot' | 'system';
  visibility?: 'public' | 'internal';
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  body?: string;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into message (id, workspace_id, conversation_id, seq, author_type, visibility, delivery_state, body, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()))`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.seq,
      args.authorType,
      args.visibility ?? 'public',
      args.deliveryState ?? 'sent',
      args.body ?? 'test message',
      args.createdAt ?? null,
    ],
  );
  return id;
}

export async function seedWorkspaceMember(args: {
  workspaceId: string;
  agentId: string;
  role?: 'agent' | 'team_lead';
  deactivatedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into workspace_member (id, workspace_id, agent_id, role, deactivated_at) values ($1, $2, $3, $4, $5)`,
    [id, args.workspaceId, args.agentId, args.role ?? 'agent', args.deactivatedAt ?? null],
  );
  return id;
}

export async function seedIntent(
  workspaceId: string,
  name = `Intent ${randomUUID().slice(0, 8)}`,
  isSystem = false,
): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into intent (id, workspace_id, name, is_system) values ($1, $2, $3, $4)`,
    [id, workspaceId, name, isSystem],
  );
  return id;
}

export async function seedSubintent(args: {
  workspaceId: string;
  intentId: string;
  name?: string;
  formId?: string | null;
  defaultPriority?: 'p1' | 'p2' | 'p3' | 'p4';
}): Promise<string> {
  const id = randomUUID();
  const name = args.name ?? `Subintent ${randomUUID().slice(0, 8)}`;
  await ownerPool.query(
    `insert into subintent (id, workspace_id, intent_id, name, form_id, default_priority) values ($1, $2, $3, $4, $5, $6::conversation_priority)`,
    [id, args.workspaceId, args.intentId, name, args.formId ?? null, args.defaultPriority ?? null],
  );
  return id;
}

export async function seedArticle(args: {
  workspaceId: string;
  createdBy: string;
  title?: string;
  body?: string;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into article (id, workspace_id, title, body, created_by) values ($1, $2, $3, $4, $5)`,
    [
      id,
      args.workspaceId,
      args.title ?? `Article ${randomUUID().slice(0, 8)}`,
      args.body ?? 'body',
      args.createdBy,
    ],
  );
  return id;
}

export async function seedBotConfig(args: {
  workspaceId: string;
  isProvisioned?: boolean;
  prompt?: string;
  rules?: unknown[];
  toolsConfig?: unknown[];
  limitsConfig?: unknown[];
}): Promise<void> {
  await ownerPool.query(
    `insert into bot_config (workspace_id, is_provisioned, prompt, rules, tools_config, limits_config)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
    [
      args.workspaceId,
      args.isProvisioned ?? false,
      args.prompt ?? 'RAW SEEDED PROMPT',
      JSON.stringify(args.rules ?? []),
      JSON.stringify(args.toolsConfig ?? []),
      JSON.stringify(args.limitsConfig ?? []),
    ],
  );
}

export async function seedForm(args: {
  workspaceId: string;
  name?: string;
  archivedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into form (id, workspace_id, name, archived_at) values ($1, $2, $3, $4)`,
    [
      id,
      args.workspaceId,
      args.name ?? `Form ${randomUUID().slice(0, 8)}`,
      args.archivedAt ?? null,
    ],
  );
  return id;
}

export async function seedFormVersion(args: {
  workspaceId: string;
  formId: string;
  version?: number;
  fields?: unknown[];
  publishedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into form_version (id, workspace_id, form_id, version, fields, published_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      id,
      args.workspaceId,
      args.formId,
      args.version ?? 1,
      JSON.stringify(args.fields ?? []),
      args.publishedAt ?? null,
    ],
  );
  return id;
}

export async function seedFormSubmission(args: {
  workspaceId: string;
  conversationId: string;
  formId: string;
  formVersion?: number;
  status?: 'in_progress' | 'completed' | 'partial' | 'skipped';
  startedAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into form_submission (id, workspace_id, conversation_id, form_id, form_version, status, started_at)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, now()))`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.formId,
      args.formVersion ?? 1,
      args.status ?? 'in_progress',
      args.startedAt ?? null,
    ],
  );
  return id;
}

export async function seedFormAnswer(args: {
  workspaceId: string;
  formSubmissionId: string;
  fieldKey: string;
  fieldType?: string;
  value?: unknown;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into form_answer (id, workspace_id, form_submission_id, field_key, field_type, value, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, coalesce($7, now()))`,
    [
      id,
      args.workspaceId,
      args.formSubmissionId,
      args.fieldKey,
      args.fieldType ?? 'short_text',
      JSON.stringify(args.value ?? 'answer'),
      args.createdAt ?? null,
    ],
  );
  return id;
}

export async function seedResolutionCycle(args: {
  workspaceId: string;
  conversationId: string;
  cycleNo?: number;
  openedAt?: Date;
  inactivityDueAt?: Date | null;
  resolvedAt?: Date | null;
  resolutionKind?: 'bot' | 'agent' | 'player_confirmed' | 'timed_out' | null;
  closedAt?: Date | null;
  supportOwedFlag?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into resolution_cycle
       (id, workspace_id, conversation_id, cycle_no, opened_at, inactivity_due_at,
        resolved_at, resolution_kind, closed_at, support_owed_flag)
     values ($1, $2, $3, $4, coalesce($5, now()), $6, $7, $8, $9, $10)`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.cycleNo ?? 1,
      args.openedAt ?? null,
      args.inactivityDueAt ?? null,
      args.resolvedAt ?? null,
      args.resolutionKind ?? null,
      args.closedAt ?? null,
      args.supportOwedFlag ?? false,
    ],
  );
  return id;
}
