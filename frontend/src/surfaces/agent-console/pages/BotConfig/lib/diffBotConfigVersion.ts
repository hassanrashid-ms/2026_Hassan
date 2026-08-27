import type { LimitToggleValue, RuleEntryView, ToolToggleValue } from '@support/types';

export type PromptDiffToken = { text: string; type: 'same' | 'added' | 'removed' };
export type StructuredDiffEntry = { key: string; kind: 'added' | 'removed' | 'changed'; description: string };

/**
 * Word-level LCS diff. No external dependency: bot prompts are a few hundred
 * words at most, well within an O(n*m) dynamic-programming table.
 */
export function diffPromptText(before: string, after: string): PromptDiffToken[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);

  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const tokens: PromptDiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      tokens.push({ text: a[i]!, type: 'same' });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      tokens.push({ text: a[i]!, type: 'removed' });
      i++;
    } else {
      tokens.push({ text: b[j]!, type: 'added' });
      j++;
    }
  }
  while (i < a.length) tokens.push({ text: a[i++]!, type: 'removed' });
  while (j < b.length) tokens.push({ text: b[j++]!, type: 'added' });

  return tokens;
}

export function diffRules(before: RuleEntryView[], after: RuleEntryView[]): StructuredDiffEntry[] {
  const beforeByKey = new Map(before.map((r) => [r.key, r]));
  const afterByKey = new Map(after.map((r) => [r.key, r]));
  const entries: StructuredDiffEntry[] = [];

  for (const [key, rule] of afterByKey) {
    const prior = beforeByKey.get(key);
    if (!prior) {
      entries.push({ key, kind: 'added', description: `Rule "${key}" added` });
    } else if (prior.enabled !== rule.enabled) {
      entries.push({
        key,
        kind: 'changed',
        description: `Rule "${key}": ${prior.enabled ? 'enabled' : 'disabled'} → ${rule.enabled ? 'enabled' : 'disabled'}`,
      });
    } else if (prior.text !== rule.text) {
      entries.push({ key, kind: 'changed', description: `Rule "${key}" text changed` });
    }
  }
  for (const key of beforeByKey.keys()) {
    if (!afterByKey.has(key)) entries.push({ key, kind: 'removed', description: `Rule "${key}" removed` });
  }
  return entries;
}

export function diffToolsConfig(
  before: ToolToggleValue[],
  after: ToolToggleValue[],
): StructuredDiffEntry[] {
  const beforeByTool = new Map(before.map((t) => [t.tool, t]));
  const entries: StructuredDiffEntry[] = [];
  for (const t of after) {
    const prior = beforeByTool.get(t.tool);
    if (prior && prior.enabled !== t.enabled) {
      entries.push({
        key: t.tool,
        kind: 'changed',
        description: `Tool "${t.tool}": ${prior.enabled ? 'enabled' : 'disabled'} → ${t.enabled ? 'enabled' : 'disabled'}`,
      });
    }
  }
  return entries;
}

export function diffLimitsConfig(
  before: LimitToggleValue[],
  after: LimitToggleValue[],
): StructuredDiffEntry[] {
  const beforeByKey = new Map(before.map((l) => [l.key, l]));
  const entries: StructuredDiffEntry[] = [];
  for (const l of after) {
    const prior = beforeByKey.get(l.key);
    if (prior && prior.value !== l.value) {
      entries.push({
        key: l.key,
        kind: 'changed',
        description: `Limit "${l.key}": ${prior.value} → ${l.value}`,
      });
    }
  }
  return entries;
}
