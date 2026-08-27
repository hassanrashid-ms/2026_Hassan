import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  hashSecret,
  parseWorkspaceSecret,
  secretMatches,
} from '../src/shared/auth/workspaceSecret.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceSecret,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function adminToken(workspaceId: string): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  return signAgentSession({ agent_id: agentId });
}

describe('POST /admin/workspaces/:id/secret/rotate', () => {
  it('returns a new raw secret once and gives the old row a 24h expiry', async () => {
    const workspaceId = await seedWorkspace({ slug: 'rotate-me' });
    await seedWorkspaceSecret({ workspaceId, secretHash: hashSecret('old-raw-secret') });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/secret/rotate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const parsed = parseWorkspaceSecret(res.body.secret);
    expect(parsed?.slug).toBe('rotate-me');
    expect(secretMatches(parsed!.raw, hashSecret(parsed!.raw))).toBe(true);

    const { rows } = await ownerPool.query(
      `select expires_at from workspace_secret where workspace_id = $1 and secret_hash = $2`,
      [workspaceId, hashSecret('old-raw-secret')],
    );
    expect(rows[0].expires_at).not.toBeNull();
  });
});

describe('GET /admin/workspaces/:id/secret', () => {
  it('never returns the raw secret, only metadata', async () => {
    const workspaceId = await seedWorkspace();
    await seedWorkspaceSecret({ workspaceId, secretHash: hashSecret('some-secret') });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceId}/secret`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.secrets).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('some-secret');
    expect(res.body.secrets[0]).not.toHaveProperty('secret_hash');
  });
});
