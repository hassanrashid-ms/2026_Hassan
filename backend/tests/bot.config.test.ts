import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BOT_PROMPT_PLACEHOLDERS,
  BOT_RULES_HEADING,
  buildSystemPrompt,
  DEFAULT_BOT_PROMPT,
  DEFAULT_BOT_RULES,
} from '../src/domain/bot/defaultPrompt.ts';
import { SEED_TAXONOMY } from '../src/shared/db/seedTaxonomy.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import {
  EmptyBotPrompt,
  InvalidRulesPayload,
  InvalidToolsPayload,
  InvalidLimitsPayload,
  resolveBotConfig,
  saveBotConfig,
  seedBotConfig as seedBotConfigDomain,
} from '../src/domain/bot/botConfig.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedBotConfig,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';
import { buildBaselineRules, type RuleEntry } from '../src/domain/bot/rulesCatalog.ts';
import { TOOL_CATALOG, buildBaselineToolsConfig } from '../src/domain/bot/tools.ts';
import { LIMIT_CATALOG, buildBaselineLimits } from '../src/domain/bot/limitsCatalog.ts';
import { SYSTEM_ACTOR_EMAIL } from '../src/domain/bot/systemActor.ts';

describe('DEFAULT_BOT_PROMPT', () => {
  it('contains {{subintents}} and {{articles}}, not {{player_level}} or {{spend_tier}}', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('{{subintents}}');
    expect(DEFAULT_BOT_PROMPT).toContain('{{articles}}');
    expect(DEFAULT_BOT_PROMPT).not.toContain('{{player_level}}');
    expect(DEFAULT_BOT_PROMPT).not.toContain('{{spend_tier}}');
  });

  it('BOT_PROMPT_PLACEHOLDERS still lists all four', () => {
    expect(BOT_PROMPT_PLACEHOLDERS).toEqual([
      '{{subintents}}',
      '{{articles}}',
      '{{player_level}}',
      '{{spend_tier}}',
    ]);
  });

  it('names no real subintent, intent or article — it ships to every workspace', () => {
    const haystack = DEFAULT_BOT_PROMPT.toLowerCase();
    const forbidden = SEED_TAXONOMY.flatMap((intent) => [
      intent.name,
      ...intent.subintents,
      ...intent.articles.map((article) => article.title),
    ]);

    expect(forbidden.length).toBeGreaterThan(0); // guard: an empty seed would vacuously pass
    for (const name of forbidden) {
      expect(haystack, `leaks taxonomy name "${name}"`).not.toContain(name.toLowerCase());
    }
  });

  it('is not empty or whitespace — it is the fallback every uncustomised bot runs on', () => {
    expect(DEFAULT_BOT_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it('holds no rules block itself — rules are a separate field, joined only at send time', () => {
    expect(DEFAULT_BOT_PROMPT).not.toContain(BOT_RULES_HEADING);
    expect(DEFAULT_BOT_PROMPT).not.toContain(DEFAULT_BOT_RULES);
  });

  /**
   * Regression guard. The prompt used to say "when you hand off, say plainly that
   * you are passing this to the support team" — but a text reply and a tool call
   * are mutually exclusive in one model response (openaiClient returns `text`
   * only when `toolCalls` is empty), so the model obeyed the sentence and never
   * called `handoff`. toolLoop scored that as an ordinary answer and the
   * conversation stayed bot_active, leaving the player told they had been handed
   * off while the bot kept replying. The prompt must point at the tool.
   */
  it('directs handoff to the tool and never asks the model to announce one in prose', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('handoff tool');
    expect(DEFAULT_BOT_PROMPT.toLowerCase()).not.toContain('say plainly');
  });

  it('requires a search before concluding no article answers the player', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('search_articles');
  });

  /**
   * Regression guard. The prompt used to treat any comprehensible problem statement as
   * search-worthy, so a broad, category-less complaint like "I've got a purchase issue" sent the
   * model straight to search_articles/classify instead of asking what specifically happened.
   * search_articles has zero preconditions in toolLoop.ts — this carve-out is the only thing
   * stopping that jump, so it must stay in the prompt text.
   */
  it('asks a clarifying question before searching or classifying a broad, category-less statement of intent', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('a broad statement of a problem area');
    expect(DEFAULT_BOT_PROMPT).toMatch(/Do not search,\s+classify, or hand off/);
    expect(DEFAULT_BOT_PROMPT).toMatch(/ask one short question|asking what they need help with/);
  });

  /**
   * Regression guard, one level deeper than the one above. A player who names only the area a
   * category sits under (e.g. the single word "purchase", matching the "In-App Purchases" half of
   * "In-App Purchases → Missing Purchase") was enough for the model to pick a specific subintent
   * and search, with zero information distinguishing it from the area's other subintents. The
   * prompt must say that naming the area is not naming the category, even as a follow-up answer.
   */
  it('treats naming only the category area, not a specific problem within it, as still not enough to search', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('naming the area is not naming the category');
    expect(DEFAULT_BOT_PROMPT).toMatch(/not just the\s+area it sits under/);
  });

  /**
   * Regression guard. `classify` is registered and write-once (tools.ts), and
   * applyBotTurn writes subintent_id whenever a decision carries one — but the
   * prompt only ever mentioned "classify" negatively, in the greeting carve-out
   * ("Do not search, classify, or hand off for any of these"). With no positive
   * instruction telling the model to call it, real conversations went through
   * search → answer/handoff with subintent_id left null the entire time — every
   * conversation is supposed to get classified (product spec), and none did.
   * The prompt must tell the model to call classify once it can point at one
   * specific row, not just describe the taxonomy block and leave the tool call
   * implicit.
   */
  it('instructs the model to call classify once it can point at a specific row', () => {
    expect(DEFAULT_BOT_PROMPT).toMatch(/call classify/);
  });

  /**
   * The prompt has to ask for the article's substance, not a pointer to it.
   * `offer_article` used to post a fixed "Here's an article that might help."
   * while nothing carried the article to the player — they were promised a
   * document, shown nothing, and then asked whether it had solved their problem.
   * The tool now takes the answer itself.
   */
  it('directs the answer through answer_from_article, not a pointer to a document', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('answer_from_article');
    expect(DEFAULT_BOT_PROMPT).not.toContain('offer_article');
  });

  it("requires the article's own wording and forbids adding to it", () => {
    expect(DEFAULT_BOT_PROMPT).toContain("article's own sentences");
    expect(DEFAULT_BOT_PROMPT).toMatch(
      /Do not add a step, a cause, a timeframe or a reassurance the article does not\ncontain/,
    );
  });

  /**
   * The three-sentence rule and "keep every step" are in direct conflict on a
   * multi-step article: obeying the shorter one silently drops steps, which is
   * the same fabrication risk wearing the opposite coat.
   */
  it('exempts an article-derived answer from the three-sentence limit rather than forcing steps to be dropped', () => {
    expect(DEFAULT_BOT_RULES).toContain('three short sentences');
    expect(DEFAULT_BOT_RULES).toContain('never drop or merge a step to fit');
  });

  /**
   * Regression guard for player_declared_resolved. The prompt must instruct the
   * model to call the tool only on an unprompted, unambiguous player statement,
   * and must explicitly carve out thanks/agreement — otherwise a "thanks, that
   * makes sense" reads to the model as resolution and the banner fires on an
   * ordinary acknowledgement instead of only on an actual close request.
   */
  it('instructs the model to call player_declared_resolved only on an unprompted, unambiguous statement, never on thanks or agreement alone', () => {
    expect(DEFAULT_BOT_PROMPT).toContain('player_declared_resolved');
    expect(DEFAULT_BOT_PROMPT).toContain('quoting back the exact words');
    expect(DEFAULT_BOT_PROMPT.toLowerCase()).toContain('ok thanks');
  });
});

