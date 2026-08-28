import { describe, expect, it } from 'vitest';
import { NOT_ANSWERED, formAnswerValue } from './formAnswerValue.ts';

describe('formAnswerValue', () => {
  // The row exists precisely so this string is visible. Never an empty cell.
  it('labels an unanswered field', () => {
    expect(formAnswerValue('short_text', null, false)).toBe(NOT_ANSWERED);
    expect(NOT_ANSWERED).toBe('Not answered');
  });

  it('renders text and choice answers verbatim', () => {
    expect(formAnswerValue('short_text', 'GPA.1234', true)).toBe('GPA.1234');
    expect(formAnswerValue('long_text', 'It charged me twice', true)).toBe('It charged me twice');
    expect(formAnswerValue('choice', 'Google Play', true)).toBe('Google Play');
  });

  it('formats a date answer', () => {
    expect(formAnswerValue('date', '2026-08-16', true)).toBe('16 Aug 2026');
  });

  // The type comes off the answer row, not off the current version. Same value,
  // different snapshotted type, different rendering — which is what makes a v1
  // answer still readable after v2 retypes the field.
  it('renders by the snapshotted type, not by the value shape', () => {
    expect(formAnswerValue('short_text', '2026-08-16', true)).toBe('2026-08-16');
  });

  it('renders numbers and times', () => {
    expect(formAnswerValue('number', 3, true)).toBe('3');
    expect(formAnswerValue('number', 0, true)).toBe('0');
    expect(formAnswerValue('time', '14:30', true)).toBe('14:30');
  });

  it('does not crash on an unparseable date or an unexpected shape', () => {
    expect(formAnswerValue('date', 'not-a-date', true)).toBe('not-a-date');
    expect(formAnswerValue('short_text', { a: 1 }, true)).toBe('{"a":1}');
    expect(formAnswerValue('short_text', null, true)).toBe(NOT_ANSWERED);
  });

  // FormPanel resolves an attachment answer into a thumbnail itself and never
  // calls this function for one — this is the fallback for the one case it
  // can't render: a resolved-attachment lookup/presign failure, which leaves
  // the raw `{ attachmentId }` shape in place. Naming it beats dumping the raw id.
  it('names an attachment rather than dumping it', () => {
    expect(formAnswerValue('attachment', { attachmentId: 'abc' }, true)).toBe('Attachment');
  });
});
