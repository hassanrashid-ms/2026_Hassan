import { eq } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import type {
  BotConfigView,
  BotConfigVersionSnapshotView,
  BotConfigVersionsListResponse,
  LimitToggleValue as LimitToggle,
  ToolToggleValue,
} from '@support/types';
import { botConfig } from '../../shared/db/schema/index.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import { resolveBotConfig, saveBotConfig } from '../../domain/bot/botConfig.ts';
import { DEFAULT_BOT_PROMPT } from '../../domain/bot/defaultPrompt.ts';
import {
  buildBaselineRules,
  deriveEnforcement,
  type RuleEntry,
} from '../../domain/bot/rulesCatalog.ts';
import { buildBaselineToolsConfig, type ToolToggle } from '../../domain/bot/tools.ts';
import { buildBaselineLimits } from '../../domain/bot/limitsCatalog.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import {
  getBotConfigVersionByNumber,
  listBotConfigVersions,
} from '../../domain/bot/botConfigVersion.ts';

async function readUpdatedAt(tx: Tx, workspaceId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ updatedAt: botConfig.updatedAt })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1);
  return row?.updatedAt ?? null;
}

/** Shared by the read and the save so one response shape cannot drift from the other. */
async function view(tx: Tx, workspaceId: string): Promise<BotConfigView> {
  const resolved = await resolveBotConfig(tx, workspaceId);
  const updatedAt = await readUpdatedAt(tx, workspaceId);

  return {
    is_provisioned: resolved.isProvisioned,
    prompt: resolved.prompt,
    rules: resolved.rules.map((r) => ({ ...r, enforcement: deriveEnforcement(r) })),
    tools_config: resolved.toolsConfig as ToolToggleValue[],
    enabled_tools: [...resolved.enabledTools].sort(),
    limits_config: resolved.limitsConfig,
    resolved_limits: resolved.resolvedLimits,
    system_prompt: resolved.systemPrompt,
    // "Customised" is a diff against the current catalog baseline, not a
    // null-check — prompt/rules/tools_config/limits_config are NOT NULL now.
    is_prompt_customized: resolved.prompt !== DEFAULT_BOT_PROMPT,
    is_rules_customized: !isDeepStrictEqual(resolved.rules, buildBaselineRules()),
    is_tools_customized: !isDeepStrictEqual(resolved.toolsConfig, buildBaselineToolsConfig()),
    is_limits_customized: !isDeepStrictEqual(resolved.limitsConfig, buildBaselineLimits()),
    updated_at: updatedAt?.toISOString() ?? null,
  };
}

export async function getBotConfigView(ctx: AgentContext): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, (tx) => view(tx, ctx.workspaceId));
}

export type BotConfigSaveInput = {
  isProvisioned?: boolean;
  prompt?: string | null;
  rules?: RuleEntry[] | null;
  toolsConfig?: ToolToggle[] | null;
  limitsConfig?: LimitToggle[] | null;
};

export async function saveBotConfigForAgent(
  ctx: AgentContext,
  input: BotConfigSaveInput,
): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    await saveBotConfig(tx, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.agentId,
      isProvisioned: input.isProvisioned,
      prompt: input.prompt,
      rules: input.rules,
      toolsConfig: input.toolsConfig,
      limitsConfig: input.limitsConfig,
    });
    return view(tx, ctx.workspaceId);
  });
}

export async function listBotConfigVersionsForAgent(
  ctx: AgentContext,
  input: { limit: number; cursor?: number },
): Promise<BotConfigVersionsListResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const page = await listBotConfigVersions(tx, {
      workspaceId: ctx.workspaceId,
      limit: input.limit,
      cursor: input.cursor,
    });
    return {
      versions: page.rows.map((row) => ({
        version: row.version,
        actor: {
          id: row.actor.id,
          display_name: row.actor.displayName,
          email: row.actor.email,
        },
        changed_fields: row.changedFields as BotConfigVersionsListResponse['versions'][number]['changed_fields'],
        created_at: row.createdAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
    };
  });
}

export class BotConfigVersionNotFound extends Error {
  constructor() {
    super('No matching bot config version.');
    this.name = 'BotConfigVersionNotFound';
  }
}

export async function getBotConfigVersionForAgent(
  ctx: AgentContext,
  version: number,
): Promise<BotConfigVersionSnapshotView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const row = await getBotConfigVersionByNumber(tx, { workspaceId: ctx.workspaceId, version });
    if (!row) throw new BotConfigVersionNotFound();
    return {
      version: row.version,
      actor: {
        id: row.actor.id,
        display_name: row.actor.displayName,
        email: row.actor.email,
      },
      changed_fields: row.changedFields as BotConfigVersionSnapshotView['changed_fields'],
      created_at: row.createdAt.toISOString(),
      prompt: row.prompt,
      rules: row.rules.map((r) => ({ ...r, enforcement: deriveEnforcement(r) })),
      tools_config: row.toolsConfig as ToolToggleValue[],
      limits_config: row.limitsConfig,
    };
  });
}

/**
 * Restores a prior version's full snapshot as the new current bot_config — a
 * normal, newly-audited save (through saveBotConfig, which writes both
 * change_log and a fresh bot_config_version), never a mutation of history.
 */
export async function rollbackBotConfigVersionForAgent(
  ctx: AgentContext,
  version: number,
): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const snapshot = await getBotConfigVersionByNumber(tx, {
      workspaceId: ctx.workspaceId,
      version,
    });
    if (!snapshot) throw new BotConfigVersionNotFound();

    await saveBotConfig(tx, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.agentId,
      prompt: snapshot.prompt,
      rules: snapshot.rules,
      toolsConfig: snapshot.toolsConfig,
      limitsConfig: snapshot.limitsConfig,
    });
    return view(tx, ctx.workspaceId);
  });
}