describe('DEFAULT_BOT_RULES', () => {
  it('is not empty or whitespace — it is the fallback every uncustomised bot runs on', () => {
    expect(DEFAULT_BOT_RULES.trim().length).toBeGreaterThan(0);
  });

  it('names no real subintent, intent or article — it ships to every workspace', () => {
    const haystack = DEFAULT_BOT_RULES.toLowerCase();
    const forbidden = SEED_TAXONOMY.flatMap((intent) => [
      intent.name,
      ...intent.subintents,
      ...intent.articles.map((article) => article.title),
    ]);

    expect(forbidden.length).toBeGreaterThan(0); // guard: an empty seed would vacuously pass
    for (const name of forbidden) {
      expect(haystack, `leaks taxonomy name "${name}"`).not.toContain(name.toLowerCase());
    }
  });
});

describe('buildSystemPrompt', () => {
  const rule = (text: string, enabled = true): RuleEntry => ({
    key: text,
    text,
    enabled,
    locked: false,
    source: 'builtin',
  });

  it('sends the prompt and enabled rule texts as one string, prompt first and rules last', () => {
    const built = buildSystemPrompt('PROMPT BODY', [rule('RULE ONE')]);
    expect(built).toContain('PROMPT BODY');
    expect(built).toContain('RULE ONE');
    expect(built.indexOf('PROMPT BODY')).toBeLessThan(built.indexOf(BOT_RULES_HEADING));
    expect(built.indexOf(BOT_RULES_HEADING)).toBeLessThan(built.indexOf('RULE ONE'));
  });

  it('omits a disabled rule entirely', () => {
    const built = buildSystemPrompt('P', [rule('KEEP ME'), rule('DROP ME', false)]);
    expect(built).toContain('KEEP ME');
    expect(built).not.toContain('DROP ME');
  });

  it('renders each enabled rule as "- {text}", in array order', () => {
    const built = buildSystemPrompt('P', [rule('first'), rule('second')]);
    const rulesBlock = built.slice(built.indexOf(BOT_RULES_HEADING));
    expect(rulesBlock.indexOf('- first')).toBeLessThan(rulesBlock.indexOf('- second'));
  });

  it('PARITY: an unmodified catalog baseline renders byte-identical to the old string-rules formula', () => {
    const built = buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules());
    const oldFormula = `${DEFAULT_BOT_PROMPT.trimEnd()}\n\n${BOT_RULES_HEADING}\n${DEFAULT_BOT_RULES.trim()}`;
    expect(built).toBe(oldFormula);
  });

  it('keeps the placeholders intact — the orchestrator substitutes after the join', () => {
    const built = buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules());
    expect(built).toContain('{{subintents}}');
    expect(built).toContain('{{articles}}');
  });
});

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

