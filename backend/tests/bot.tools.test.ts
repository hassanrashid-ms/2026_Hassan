import { describe, expect, it } from 'vitest';
import {
  CONFIRM_RESOLUTION_TOOL_NAME,
  TOOL_CATALOG,
  buildBaselineToolsConfig,
  toolsForPhase,
} from '../src/domain/bot/tools.ts';

const ALL_TOGGLEABLE = new Set(TOOL_CATALOG.map((t) => t.name));

describe('TOOL_CATALOG', () => {
  it('lists exactly the 4 toggleable tools, excluding handoff, all default-enabled and lockable', () => {
    expect(TOOL_CATALOG.map((t) => t.name)).toEqual([
      'search_articles',
      'classify',
      'answer_from_article',
      CONFIRM_RESOLUTION_TOOL_NAME,
    ]);
    expect(TOOL_CATALOG.every((t) => t.defaultEnabled && t.lockable)).toBe(true);
  });
});

describe('buildBaselineToolsConfig', () => {
  it('returns one enabled ToolToggle per catalog entry', () => {
    expect(buildBaselineToolsConfig()).toEqual(
      TOOL_CATALOG.map((t) => ({ tool: t.name, enabled: true })),
    );
  });
});

describe('toolsForPhase (deterministic gating)', () => {
  it("PARITY: with every toggleable tool enabled, matches today's tool array exactly, in order (handoff is always present)", () => {
    const bot_article = toolsForPhase('bot_article', ALL_TOGGLEABLE);
    const agent_ask = toolsForPhase('agent_ask', ALL_TOGGLEABLE);
    expect(bot_article).toHaveLength(5);
    expect(agent_ask).toHaveLength(4);
    expect((bot_article[4] as { function: { name: string } }).function.name).toBe(
      CONFIRM_RESOLUTION_TOOL_NAME,
    );
    expect(agent_ask.map((t) => (t as { function: { name: string } }).function.name)).toEqual([
      'search_articles',
      'classify',
      'answer_from_article',
      'handoff',
    ]);
  });

  it('drops a disabled tool without reordering the rest', () => {
    const enabled = new Set(['classify', 'answer_from_article', CONFIRM_RESOLUTION_TOOL_NAME]);
    const names = toolsForPhase('bot_article', enabled).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).toEqual([
      'classify',
      'answer_from_article',
      'handoff',
      CONFIRM_RESOLUTION_TOOL_NAME,
    ]);
  });

  it('never drops handoff, even when the enabled set is empty', () => {
    const names = toolsForPhase('agent_ask', new Set()).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).toEqual(['handoff']);
  });

  it('drops confirm_resolution outside bot_article regardless of the enabled set', () => {
    const names = toolsForPhase('agent_ask', ALL_TOGGLEABLE).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).not.toContain(CONFIRM_RESOLUTION_TOOL_NAME);
  });
});
