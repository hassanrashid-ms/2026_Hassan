import { eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { botConfig } from '../../shared/db/schema/index.ts';
import { buildSystemPrompt, DEFAULT_BOT_PROMPT } from './defaultPrompt.ts';
import {
  BUILTIN_RULE_KEYS,
  LOCKED_RULE_KEYS,
  buildBaselineRules,
  type RuleEntry,
} from './rulesCatalog.ts';
import { TOOL_CATALOG, buildBaselineToolsConfig, type ToolToggle } from './tools.ts';
import { LIMIT_CATALOG, buildBaselineLimits, clampLimitBounds } from './limitsCatalog.ts';
import type { LimitKey, LimitToggleValue as LimitToggle } from '@support/types';
import { getOrCreateSystemActor } from './systemActor.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';
import { appendBotConfigVersion } from './botConfigVersion.ts';

export type ResolvedBotConfig = {
  isProvisioned: boolean;
  prompt: string;
  rules: RuleEntry[];
  toolsConfig: ToolToggle[];
  /** Derived from toolsConfig — what toolsForPhase actually filters against. */
  enabledTools: ReadonlySet<string>;
  limitsConfig: LimitToggle[];
  resolvedLimits: Record<LimitKey, number>;
  systemPrompt: string;
};

function resolved(
  isProvisioned: boolean,
  prompt: string,
  rules: RuleEntry[],
  toolsConfig: ToolToggle[],
  limitsConfig: LimitToggle[],
): ResolvedBotConfig {
  return {
    isProvisioned,
    prompt,
    rules,
    toolsConfig,
    enabledTools: new Set(toolsConfig.filter((t) => t.enabled).map((t) => t.tool)),
    limitsConfig,
    resolvedLimits: Object.fromEntries(limitsConfig.map((l) => [l.key, l.value])) as Record<
      LimitKey,
      number
    >,
    systemPrompt: buildSystemPrompt(prompt, rules),
  };
}

/**
 * The one place an absent row collapses to the off state on the catalog
 * baseline. Every caller goes through here. Unlike before this migration, a
 * PRESENT row's prompt/rules/tools_config are never null — the NOT NULL
 * columns guarantee that — so this function's only remaining job is the
 * absent-row case.
 */
export async function resolveBotConfig(tx: Tx, workspaceId: string): Promise<ResolvedBotConfig> {
  const [row] = await tx
    .select({
      isProvisioned: botConfig.isProvisioned,
      prompt: botConfig.prompt,
      rules: botConfig.rules,
      toolsConfig: botConfig.toolsConfig,
      limitsConfig: botConfig.limitsConfig,
    })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1);

  if (!row) {
    return resolved(
      false,
      DEFAULT_BOT_PROMPT,
      buildBaselineRules(),
      buildBaselineToolsConfig(),
      buildBaselineLimits(),
    );
  }
  return resolved(
    row.isProvisioned,
    row.prompt,
    row.rules as RuleEntry[],
    row.toolsConfig as ToolToggle[],
    row.limitsConfig as LimitToggle[],
  );
}

export const BOT_CONFIG_ENTITY_TYPE = 'bot_config';

export class EmptyBotPrompt extends Error {
  readonly field: 'prompt';
  constructor() {
    super('Bot prompt cannot be empty — pass null to reset it to the default');
    this.name = 'EmptyBotPrompt';
    this.field = 'prompt';
  }
}

export class InvalidRulesPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRulesPayload';
  }
}

export class InvalidToolsPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolsPayload';
  }
}

export class InvalidLimitsPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLimitsPayload';
  }
}