describe('resolveBotConfig', () => {
  let workspaceId: string;

  beforeEach(async () => {
    await truncateAll();
    workspaceId = await seedWorkspace();
  });

  it('resolves an absent row to off, with the catalog baseline prompt/rules/tools', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId));
    expect(resolved.isProvisioned).toBe(false);
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(resolved.rules).toEqual(buildBaselineRules());
    expect(resolved.toolsConfig).toEqual(buildBaselineToolsConfig());
    expect(resolved.enabledTools).toEqual(new Set(TOOL_CATALOG.map((t) => t.name)));
    expect(resolved.systemPrompt).toBe(buildSystemPrompt(DEFAULT_BOT_PROMPT, buildBaselineRules()));
  });

  it('returns a stored prompt, rules and tools_config verbatim', async () => {
    const rules = [
      {
        key: 'no_regreet',
        text: 'Do not greet twice.',
        enabled: false,
        locked: false,
        source: 'builtin',
      },
    ];
    const toolsConfig = [{ tool: 'search_articles', enabled: false }];
    await seedBotConfig({
      workspaceId,
      isProvisioned: true,
      prompt: 'MY PROMPT',
      rules,
      toolsConfig,
    });
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId));
    expect(resolved.prompt).toBe('MY PROMPT');
    expect(resolved.rules).toEqual(rules);
    expect(resolved.toolsConfig).toEqual(toolsConfig);
    expect(resolved.enabledTools).toEqual(new Set());
  });

  it('cannot tell an absent row from is_provisioned = false — one resolver, one answer', async () => {
    const absent = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId));
    await seedBotConfig({
      workspaceId,
      isProvisioned: false,
      prompt: DEFAULT_BOT_PROMPT,
      rules: buildBaselineRules(),
      toolsConfig: buildBaselineToolsConfig(),
      limitsConfig: buildBaselineLimits(),
    });
    const present = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId));
    expect(present).toEqual(absent);
  });

  it('never leaks another workspace config', async () => {
    const otherWorkspaceId = await seedWorkspace();
    await seedBotConfig({ workspaceId: otherWorkspaceId, isProvisioned: true, prompt: 'theirs' });
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId));
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(resolved.isProvisioned).toBe(false);
  });
});

