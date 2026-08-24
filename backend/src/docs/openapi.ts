import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  FormAnswerBody,
  FormTerminateBody,
  NewTicketBody,
  ResolutionAnswerBody,
} from '@support/types';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// Schema definitions
const PlayerTokenRequestSchema = z.object({
  external_player_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .openapi({ example: 'test-player-1', description: 'Game external player identifier' }),
});

const SessionStartBodySchema = z.object({
  session_id: z.uuid().openapi({ example: '9a40fd09-f71d-4f4f-a909-8562c564b1ca' }),
  entry_point: z.string().min(1).max(120).openapi({ example: 'settings_menu' }),
  started_at: z.string().optional().openapi({ example: '2026-08-06T04:59:35.742Z' }),
  snapshot: z
    .record(z.string(), z.unknown())
    .optional()
    .openapi({ description: 'Captured Player State Snapshot' }),
});

const SessionEndBodySchema = z.object({
  session_id: z.uuid().openapi({ example: '9a40fd09-f71d-4f4f-a909-8562c564b1ca' }),
  duration_ms: z.number().int().nonnegative().nullable().openapi({ example: 184200 }),
  conversation_created: z.boolean().nullable().openapi({ example: false }),
  articles_read: z.array(z.string().max(200)).openapi({ example: ['a_123', 'a_456'] }),
});

const IncidentBodySchema = z.object({
  incident_id: z.uuid().nullable().openapi({ example: 'c7a20fd0-f71d-4f4f-a909-8562c564b1ca' }),
  session_id: z.uuid().nullable().openapi({ example: '9a40fd09-f71d-4f4f-a909-8562c564b1ca' }),
  kind: z.string().min(1).max(120).openapi({ example: 'token_timeout' }),
  detail: z.string().openapi({ example: '5s elapsed, no response' }),
  sdk_version: z.string().max(60).optional().openapi({ example: '1.0.0' }),
  client_version: z.string().max(60).optional().openapi({ example: '0.1.0' }),
});

const AgentMessageViewSchema = z.object({
  id: z.uuid(),
  seq: z.number().int().nonnegative(),
  author_type: z.enum(['player', 'agent', 'bot', 'system']),
  author_agent_id: z.uuid().nullable(),
  author_name: z.string().openapi({
    description:
      'Per-message author display name; resolved from author_agent_id, never the conversation assignee.',
  }),
  body: z.string(),
  visibility: z.enum(['public', 'internal']),
  delivery_state: z.enum(['sending', 'sent', 'delivered', 'read', 'failed']),
  read_at: z.string().nullable(),
  created_at: z.string(),
  article_id: z.uuid().nullable().openapi({
    description:
      'The article a bot answer was written from, or null. Clients render their own "Read more" from it.',
  }),
});

// Register Component Schemas
const playerTokenRequestComponent = registry.register(
  'PlayerTokenRequest',
  PlayerTokenRequestSchema,
);
const sessionStartBodyComponent = registry.register('SessionStartBody', SessionStartBodySchema);
const sessionEndBodyComponent = registry.register('SessionEndBody', SessionEndBodySchema);
const incidentBodyComponent = registry.register('IncidentBody', IncidentBodySchema);

// Define Security Schemes
const bearerWorkspaceSecret = registry.registerComponent('securitySchemes', 'WorkspaceSecretAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'Game Backend Workspace Secret (sk_<slug>.<raw>)',
});

const bearerPlayerJwt = registry.registerComponent('securitySchemes', 'PlayerJwtAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Short-lived Player JWT (15-min TTL)',
});

const bearerAgentJwt = registry.registerComponent('securitySchemes', 'AgentJwtAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Agent Session JWT',
});

// Header Schemas
const SdkHeadersSchema = z.object({
  'x-support-workspace': z
    .string()
    .openapi({ description: 'Workspace slug', example: 'demo-workspace' }),
  'x-support-sdk': z.string().optional().openapi({ description: 'SDK Version', example: '1.0.0' }),
  'x-support-client-version': z
    .string()
    .optional()
    .openapi({ description: 'Game Version', example: '0.1.0' }),
  'idempotency-key': z.string().optional().openapi({ description: 'Idempotency UUID' }),
});

// Admin Schemas
const WorkspaceSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  member_count: z.number().int().nonnegative(),
  created_at: z.string(),
});

const CreateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(200).openapi({ example: 'My New Game' }),
  slug: z.string().min(1).max(63).openapi({ example: 'my-new-game' }),
});

const RenameWorkspaceBodySchema = z.object({ name: z.string().min(1).max(200) });

const MemberSummarySchema = z.object({
  agent_id: z.uuid(),
  email: z.string(),
  display_name: z.string(),
  status: z.enum(['active', 'on_leave', 'deactivated', 'invited']),
  role: z.enum(['agent', 'team_lead']),
});

const AddMemberBodySchema = z.object({
  email: z.email().openapi({ example: 'new-hire@mindstormstudios.com' }),
  role: z.enum(['agent', 'team_lead']),
});

const UpdateMemberBodySchema = z.object({
  role: z.enum(['agent', 'team_lead']).optional(),
  remove: z.boolean().optional(),
});

const SecretMetadataSchema = z.object({
  created_at: z.string(),
  expires_at: z.string().nullable(),
});

