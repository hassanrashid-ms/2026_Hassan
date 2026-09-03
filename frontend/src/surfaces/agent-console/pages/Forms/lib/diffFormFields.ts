import type { FormField } from '@support/types';

export type FormFieldDiffEntry = { key: string; kind: 'added' | 'removed' | 'changed'; description: string };

export function diffFormFields(before: FormField[], after: FormField[]): FormFieldDiffEntry[] {
  const beforeByKey = new Map(before.map((f) => [f.key, f]));
  const afterByKey = new Map(after.map((f) => [f.key, f]));
  const entries: FormFieldDiffEntry[] = [];

  for (const [key, field] of afterByKey) {
    const prior = beforeByKey.get(key);
    if (!prior) {
      entries.push({ key, kind: 'added', description: `Field "${field.label}" added` });
      continue;
    }
    if (prior.label !== field.label) {
      entries.push({
        key,
        kind: 'changed',
        description: `Field "${field.label}": label changed from "${prior.label}"`,
      });
    } else if (prior.isRequired !== field.isRequired) {
      entries.push({
        key,
        kind: 'changed',
        description: `Field "${field.label}": ${prior.isRequired ? 'required → optional' : 'optional → required'}`,
      });
    } else if (prior.type !== field.type) {
      entries.push({
        key,
        kind: 'changed',
        description: `Field "${field.label}": type changed from ${prior.type} to ${field.type}`,
      });
    } else if (JSON.stringify(prior.options) !== JSON.stringify(field.options)) {
      entries.push({ key, kind: 'changed', description: `Field "${field.label}": options changed` });
    }
  }
  for (const [key, field] of beforeByKey) {
    if (!afterByKey.has(key)) {
      entries.push({ key, kind: 'removed', description: `Field "${field.label}" removed` });
    }
  }
  return entries;
}
