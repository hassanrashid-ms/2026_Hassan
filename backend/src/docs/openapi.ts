import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { NewTicketBody, ResolutionAnswerBody } from '@support/types'

extendZodWithOpenApi(z)

const registry = new OpenAPIRegistry()

// Schema definitions
const PlayerTokenRequestSchema = z.object({
  external_player_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .openapi({ example: 'test-player-1', description: 'Game external player identifier' }),
})

const SessionStartBodySchema = z.object({
  session_id: z.uuid().openapi({ example: '9a40fd09-f71d-4f4f-a909-8562c564b1ca' }),
  entry_point: z.string().min(1).max(120).openapi({ example: 'settings_menu' }),
  started_at: z.string().optional().openapi({ example: '2026-08-06T04:59:35.742Z' }),
  snapshot: z.record(z.string(), z.unknown()).optional().openapi({ description: 'Captured Player State Snapshot' }),
})

const SessionEndBodySchema = z.object({
  session_id: z.uuid().openapi({ example: '9a40fd09-f71d-4f4f-a909-8562c564b1ca' }),
  duration_ms: z.number().int().nonnegative().nullable().openapi({ example: 184200 }),
  conversation_created: z.boolean().nullable().openapi({ example: false }),
  articles_read: z.array(z.string().max(200)).openapi({ example: ['a_123', 'a_456'] }),
})

const IncidentBodySchema = z.object({
  incident_id: z.uuid().nullable().openapi({ example: 'c7a20fd0-f71d-4f4f-a909-8562c564b1ca' }),
  session_id: z.uuid().nullable().openapi({ example: '9a40fd09-f71d-4f4f-a909-8562c564b1ca' }),
  kind: z.string().min(1).max(120).openapi({ example: 'token_timeout' }),
  detail: z.string().openapi({ example: '5s elapsed, no response' }),
  sdk_version: z.string().max(60).optional().openapi({ example: '1.0.0' }),
  client_version: z.string().max(60).optional().openapi({ example: '0.1.0' }),
})

// Register Component Schemas
const playerTokenRequestComponent = registry.register('PlayerTokenRequest', PlayerTokenRequestSchema)
const sessionStartBodyComponent = registry.register('SessionStartBody', SessionStartBodySchema)
const sessionEndBodyComponent = registry.register('SessionEndBody', SessionEndBodySchema)
const incidentBodyComponent = registry.register('IncidentBody', IncidentBodySchema)

// Define Security Schemes
const bearerWorkspaceSecret = registry.registerComponent('securitySchemes', 'WorkspaceSecretAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'Game Backend Workspace Secret (sk_<slug>.<raw>)',
})

const bearerPlayerJwt = registry.registerComponent('securitySchemes', 'PlayerJwtAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Short-lived Player JWT (15-min TTL)',
})

const bearerAgentJwt = registry.registerComponent('securitySchemes', 'AgentJwtAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Agent Session JWT',
})

// Header Schemas
const SdkHeadersSchema = z.object({
  'x-support-workspace': z.string().openapi({ description: 'Workspace slug', example: 'demo-workspace' }),
  'x-support-sdk': z.string().optional().openapi({ description: 'SDK Version', example: '1.0.0' }),
  'x-support-client-version': z.string().optional().openapi({ description: 'Game Version', example: '0.1.0' }),
  'idempotency-key': z.string().optional().openapi({ description: 'Idempotency UUID' }),
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

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
})

// --- 4. AGENT ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/agent/conversations',
  summary: 'Agent List Conversations',
  description: 'Lists open/unassigned conversations for the agent.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    query: z.object({ status: z.enum(['unassigned', 'mine', 'all']).optional() }),
  },
  responses: {
    200: { description: 'Conversations list' },
  },
})

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
})

registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/ask-resolved',
  summary: 'Agent Ask If Resolved',
  description:
    'Asks the player "Did this solve it?" and sets confirm_phase = agent_ask. Requires status open or awaiting_player, confirm_phase none, and either ownership or an unassigned conversation. There is no agent-side resolve: only the player\'s answer moves the status.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Asked', content: { 'application/json': { schema: z.object({ asked: z.boolean() }) } } },
    403: { description: 'Another agent owns this conversation' },
    404: { description: 'Conversation not found' },
    409: { description: 'Wrong status, or a check is already pending' },
  },
})

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
    200: { description: 'Messages list' },
  },
})

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
})

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
})

// --- 5. AGENT TAXONOMY & ARTICLE ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/agent/intents',
  summary: 'Agent List Intents',
  description: 'Lists intents with nested subintents, for the category picker.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Intents list' } },
})

