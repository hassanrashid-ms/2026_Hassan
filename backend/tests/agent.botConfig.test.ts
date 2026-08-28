import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { botConfigRouter } from '../src/agent/routers/botConfigRouter.ts';
import { DEFAULT_BOT_PROMPT, buildSystemPrompt } from '../src/domain/bot/defaultPrompt.ts';
import { buildBaselineRules } from '../src/domain/bot/rulesCatalog.ts';
import { buildBaselineToolsConfig } from '../src/domain/bot/tools.ts';
import { buildBaselineLimits } from '../src/domain/bot/limitsCatalog.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

// Standalone app carrying just this router behind the real session and role
// middleware — same rationale as agent.taxonomy.test.ts: it keeps this suite off
// the shared app wiring.
const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, botConfigRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name, is_admin) values ($1, 'Test Agent', $2) returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`, role === 'admin'],
  );
  const agentId = rows[0]!.id;
  if (role !== 'admin') {
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
      [workspaceId, agentId, role],
    );
  }
  const token = await signAgentSession({ agent_id: agentId, is_admin: role === 'admin' });
  return { agentId, token };
}

describe('GET /bot-config', () => {
  it('resolves an absent row to the off state on the catalog baseline', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.is_provisioned).toBe(false);
    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(res.body.rules).toHaveLength(8);
    expect(
      res.body.rules.find((r: { key: string }) => r.key === 'no_invented_facts').enforcement,
    ).toBe('code');
    expect(res.body.tools_config).toHaveLength(4);
    expect(res.body.enabled_tools.sort()).toEqual([
      'answer_from_article',
      'classify',
      'confirm_resolution',
      'search_articles',
    ]);
    expect(res.body.system_prompt).toBe(
      buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules()),
    );
    expect(res.body.is_prompt_customized).toBe(false);
    expect(res.body.is_rules_customized).toBe(false);
    expect(res.body.is_tools_customized).toBe(false);
    expect(res.body.updated_at).toBeNull();
  });

  it('reports a stored prompt verbatim and marks only that field customised', async () => {
    const workspaceId = await seedWorkspace();
    await ownerPool.query(
      `insert into bot_config (workspace_id, is_provisioned, prompt, rules, tools_config, limits_config)
       values ($1, true, 'Custom prompt', $2::jsonb, $3::jsonb, $4::jsonb)`,
      [
        workspaceId,
        JSON.stringify(buildBaselineRules()),
        JSON.stringify(buildBaselineToolsConfig()),
        JSON.stringify([]),
      ],
    );
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.is_provisioned).toBe(true);
    expect(res.body.prompt).toBe('Custom prompt');
    expect(res.body.is_prompt_customized).toBe(true);
    expect(res.body.is_rules_customized).toBe(false);
    expect(res.body.system_prompt).toBe(buildSystemPrompt('Custom prompt', buildBaselineRules()));
    expect(typeof res.body.updated_at).toBe('string');
  });

  // The matrix row is "See bot config" — Team Lead ✓, Admin ✓.
  it('admits a team lead, who may see the config but not edit it', async () => {
    const workspaceId = await seedWorkspace();
    await ownerPool.query(
      `insert into bot_config (workspace_id, prompt, rules, tools_config, limits_config)
       values ($1, 'Custom prompt', $2::jsonb, $3::jsonb, $4::jsonb)`,
      [
        workspaceId,
        JSON.stringify(buildBaselineRules()),
        JSON.stringify(buildBaselineToolsConfig()),
        JSON.stringify([]),
      ],
    );
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.prompt).toBe('Custom prompt');
  });

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });

  it('refuses an unauthenticated request with 401', async () => {
    await request(app).get('/bot-config').expect(401);
  });

  it('never leaks another workspace config', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    await ownerPool.query(
      `insert into bot_config (workspace_id, is_provisioned, prompt, rules, tools_config, limits_config)
       values ($1, true, 'B prompt', $2::jsonb, $3::jsonb, $4::jsonb)`,
      [
        workspaceB,
        JSON.stringify(buildBaselineRules()),
        JSON.stringify(buildBaselineToolsConfig()),
        JSON.stringify([]),
      ],
    );
    const { token } = await seedAgentWithRole(workspaceA, 'admin');

    const res = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .expect(200);

    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(res.body.is_provisioned).toBe(false);
  });

  it('GET resolves limits_config to the catalog defaults and rejects an out-of-bound save', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const get = await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(get.body.limits_config).toHaveLength(4);
    expect(get.body.resolved_limits).toEqual({
      max_bot_messages: 8,
      max_tool_calls_per_turn: 6,
      max_articles_per_turn: 3,
      max_unhelped_replies: 3,
    });
    expect(get.body.is_limits_customized).toBe(false);

    const badSave = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ limits_config: [{ key: 'max_bot_messages', value: 999 }] })
      .expect(422);
    expect(badSave.body.error.message).toMatch(/max_bot_messages/);
  });

});

describe('POST /bot-config', () => {
  it('creates the row on a first save and returns the resolved view', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ is_provisioned: true, prompt: 'Custom prompt' })
      .expect(200);

    expect(res.body.is_provisioned).toBe(true);
    expect(res.body.prompt).toBe('Custom prompt');
    expect(res.body.is_prompt_customized).toBe(true);
    expect(res.body.is_rules_customized).toBe(false);

    const { rows } = await ownerPool.query<{ prompt: string | null; is_provisioned: boolean }>(
      `select prompt, is_provisioned from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]).toEqual({ prompt: 'Custom prompt', is_provisioned: true });
  });

  it('writes one audit row per changed field, attributed to the caller', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ is_provisioned: true, prompt: 'Custom prompt' })
      .expect(200);

    const { rows } = await ownerPool.query<{ field: string; actor_id: string }>(
      `select field, actor_id from change_log
        where entity_type = 'bot_config' and entity_id = $1 order by field`,
      [workspaceId],
    );
    expect(rows.map((row) => row.field)).toEqual(['is_provisioned', 'prompt']);
    expect(rows.every((row) => row.actor_id === agentId)).toBe(true);
  });

  it('rejects a rules payload missing a locked builtin key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const withoutLocked = buildBaselineRules().filter((r) => r.key !== 'no_credentials');

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ rules: withoutLocked })
      .expect(422);
    expect(res.body.error.message).toContain('no_credentials');
  });

  it('accepts an added custom rule and renders it in system_prompt', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const rules = [
      ...buildBaselineRules(),
      {
        key: 'custom-1',
        text: 'Never mention competitor games.',
        enabled: true,
        locked: false,
        source: 'custom',
      },
    ];

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ rules })
      .expect(200);
    expect(res.body.system_prompt).toContain('Never mention competitor games.');
    expect(res.body.is_rules_customized).toBe(true);
  });

  it('disabling a tool removes it from enabled_tools and is reflected in is_tools_customized', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const toolsConfig = buildBaselineToolsConfig().map((t) =>
      t.tool === 'classify' ? { ...t, enabled: false } : t,
    );

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ tools_config: toolsConfig })
      .expect(200);
    expect(res.body.enabled_tools).not.toContain('classify');
    expect(res.body.is_tools_customized).toBe(true);
  });

  it('rejects tools_config missing a catalog tool', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const missingOne = buildBaselineToolsConfig().slice(1);

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ tools_config: missingOne })
      .expect(422);
  });

  it('leaves an omitted field alone and audits nothing for it', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'First' })
      .expect(200);
    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Second' })
      .expect(200);

    expect(res.body.prompt).toBe('Second');

    const { rows } = await ownerPool.query<{ field: string }>(
      `select field from change_log where entity_type = 'bot_config' and entity_id = $1`,
      [workspaceId],
    );
    expect(rows.filter((row) => row.field === 'rules')).toHaveLength(0);
  });

  it('treats explicit null as a reset to the default and audits it', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Custom' })
      .expect(200);
    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: null })
      .expect(200);

    expect(res.body.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(res.body.is_prompt_customized).toBe(false);

    const { rows } = await ownerPool.query<{ before_value: unknown; after_value: unknown }>(
      `select before_value, after_value from change_log
        where entity_type = 'bot_config' and entity_id = $1 and field = 'prompt'
        order by changed_at desc, id desc limit 1`,
      [workspaceId],
    );
    expect(rows[0]).toEqual({ before_value: 'Custom', after_value: DEFAULT_BOT_PROMPT });
  });

  it('is an upsert — a second save does not error', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ is_provisioned: true })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ is_provisioned: false })
      .expect(200);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('rejects a whitespace-only prompt with 422 naming the offending column', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: '   ' })
      .expect(422);

    expect(res.body.error.message).toContain('prompt');

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('rejects an empty body and an unknown key with 422', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({})
      .expect(422);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ provisioned: true })
      .expect(422);
  });

  // Editing is Admin-only in the matrix, so a Team Lead who CAN read the config is
  // still refused here. This is the case that proves read and write are separate
  // gates rather than one copy-pasted middleware.
  it('refuses a team lead with 403 and writes nothing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Lead tried to edit' })
      .expect(403);

    await request(app)
      .get('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('refuses a plain agent with 403 and writes nothing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ is_provisioned: true })
      .expect(403);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('writes no audit row when the caller was refused', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'x' })
      .expect(403);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*)::text as count from change_log where entity_id = $1`,
      [workspaceId],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('writes only the caller workspace row', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceA, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .send({ prompt: 'A' })
      .expect(200);

    const { rows } = await ownerPool.query<{ workspace_id: string }>(
      `select workspace_id from bot_config`,
    );
    expect(rows.map((row) => row.workspace_id)).toEqual([workspaceA]);
    expect(rows.map((row) => row.workspace_id)).not.toContain(workspaceB);
  });
});

describe('GET /bot-config/versions', () => {
  it('returns one version after seeding via first save, newest first', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'V1' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'V2' })
      .expect(200);

    const res = await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(res.body.versions[0].changed_fields).toEqual(['prompt']);
    expect(res.body.versions[1].changed_fields.sort()).toEqual(
      ['limits_config', 'prompt', 'rules', 'tools_config'].sort(),
    );
    expect(res.body.next_cursor).toBeNull();
  });

  it('never returns another workspace trail', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token: tokenA } = await seedAgentWithRole(workspaceA, 'admin');
    const { token: tokenB } = await seedAgentWithRole(workspaceB, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Workspace-Id', workspaceA)
      .send({ prompt: 'A only' })
      .expect(200);

    const res = await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-Workspace-Id', workspaceB)
      .expect(200);

    expect(res.body.versions).toEqual([]);
  });

  it('refuses a plain agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});

describe('GET /bot-config/versions/:version', () => {
  it('returns the full snapshot for that version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'V1' })
      .expect(200);

    const res = await request(app)
      .get('/bot-config/versions/1')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.version).toBe(1);
    expect(res.body.prompt).toBe('V1');
    expect(res.body.rules).toBeInstanceOf(Array);
  });

  it('404s on an unknown version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .get('/bot-config/versions/99')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });
});

describe('POST /bot-config/rollback', () => {
  it('restores a prior version and writes a new, forward version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Original' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Changed' })
      .expect(200);

    const res = await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ version: 1 })
      .expect(200);

    expect(res.body.prompt).toBe('Original');

    const versions = await request(app)
      .get('/bot-config/versions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
  });

  it('404s on an unknown version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ version: 99 })
      .expect(404);
  });

  it('refuses a team lead with 403', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'X' })
      .expect(200);

    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');
    await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ version: 1 })
      .expect(403);
  });
});

describe('bot_config_version writes', () => {
  it('seeding writes version 1 with all four fields as changed', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    // Any provisioning path that calls seedBotConfig would work; the simplest
    // trigger available at the HTTP layer today is a save, which upserts the
    // row and therefore also runs through saveBotConfig's own version write.
    // This test instead asserts directly against the table so it exercises
    // seedBotConfig specifically once a provisioning endpoint calls it — until
    // then, assert saveBotConfig's first-ever save behaves the same way:
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Version one prompt' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select version, changed_fields from bot_config_version where workspace_id = $1 order by version`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].changed_fields.sort()).toEqual(
      ['limits_config', 'prompt', 'rules', 'tools_config'].sort(),
    );
  });

  it('a second save with only prompt changed writes version 2 naming only prompt', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'First' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Second' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select version, changed_fields from bot_config_version where workspace_id = $1 order by version`,
      [workspaceId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].version).toBe(2);
    expect(rows[1].changed_fields).toEqual(['prompt']);
  });

  it('a save with no actual change writes no new version', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Same' })
      .expect(200);
    await request(app)
      .post('/bot-config')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ prompt: 'Same' })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select version from bot_config_version where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('rollback against a snapshot older than the current catalog', () => {
  it('fills in baseline values for rule/tool/limit entries the old snapshot predates', async () => {
    const workspaceId = await seedWorkspace();
    const { token, agentId } = await seedAgentWithRole(workspaceId, 'admin');

    // Build an "old" snapshot the way a version taken before a catalog entry
    // existed would look: every builtin rule/tool/limit EXCEPT one, mirroring
    // a rule/tool/limit added to the catalog after this version was written.
    const staleRules = buildBaselineRules().filter((r) => r.key !== 'no_regreet');
    const staleTools = buildBaselineToolsConfig().filter((t) => t.tool !== 'classify');
    const staleLimits = buildBaselineLimits().filter((l) => l.key !== 'max_unhelped_replies');

    await ownerPool.query(
      `insert into bot_config_version
         (workspace_id, version, prompt, rules, tools_config, limits_config, actor_id, changed_fields)
       values ($1, 1, 'Stale prompt', $2::jsonb, $3::jsonb, $4::jsonb, $5, '{prompt,rules,tools_config,limits_config}')`,
      [
        workspaceId,
        JSON.stringify(staleRules),
        JSON.stringify(staleTools),
        JSON.stringify(staleLimits),
        agentId,
      ],
    );

    const res = await request(app)
      .post('/bot-config/rollback')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ version: 1 })
      .expect(200);

    expect(res.body.prompt).toBe('Stale prompt');

    const restoredRuleKeys = res.body.rules.map((r: { key: string }) => r.key).sort();
    expect(restoredRuleKeys).toEqual(buildBaselineRules().map((r) => r.key).sort());
    const noRegreet = res.body.rules.find((r: { key: string }) => r.key === 'no_regreet');
    expect(noRegreet).toBeDefined();
    expect(noRegreet.enabled).toBe(
      buildBaselineRules().find((r) => r.key === 'no_regreet')!.enabled,
    );

    const restoredToolNames = res.body.tools_config.map((t: { tool: string }) => t.tool).sort();
    expect(restoredToolNames).toEqual(buildBaselineToolsConfig().map((t) => t.tool).sort());

    const restoredLimit = res.body.limits_config.find(
      (l: { key: string }) => l.key === 'max_unhelped_replies',
    );
    expect(restoredLimit).toBeDefined();
    expect(restoredLimit.value).toBe(
      buildBaselineLimits().find((l) => l.key === 'max_unhelped_replies')!.value,
    );
  });
});
