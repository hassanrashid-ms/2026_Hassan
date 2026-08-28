import type { FormSubmissionStatus } from '@support/types';

/**
 * The one line under the form's name. Split out for the same reason
 * ticketOutcome is: it is the piece with real branching, and it is testable
 * without mounting anything.
 *
 * Four statuses, four sentences. `skipped` never reads as an absence — the
 * player declined, and the agent has to know to ask rather than wonder where
 * the details went.
 */
export function formStatusLine(
  status: FormSubmissionStatus,
  answeredCount: number,
  fieldCount: number,
): string {
  switch (status) {
    case 'in_progress':
      return `Player is answering · ${answeredCount} of ${fieldCount}`;
    case 'completed':
      return `All ${fieldCount} question${fieldCount === 1 ? '' : 's'} answered`;
    case 'partial':
      return `${answeredCount} answered · ${fieldCount - answeredCount} not answered`;
    case 'skipped':
      return 'Player skipped the questions';
  }
}