/** Save-time domain validation beyond Zod's shape check (spec "API / types"). */
function validateRules(rules: readonly RuleEntry[]): void {
  const byKey = new Map(rules.map((r) => [r.key, r]));

  for (const key of BUILTIN_RULE_KEYS) {
    const entry = byKey.get(key);
    if (!entry) throw new InvalidRulesPayload(`Rules payload is missing builtin rule "${key}".`);
    if (LOCKED_RULE_KEYS.has(key) && !entry.enabled) {
      throw new InvalidRulesPayload(`"${key}" is a locked rule and cannot be disabled.`);
    }
  }

  for (const rule of rules) {
    if (rule.source === 'custom' && BUILTIN_RULE_KEYS.has(rule.key)) {
      throw new InvalidRulesPayload(`Custom rule cannot reuse builtin key "${rule.key}".`);
    }
  }

  if (!rules.some((r) => r.enabled)) {
    throw new InvalidRulesPayload('At least one rule must remain enabled.');
  }
}

function validateToolsConfig(toolsConfig: readonly ToolToggle[]): void {
  const names = new Set(toolsConfig.map((t) => t.tool));
  for (const t of TOOL_CATALOG) {
    if (!names.has(t.name)) throw new InvalidToolsPayload(`tools_config is missing "${t.name}".`);
  }
}

function validateLimitsConfig(limitsConfig: readonly LimitToggle[]): void {
  const byKey = new Map(limitsConfig.map((l) => [l.key, l.value]));
  for (const entry of LIMIT_CATALOG) {
    const value = byKey.get(entry.key);
    if (value === undefined)
      throw new InvalidLimitsPayload(`limits_config is missing "${entry.key}".`);
    const bounds = clampLimitBounds(entry.key, value);
    if (!bounds.ok) {
      throw new InvalidLimitsPayload(
        `"${entry.key}" must be between ${bounds.min} and ${bounds.max}.`,
      );
    }
  }
}

export type BotConfigSave = {
  workspaceId: string;
  actorId: string;
  isProvisioned?: boolean;
  /** Omitted means leave alone; explicit null resets to DEFAULT_BOT_PROMPT. */
  prompt?: string | null;
  /** Omitted means leave alone; explicit null resets to the catalog baseline. */
  rules?: RuleEntry[] | null;
  /** Omitted means leave alone; explicit null resets to the catalog baseline. */
  toolsConfig?: ToolToggle[] | null;
  /** Omitted means leave alone; explicit null resets to the catalog baseline. */
  limitsConfig?: LimitToggle[] | null;
};

/**
 * The only way `bot_config` is written for an ordinary edit. `seedBotConfig`
 * below is the only OTHER writer, and it never calls this — see its own
 * before_value semantics.
 */
