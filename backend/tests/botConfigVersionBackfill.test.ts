import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeOwnerPool, ownerPool, seedBotConfig, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeOwnerPool();
});

beforeEach(truncateAll);

// 0022 introduced bot_config_version, but appendBotConfigVersion only ever
// diffs against the PRIOR version row — a workspace that already had a
// bot_config row before 0022 shipped gets zero version rows from that alone.
// 0023 backfills exactly this case. Replayed here the same way
// ticketNumber.test.ts replays 0003's backfill: the real statement from the
// shipped migration file, not a paraphrase of it.
describe('bot_config_version backfill (0023)', () => {
  const backfillSql = readFileSync(
    new URL('../drizzle/0023_backfill_bot_config_version.sql', import.meta.url),
    'utf8',
  );

  it('writes a v1 snapshot for a pre-existing workspace with no version rows', async () => {
    const workspaceId = await seedWorkspace();
    await seedBotConfig({
      workspaceId,
      isProvisioned: true,
      prompt: 'Pre-migration prompt',
      rules: [{ key: 'custom_rule', text: 'Be nice', enabled: true, locked: false, source: 'custom' }],
      toolsConfig: [{ tool: 'search_articles', enabled: true }],
      limitsConfig: [{ key: 'max_bot_messages', value: 5 }],
    });

    await ownerPool.query(backfillSql);

    const { rows } = await ownerPool.query<{
      version: number;
      prompt: string;
      changed_fields: string[];
      actor_email: string;
    }>(
      `select bcv.version, bcv.prompt, bcv.changed_fields, a.email as actor_email
         from bot_config_version bcv
         join agent a on a.id = bcv.actor_id
        where bcv.workspace_id = $1`,
      [workspaceId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.prompt).toBe('Pre-migration prompt');
    expect(rows[0]!.changed_fields.sort()).toEqual(
      ['limits_config', 'prompt', 'rules', 'tools_config'].sort(),
    );
    expect(rows[0]!.actor_email).toBe('system@internal.support');
  });

  it('is a no-op for a workspace that already has version rows', async () => {
    const workspaceId = await seedWorkspace();
    await seedBotConfig({ workspaceId, prompt: 'Already versioned' });

    // Simulate the normal post-0022 path: a save already wrote v1 itself.
    const { rows: agentRows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('actor@example.test', 'Actor') returning id`,
    );
    await ownerPool.query(
      `insert into bot_config_version
         (workspace_id, version, prompt, rules, tools_config, limits_config, actor_id, changed_fields)
       values ($1, 1, 'Already versioned', '[]', '[]', '[]', $2, '{prompt}')`,
      [workspaceId, agentRows[0]!.id],
    );

    await ownerPool.query(backfillSql);

    const { rows } = await ownerPool.query<{ version: number }>(
      `select version from bot_config_version where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
  });

  it('is safe to run twice — no duplicate version rows', async () => {
    const workspaceId = await seedWorkspace();
    await seedBotConfig({ workspaceId, prompt: 'Idempotent check' });

    await ownerPool.query(backfillSql);
    await ownerPool.query(backfillSql);

    const { rows } = await ownerPool.query<{ version: number }>(
      `select version from bot_config_version where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
  });

  it('reuses the same system actor row across multiple backfilled workspaces', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    await seedBotConfig({ workspaceId: wsA, prompt: 'A' });
    await seedBotConfig({ workspaceId: wsB, prompt: 'B' });

    await ownerPool.query(backfillSql);

    const { rows } = await ownerPool.query<{ actor_id: string }>(
      `select distinct actor_id from bot_config_version where workspace_id in ($1, $2)`,
      [wsA, wsB],
    );
    expect(rows).toHaveLength(1);

    const { rows: agentRows } = await ownerPool.query<{ count: string }>(
      `select count(*) from agent where email = 'system@internal.support'`,
    );
    expect(agentRows[0]!.count).toBe('1');
  });

  it('leaves a workspace with no bot_config row untouched', async () => {
    const workspaceId = await seedWorkspace();

    await ownerPool.query(backfillSql);

    const { rows } = await ownerPool.query<{ version: number }>(
      `select version from bot_config_version where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows).toHaveLength(0);
  });
});
