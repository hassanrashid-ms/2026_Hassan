import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts';
import { errorMiddleware } from '../src/errors.ts';
import { mintToken } from './helpers/app.ts';
import { uploadsRouter } from '../src/surface/routers/uploadsRouter.ts';
import { headObject } from '../src/shared/storage/presign.ts';
import { closeOwnerPool, seedWorkspace, seedPlayer, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requirePlayerToken, uploadsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('POST /uploads (player)', () => {
  it('returns a presigned PUT url for an allowed image type', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'screenshot.png', content_type: 'image/png', byte_size: 1024 })
      .expect(200);

    expect(res.body.key).toContain(`pending/${workspaceId}/${playerId}/`);
  });

  it('422s for a disallowed content type', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'doc.pdf', content_type: 'application/pdf', byte_size: 1024 })
      .expect(422);
    expect(res.body.error.code).toBe('unsupported_media_type');
  });

  it('returns a presigned PUT url for an allowed video type', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'clip.mp4', content_type: 'video/mp4', byte_size: 20 * 1024 * 1024 })
      .expect(200);

    expect(res.body.key).toContain(`pending/${workspaceId}/${playerId}/`);
    expect(res.body.key).toMatch(/\.mp4$/);
  });

  it('422s for a video over the 50 MB video cap', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'huge.webm', content_type: 'video/webm', byte_size: 51 * 1024 * 1024 })
      .expect(422);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('DELETE /uploads/:key (player)', () => {
  it('deletes an object the caller owns', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const key = `pending/${workspaceId}/${playerId}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(key)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(await headObject(key)).toBeNull();
  });

  it("404s for a key under a different player's path", async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const otherKey = `pending/${workspaceId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(otherKey)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