const RotatedSecretSchema = z.object({
  secret: z.string().openapi({ description: 'Raw secret — shown exactly once.' }),
  created_at: z.string(),
});

const AgentSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  display_name: z.string(),
  status: z.enum(['active', 'on_leave', 'deactivated', 'invited']),
  is_admin: z.boolean(),
  is_super_admin: z.boolean(),
});

const bearerAgentSession = registry.registerComponent('securitySchemes', 'AgentSessionAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Agent session JWT — the caller must additionally have agent.is_admin = true for every /admin/* route.',
});

// --- 1. AUTH ROUTES ---
registry.registerPath({
  method: 'post',
  path: '/auth/player-token',
  summary: 'Mint Short-Lived Player JWT',
  description: 'Called server-to-server by the Game Backend using the workspace secret.',
  security: [{ [bearerWorkspaceSecret.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: playerTokenRequestComponent,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Player JWT issued successfully',
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            expires_in: z.number().openapi({ example: 900 }),
          }),
        },
      },
    },
    401: { description: 'Unauthorized — invalid or missing workspace secret' },
    404: { description: 'Workspace not found' },
    422: { description: 'Malformed external_player_id' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/dev-agents',
  summary: 'List Dev Agents (Dev Mode Only)',
  description: 'Returns available dev agents for local testing.',
  responses: {
    200: {
      description: 'List of agents',
      content: {
        'application/json': {
          schema: z.object({
            agents: z.array(
              z.object({
                id: z.string(),
                email: z.string(),
                display_name: z.string(),
              }),
            ),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/auth/dev-login',
  summary: 'Dev Agent Login (Dev Mode Only)',
  description: 'Mints an agent JWT for the selected dev agent.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ agent_id: z.uuid() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Agent token response',
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            agent: z.object({ id: z.string(), display_name: z.string() }),
            workspace: z.object({ id: z.string(), slug: z.string() }),
          }),
        },
      },
    },
  },
});

