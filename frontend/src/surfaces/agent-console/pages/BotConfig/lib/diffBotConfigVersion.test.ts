import { describe, expect, it } from 'vitest';
import {
  diffLimitsConfig,
  diffPromptText,
  diffRules,
  diffToolsConfig,
} from './diffBotConfigVersion.ts';

describe('diffPromptText', () => {
  it('marks unchanged words as same and changed words as removed/added', () => {
    const tokens = diffPromptText('You are a helpful bot', 'You are a friendly bot');
    expect(tokens).toEqual([
      { text: 'You', type: 'same' },
      { text: 'are', type: 'same' },
      { text: 'a', type: 'same' },
      { text: 'helpful', type: 'removed' },
      { text: 'friendly', type: 'added' },
      { text: 'bot', type: 'same' },
    ]);
  });

  it('returns all-same tokens for identical text', () => {
    expect(diffPromptText('Same text', 'Same text')).toEqual([
      { text: 'Same', type: 'same' },
      { text: 'text', type: 'same' },
    ]);
  });
});

describe('diffRules', () => {
  const rule = (key: string, enabled: boolean) => ({
    key,
    text: `${key} text`,
    enabled,
    locked: false,
    source: 'builtin' as const,
    enforcement: 'prompt' as const,
  });

  it('reports an enabled flag flip as changed', () => {
    const entries = diffRules([rule('greeting', true)], [rule('greeting', false)]);
    expect(entries).toEqual([
      { key: 'greeting', kind: 'changed', description: 'Rule "greeting": enabled → disabled' },
    ]);
  });

  it('reports a rule present only in after as added', () => {
    const entries = diffRules([], [rule('greeting', true)]);
    expect(entries).toEqual([
      { key: 'greeting', kind: 'added', description: 'Rule "greeting" added' },
    ]);
  });

  it('reports a rule present only in before as removed', () => {
    const entries = diffRules([rule('greeting', true)], []);
    expect(entries).toEqual([
      { key: 'greeting', kind: 'removed', description: 'Rule "greeting" removed' },
    ]);
  });
});

describe('diffToolsConfig', () => {
  it('reports a tool enabled flip', () => {
    const entries = diffToolsConfig(
      [{ tool: 'search_articles', enabled: true }],
      [{ tool: 'search_articles', enabled: false }],
    );
    expect(entries).toEqual([
      {
        key: 'search_articles',
        kind: 'changed',
        description: 'Tool "search_articles": enabled → disabled',
      },
    ]);
  });

  it('reports a tool present only in after as added', () => {
    const entries = diffToolsConfig([], [{ tool: 'search_articles', enabled: true }]);
    expect(entries).toEqual([
      { key: 'search_articles', kind: 'added', description: 'Tool "search_articles" added' },
    ]);
  });

  it('reports a tool present only in before as removed', () => {
    const entries = diffToolsConfig([{ tool: 'search_articles', enabled: true }], []);
    expect(entries).toEqual([
      { key: 'search_articles', kind: 'removed', description: 'Tool "search_articles" removed' },
    ]);
  });
});

describe('diffLimitsConfig', () => {
  it('reports a limit value change', () => {
    const entries = diffLimitsConfig(
      [{ key: 'max_bot_messages', value: 3 }],
      [{ key: 'max_bot_messages', value: 5 }],
    );
    expect(entries).toEqual([
      {
        key: 'max_bot_messages',
        kind: 'changed',
        description: 'Limit "max_bot_messages": 3 → 5',
      },
    ]);
  });

  it('reports a limit present only in after as added', () => {
    const entries = diffLimitsConfig([], [{ key: 'max_bot_messages', value: 5 }]);
    expect(entries).toEqual([
      { key: 'max_bot_messages', kind: 'added', description: 'Limit "max_bot_messages" added' },
    ]);
  });

  it('reports a limit present only in before as removed', () => {
    const entries = diffLimitsConfig([{ key: 'max_bot_messages', value: 5 }], []);
    expect(entries).toEqual([
      {
        key: 'max_bot_messages',
        kind: 'removed',
        description: 'Limit "max_bot_messages" removed',
      },
    ]);
  });
});
