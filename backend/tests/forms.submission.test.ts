import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import type { FormField } from '@support/types';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, event, formSubmission, message } from '../src/shared/db/schema/index.ts';
import { completeFormAndHandoff } from '../src/domain/forms/completeFormAndHandoff.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts';
import { formRouter } from '../src/surface/routers/formRouter.ts';
import { mintToken } from './helpers/app.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedForm,
  seedFormAnswer,
  seedFormSubmission,
  seedFormVersion,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const FIELDS: FormField[] = [
  { key: 'a', label: 'A', type: 'short_text', isRequired: true, position: 0 },
  { key: 'b', label: 'B', type: 'short_text', isRequired: false, position: 1 },
  { key: 'c', label: 'C', type: 'short_text', isRequired: false, position: 2 },
  { key: 'd', label: 'D', type: 'short_text', isRequired: false, position: 3 },
];

const app = express();
app.use(express.json());
app.use(requirePlayerToken, formRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

beforeEach(truncateAll);

async function offered(answers: string[]) {
  const workspaceId = await seedWorkspace();
  const agentId = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId });
  await incrementPresence(agentId);
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  await ownerPool.query(`update conversation set confirm_phase = 'form' where id = $1`, [
    conversationId,
  ]);
  const formId = await seedForm({ workspaceId });
  await seedFormVersion({
    workspaceId,
    formId,
    version: 1,
    fields: FIELDS,
    publishedAt: new Date(),
  });
  const submissionId = await seedFormSubmission({
    workspaceId,
    conversationId,
    formId,
    formVersion: 1,
  });
  // The offer event the terminate step reads the handoff reason back out of.
  await ownerPool.query(
    `insert into event (workspace_id, type, conversation_id, actor_type, payload)
     values ($1, 'form_offered', $2, 'bot', $3::jsonb)`,
    [
      workspaceId,
      conversationId,
      JSON.stringify({
        form_id: formId,
        form_version: 1,
        field_count: 4,
        handoff_reason: 'no_article',
      }),
    ],
  );
  for (const key of answers) {
    await seedFormAnswer({
      workspaceId,
      formSubmissionId: submissionId,
      fieldKey: key,
      fieldType: 'short_text',
      value: 'x',
    });
  }
  return { workspaceId, agentId, playerId, conversationId, submissionId };
}

/**
 * The same offer, reached over HTTP: one live submission on the player's latest
 * conversation plus a minted player token. `store` sits at position 0 so a later
 * version that reorders the fields is visibly not what the answer is scored on.
 */
const LIVE_FIELDS: FormField[] = [
  {
    key: 'store',
    label: 'Store',
    type: 'choice',
    isRequired: true,
    position: 0,
    options: ['Apple App Store', 'Google Play'],
  },
  { key: 'quantity', label: 'Quantity', type: 'number', isRequired: false, position: 1 },
  { key: 'proof', label: 'Proof', type: 'attachment', isRequired: false, position: 2 },
];

async function liveForm() {
  const workspaceId = await seedWorkspace();
  const agentId = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  await ownerPool.query(`update conversation set confirm_phase = 'form' where id = $1`, [
    conversationId,
  ]);
  const formId = await seedForm({ workspaceId });
  await seedFormVersion({
    workspaceId,
    formId,
    version: 1,
    fields: LIVE_FIELDS,
    publishedAt: new Date(),
  });
  const submissionId = await seedFormSubmission({
    workspaceId,
    conversationId,
    formId,
    formVersion: 1,
  });
  await ownerPool.query(
    `insert into event (workspace_id, type, conversation_id, actor_type, payload)
     values ($1, 'form_offered', $2, 'bot', $3::jsonb)`,
    [
      workspaceId,
      conversationId,
      JSON.stringify({
        form_id: formId,
        form_version: 1,
        field_count: 3,
        handoff_reason: 'no_article',
      }),
    ],
  );
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p-1',
  });
  return { workspaceId, agentId, playerId, conversationId, submissionId, formId, token };
}