// --- 2. SDK ENDPOINTS ---
registry.registerPath({
  method: 'post',
  path: '/sdk/sessions/start',
  summary: 'SDK Session Start (Outbox)',
  description: 'Ingests SDK session start payload and player state snapshot.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    headers: SdkHeadersSchema,
    body: {
      content: {
        'application/json': {
          schema: sessionStartBodyComponent,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Session recorded',
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
    },
    401: { description: 'Unauthorized — invalid player token' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/sdk/sessions/end',
  summary: 'SDK Session End (Outbox)',
  description: 'Records SDK session duration and articles read.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    headers: SdkHeadersSchema,
    body: {
      content: {
        'application/json': {
          schema: sessionEndBodyComponent,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Session ended recorded',
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/sdk/incidents',
  summary: 'SDK Incident Report (Outbox)',
  description: 'Appends an incident event for triage.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    headers: SdkHeadersSchema,
    body: {
      content: {
        'application/json': {
          schema: incidentBodyComponent,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Incident recorded',
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/sdk/unread',
  summary: 'SDK Unread Poll',
  description: 'Returns the count of unread public messages for the player.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    headers: SdkHeadersSchema,
  },
  responses: {
    200: {
      description: 'Unread message count',
      content: {
        'application/json': {
          schema: z.object({ unread_count: z.number() }),
        },
      },
    },
  },
});

// --- 3. SURFACE ENDPOINTS (WebView) ---
registry.registerPath({
  method: 'get',
  path: '/surface/bootstrap',
  summary: 'Surface Bootstrap',
  description: 'Returns session, player info, and snapshot state for WebView launch.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    query: z.object({ session_id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Bootstrap data',
      content: {
        'application/json': {
          schema: z.object({
            workspace: z.object({ name: z.string() }),
            session: z.object({
              id: z.string(),
              entry_point: z.string(),
              started_at: z.string(),
              ended_at: z.string().nullable(),
            }),
            player: z.object({ external_player_id: z.string() }),
            player_state: z.object({
              availability: z.enum(['ok', 'degraded', 'missing', 'absent']),
              captured_at: z.string().nullable(),
              degraded_reason: z.string().nullable(),
              declared: z.record(z.string(), z.unknown()),
              raw: z.record(z.string(), z.unknown()).optional(),
            }),
            unread_count: z.number(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/surface/conversations/active',
  summary: 'Get Player Active Conversation',
  description: 'Returns active conversation and messages for player.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    query: z.object({ session_id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Active conversation or null',
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/conversations',
  summary: 'Create Player Conversation',
  description: 'Creates a new support conversation linked to the session.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ session_id: z.uuid() }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Conversation created' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/conversations/{id}/messages',
  summary: 'Send Player Message',
  description: 'Sends a player chat message.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ body: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Message sent' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/surface/messages',
  summary: 'Get Player Messages',
  description:
    "Returns the player's thread. `session_id` is validated but not used to resolve the thread — the conversation comes from the token's player under RLS.",
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    query: z.object({ session_id: z.uuid() }),
  },
  responses: {
    200: { description: 'Player thread (conversation_id is null when none exists yet)' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/messages',
  summary: 'Send Player Message',
  description:
    'Sends a player chat message. `session_id` is optional and best-effort: it is verified against the caller and used to attribute the resulting events, and is ignored when it cannot be verified.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ body: z.string().min(1).max(4000), session_id: z.uuid().optional() }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Message sent' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/messages/read',
  summary: 'Mark Player Messages Read',
  description: 'Marks non-player messages as read up to the given sequence number.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ up_to_seq: z.number().int().nonnegative() }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Marked read' },
  },
});

// --- 4. AGENT ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/agent/agents',
  summary: 'List agents',
  description: 'Lists all agents in the workspace.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: { description: 'Agents list' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/conversations',
  summary: 'Agent List Conversations',
  description: 'Lists open/unassigned conversations for the agent.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    query: z.object({
      status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling', 'escalated']),
      priority: z
        .union([z.enum(['p1', 'p2', 'p3', 'p4']), z.array(z.enum(['p1', 'p2', 'p3', 'p4']))])
        .optional(),
      labelIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
      subintentIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
      assigneeIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
      olderThanHours: z.coerce.number().optional(),
      q: z.string().optional(),
    }),
  },
  responses: {
    200: { description: 'Conversations list' },
  },
});

const AgentWorkspaceWorkloadSchema = z.object({
  agents: z.array(
    z.object({
      agentId: z.uuid(),
      agentName: z.string(),
      openCount: z.number().int(),
      resolved7d: z.number().int(),
      status: z.enum(['online', 'away', 'offline', 'on_leave']).openapi({
        description:
          'on_leave overrides live presence unconditionally; otherwise online/away from Redis while connected, offline otherwise (including when Redis is unreachable).',
      }),
      onLeaveSince: z.iso.datetime().nullable(),
      onLeaveUntil: z.iso.datetime().nullable().openapi({
        description:
          'Planned return date, if a duration was set. Null = indefinite. Not auto-enforced.',
      }),
    }),
  ),
});

const PresenceStatusBodySchema = z.object({ status: z.enum(['online', 'away']) });

registry.registerPath({
  method: 'get',
  path: '/agent/workload',
  summary: 'Agent Workspace Workload',
  description:
    'Per-agent open ticket counts and 7-day resolved counts for every active agent/team lead in the workspace. Team lead or admin role required.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Workspace workload by agent',
      content: { 'application/json': { schema: AgentWorkspaceWorkloadSchema } },
    },
    403: { description: 'Forbidden — team lead or admin role required' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/presence',
  summary: 'Agent Set Own Presence',
  description:
    "Sets the caller's live presence to online or away. Self only. Requires the connection counter to be > 0 (there must be an open socket) — 409 if fully disconnected. Emits presence_changed to the calling agent's workspace inbox room.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: { content: { 'application/json': { schema: PresenceStatusBodySchema } } },
  },
  responses: {
    200: {
      description: 'Presence set',
      content: { 'application/json': { schema: PresenceStatusBodySchema } },
    },
    400: { description: "Unrecognized status — must be 'online' or 'away'" },
    409: { description: 'No open socket (connection counter is 0)' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/presence',
  summary: 'Agent Get Own Presence',
  description:
    'Returns the live presence for the calling agent — online/away/offline, read from Redis. Does not fold in on_leave, which is a display-layer concern applied by /agent/workload instead.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Current presence',
      content: {
        'application/json': {
          schema: z.object({ status: z.enum(['online', 'away', 'offline']) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/agents/{agentId}/leave',
  summary: 'Set Agent Leave Status',
  description:
    "Team lead/admin toggle of the on_leave account flag for another agent in the workspace. Restricted to the active <-> on_leave transition; 409 if the target is deactivated or invited. Emits presence_changed with the resulting display status (on_leave, or the target's live presence if leave is cleared). Also writes a change_log audit row (entity_type 'agent') for status/on_leave_since/on_leave_until.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ agentId: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            onLeave: z.boolean(),
            days: z.number().int().positive().optional().openapi({
              description:
                'Only meaningful when onLeave is true. Sets a planned return date; omitted = indefinite.',
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Leave status updated',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['online', 'away', 'offline', 'on_leave']),
            onLeaveSince: z.iso.datetime().nullable(),
            onLeaveUntil: z.iso.datetime().nullable(),
          }),
        },
      },
    },
    403: { description: 'Forbidden — team lead or admin role required' },
    404: { description: 'Agent not found in this workspace' },
    409: { description: 'Agent is deactivated or invited; leave status cannot be changed' },
  },
});

const AgentSubintentSchema = z
  .object({ intent_name: z.string(), subintent_name: z.string() })
  .nullable();

const AgentConversationDetailSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  player: z.object({ id: z.uuid(), external_player_id: z.string() }),
  status: z.enum([
    'new',
    'bot_active',
    'open',
    'awaiting_player',
    'escalated',
    'resolved',
    'closed',
  ]),
  subintent: AgentSubintentSchema,
  assigned_agent: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
  resolution_source: z.enum(['bot', 'agent']).nullable(),
  resolved_by_agent_name: z.string().nullable(),
  created_at: z.string(),
});

registry.registerPath({
  method: 'get',
  path: '/agent/conversations/{id}',
  summary: 'Agent Get Conversation',
  description:
    'One conversation header row by id. Serves tickets that are in neither the unassigned nor the mine list — resolved, or owned by another agent — which the inbox lists can never supply.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Conversation header',
      content: { 'application/json': { schema: AgentConversationDetailSchema } },
    },
    404: { description: 'Not found, or not in this workspace' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/take-over',
  summary: 'Agent Take Over Bot Conversation',
  description:
    'Atomically assigns a bot_active conversation to the acting agent and transitions it to open.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Take-over result',
      content: { 'application/json': { schema: z.object({ taken_over: z.boolean() }) } },
    },
  },
});

const AgentPlayerStateSchema = z.union([
  z.object({ status: z.literal('no_session') }),
  z.object({ status: z.literal('not_captured') }),
  z.object({ status: z.literal('missing') }),
  z.object({
    status: z.literal('captured'),
    declared: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(['string', 'number', 'boolean', 'timestamp']),
        value: z.unknown(),
      }),
    ),
    raw: z.record(z.string(), z.unknown()),
    degraded_reason: z.string().nullable(),
    captured_at: z.string(),
  }),
]);

const AgentTicketSummarySchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  created_at: z.string(),
  status: z.enum([
    'new',
    'bot_active',
    'open',
    'awaiting_player',
    'escalated',
    'resolved',
    'closed',
  ]),
  subintent: AgentSubintentSchema,
  resolution_source: z.enum(['bot', 'agent']).nullable(),
  resolved_by_agent_name: z.string().nullable(),
  reopen_count: z.number().int(),
});

