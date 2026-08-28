// backend/src/domain/bot/tools.ts
import { eq } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { article } from '../../shared/db/schema/index.ts';
import { searchArticleIds } from '../../shared/weaviate/articlesIndex.ts';
import { logger } from '../../shared/logging/logger.ts';
import type { ConfirmPhaseValue } from '@support/types';
import type { SubintentOption } from './contextAssembly.ts';

export type ToolPhase = ConfirmPhaseValue;

export const CONFIRM_RESOLUTION_TOOL_NAME = 'confirm_resolution';

/**
 * Renamed from `offer_article` when the tool stopped shipping an article and
 * started shipping an answer drawn from one. The model reads this name as part
 * of its instructions, and the old one asked for the exact behaviour that was
 * the bug: "offer" invites "Here's an article that might help", which is a
 * pointer, and the player had nothing to point at.
 *
 * The `bot_article_offered` / `bot_article_rejected` event types and the
 * `bot_article` confirm phase deliberately keep their names. Those are written
 * history and the columns metrics already group by; renaming them would either
 * rewrite the past or split every article funnel in two at this deploy. The
 * article is still what is being offered — only the form changed.
 */
export const ANSWER_FROM_ARTICLE_TOOL_NAME = 'answer_from_article';

/**
 * Only fires the double-check banner — it never resolves anything itself. See
 * applyBotTurn's `confirm_player_resolution` case: this sets `confirm_phase =
 * 'player_stated'` and posts the bot's own "should I close this?" question, so
 * even a wrong call costs the player one discardable No tap, never an
 * unwanted resolve. `quoted_text` is required and is checked server-side
 * (toolLoop.ts) against the player's actual latest message — a call whose
 * `quoted_text` is not a verbatim substring of what the player just wrote is
 * rejected before it can move `confirm_phase` at all, the same class of
 * guard as `scoreGrounding` on `answer_from_article`.
 */
export const PLAYER_DECLARED_RESOLVED_TOOL_NAME = 'player_declared_resolved';

