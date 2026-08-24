import { eq } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import type {
  BotConfigView,
  ChangeLogHistoryResponse,
  LimitToggleValue as LimitToggle,
  ToolToggleValue,
} from '@support/types';
import { botConfig } from '../../shared/db/schema/index.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import {
  BOT_CONFIG_ENTITY_TYPE,
  resolveBotConfig,
  saveBotConfig,
} from '../../domain/bot/botConfig.ts';
import { DEFAULT_BOT_PROMPT } from '../../domain/bot/defaultPrompt.ts';
import {
  buildBaselineRules,
  deriveEnforcement,
  type RuleEntry,
} from '../../domain/bot/rulesCatalog.ts';
import { buildBaselineToolsConfig, type ToolToggle } from '../../domain/bot/tools.ts';
import { buildBaselineLimits } from '../../domain/bot/limitsCatalog.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import type { ChangeLogCursor } from '../../shared/changeLog/cursor.ts';
import { getChangeLogEntryById, readChangeLog } from '../../shared/changeLog/readChangeLog.ts';

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

export async function listBotConfigHistory(
  ctx: AgentContext,
  input: {
    limit: number;
    cursor?: ChangeLogCursor;
    field?: 'prompt' | 'rules' | 'tools_config' | 'limits_config' | 'is_provisioned';
  },
): Promise<ChangeLogHistoryResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const page = await readChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: BOT_CONFIG_ENTITY_TYPE,
      entityId: ctx.workspaceId,
      limit: input.limit,
      cursor: input.cursor,
    });

    const filtered = input.field ? page.rows.filter((r) => r.field === input.field) : page.rows;

    return {
      entries: filtered.map((row) => ({
        id: row.id,
        field: row.field,
        before_value: row.beforeValue,
        after_value: row.afterValue,
        actor: { id: row.actor.id, display_name: row.actor.displayName, email: row.actor.email },
        changed_at: row.changedAt.toISOString(),
      })),
      next_cursor: page.nextCursor,
    };
  });
}

export class ChangeLogEntryNotFound extends Error {
  constructor() {
    super('No matching change_log entry.');
    this.name = 'ChangeLogEntryNotFound';
  }
}

export class ChangeLogFieldMismatch extends Error {
  constructor(actual: string, requested: string) {
    super(`change_log_id refers to field "${actual}", not "${requested}".`);
    this.name = 'ChangeLogFieldMismatch';
  }
}

/**
 * Restores a prior change_log value as the new current value — a normal,
 * newly-audited save, never a mutation of history (spec "Versioning /
 * history / rollback").
 */
export async function rollbackBotConfigForAgent(
  ctx: AgentContext,
  input: {
    field: 'prompt' | 'rules' | 'tools_config' | 'limits_config';
    changeLogId: string;
    side: 'before' | 'after';
  },
): Promise<BotConfigView> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const entry = await getChangeLogEntryById(tx, {
      workspaceId: ctx.workspaceId,
      entityType: BOT_CONFIG_ENTITY_TYPE,
      entityId: ctx.workspaceId,
      id: input.changeLogId,
    });
    if (!entry) throw new ChangeLogEntryNotFound();
    if (entry.field !== input.field) throw new ChangeLogFieldMismatch(entry.field, input.field);

    const value = input.side === 'before' ? entry.beforeValue : entry.afterValue;
    const save =
      input.field === 'prompt'
        ? { prompt: value as string | null }
        : input.field === 'rules'
          ? { rules: value as RuleEntry[] | null }
          : input.field === 'tools_config'
            ? { toolsConfig: value as ToolToggle[] | null }
            : { limitsConfig: value as LimitToggle[] | null };

    await saveBotConfig(tx, { workspaceId: ctx.workspaceId, actorId: ctx.agentId, ...save });
    return view(tx, ctx.workspaceId);
  });
}