const FormFieldTypeSchema = z.enum([
  'short_text',
  'long_text',
  'number',
  'date',
  'time',
  'choice',
  'attachment',
]);

const AgentFormViewSchema = z.object({
  form_name: z.string(),
  form_version: z.number().int(),
  status: z.enum(['in_progress', 'completed', 'partial', 'skipped']),
  field_count: z.number().int(),
  answered_count: z.number().int(),
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      position: z.number().int(),
      field_type: FormFieldTypeSchema,
      value: z.unknown(),
      answered: z.boolean(),
    }),
  ),
});

registry.registerPath({
  method: 'get',
  path: '/agent/conversations/{id}/context',
  summary: 'Agent Conversation Context',
  description:
    "The context rail in one payload: the player-state snapshot captured when this ticket was raised, the player's other tickets in this workspace (newest first, capped at 20), and totals. All four player_state cases return 200 — missing player state is a state, not an error. `raw` is PII and is returned in full, uncollapsed by the API. Plus `form`: the form the player was asked before handoff, or null when the subintent had none. Labels resolve against the submission's snapshotted form_version, never the current one; values carry the answer's own snapshotted field_type. Unanswered fields are present as rows with `answered: false` — a gap is a row, never an omission.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Context rail payload',
      content: {
        'application/json': {
          schema: z.object({
            player_state: AgentPlayerStateSchema,
            tickets: z.array(AgentTicketSummarySchema),
            summary: z.object({
              total_tickets: z.number().int(),
              total_reopened: z.number().int(),
              first_contact_at: z.string(),
            }),
            form: AgentFormViewSchema.nullable(),
          }),
        },
      },
    },
    404: { description: 'Not found, or not in this workspace' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/claim',
  summary: 'Agent Claim Conversation',
  description: 'Claims an unassigned conversation for the current agent.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Claim result',
      content: {
        'application/json': {
          schema: z.object({ claimed: z.boolean() }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/conversations/{id}/assign',
  summary: 'Agent Reassign Conversation',
  description:
    'Reassigns an active conversation to a different agent. Team lead or admin role required.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ agentId: z.uuid() }) } } },
  },
  responses: {
    200: {
      description: 'Reassign result',
      content: {
        'application/json': {
          schema: z.object({ reassigned: z.boolean() }),
        },
      },
    },
    403: { description: 'Forbidden — team lead or admin role required' },
    404: { description: 'Conversation not found or target agent not found' },
    409: { description: 'Conversation status invalid or target agent not active' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/conversations/{id}/subintent',
  summary: 'Agent Reclassify Conversation',
  description: 'Reclassifies a conversation to a different subintent.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ subintentId: z.uuid() }) } } },
  },
  responses: {
    200: {
      description: 'Reclassify result',
      content: {
        'application/json': {
          schema: z.object({ reclassified: z.boolean() }),
        },
      },
    },
    404: { description: 'Conversation not found' },
    409: { description: 'Target subintent does not exist or is archived' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/ask-resolved',
  summary: 'Agent Ask If Resolved',
  description:
    'Asks the player "Did this solve it?" and sets confirm_phase = agent_ask. Requires status open or awaiting_player, confirm_phase none, and either ownership or an unassigned conversation. There is no agent-side resolve: only the player\'s answer moves the status. The inactivity clock sets confirm_phase = inactivity_ask on the same conversation shape after 24h of silence; the two are distinguished so the resolution can be attributed to `agent` or `player_confirmed`.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Asked',
      content: { 'application/json': { schema: z.object({ asked: z.boolean() }) } },
    },
    403: { description: 'Another agent owns this conversation' },
    404: { description: 'Conversation not found' },
    409: { description: 'Wrong status, or a check is already pending' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/escalate',
  summary: 'Agent Escalate Conversation',
  description:
    'Moves status from open or awaiting_player to escalated. A direct status flip, not a message side effect. Does not change assigned_agent_id — the agent keeps the conversation, only its status changes. Requires either ownership or an unassigned conversation.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Escalated',
      content: { 'application/json': { schema: z.object({ escalated: z.boolean() }) } },
    },
    403: { description: 'Another agent owns this conversation' },
    404: { description: 'Conversation not found' },
    409: { description: 'Wrong status' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/unescalate',
  summary: 'Agent Unescalate Conversation',
  description:
    'Moves status from escalated back to open. Requires either ownership or an unassigned conversation.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Unescalated',
      content: { 'application/json': { schema: z.object({ unescalated: z.boolean() }) } },
    },
    403: { description: 'Another agent owns this conversation' },
    404: { description: 'Conversation not found' },
    409: { description: 'Wrong status' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/conversations/{id}/messages',
  summary: 'Agent Get Conversation Messages',
  description: 'Retrieves all messages (public and internal) for a conversation.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Messages list',
      content: {
        'application/json': { schema: z.object({ messages: z.array(AgentMessageViewSchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/messages',
  summary: 'Agent Send Reply or Internal Note',
  description: 'Sends an agent reply (visibility: public) or internal note (visibility: internal).',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            body: z.string().min(1),
            visibility: z.enum(['public', 'internal']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Agent message or internal note sent' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/messages/read',
  summary: 'Agent Mark Messages Read',
  description: 'Marks messages as read up to the given sequence number.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            conversation_id: z.uuid(),
            up_to_seq: z.number().int().nonnegative(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Messages marked read' },
  },
});

// --- 5. AGENT TAXONOMY & ARTICLE ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/agent/intents',
  summary: 'Agent List Intents',
  description: 'Lists intents with nested subintents, for the category picker.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Intents list' } },
});

registry.registerPath({
  method: 'post',
  path: '/agent/intents',
  summary: 'Agent Create Intent',
  description: 'Creates an intent inline. Admin-only, enforced server-side.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } },
    },
  },
  responses: {
    201: { description: 'Intent created' },
    403: { description: 'Forbidden — admin role required' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/intents/{id}/subintents',
  summary: 'Agent Create Subintent',
  description: 'Creates a subintent under an intent. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } },
    },
  },
  responses: {
    201: { description: 'Subintent created' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Intent not found' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/intents/{id}',
  summary: 'Agent Rename Intent',
  description: 'Renames an intent. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } },
    },
  },
  responses: {
    200: { description: 'Intent renamed' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Intent not found' },
    409: { description: 'Another intent already has this name' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/intents/{id}/archive',
  summary: 'Agent Archive Intent',
  description:
    'Archives an intent. Admin-only. Blocked while active subintents or published articles reference it.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Intent archived' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Intent not found' },
    409: { description: 'Not archivable — is the system intent, or still referenced' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/subintents/{id}',
  summary: 'Agent Rename/Reprioritize Subintent',
  description: 'Renames a subintent and/or sets its default priority. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(120).optional(),
            defaultPriority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Subintent updated' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent not found' },
    409: { description: 'Another subintent under this intent already has this name' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/subintents/{id}/archive',
  summary: 'Agent Archive Subintent',
  description:
    'Archives a subintent. Admin-only. The workspace’s "Other" subintent can never be archived.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Subintent archived' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent not found' },
    409: { description: 'Not archivable — this is the "Other" subintent' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/subintents/{id}/move',
  summary: 'Agent Move Subintent',
  description: 'Moves a subintent to a different intent. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ intentId: z.uuid() }) } } },
  },
  responses: {
    200: { description: 'Subintent moved' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent or target intent not found (or target is archived)' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/subintents/{id}/merge',
  summary: 'Agent Merge Subintent',
  description:
    'Reassigns every conversation on the loser subintent to the survivor, then archives the loser with mergedIntoId set. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ intoId: z.uuid() }) } } },
  },
  responses: {
    200: { description: 'Subintent merged and archived' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Subintent not found' },
    409: { description: 'Invalid merge target, or loser is the "Other" subintent' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/tags',
  summary: 'Agent List Tags',
  description:
    'Searches active (non-archived) workspace tags by normalizedName prefix. Empty query returns all, alphabetical.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { query: z.object({ query: z.string().optional() }) },
  responses: { 200: { description: 'Tags list' } },
});

registry.registerPath({
  method: 'post',
  path: '/agent/tags',
  summary: 'Agent Create Tag',
  description:
    'Normalizes name and creates a tag. Idempotent: returns the existing active tag if one matches, or un-archives and returns a matching archived tag.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } },
    },
  },
  responses: {
    200: { description: 'Existing tag returned (reuse or revival), no-op create' },
    201: { description: 'Tag created' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/tags/{id}',
  summary: 'Agent Rename Tag',
  description: 'Renames a tag.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } },
    },
  },
  responses: {
    200: { description: 'Tag renamed' },
    404: { description: 'Tag not found' },
    409: { description: 'Another active tag already has this name' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/tags/{id}/archive',
  summary: 'Agent Archive Tag',
  description:
    'Archives a tag. No preconditions — a tag can be archived while still attached to conversations.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Tag archived' },
    404: { description: 'Tag not found' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/tags',
  summary: 'Agent Attach Tag',
  description:
    'Attaches a tag to a conversation. Idempotent. tagId is confirmed visible in-workspace before use.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ tagId: z.uuid() }) } } },
  },
  responses: {
    200: { description: 'Tag attached' },
    404: { description: 'Tag not found in this workspace' },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/agent/conversations/{id}/tags/{tagId}',
  summary: 'Agent Detach Tag',
  description:
    'Detaches a tag from a conversation (soft removal). No-op if not currently attached.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid(), tagId: z.uuid() }) },
  responses: { 200: { description: 'Tag detached (or was already detached)' } },
});

registry.registerPath({
  method: 'get',
  path: '/agent/articles',
  summary: 'Agent List Articles',
  description: 'Lists articles in all states for this workspace.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Articles list' } },
});

registry.registerPath({
  method: 'get',
  path: '/agent/articles/{id}',
  summary: 'Agent Get Article',
  description: 'Fetches one article for editing.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article detail' }, 404: { description: 'Not found' } },
});

registry.registerPath({
  method: 'post',
  path: '/agent/articles',
  summary: 'Agent Create Article',
  description: 'Creates a draft article.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).max(200),
            body: z.string().min(1),
            keywords: z.array(z.string()).optional(),
            intent_id: z.uuid().optional(),
          }),
        },
      },
    },
  },
  responses: { 201: { description: 'Draft created' }, 404: { description: 'Intent not found' } },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/articles/{id}',
  summary: 'Agent Update Article',
  description: 'Edits title/body/keywords/intent while in draft.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).max(200).optional(),
            body: z.string().min(1).optional(),
            keywords: z.array(z.string()).optional(),
            intent_id: z.uuid().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Article updated' },
    404: { description: 'Not found' },
    409: { description: 'Article is not a draft' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/publish',
  summary: 'Agent Publish Article',
  description: 'draft -> published, stamps published_by/published_at.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Article published' },
    404: { description: 'Not found' },
    409: { description: 'Not a draft, or title/body empty' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/archive',
  summary: 'Agent Archive Article',
  description: 'Any state -> archived. No delete route exists.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article archived' }, 404: { description: 'Not found' } },
});

// --- 5b. AGENT FORMS ENDPOINTS ---
// PATCH routes from the design doc fall back to POST-with-verb-suffix here:
// app.ts's CORS allows only GET and POST (see botConfigRouter's own note).
const FormFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: z.enum(['short_text', 'long_text', 'number', 'date', 'choice']),
  isRequired: z.boolean(),
  position: z.number().int().nonnegative(),
  options: z.array(z.string().min(1)).min(2).optional(),
  placeholder: z.string().min(1).max(200).optional(),
  helperText: z.string().min(1).max(300).optional(),
});