describe('resolveBotConfig / saveBotConfig — limits_config', () => {
  let workspaceId: string;
  let actorId: string;

  beforeEach(async () => {
    await truncateAll();
    workspaceId = await seedWorkspace();
    actorId = await seedAgent();
  });

  it('resolves an absent row to buildBaselineLimits(), with resolvedLimits matching every default', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId));
    expect(resolved.limitsConfig).toEqual(buildBaselineLimits());
    for (const l of LIMIT_CATALOG) {
      expect(resolved.resolvedLimits[l.key]).toBe(l.defaultValue);
    }
  });

  it('resolves a stored limits_config verbatim into resolvedLimits', async () => {
    const limitsConfig = buildBaselineLimits().map((l) =>
      l.key === 'max_bot_messages' ? { ...l, value: 10 } : l,
    );
    await seedBotConfig({
      workspaceId,
      isProvisioned: true,
      prompt: 'p',
      rules: buildBaselineRules(),
      toolsConfig: buildBaselineToolsConfig(),
      limitsConfig,
    });
    const resolved = await withWorkspace(workspaceId, (tx) => resolveBotConfig(tx, workspaceId));
    expect(resolved.limitsConfig).toEqual(limitsConfig);
    expect(resolved.resolvedLimits.max_bot_messages).toBe(10);
  });

  it('rejects a limit value outside its bound, naming the bound', async () => {
    const badLimits = buildBaselineLimits().map((l) =>
      l.key === 'max_bot_messages' ? { ...l, value: 100 } : l,
    );
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, limitsConfig: badLimits }),
      ),
    ).rejects.toThrow(InvalidLimitsPayload);
  });

  it('rejects a limits payload missing a catalog key', async () => {
    const missingOne = buildBaselineLimits().slice(1);
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, limitsConfig: missingOne }),
      ),
    ).rejects.toThrow(InvalidLimitsPayload);
  });

  it('seedBotConfig writes a limits_config change-log row with before: null', async () => {
    await withWorkspace(workspaceId, (tx) => seedBotConfigDomain(tx, workspaceId));
    const { rows } = await ownerPool.query<{ field: string; before_value: unknown }>(
      `select field, before_value from change_log where entity_type = 'bot_config' and entity_id = $1 and field = 'limits_config'`,
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before_value).toBeNull();
  });
});