function terminate(f: Awaited<ReturnType<typeof offered>>, by: 'submit' | 'skip' | 'timeout') {
  return withWorkspace(f.workspaceId, (tx) =>
    completeFormAndHandoff(
      tx,
      {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        submissionId: f.submissionId,
        actorType: by === 'timeout' ? 'system' : 'player',
        actorId: by === 'timeout' ? null : f.playerId,
        sessionId: null,
      },
      by,
    ),
  );
}

describe('completeFormAndHandoff', () => {
  it('derives completed when every field has an answer', async () => {
    const f = await offered(['a', 'b', 'c', 'd']);
    const result = await terminate(f, 'submit');
    expect(result!.formStatus).toBe('completed');
    expect(result!.answeredCount).toBe(4);
    expect(result!.fieldCount).toBe(4);
  });

  it('derives partial when some fields are answered and keeps the answers', async () => {
    const f = await offered(['a', 'b']);
    const result = await terminate(f, 'skip');
    expect(result!.formStatus).toBe('partial');
    expect(result!.answeredCount).toBe(2);
    const rows = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission));
    expect(rows[0]!.status).toBe('partial');
    const { rows: answers } = await ownerPool.query(
      `select field_key from form_answer order by field_key`,
    );
    expect(answers.map((r) => r.field_key)).toEqual(['a', 'b']);
  });

  it('derives skipped when there are no answers at all', async () => {
    const f = await offered([]);
    const result = await terminate(f, 'skip');
    expect(result!.formStatus).toBe('skipped');
    expect(result!.answeredCount).toBe(0);
  });

  it('counts distinct field keys, not answer rows, when a field was corrected', async () => {
    const f = await offered(['a', 'a', 'b']);
    const result = await terminate(f, 'submit');
    expect(result!.answeredCount).toBe(2);
    expect(result!.formStatus).toBe('partial');
  });

  it('assigns an agent, opens the conversation and clears the phase', async () => {
    const f = await offered(['a', 'b', 'c', 'd']);
    await terminate(f, 'submit');
    const [conv] = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, f.conversationId)),
    );
    expect(conv!.status).toBe('open');
    expect(conv!.confirmPhase).toBe('none');
    expect(conv!.assignedAgentId).toBe(f.agentId);
  });

  it('writes exactly one bot_handoff carrying the reason from the offer, and one form_completed', async () => {
    const f = await offered(['a']);
    await terminate(f, 'timeout');
    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    );
    const handoffs = events.filter((e) => e.type === 'bot_handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toEqual({ reason: 'no_article', assigned_agent_id: f.agentId });
    const completed = events.filter((e) => e.type === 'form_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.actorType).toBe('system');
    expect(completed[0]!.actorId).toBeNull();
    expect(completed[0]!.payload).toEqual({
      status: 'partial',
      terminated_by: 'timeout',
      answered_count: 1,
      field_count: 4,
    });
  });

  it('posts exactly one non-empty summary card and no other message when skipped without answers', async () => {
    const f = await offered([]);
    await terminate(f, 'skip');
    const rows = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, f.conversationId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorType).toBe('system');
    expect(rows[0]!.visibility).toBe('public');
    expect(rows[0]!.body.trim().length).toBeGreaterThan(0);
  });

  it('posts an internal system message with the answers when fields are answered', async () => {
    const f = await offered(['a', 'b']);
    await terminate(f, 'submit');
    const rows = await withWorkspace(f.workspaceId, (tx) =>
      tx
        .select()
        .from(message)
        .where(eq(message.conversationId, f.conversationId))
        .orderBy(asc(message.createdAt), asc(message.id)),
    );
    expect(rows).toHaveLength(2);
    const publicMsg = rows.find((r) => r.visibility === 'public')!;
    const internalMsg = rows.find((r) => r.visibility === 'internal')!;

    // First message should be the public summary
    expect(publicMsg.authorType).toBe('system');
    // Second message should be the internal answers
    expect(internalMsg.authorType).toBe('system');
    expect(internalMsg.body).toContain('Form Submitted');
    expect(internalMsg.body).toContain('A'); // Field label A
    expect(internalMsg.body).toContain('B'); // Field label B
  });

  it('returns null on a second call and writes nothing the second time', async () => {
    const f = await offered(['a']);
    await terminate(f, 'submit');
    const second = await terminate(f, 'skip');
    expect(second).toBeNull();
    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    );
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'form_completed')).toHaveLength(1);
  });
});