registry.registerPath({
  method: 'get',
  path: '/agent/forms',
  summary: 'Agent List Forms',
  description:
    'Lists all forms in the workspace with mapping/publish/draft status. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Forms list' }, 403: { description: 'Forbidden' } },
});

registry.registerPath({
  method: 'post',
  path: '/agent/forms',
  summary: 'Agent Create Form',
  description: 'Creates a form and its v1 empty draft. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(200) }) } },
    },
  },
  responses: { 201: { description: 'Form created' }, 403: { description: 'Forbidden' } },
});

registry.registerPath({
  method: 'get',
  path: '/agent/forms/{id}',
  summary: 'Agent Get Form',
  description:
    'Fetches one form: draft fields, published fields, and mapped subintents. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Form detail' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/forms/{id}',
  summary: 'Agent Update Form',
  description:
    'Edits name and/or fields. Editing a draft edits it in place; editing a published form auto-forks a new draft version. Rejects attachment/time field types. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().min(1).max(200).optional(),
            fields: z.array(FormFieldSchema).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Form updated' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
    422: { description: 'Invalid fields, or attachment/time field type used' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/forms/{id}/publish',
  summary: 'Agent Publish Form',
  description:
    'Publishes the current draft; rejects if there is no draft or the draft is empty. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Form published' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Not found' },
    409: { description: 'No draft, or draft has zero fields' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/forms/{id}/archive',
  summary: 'Agent Archive Form',
  description:
    'Archives a form. Idempotent — archiving twice succeeds. No cascade to mapped subintents. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Form archived' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/forms/{id}/subintents',
  summary: 'Agent Set Form Subintents',
  description:
    'Full set-replacement of which subintents map to this form. Client-supplied ids are verified in-workspace and non-archived first. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ subintentIds: z.array(z.uuid()) }) } },
    },
  },
  responses: {
    200: { description: 'Mapping replaced' },
    403: { description: 'Forbidden' },
    404: { description: 'Not found' },
    422: { description: 'One or more subintent ids are unknown, archived, or cross-workspace' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/bot-config',
  summary: 'Agent Get Bot Config',
  description:
    'The resolved bot config for this workspace: is_provisioned, prompt, the toggleable rules catalog (with derived enforcement), tools_config, enabled_tools, limits_config, resolved_limits, the joined system_prompt, and which fields are customised relative to the catalog baseline. An absent row resolves to the off state on the catalog baseline. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: { description: 'Resolved bot config' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/bot-config',
  summary: 'Agent Save Bot Config',
  description:
    'Partial upsert of this workspace bot config, audited field-by-field into change_log in the same transaction. An omitted key is left alone; an explicit null on prompt, rules, tools_config or limits_config resets it to the catalog baseline. Locked rules cannot be disabled or removed, every builtin rule key must be present, at least one rule must stay enabled, tools_config must name every catalog tool, and limits_config must name every catalog limit with a value inside its min/max bound. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            is_provisioned: z.boolean().optional().openapi({ example: true }),
            prompt: z
              .string()
              .nullable()
              .optional()
              .openapi({ example: 'You are the first-line support assistant…' }),
            rules: z
              .array(
                z.object({
                  key: z.string(),
                  text: z.string(),
                  enabled: z.boolean(),
                  locked: z.boolean(),
                  source: z.enum(['builtin', 'custom']),
                }),
              )
              .nullable()
              .optional(),
            tools_config: z
              .array(z.object({ tool: z.string(), enabled: z.boolean() }))
              .nullable()
              .optional(),
            limits_config: z
              .array(z.object({ key: z.string(), value: z.number().int().positive() }))
              .nullable()
              .optional()
              .openapi({
                example: [
                  { key: 'max_bot_messages', value: 8 },
                  { key: 'max_tool_calls_per_turn', value: 6 },
                  { key: 'max_articles_per_turn', value: 3 },
                  { key: 'max_unhelped_replies', value: 3 },
                ],
              }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Resolved bot config after the save' },
    403: { description: 'Forbidden — admin role required' },
    422: {
      description:
        'Nothing to change, an unknown field, an empty prompt, or an invalid rules/tools_config/limits_config payload',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/workspace-settings',
  summary: 'Agent Get Workspace Settings',
  description:
    'Per-workspace ticket-handling settings: max_assigned_tickets (assignOnHandoff cap), auto_close_days, inactivity_window_hours, form_timeout_minutes. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: { description: 'Current workspace settings' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/workspace-settings',
  summary: 'Agent Save Workspace Settings',
  description: 'Replaces all four workspace settings at once. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            max_assigned_tickets: z.number().int().min(1).max(100).openapi({ example: 5 }),
            auto_close_days: z.number().int().min(1).max(365).openapi({ example: 7 }),
            inactivity_window_hours: z.number().int().min(1).max(720).openapi({ example: 24 }),
            form_timeout_minutes: z.number().int().min(1).max(1440).openapi({ example: 30 }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Workspace settings after the save' },
    403: { description: 'Forbidden — admin role required' },
    422: { description: 'A field is missing or outside its allowed bounds' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/bot-config/history',
  summary: 'Agent Get Bot Config Audit Trail',
  description:
    'This workspace bot-config change_log rows, newest first, cursor-paged, optionally filtered to one field. `field` on the query string narrows the page; `field` on each entry is the database column name. `before_value` null means the field had no value before; `after_value` null means it was reset to the catalog baseline. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional().openapi({ example: 50 }),
      cursor: z
        .string()
        .optional()
        .openapi({ description: 'Opaque next_cursor from the previous page' }),
      field: z
        .enum(['prompt', 'rules', 'tools_config', 'limits_config', 'is_provisioned'])
        .optional(),
    }),
  },
  responses: {
    200: { description: 'Audit trail page' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
    422: { description: 'Invalid limit, cursor or field' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/agent/bot-config/rollback',
  summary: 'Agent Rollback Bot Config Field',
  description:
    'Restores a prior change_log value for one field as the new current value. This is itself a new, audited save — history is never mutated. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            field: z.enum(['prompt', 'rules', 'tools_config', 'limits_config']),
            change_log_id: z.string(),
            side: z.enum(['before', 'after']),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Resolved bot config after the rollback' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'No matching change_log entry for this workspace' },
    422: {
      description:
        'change_log_id does not belong to the requested field, or the restored value fails validation',
    },
  },
});

// --- 6. SURFACE ARTICLE ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/surface/articles',
  summary: 'Public List Articles',
  description: 'Lists published articles, optionally filtered by intent or keyword.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: {
    query: z.object({ intentId: z.uuid().optional(), q: z.string().min(1).max(200).optional() }),
  },
  responses: { 200: { description: 'Articles list' } },
});

registry.registerPath({
  method: 'get',
  path: '/surface/articles/{id}',
  summary: 'Public Get Article',
  description: 'Returns a single published article. 404 if draft/archived or wrong workspace.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article detail' }, 404: { description: 'Not found' } },
});

