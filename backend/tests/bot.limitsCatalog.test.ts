import { describe, expect, it } from 'vitest';
import {
  LIMIT_CATALOG,
  buildBaselineLimits,
  clampLimitBounds,
} from '../src/domain/bot/limitsCatalog.ts';

describe('LIMIT_CATALOG', () => {
  it("lists exactly the 4 limit keys, in order, matching today's hardcoded constants as defaults", () => {
    expect(LIMIT_CATALOG.map((l) => l.key)).toEqual([
      'max_bot_messages',
      'max_tool_calls_per_turn',
      'max_articles_per_turn',
      'max_unhelped_replies',
    ]);
    const byKey = new Map(LIMIT_CATALOG.map((l) => [l.key, l.defaultValue]));
    expect(byKey.get('max_bot_messages')).toBe(8);
    expect(byKey.get('max_tool_calls_per_turn')).toBe(6);
    expect(byKey.get('max_articles_per_turn')).toBe(3);
    expect(byKey.get('max_unhelped_replies')).toBe(3);
  });

  it('every entry has min <= defaultValue <= max', () => {
    for (const l of LIMIT_CATALOG) {
      expect(l.min).toBeLessThanOrEqual(l.defaultValue);
      expect(l.defaultValue).toBeLessThanOrEqual(l.max);
    }
  });
});

describe('buildBaselineLimits', () => {
  it('returns one LimitToggle per catalog entry, at its default value, in catalog order', () => {
    expect(buildBaselineLimits()).toEqual(
      LIMIT_CATALOG.map((l) => ({ key: l.key, value: l.defaultValue })),
    );
  });
});

describe('clampLimitBounds', () => {
  it('accepts a value within [min, max]', () => {
    expect(clampLimitBounds('max_bot_messages', 8)).toEqual({ ok: true });
  });

  it('rejects a value outside [min, max], naming the actual bound', () => {
    const result = clampLimitBounds('max_bot_messages', 100);
    expect(result).toEqual({ ok: false, min: 3, max: 20 });
  });
});
