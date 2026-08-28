import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FormField } from '@support/types';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, event, formSubmission } from '../src/shared/db/schema/index.ts';
import { sweepAbandonedForms } from '../src/shared/jobs/formTimeout.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
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

const NOW = new Date('2026-08-17T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const FIELDS: FormField[] = [
  { key: 'a', label: 'A', type: 'short_text', isRequired: true, position: 0 },
  { key: 'b', label: 'B', type: 'short_text', isRequired: false, position: 1 },
];

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

beforeEach(truncateAll);

/**
 * The Task 4 `offered()` fixture with a started_at parameter. Copied rather than
 * imported: a shared fixture across test files couples two suites that need to
 * diverge independently.
 */
async function offeredAt(
  startedAt: Date,
  answers: string[],
  workspaceOverrides: { slug?: string; formTimeoutMinutes?: number } = {},
) {
  const workspaceId = await seedWorkspace(workspaceOverrides);
  const agentId = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId });
  await incrementPresence(agentId);
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  await ownerPool.query(
    `update conversation set confirm_phase = 'form', status = 'bot_active' where id = $1`,
    [conversationId],
  );
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
    startedAt,
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
        field_count: FIELDS.length,
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

describe('sweepAbandonedForms', () => {
  it('terminates a stale in_progress submission and reaches the same end state as a skip', async () => {
    const f = await offeredAt(minutesAgo(45), ['a']);

    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(1);

    const [conv] = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, f.conversationId)),
    );
    expect(conv!.status).toBe('open');
    expect(conv!.confirmPhase).toBe('none');
    expect(conv!.assignedAgentId).toBe(f.agentId);

    const [sub] = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission));
    expect(sub!.status).toBe('partial');
    expect(sub!.submittedAt).not.toBeNull();

    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    );
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(1);
    const completed = events.filter((e) => e.type === 'form_completed');
    expect(completed).toHaveLength(1);
    // The load-bearing distinction: a submission the sweeper closed and one the
    // player skipped are the same row and need opposite fixes.
    expect((completed[0]!.payload as { terminated_by?: string }).terminated_by).toBe('timeout');
    expect(completed[0]!.actorType).toBe('system');
    expect(completed[0]!.actorId).toBeNull();
  });

  it('leaves a submission younger than the window alone', async () => {
    await offeredAt(minutesAgo(10), []);
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(0);
  });

  it('leaves a conversation whose confirm_phase is not form alone', async () => {
    const f = await offeredAt(minutesAgo(45), []);
    await ownerPool.query(`update conversation set confirm_phase = 'none' where id = $1`, [
      f.conversationId,
    ]);
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(0);
    const [sub] = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission));
    expect(sub!.status).toBe('in_progress');
  });

  it('is idempotent across runs', async () => {
    await offeredAt(minutesAgo(45), []);
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(1);
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(0);
  });

  it('sweeps across workspaces without bypassing RLS', async () => {
    await offeredAt(minutesAgo(45), []);
    await offeredAt(minutesAgo(45), []);
    expect(await sweepAbandonedForms({ now: NOW, timeoutMinutes: 30 })).toBe(2);
  });

  it("uses each workspace's own form_timeout_minutes", async () => {
    // Stale under a 10-minute window, not yet stale under a 60-minute one.
    const short = await offeredAt(minutesAgo(20), [], {
      slug: 'short-timeout',
      formTimeoutMinutes: 10,
    });
    const long = await offeredAt(minutesAgo(20), [], {
      slug: 'long-timeout',
      formTimeoutMinutes: 60,
    });

    expect(await sweepAbandonedForms({ now: NOW })).toBe(1);

    const [shortSub] = await withWorkspace(short.workspaceId, (tx) =>
      tx.select().from(formSubmission),
    );
    expect(shortSub!.status).toBe('skipped');

    const [longSub] = await withWorkspace(long.workspaceId, (tx) =>
      tx.select().from(formSubmission),
    );
    expect(longSub!.status).toBe('in_progress');
  });
});
