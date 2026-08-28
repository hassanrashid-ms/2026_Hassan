import type { ArticleAttachmentView } from '@support/types';

export type FieldDiffEntry = { key: string; description: string };

export function diffKeywords(before: string[], after: string[]): FieldDiffEntry[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((k) => !beforeSet.has(k));
  const removed = before.filter((k) => !afterSet.has(k));
  const entries: FieldDiffEntry[] = [];
  if (added.length) entries.push({ key: 'keywords-added', description: `Added: ${added.join(', ')}` });
  if (removed.length)
    entries.push({ key: 'keywords-removed', description: `Removed: ${removed.join(', ')}` });
  return entries;
}

export function diffAttachments(
  before: ArticleAttachmentView[],
  after: ArticleAttachmentView[],
): FieldDiffEntry[] {
  const beforeIds = new Set(before.map((a) => a.id));
  const afterIds = new Set(after.map((a) => a.id));
  const entries: FieldDiffEntry[] = [];
  for (const a of after) {
    if (!beforeIds.has(a.id)) entries.push({ key: `att-add-${a.id}`, description: `Added "${a.filename}"` });
  }
  for (const a of before) {
    if (!afterIds.has(a.id))
      entries.push({ key: `att-remove-${a.id}`, description: `Removed "${a.filename}"` });
  }
  return entries;
}
