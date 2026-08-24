import { eq } from 'drizzle-orm';
import {
  truncateAll,
  seedWorkspace,
  seedPlayer,
  seedConversation,
  setupAgent,
  ownerPool,
} from './backend/tests/helpers/db.ts';
import { listConversations } from './backend/src/agent/services/conversationsService.ts';
import { agent } from './backend/src/shared/db/schema/index.ts';

async function run() {
  await truncateAll();
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);

  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  );
  const agentId = rows[0]!.id;

  const ctx = { workspaceId, agentId } as any;

  const highId = await seedConversation({ workspaceId, playerId, priority: 'p1', status: 'open' });
  const lowId = await seedConversation({ workspaceId, playerId, priority: 'p4', status: 'open' });

  const summaries = await listConversations(ctx, 'unassigned', { priority: ['p1'] });
  console.log('Result for priority p1:', summaries);

  const all = await listConversations(ctx, 'unassigned', {});
  console.log('Result for all unassigned:', all);
}

run()
  .catch(console.error)
  .finally(() => process.exit(0));