const ALWAYS_AVAILABLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_articles',
      description:
        'Search published help articles by natural-language query. No side effects. Call at most 3 times per turn.',
      strict: true,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'classify',
      description:
        "Record which category the player's problem falls into. Write-once: a second call in this conversation is ignored.",
      strict: true,
      parameters: {
        type: 'object',
        properties: { subintent_index: { type: 'integer' } },
        required: ['subintent_index'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: ANSWER_FROM_ARTICLE_TOOL_NAME,
      description:
        "Answer the player using one of the articles returned by search_articles this turn, and ask if it solved their problem. `answer` is what the player reads, so write it in the article's own words: reuse its sentences and its terms, keep every step, number and condition exactly as written, and change only what is needed to address this player's situation. Add nothing the article does not say.",
      strict: true,
      parameters: {
        type: 'object',
        properties: { article_id: { type: 'string' }, answer: { type: 'string' } },
        required: ['article_id', 'answer'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handoff',
      description: 'End the turn and connect the player to a human support agent.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: ['asked_for_person', 'no_article', 'sensitive'] },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },
] as const;

const CONFIRM_RESOLUTION_TOOL = {
  type: 'function',
  function: {
    name: CONFIRM_RESOLUTION_TOOL_NAME,
    description:
      'Record whether the offered article solved the player\'s problem. Only call this in direct response to the player answering "did this solve it?".',
    strict: true,
    parameters: {
      type: 'object',
      properties: { helped: { type: 'boolean' } },
      required: ['helped'],
      additionalProperties: false,
    },
  },
} as const;

const PLAYER_DECLARED_RESOLVED_TOOL = {
  type: 'function',
  function: {
    name: PLAYER_DECLARED_RESOLVED_TOOL_NAME,
    description:
      "Call this ONLY when the player's own latest message unprompted, unambiguously states their issue is now fixed, solved, or that they want this ticket closed — for example \"that fixed it, thanks\", \"this is resolved now\", \"please close this ticket\", \"you can close it\". This does not resolve the conversation by itself — it only asks the player to confirm. Do NOT call this for: thanks or acknowledgement of an answer alone (\"ok thanks\", \"got it\", \"cool\"), agreement to try a suggestion (\"I'll try that\", \"sure, I'll check\"), a new question, small talk, or anything ambiguous — in every one of those cases, keep answering or ask a clarifying question instead. `quoted_text` must be an exact, verbatim substring of the player's own latest message — the call is rejected and has no effect if it is not found verbatim in what they actually wrote.",
    strict: true,
    parameters: {
      type: 'object',
      properties: { quoted_text: { type: 'string' } },
      required: ['quoted_text'],
      additionalProperties: false,
    },
  },
} as const;

export const TOOL_DEFS = [
  ...ALWAYS_AVAILABLE_TOOLS,
  CONFIRM_RESOLUTION_TOOL,
  PLAYER_DECLARED_RESOLVED_TOOL,
];

export type ToolToggle = { tool: string; enabled: boolean };

/**
 * Declared in the same order ALWAYS_AVAILABLE_TOOLS already ships them, then
 * confirm_resolution, then player_declared_resolved — matches the doc's Tool
 * gating section. `handoff` is intentionally absent: always available, never
 * configurable.
 */
export const TOOL_CATALOG = [
  {
    name: 'search_articles',
    lockable: true,
    defaultEnabled: true,
    consequence: 'Bot can never look anything up; every turn ends in classify-only or handoff.',
  },
  {
    name: 'classify',
    lockable: true,
    defaultEnabled: true,
    consequence: 'Conversations stay unclassified from the bot; agents classify manually.',
  },
  {
    name: ANSWER_FROM_ARTICLE_TOOL_NAME,
    lockable: true,
    defaultEnabled: true,
    consequence:
      'Bot can search/classify but never answers itself — always hands off after searching.',
  },
  {
    name: CONFIRM_RESOLUTION_TOOL_NAME,
    lockable: true,
    defaultEnabled: true,
    consequence:
      'Article answers are never confirmed by the player; bot_active exits only via handoff or the turn cap.',
  },
  {
    name: PLAYER_DECLARED_RESOLVED_TOOL_NAME,
    lockable: true,
    defaultEnabled: true,
    consequence:
      'The bot never notices a player declaring their own issue resolved — the player must wait for the bot to offer an article or for an agent to ask instead.',
  },
] as const;

/** "Version 1" — every toggleable tool enabled, matching today's always-on behavior. */
export function buildBaselineToolsConfig(): ToolToggle[] {
  return TOOL_CATALOG.map((t) => ({ tool: t.name, enabled: true }));
}

/**
 * confirm_resolution is offered to the model only while confirm_phase =
 * 'bot_article' (spec 4 §3) AND it is enabled. player_declared_resolved is
 * offered only while confirm_phase = 'none' AND it is enabled — never
 * alongside confirm_resolution (a second yes/no question can't stack on a
 * first one that hasn't been answered yet), and never while some other phase
 * (agent_ask, form, inactivity_ask) already has a question on the player's
 * screen. `handoff`'s name is never checked against `enabledTools` — it always
 * passes the filter, so it stays exactly where ALWAYS_AVAILABLE_TOOLS already
 * puts it. Every other tool is dropped only if its name isn't in
 * `enabledTools`. Filter in place — never reorder: a disabled tool is simply
 * absent from the array sent to the model, which is the entire determinism
 * guarantee this function exists for.
 */
export function toolsForPhase(phase: ToolPhase, enabledTools: ReadonlySet<string>): unknown[] {
  const base =
    phase === 'bot_article'
      ? [...ALWAYS_AVAILABLE_TOOLS, CONFIRM_RESOLUTION_TOOL]
      : phase === 'none'
        ? [...ALWAYS_AVAILABLE_TOOLS, PLAYER_DECLARED_RESOLVED_TOOL]
        : [...ALWAYS_AVAILABLE_TOOLS];
  return base.filter((t) => t.function.name === 'handoff' || enabledTools.has(t.function.name));
}

export type SearchArticlesResult = { id: string; title: string; body: string }[];

/** Hybrid retrieval fired against the model's own phrased query, not the player's raw words (spec §3). */
export async function searchArticles(
  tx: Tx,
  workspaceId: string,
  query: string,
): Promise<SearchArticlesResult> {
  const ids = await searchArticleIds(query, { workspaceId, limit: 5 });
  if (ids.length === 0) {
    logger.info('bot.search', 'no index hits', { workspaceId, query });
    return [];
  }

  const rows = await tx
    .select({ id: article.id, title: article.title, body: article.body })
    .from(article)
    .where(eq(article.workspaceId, workspaceId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolved = ids
    .map((id) => byId.get(id))
    .filter((r): r is { id: string; title: string; body: string } => r !== undefined);

  // Index drift: Weaviate returned an article id with no row behind it, so the
  // hit is silently dropped and the model sees fewer results than retrieval
  // actually ranked. Warned rather than thrown — a stale index entry must not
  // fail a player's turn — but it is a real defect in the index, not noise, and
  // it costs a slot that a live article would otherwise have filled.
  if (resolved.length < ids.length) {
    const orphans = ids.filter((id) => !byId.has(id));
    logger.warn(
      'bot.search',
      'weaviate returned article ids with no matching row — index is stale',
      {
        workspaceId,
        query,
        orphanIds: orphans,
        ranked: ids.length,
        returned: resolved.length,
      },
    );
  }

  return resolved;
}

/** Null on an out-of-range index — toolLoop maps that to the Other fallback, same as an explicit Other choice. */
export function resolveClassifyIndex(
  options: SubintentOption[],
  index: number,
): SubintentOption | null {
  return options.find((o) => o.index === index) ?? null;
}
