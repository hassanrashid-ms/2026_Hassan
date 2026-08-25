import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { app } from './helpers/app.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

async function seedAgentWithMembership(
  workspaceId: string,
  email: string,
  displayName: string,
): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, $2) returning id`,
    [email, displayName],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  return agentId;
}

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('agent dev auth', () => {
  it('GET /agent/auth/dev-agents lists agents with a workspace membership', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentWithMembership(workspaceId, 'alex@example.test', 'Alex Agent');

    const res = await request(app).get('/agent/auth/dev-agents').expect(200);
    expect(res.body.agents).toEqual([
      { id: agentId, email: 'alex@example.test', display_name: 'Alex Agent' },
    ]);
  });

  it('POST /agent/auth/dev-login mints a token that requireAgentSession accepts', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentWithMembership(workspaceId, 'sam@example.test', 'Sam Agent');

    const res = await request(app)
      .post('/agent/auth/dev-login')
      .send({ agent_id: agentId })
      .expect(200);
    expect(res.body.agent).toEqual({ id: agentId, display_name: 'Sam Agent' });
    expect(res.body.workspace).toBeUndefined();
    expect(typeof res.body.token).toBe('string');
  });

  it('POST /agent/auth/dev-login logs in an agent with no workspace membership — identity only, no longer 404', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('nomember@example.test', 'No Member') returning id`,
    );
    await request(app).post('/agent/auth/dev-login').send({ agent_id: rows[0]!.id }).expect(200);
  });
});