registry.registerPath({
  method: 'post',
  path: '/agent/intents',
  summary: 'Agent Create Intent',
  description: 'Creates an intent inline. Admin-only, enforced server-side.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } } } },
  responses: {
    201: { description: 'Intent created' },
    403: { description: 'Forbidden — admin role required' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/intents/{id}/subintents',
  summary: 'Agent Create Subintent',
  description: 'Creates a subintent under an intent. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } } },
  },
  responses: {
    201: { description: 'Subintent created' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Intent not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/agent/articles',
  summary: 'Agent List Articles',
  description: 'Lists articles in all states for this workspace.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Articles list' } },
})

registry.registerPath({
  method: 'get',
  path: '/agent/articles/{id}',
  summary: 'Agent Get Article',
  description: 'Fetches one article for editing.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article detail' }, 404: { description: 'Not found' } },
})

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
})

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
})

registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/publish',
  summary: 'Agent Publish Article',
  description: "draft -> published, stamps published_by/published_at.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Article published' },
    404: { description: 'Not found' },
    409: { description: 'Not a draft, or title/body empty' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/archive',
  summary: 'Agent Archive Article',
  description: 'Any state -> archived. No delete route exists.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article archived' }, 404: { description: 'Not found' } },
})

registry.registerPath({
  method: 'get',
  path: '/agent/bot-config',
  summary: 'Agent Get Bot Config',
  description:
    'The resolved bot config for this workspace: is_provisioned, prompt, rules, the joined system_prompt, and which of the two text fields is customised. An absent row resolves to the off state on the defaults. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: { description: 'Resolved bot config' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/bot-config',
  summary: 'Agent Save Bot Config',
  description:
    'Partial upsert of this workspace bot config, audited field-by-field into change_log in the same transaction. An omitted key is left alone; an explicit null on prompt or rules resets it to the default. An empty or whitespace-only value is refused. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            is_provisioned: z.boolean().optional().openapi({ example: true }),
            prompt: z.string().nullable().optional().openapi({ example: 'You are the first-line support assistant…' }),
            rules: z.string().nullable().optional().openapi({ example: 'Never promise a refund.' }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Resolved bot config after the save' },
    403: { description: 'Forbidden — admin role required' },
    422: { description: 'Nothing to change, an unknown field, or an empty prompt/rules value' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/agent/bot-config/history',
  summary: 'Agent Get Bot Config Audit Trail',
  description:
    'This workspace bot-config change_log rows, newest first, cursor-paged. `field` is the database column name. `before_value` null means the field had no value before; `after_value` null means it was reset to the default. Team Lead or Admin.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional().openapi({ example: 50 }),
      cursor: z.string().optional().openapi({ description: 'Opaque next_cursor from the previous page' }),
    }),
  },
  responses: {
    200: { description: 'Audit trail page' },
    403: { description: 'Forbidden — Team Lead or Admin role required' },
    422: { description: 'Invalid limit or cursor' },
  },
})

// --- 6. SURFACE ARTICLE ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/surface/articles',
  summary: 'Public List Articles',
  description: 'Lists published articles, optionally filtered by intent or keyword.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { query: z.object({ intentId: z.uuid().optional(), q: z.string().min(1).max(200).optional() }) },
  responses: { 200: { description: 'Articles list' } },
})

registry.registerPath({
  method: 'get',
  path: '/surface/articles/{id}',
  summary: 'Public Get Article',
  description: 'Returns a single published article. 404 if draft/archived or wrong workspace.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article detail' }, 404: { description: 'Not found' } },
})

registry.registerPath({
  method: 'get',
  path: '/surface/intents',
  summary: 'Public List Intents',
  description: 'Lists intents (categories) with at least one published article, alphabetical by name.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  responses: { 200: { description: 'Intents list' } },
})

registry.registerPath({
  method: 'post',
  path: '/surface/resolution-answer',
  summary: 'Player Answer Resolution Check',
  description:
    "The banner's Yes/No, for both sources. Yes resolves the conversation (source bot or agent, per confirm_phase); No hands off to a human on bot_article, and only clears the phase on agent_ask. 409 when no check is pending.",
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: ResolutionAnswerBody } } } },
  responses: {
    200: {
      description: 'Answer applied',
      content: { 'application/json': { schema: z.object({ confirm_phase: z.string(), status: z.string() }) } },
    },
    404: { description: 'No conversation for this player' },
    409: { description: 'No resolution check pending' },
  },
})

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
})

// Build Document
const generator = new OpenApiGeneratorV3(registry.definitions)

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
})