registry.registerPath({
  method: 'get',
  path: '/surface/intents',
  summary: 'Public List Intents',
  description:
    'Lists intents (categories) with at least one published article, alphabetical by name.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  responses: { 200: { description: 'Intents list' } },
});

registry.registerPath({
  method: 'post',
  path: '/surface/resolution-answer',
  summary: 'Player Answer Resolution Check',
  description:
    "The banner's Yes/No, for all three sources. Yes resolves the conversation — source `bot` on bot_article, `agent` on agent_ask, `player_confirmed` on inactivity_ask. No hands off to a human on bot_article, and only clears the phase on agent_ask and inactivity_ask (which restarts the inactivity clock). 409 when no check is pending.",
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: ResolutionAnswerBody } } } },
  responses: {
    200: {
      description: 'Answer applied',
      content: {
        'application/json': { schema: z.object({ confirm_phase: z.string(), status: z.string() }) },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No resolution check pending' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/form/answer',
  summary: 'Player Answer One Form Question',
  description:
    "One question of the pinned form card. No conversation id — the submission is the live one on the player's latest conversation. Answers are append-only: a second answer for the same field_key is a correction, not an update, and the newest wins on read. 409 when no form is pending; 422 for an unknown field, a value of the wrong type, a choice outside its options, or an attachment.",
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: FormAnswerBody } } } },
  responses: {
    200: {
      description: 'Answer accepted',
      content: {
        'application/json': {
          schema: z.object({ ok: z.literal(true), is_correction: z.boolean() }),
        },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No form pending' },
    422: { description: 'Unknown field, invalid value, or unsupported field type' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/form/submit',
  summary: 'Player Submit Form',
  description:
    'Terminates the form and completes the gated handoff: the status is derived from the answer rows (completed / partial / skipped), an agent is assigned, the conversation opens, and a summary card is posted. 409 on an already-terminal submission.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: FormTerminateBody } } } },
  responses: {
    200: {
      description: 'Form terminated and handoff completed',
      content: {
        'application/json': {
          schema: z.object({
            confirm_phase: z.literal('none'),
            status: z.string(),
            form_status: z.string(),
          }),
        },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No form pending' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/form/skip',
  summary: 'Player Skip Form',
  description:
    'The "Skip and talk to an agent" button, present on every question and never removable — nothing about a form may block a player reaching a human. Identical end state to submit; only form_completed.terminated_by differs. Answers given before the skip are kept, so a partly-filled form terminates as partial, not skipped.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: FormTerminateBody } } } },
  responses: {
    200: {
      description: 'Form skipped and handoff completed',
      content: {
        'application/json': {
          schema: z.object({
            confirm_phase: z.literal('none'),
            status: z.string(),
            form_status: z.string(),
          }),
        },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No form pending' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/surface/new-ticket',
  summary: 'Player Open New Ticket',
  description:
    "Closes the player's current conversation for good and opens a fresh one. Only valid when that conversation is already resolved or closed — 409 otherwise, since a player has at most one live conversation at a time. Returns the new conversation, which starts empty.",
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: NewTicketBody } } } },
  responses: {
    201: {
      description: 'New conversation opened',
      content: {
        'application/json': {
          schema: z.object({ conversation_id: z.uuid(), status: z.string(), message: z.null() }),
        },
      },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'The current conversation is still open' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/workspaces',
  summary: 'List All Workspaces',
  security: [{ [bearerAgentSession.name]: [] }],
  responses: {
    200: {
      description: 'Every workspace with its member count',
      content: {
        'application/json': { schema: z.object({ workspaces: z.array(WorkspaceSummarySchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces',
  summary: 'Create Workspace',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { body: { content: { 'application/json': { schema: CreateWorkspaceBodySchema } } } },
  responses: {
    201: {
      description: 'Workspace created',
      content: { 'application/json': { schema: WorkspaceSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/workspaces/{id}',
  summary: 'Rename Workspace',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: RenameWorkspaceBodySchema } } },
  },
  responses: {
    200: {
      description: 'Workspace renamed',
      content: { 'application/json': { schema: WorkspaceSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/workspaces/{id}/members',
  summary: 'List Workspace Members',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Active members',
      content: {
        'application/json': { schema: z.object({ members: z.array(MemberSummarySchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/members',
  summary: 'Grant Workspace Access',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: AddMemberBodySchema } } },
  },
  responses: {
    201: {
      description: 'Member granted',
      content: { 'application/json': { schema: MemberSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/workspaces/{id}/members/{agentId}',
  summary: 'Change Or Remove Member Access',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid(), agentId: z.uuid() }),
    body: { content: { 'application/json': { schema: UpdateMemberBodySchema } } },
  },
  responses: {
    200: {
      description: 'Member updated or removed',
      content: { 'application/json': { schema: MemberSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/workspaces/{id}/secret',
  summary: 'Get Workspace Secret Metadata',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: 'Metadata only — never the raw secret',
      content: {
        'application/json': { schema: z.object({ secrets: z.array(SecretMetadataSchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/admin/workspaces/{id}/secret/rotate',
  summary: 'Rotate Workspace Secret',
  description:
    'The old secret keeps working for a 24h grace window. The raw new secret is returned exactly once, here.',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    201: {
      description: 'New secret minted',
      content: { 'application/json': { schema: RotatedSecretSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/admin/agents',
  summary: 'Agent Directory',
  security: [{ [bearerAgentSession.name]: [] }],
  request: { query: z.object({ q: z.string().optional() }) },
  responses: {
    200: {
      description: 'Every agent, admin flags included',
      content: {
        'application/json': { schema: z.object({ agents: z.array(AgentSummarySchema) }) },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/agents/{id}/admin',
  summary: 'Grant Or Revoke Admin (super admin only)',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ is_admin: z.boolean() }) } } },
  },
  responses: {
    200: {
      description: 'Flag updated',
      content: { 'application/json': { schema: AgentSummarySchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/admin/agents/{id}/super-admin',
  summary: 'Grant Or Revoke Super Admin (super admin only)',
  security: [{ [bearerAgentSession.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: z.object({ is_super_admin: z.boolean() }) } },
    },
  },
  responses: {
    200: {
      description: 'Flag updated',
      content: { 'application/json': { schema: AgentSummarySchema } },
    },
  },
});

// Build Document
const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'Support CRM API',
    version: '1.0.0',
    description: 'Multi-tenant Support CRM REST API (SDK, Web Surface, and Agent Console).',
  },
  servers: [
    {
      url: 'http://localhost:4000',
      description: 'Local Development Server',
    },
  ],
});
