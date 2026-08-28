import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, event, formSubmission, message } from '../src/shared/db/schema/index.ts';
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import type { HandoffReason } from '../src/domain/bot/botTurn.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedForm,
  seedFormVersion,
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const FIELDS = [
  {
    key: 'store',
    label: 'Store',
    type: 'choice',
    isRequired: true,
    position: 0,
    options: ['Apple App Store', 'Google Play'],
  },
  {
    key: 'order_id',
    label: 'Order or receipt ID',
    type: 'short_text',
    isRequired: true,
    position: 1,
  },
];

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

beforeEach(truncateAll);

/** A workspace with one active agent, so "no agent was assigned" is a real assertion. */
async function fixture(options: { withForm: boolean; publishForm?: boolean } = { withForm: true }) {
  const workspaceId = await seedWorkspace();
  const agentId = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId });
  await incrementPresence(agentId);
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  const intentId = await seedIntent(workspaceId);
  let formId: string | null = null;
  if (options.withForm) {
    formId = await seedForm({ workspaceId });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: FIELDS,
      publishedAt: options.publishForm === false ? null : new Date(),
    });
  }
  const subintentId = await seedSubintent({ workspaceId, intentId, formId });
  return { workspaceId, agentId, playerId, conversationId, subintentId, formId };
}

async function handoff(
  workspaceId: string,
  conversationId: string,
  reason: HandoffReason,
  subintentId: string | null,
) {
  return withWorkspace(workspaceId, (tx) =>
    applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'handoff', reason, subintentId }),
  );
}

async function read(workspaceId: string, conversationId: string) {
  return withWorkspace(workspaceId, async (tx) => {
    const [conv] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    const events = await tx.select().from(event).where(eq(event.conversationId, conversationId));
    const messages = await tx
      .select()
      .from(message)
      .where(eq(message.conversationId, conversationId));
    const submissions = await tx
      .select()
      .from(formSubmission)
      .where(eq(formSubmission.conversationId, conversationId));
    return { conv: conv!, events, messages, submissions };
  });
}

describe('the form offer at handoff', () => {
  it('holds the conversation in bot_active with no agent and no bot_handoff event', async () => {
    const f = await fixture();
    const result = await handoff(
      f.workspaceId,
      f.conversationId,
      'article_rejected',
      f.subintentId,
    );

    const { conv, events, messages, submissions } = await read(f.workspaceId, f.conversationId);
    expect(conv.status).toBe('bot_active');
    expect(conv.assignedAgentId).toBeNull();
    expect(conv.confirmPhase).toBe('form');
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(0);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.status).toBe('in_progress');
    expect(submissions[0]!.submittedAt).toBeNull();
    // The handoff line is posted at the moment the handoff is decided, not at terminate.
    expect(messages.filter((m) => m.authorType === 'system')).toHaveLength(1);
    expect(result.statusChanged).toBe(false);
    expect(result.phaseChanged).toBe('form');
  });

  it('writes one form_offered carrying the version, the field count and the reason', async () => {
    const f = await fixture();
    await handoff(f.workspaceId, f.conversationId, 'no_article', f.subintentId);

    const { events } = await read(f.workspaceId, f.conversationId);
    const offered = events.filter((e) => e.type === 'form_offered');
    expect(offered).toHaveLength(1);
    expect(offered[0]!.actorType).toBe('bot');
    expect(offered[0]!.actorId).toBeNull();
    expect(offered[0]!.payload).toEqual({
      form_id: f.formId,
      form_version: 1,
      field_count: 2,
      handoff_reason: 'no_article',
    });
  });

  it('still records the article rejection in the offer transaction', async () => {
    const f = await fixture();
    await handoff(f.workspaceId, f.conversationId, 'article_rejected', f.subintentId);
    const { events } = await read(f.workspaceId, f.conversationId);
    expect(events.filter((e) => e.type === 'bot_article_rejected')).toHaveLength(1);
  });

  it.each(['no_article', 'sensitive', 'article_rejected'] as const)(
    'offers a form on %s',
    async (reason) => {
      const f = await fixture();
      await handoff(f.workspaceId, f.conversationId, reason, f.subintentId);
      const { conv, submissions } = await read(f.workspaceId, f.conversationId);
      expect(conv.confirmPhase).toBe('form');
      expect(submissions).toHaveLength(1);
    },
  );

  it('never offers a form on asked_for_person, even when the subintent resolves to one', async () => {
    const f = await fixture();
    await handoff(f.workspaceId, f.conversationId, 'asked_for_person', f.subintentId);
    const { conv, submissions, events } = await read(f.workspaceId, f.conversationId);
    expect(submissions).toHaveLength(0);
    expect(conv.confirmPhase).toBe('none');
    expect(conv.status).toBe('open');
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(1);
  });

  it('offers no form when the subintent is null', async () => {
    const f = await fixture();
    await handoff(f.workspaceId, f.conversationId, 'turn_cap', null);
    const { conv, submissions } = await read(f.workspaceId, f.conversationId);
    expect(submissions).toHaveLength(0);
    expect(conv.status).toBe('open');
  });

  it('offers no form when the subintent has only a draft version', async () => {
    const f = await fixture({ withForm: true, publishForm: false });
    await handoff(f.workspaceId, f.conversationId, 'no_article', f.subintentId);
    const { conv, submissions } = await read(f.workspaceId, f.conversationId);
    expect(submissions).toHaveLength(0);
    expect(conv.status).toBe('open');
  });

  // The regression that matters most.
  it('a handoff whose subintent has no form behaves exactly as it does today', async () => {
    const f = await fixture({ withForm: false });
    const result = await handoff(f.workspaceId, f.conversationId, 'no_article', f.subintentId);

    const { conv, events, messages, submissions } = await read(f.workspaceId, f.conversationId);
    expect(submissions).toHaveLength(0);
    expect(conv.status).toBe('open');
    expect(conv.confirmPhase).toBe('none');
    expect(conv.assignedAgentId).toBe(f.agentId);
    const handoffs = events.filter((e) => e.type === 'bot_handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toEqual({ reason: 'no_article', assigned_agent_id: f.agentId });
    expect(messages).toHaveLength(1);
    expect(result.statusChanged).toBe(true);
    expect(result.phaseChanged).toBeNull();
  });
});