describe('POST /surface/form/answer', () => {
  it('accepts a valid answer and reports it as not a correction', async () => {
    const f = await liveForm();
    const res = await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, is_correction: false });
  });

  it('reports the second answer for the same field as a correction', async () => {
    const f = await liveForm();
    const post = (value: string) =>
      request(app)
        .post('/form/answer')
        .set('Authorization', `Bearer ${f.token}`)
        .send({ field_key: 'store', value });
    await post('Google Play');
    const res = await post('Apple App Store');
    expect(res.body.is_correction).toBe(true);
    const { rows } = await ownerPool.query(`select value from form_answer order by created_at`);
    expect(rows).toHaveLength(2);
  });

  it('rejects an unknown field key', async () => {
    const f = await liveForm();
    const res = await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'not_a_field', value: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unknown_field');
  });

  it('rejects a value of the wrong type', async () => {
    const f = await liveForm();
    const res = await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'quantity', value: 'seven' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_value');
  });

  it('rejects a choice outside its options', async () => {
    const f = await liveForm();
    const res = await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Steam' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('invalid_value');
  });

  it('rejects an attachment as unsupported', async () => {
    const f = await liveForm();
    const res = await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        field_key: 'proof',
        value: { attachmentId: '00000000-0000-4000-8000-000000000000' },
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('unsupported_field_type');
  });

  it('never posts an answer as a chat message', async () => {
    const f = await liveForm();
    await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' });
    const { rows } = await ownerPool.query(`select body from message where conversation_id = $1`, [
      f.conversationId,
    ]);
    expect(rows.map((r) => r.body)).not.toContain('Google Play');
  });
});

describe('POST /surface/form/submit and /skip', () => {
  it('rejects submit when the required field is unanswered', async () => {
    const f = await liveForm();
    const res = await request(app)
      .post('/form/submit')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('required_fields_missing');
    const rows = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission));
    expect(rows[0]!.status).toBe('in_progress');
  });

  it('rejects skip when the required field is unanswered', async () => {
    const f = await liveForm();
    const res = await request(app)
      .post('/form/skip')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('required_fields_missing');
  });

  it('submit terminates with terminated_by submit once the required field is answered, leaving the rest optional', async () => {
    const f = await liveForm();
    await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' });
    const res = await request(app)
      .post('/form/submit')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ confirm_phase: 'none', status: 'open', form_status: 'partial' });
    const { rows } = await ownerPool.query(
      `select payload from event where type = 'form_completed'`,
    );
    expect(rows[0]!.payload.terminated_by).toBe('submit');
  });

  it('skip terminates with terminated_by skip and keeps earlier answers readable', async () => {
    const f = await liveForm();
    await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' });
    const res = await request(app)
      .post('/form/skip')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(res.body.form_status).toBe('partial');
    const { rows } = await ownerPool.query(`select field_key, value from form_answer`);
    expect(rows).toEqual([{ field_key: 'store', value: 'Google Play' }]);
    const { rows: events } = await ownerPool.query(
      `select payload from event where type = 'form_completed'`,
    );
    expect(events[0]!.payload.terminated_by).toBe('skip');
  });

  it('refuses a second terminate on a terminal submission', async () => {
    const f = await liveForm();
    await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' });
    await request(app).post('/form/skip').set('Authorization', `Bearer ${f.token}`).send({});
    const res = await request(app)
      .post('/form/submit')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(res.status).toBe(409);
  });

  it('refuses an answer once the submission is terminal', async () => {
    const f = await liveForm();
    await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Google Play' });
    await request(app).post('/form/skip').set('Authorization', `Bearer ${f.token}`).send({});
    const res = await request(app)
      .post('/form/answer')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ field_key: 'store', value: 'Apple App Store' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_form_pending');
  });
});
