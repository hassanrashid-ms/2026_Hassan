import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { agent, botConfigVersion } from '../../shared/db/schema/index.ts';
import type { RuleEntry } from './rulesCatalog.ts';
import type { ToolToggle } from './tools.ts';
import type { LimitToggleValue as LimitToggle } from '@support/types';

export type BotConfigVersionActor = { id: string; displayName: string; email: string };

export type BotConfigVersionSummaryRow = {
  version: number;
  actor: BotConfigVersionActor;
  createdAt: Date;
  changedFields: string[];
};

export type BotConfigVersionSnapshotRow = BotConfigVersionSummaryRow & {
  prompt: string;
  rules: RuleEntry[];
  toolsConfig: ToolToggle[];
  limitsConfig: LimitToggle[];
};

const FIELD_NAMES = ['prompt', 'rules', 'tools_config', 'limits_config'] as const;

/**
 * Inserts the next bot_config_version row for the workspace, or writes nothing
 * if every field is deep-equal to the immediately prior version — the same
 * no-op guard appendChangeLog applies per-field, applied here to the whole
 * snapshot so a save that changes nothing does not mint an empty version.
 *
 * `version` is MAX(version)+1 computed in the same transaction as the caller's
 * bot_config write, so two concurrent saves for one workspace still serialize
 * correctly under Postgres's transaction isolation on this table.
 */
export async function appendBotConfigVersion(
  tx: Tx,
  input: {
    workspaceId: string;
    actorId: string;
    prompt: string;
    rules: RuleEntry[];
    toolsConfig: ToolToggle[];
    limitsConfig: LimitToggle[];
  },
): Promise<void> {
  const [prior] = await tx
    .select({
      prompt: botConfigVersion.prompt,
      rules: botConfigVersion.rules,
      toolsConfig: botConfigVersion.toolsConfig,
      limitsConfig: botConfigVersion.limitsConfig,
      version: botConfigVersion.version,
    })
    .from(botConfigVersion)
    .where(eq(botConfigVersion.workspaceId, input.workspaceId))
    .orderBy(desc(botConfigVersion.version))
    .limit(1);

  const changedFields = FIELD_NAMES.filter((field) => {
    if (!prior) return true;
    const before =
      field === 'prompt'
        ? prior.prompt
        : field === 'rules'
          ? prior.rules
          : field === 'tools_config'
            ? prior.toolsConfig
            : prior.limitsConfig;
    const after =
      field === 'prompt'
        ? input.prompt
        : field === 'rules'
          ? input.rules
          : field === 'tools_config'
            ? input.toolsConfig
            : input.limitsConfig;
    return !isDeepStrictEqual(before, after);
  });

  if (changedFields.length === 0) return;

  await tx.insert(botConfigVersion).values({
    workspaceId: input.workspaceId,
    version: (prior?.version ?? 0) + 1,
    prompt: input.prompt,
    rules: input.rules,
    toolsConfig: input.toolsConfig,
    limitsConfig: input.limitsConfig,
    actorId: input.actorId,
    changedFields,
  });
}

/** Newest-first, keyset-paged on the integer version column. */
export async function listBotConfigVersions(
  tx: Tx,
  input: { workspaceId: string; limit: number; cursor?: number },
): Promise<{ rows: BotConfigVersionSummaryRow[]; nextCursor: number | null }> {
  const where =
    input.cursor === undefined
      ? eq(botConfigVersion.workspaceId, input.workspaceId)
      : and(
          eq(botConfigVersion.workspaceId, input.workspaceId),
          lt(botConfigVersion.version, input.cursor),
        );

  const found = await tx
    .select({
      version: botConfigVersion.version,
      createdAt: botConfigVersion.createdAt,
      changedFields: botConfigVersion.changedFields,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(botConfigVersion)
    .innerJoin(agent, eq(agent.id, botConfigVersion.actorId))
    .where(where)
    .orderBy(desc(botConfigVersion.version))
    .limit(input.limit + 1);

  const page = found.slice(0, input.limit);
  const rows: BotConfigVersionSummaryRow[] = page.map((row) => ({
    version: row.version,
    createdAt: row.createdAt,
    changedFields: row.changedFields,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  }));

  const last = rows.at(-1);
  const nextCursor = found.length > input.limit && last ? last.version : null;

  return { rows, nextCursor };
}

export async function getBotConfigVersionByNumber(
  tx: Tx,
  input: { workspaceId: string; version: number },
): Promise<BotConfigVersionSnapshotRow | null> {
  const [row] = await tx
    .select({
      version: botConfigVersion.version,
      prompt: botConfigVersion.prompt,
      rules: botConfigVersion.rules,
      toolsConfig: botConfigVersion.toolsConfig,
      limitsConfig: botConfigVersion.limitsConfig,
      createdAt: botConfigVersion.createdAt,
      changedFields: botConfigVersion.changedFields,
      actorId: agent.id,
      actorDisplayName: agent.displayName,
      actorEmail: agent.email,
    })
    .from(botConfigVersion)
    .innerJoin(agent, eq(agent.id, botConfigVersion.actorId))
    .where(
      and(
        eq(botConfigVersion.workspaceId, input.workspaceId),
        eq(botConfigVersion.version, input.version),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    version: row.version,
    prompt: row.prompt,
    rules: row.rules as RuleEntry[],
    toolsConfig: row.toolsConfig as ToolToggle[],
    limitsConfig: row.limitsConfig as LimitToggle[],
    createdAt: row.createdAt,
    changedFields: row.changedFields,
    actor: { id: row.actorId, displayName: row.actorDisplayName, email: row.actorEmail },
  };
}