export async function saveBotConfig(tx: Tx, input: BotConfigSave): Promise<ResolvedBotConfig> {
  if (typeof input.prompt === 'string' && input.prompt.trim() === '') throw new EmptyBotPrompt();
  if (input.rules) validateRules(input.rules);
  if (input.toolsConfig) validateToolsConfig(input.toolsConfig);
  if (input.limitsConfig) validateLimitsConfig(input.limitsConfig);

  const [existing] = await tx
    .select({
      isProvisioned: botConfig.isProvisioned,
      prompt: botConfig.prompt,
      rules: botConfig.rules,
      toolsConfig: botConfig.toolsConfig,
      limitsConfig: botConfig.limitsConfig,
    })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, input.workspaceId))
    .limit(1);

  const beforeProvisioned = existing?.isProvisioned ?? false;
  const beforePrompt = existing?.prompt ?? DEFAULT_BOT_PROMPT;
  const beforeRules = (existing?.rules as RuleEntry[] | undefined) ?? buildBaselineRules();
  const beforeTools =
    (existing?.toolsConfig as ToolToggle[] | undefined) ?? buildBaselineToolsConfig();
  const beforeLimits =
    (existing?.limitsConfig as LimitToggle[] | undefined) ?? buildBaselineLimits();

  const afterProvisioned = input.isProvisioned ?? beforeProvisioned;
  const afterPrompt =
    input.prompt === undefined ? beforePrompt : (input.prompt ?? DEFAULT_BOT_PROMPT);
  const afterRules =
    input.rules === undefined ? beforeRules : (input.rules ?? buildBaselineRules());
  const afterTools =
    input.toolsConfig === undefined
      ? beforeTools
      : (input.toolsConfig ?? buildBaselineToolsConfig());
  const afterLimits =
    input.limitsConfig === undefined ? beforeLimits : (input.limitsConfig ?? buildBaselineLimits());

  await tx
    .insert(botConfig)
    .values({
      workspaceId: input.workspaceId,
      isProvisioned: afterProvisioned,
      prompt: afterPrompt,
      rules: afterRules,
      toolsConfig: afterTools,
      limitsConfig: afterLimits,
    })
    .onConflictDoUpdate({
      target: botConfig.workspaceId,
      set: {
        isProvisioned: afterProvisioned,
        prompt: afterPrompt,
        rules: afterRules,
        toolsConfig: afterTools,
        limitsConfig: afterLimits,
        updatedAt: new Date(),
      },
    });

  await appendChangeLog(tx, {
    workspaceId: input.workspaceId,
    entityType: BOT_CONFIG_ENTITY_TYPE,
    entityId: input.workspaceId,
    actorId: input.actorId,
    changes: [
      { field: 'is_provisioned', before: beforeProvisioned, after: afterProvisioned },
      { field: 'prompt', before: beforePrompt, after: afterPrompt },
      { field: 'rules', before: beforeRules, after: afterRules },
      { field: 'tools_config', before: beforeTools, after: afterTools },
      { field: 'limits_config', before: beforeLimits, after: afterLimits },
    ],
  });

  await appendBotConfigVersion(tx, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    prompt: afterPrompt,
    rules: afterRules,
    toolsConfig: afterTools,
    limitsConfig: afterLimits,
  });

  return resolved(afterProvisioned, afterPrompt, afterRules, afterTools, afterLimits);
}

/**
 * Materialises the catalog baseline into a real row — "version 1" (spec
 * "Seeding / baseline"). A workspace that already has a row is left
 * untouched. Deliberately does NOT call saveBotConfig: a first save's
 * before-values collapse to the baseline (nothing observably changed), which
 * would make appendChangeLog drop every field as a no-op — but the seed's
 * before_value must be `null` (genuinely never set), not "collapsed to
 * baseline", so the History panel shows a real "version 1" row. Also writes
 * the first bot_config_version row directly, since no prior version row
 * exists for appendBotConfigVersion's no-op guard to collapse against.
 */
export async function seedBotConfig(tx: Tx, workspaceId: string): Promise<ResolvedBotConfig> {
  const [existing] = await tx
    .select({ workspaceId: botConfig.workspaceId })
    .from(botConfig)
    .where(eq(botConfig.workspaceId, workspaceId))
    .limit(1);
  if (existing) return resolveBotConfig(tx, workspaceId);

  const actorId = await getOrCreateSystemActor(tx);

  const prompt = DEFAULT_BOT_PROMPT;
  const rules = buildBaselineRules();
  const toolsConfig = buildBaselineToolsConfig();
  const limitsConfig = buildBaselineLimits();

  await tx
    .insert(botConfig)
    .values({ workspaceId, isProvisioned: false, prompt, rules, toolsConfig, limitsConfig });

  await appendChangeLog(tx, {
    workspaceId,
    entityType: BOT_CONFIG_ENTITY_TYPE,
    entityId: workspaceId,
    actorId,
    changes: [
      { field: 'prompt', before: null, after: prompt },
      { field: 'rules', before: null, after: rules },
      { field: 'tools_config', before: null, after: toolsConfig },
      { field: 'limits_config', before: null, after: limitsConfig },
    ],
  });

  await appendBotConfigVersion(tx, {
    workspaceId,
    actorId,
    prompt,
    rules,
    toolsConfig,
    limitsConfig,
  });

  return resolved(false, prompt, rules, toolsConfig, limitsConfig);
}
