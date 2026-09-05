import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { runTestResolutionAnswer } from '../src/domain/bot/botTestResolution.ts';
import {
  closeOwnerPool,
  seedForm,
  seedFormVersion,
  seedIntent,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('runTestResolutionAnswer', () => {
  it('resolves on a Yes for bot_article, without touching the model or resolving a form', async () => {
    const workspaceId = await seedWorkspace();

    const decision = await runTestResolutionAnswer(
      { agentId: 'agent', workspaceId, isAdmin: true },
      { subintent_id: null, confirm_phase: 'bot_article', helped: true },
    );

    expect(decision).toEqual({ kind: 'resolved' });
  });

  it('hands off with no form on a No for bot_article when the subintent has none', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId });

    const decision = await runTestResolutionAnswer(
      { agentId: 'agent', workspaceId, isAdmin: true },
      { subintent_id: subintentId, confirm_phase: 'bot_article', helped: false },
    );

    expect(decision).toEqual({ kind: 'handed_off', reason: 'article_rejected', form: null });
  });

  it('hands off carrying the subintent form on a No for bot_article', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId);
    const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: [
        {
          key: 'store',
          label: 'Store',
          type: 'choice',
          isRequired: true,
          position: 0,
          options: ['A', 'B'],
        },
      ],
      publishedAt: new Date(),
    });
    const subintentId = await seedSubintent({ workspaceId, intentId, formId });

    const decision = await runTestResolutionAnswer(
      { agentId: 'agent', workspaceId, isAdmin: true },
      { subintent_id: subintentId, confirm_phase: 'bot_article', helped: false },
    );

    expect(decision.kind).toBe('handed_off');
    expect(decision).toMatchObject({
      kind: 'handed_off',
      reason: 'article_rejected',
      form: { form_name: 'Purchase receipt', version: 1 },
    });
  });

  it.each(['agent_ask', 'inactivity_ask', 'player_stated'] as const)(
    'resolves on Yes and reopens on No for %s, without ever resolving a form',
    async (confirmPhase) => {
      const workspaceId = await seedWorkspace();
      const intentId = await seedIntent(workspaceId);
      const formId = await seedForm({ workspaceId, name: 'Should never surface' });
      await seedFormVersion({ workspaceId, formId, version: 1, publishedAt: new Date() });
      const subintentId = await seedSubintent({ workspaceId, intentId, formId });

      const yes = await runTestResolutionAnswer(
        { agentId: 'agent', workspaceId, isAdmin: true },
        { subintent_id: subintentId, confirm_phase: confirmPhase, helped: true },
      );
      expect(yes).toEqual({ kind: 'resolved' });

      const no = await runTestResolutionAnswer(
        { agentId: 'agent', workspaceId, isAdmin: true },
        { subintent_id: subintentId, confirm_phase: confirmPhase, helped: false },
      );
      expect(no).toEqual({ kind: 'reopened' });
    },
  );
});
