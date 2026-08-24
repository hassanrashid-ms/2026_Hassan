import type { FormFieldType } from '@support/types';

/** The visible text for a field the player did not answer. Never an empty cell. */
export const NOT_ANSWERED = 'Not answered';

function shortDate(value: string): string {
  // Answers are stored as YYYY-MM-DD. Parsed as UTC so a local timezone west of
  // Greenwich cannot render the day before the one the player picked.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Renders one answer, keyed on the field type the *answer row* snapshotted —
 * never the current version's type. That snapshot is why a value is
 * interpretable without resolving the version at all.
 */
export function formAnswerValue(
  fieldType: FormFieldType,
  value: unknown,
  answered: boolean,
): string {
  if (!answered || value === null || value === undefined) return NOT_ANSWERED;
  if (fieldType === 'attachment') return 'Attachment';
  if (fieldType === 'date' && typeof value === 'string') return shortDate(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