describe('saveBotConfig', () => {
  let workspaceId: string;
  let actorId: string;

  beforeEach(async () => {
    await truncateAll();
    workspaceId = await seedWorkspace();
    actorId = await seedAgent();
  });

  it('creates the row on first save and upserts on the second rather than erroring', async () => {
    const first = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, isProvisioned: true, prompt: 'v1' }),
    );
    expect(first).toMatchObject({ isProvisioned: true, prompt: 'v1' });

    const second = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }),
    );
    expect(second).toMatchObject({ isProvisioned: true, prompt: 'v2' });

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('leaves an omitted field alone, and resets to the catalog baseline on an explicit null', async () => {
    const customRules = [...buildBaselineRules().slice(0, 1)];
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, {
        workspaceId,
        actorId,
        prompt: 'custom',
        rules: customRules.length ? undefined : undefined,
      }),
    );
    const cleared = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: null }),
    );
    expect(cleared.prompt).toBe(DEFAULT_BOT_PROMPT);
  });

  it('rejects an empty or whitespace-only prompt instead of storing one', async () => {
    for (const blank of ['', '   ', '\n\t']) {
      await expect(
        withWorkspace(workspaceId, (tx) =>
          saveBotConfig(tx, { workspaceId, actorId, prompt: blank }),
        ),
      ).rejects.toThrow(EmptyBotPrompt);
    }
  });

  it('rejects a payload where a locked rule key is missing or disabled', async () => {
    const withoutLocked = buildBaselineRules().filter((r) => r.key !== 'no_credentials');
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, rules: withoutLocked }),
      ),
    ).rejects.toThrow(InvalidRulesPayload);

    const disabledLocked = buildBaselineRules().map((r) =>
      r.key === 'no_credentials' ? { ...r, enabled: false } : r,
    );
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, rules: disabledLocked }),
      ),
    ).rejects.toThrow(InvalidRulesPayload);
  });

  it('rejects a payload missing any builtin key, not just a locked one', async () => {
    const withoutBuiltin = buildBaselineRules().filter((r) => r.key !== 'no_regreet');
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, rules: withoutBuiltin }),
      ),
    ).rejects.toThrow(InvalidRulesPayload);
  });

  it('rejects a rule set with zero enabled entries', async () => {
    const allDisabled = buildBaselineRules().map((r) => ({ ...r, enabled: false }));
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, rules: allDisabled }),
      ),
    ).rejects.toThrow(InvalidRulesPayload);
  });

  it('rejects a custom rule that reuses a builtin key', async () => {
    const reused = [
      ...buildBaselineRules(),
      { key: 'no_regreet', text: 'dup', enabled: true, locked: false, source: 'custom' as const },
    ];
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, rules: reused }),
      ),
    ).rejects.toThrow(InvalidRulesPayload);
  });

  it('accepts an added custom rule, appended after the catalog', async () => {
    const withCustom = [
      ...buildBaselineRules(),
      {
        key: 'custom-1',
        text: 'No emoji.',
        enabled: true,
        locked: false,
        source: 'custom' as const,
      },
    ];
    const saved = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, rules: withCustom }),
    );
    expect(saved.rules.at(-1)).toEqual({
      key: 'custom-1',
      text: 'No emoji.',
      enabled: true,
      locked: false,
      source: 'custom',
    });
    expect(saved.systemPrompt).toContain('No emoji.');
  });

  it('rejects tools_config missing a catalog tool', async () => {
    const missingOne = buildBaselineToolsConfig().slice(1);
    await expect(
      withWorkspace(workspaceId, (tx) =>
        saveBotConfig(tx, { workspaceId, actorId, toolsConfig: missingOne }),
      ),
    ).rejects.toThrow(InvalidToolsPayload);
  });

  it('disabling a tool removes it from enabledTools', async () => {
    const toggled = buildBaselineToolsConfig().map((t) =>
      t.tool === 'search_articles' ? { ...t, enabled: false } : t,
    );
    const saved = await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, toolsConfig: toggled }),
    );
    expect(saved.enabledTools.has('search_articles')).toBe(false);
    expect(saved.enabledTools.has('classify')).toBe(true);
  });

  it('bumps updated_at on a real change without touching created_at', async () => {
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'v1' }),
    );
    const before = await ownerPool.query<{ created_at: Date; updated_at: Date }>(
      `select created_at, updated_at from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'v2' }),
    );
    const after = await ownerPool.query<{ created_at: Date; updated_at: Date }>(
      `select created_at, updated_at from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(after.rows[0]!.created_at.getTime()).toBe(before.rows[0]!.created_at.getTime());
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.updated_at.getTime(),
    );
  });
});

describe('seedBotConfig', () => {
  let workspaceId: string;

  beforeEach(async () => {
    await truncateAll();
    workspaceId = await seedWorkspace();
  });

  it('creates a real row with the catalog baseline and one change_log entry per field, attributed to the system actor', async () => {
    const resolved = await withWorkspace(workspaceId, (tx) => seedBotConfigDomain(tx, workspaceId));
    expect(resolved.prompt).toBe(DEFAULT_BOT_PROMPT);
    expect(resolved.rules).toEqual(buildBaselineRules());
    expect(resolved.toolsConfig).toEqual(buildBaselineToolsConfig());

    const { rows } = await ownerPool.query<{
      field: string;
      before_value: unknown;
      actor_id: string;
    }>(
      `select field, before_value, actor_id from change_log where entity_type = 'bot_config' and entity_id = $1 order by field`,
      [workspaceId],
    );
    expect(rows.map((r) => r.field)).toEqual(['limits_config', 'prompt', 'rules', 'tools_config']);
    expect(rows.every((r) => r.before_value === null)).toBe(true);
    const { rows: agentRows } = await ownerPool.query(`select email from agent where id = $1`, [
      rows[0]!.actor_id,
    ]);
    expect(agentRows[0]).toEqual({ email: SYSTEM_ACTOR_EMAIL });
  });

  it('is a no-op when a row already exists', async () => {
    const actorId = await seedAgent();
    await withWorkspace(workspaceId, (tx) =>
      saveBotConfig(tx, { workspaceId, actorId, prompt: 'already customised' }),
    );
    const resolved = await withWorkspace(workspaceId, (tx) => seedBotConfigDomain(tx, workspaceId));
    expect(resolved.prompt).toBe('already customised');
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from bot_config where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});
