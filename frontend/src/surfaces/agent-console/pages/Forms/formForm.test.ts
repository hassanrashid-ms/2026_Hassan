import { describe, expect, it } from 'vitest';
import type { FormField } from '@support/types';
import {
  BUILDER_FIELD_TYPES,
  canPublish,
  formStatusLabel,
  isBuilderFieldType,
  slugifyKey,
  renumberPositions,
  validateFields,
} from './formForm.ts';

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    key: 'k',
    label: 'Label',
    type: 'short_text',
    isRequired: false,
    position: 0,
    ...overrides,
  };
}

describe('validateFields', () => {
  it('accepts an empty list', () => {
    expect(validateFields([])).toEqual([]);
  });

  it('accepts a well-formed set of fields', () => {
    expect(
      validateFields([
        field({ key: 'a', position: 0 }),
        field({ key: 'b', position: 1, type: 'choice', options: ['x', 'y'] }),
      ]),
    ).toEqual([]);
  });

  it('rejects a duplicate key', () => {
    const errors = validateFields([
      field({ key: 'a', position: 0 }),
      field({ key: 'a', position: 1 }),
    ]);
    expect(errors.some((e) => e.includes('Duplicate field key'))).toBe(true);
  });

  it('rejects a duplicate position', () => {
    const errors = validateFields([
      field({ key: 'a', position: 0 }),
      field({ key: 'b', position: 0 }),
    ]);
    expect(errors.some((e) => e.includes('Duplicate field position'))).toBe(true);
  });

  it('rejects a choice field with fewer than 2 options', () => {
    const errors = validateFields([field({ key: 'a', type: 'choice', options: ['only-one'] })]);
    expect(errors.some((e) => e.includes('needs at least 2 options'))).toBe(true);
  });

  it('rejects a choice field with no options at all', () => {
    const errors = validateFields([field({ key: 'a', type: 'choice' })]);
    expect(errors.some((e) => e.includes('needs at least 2 options'))).toBe(true);
  });

  it('rejects a non-choice field carrying options', () => {
    const errors = validateFields([field({ key: 'a', type: 'short_text', options: ['x', 'y'] })]);
    expect(errors.some((e) => e.includes('must not carry options'))).toBe(true);
  });
});

describe('isBuilderFieldType', () => {
  it('excludes attachment and time', () => {
    expect(BUILDER_FIELD_TYPES).not.toContain('attachment');
    expect(BUILDER_FIELD_TYPES).not.toContain('time');
    expect(isBuilderFieldType('attachment')).toBe(false);
    expect(isBuilderFieldType('time')).toBe(false);
    expect(isBuilderFieldType('choice')).toBe(true);
  });
});

describe('canPublish', () => {
  it('is false with no draft', () => {
    expect(canPublish([])).toBe(false);
  });

  it('is false with an empty draft', () => {
    expect(canPublish([])).toBe(false);
  });

  it('is false when the draft fails validation', () => {
    expect(canPublish([field({ key: 'a', position: 0 }), field({ key: 'a', position: 1 })])).toBe(
      false,
    );
  });

  it('is true with a non-empty, valid draft', () => {
    expect(canPublish([field({ key: 'a', position: 0 })])).toBe(true);
  });
});

describe('renumberPositions', () => {
  it('assigns dense 0..n-1 positions in array order', () => {
    const result = renumberPositions([field({ position: 5 }), field({ position: 9 })]);
    expect(result.map((f) => f.position)).toEqual([0, 1]);
  });
});

describe('formStatusLabel', () => {
  it('is Archived regardless of publish/draft state', () => {
    expect(formStatusLabel({ archivedAt: '2026-01-01', publishedVersion: 2, hasDraft: true })).toBe(
      'Archived',
    );
  });

  it('is Draft when never published', () => {
    expect(formStatusLabel({ archivedAt: null, publishedVersion: null, hasDraft: true })).toBe(
      'Draft',
    );
  });

  it('is Published v{n} with no pending draft', () => {
    expect(formStatusLabel({ archivedAt: null, publishedVersion: 3, hasDraft: false })).toBe(
      'Published v3',
    );
  });

  it('is Published v{n} · draft pending when both exist', () => {
    expect(formStatusLabel({ archivedAt: null, publishedVersion: 3, hasDraft: true })).toBe(
      'Published v3 · draft pending',
    );
  });
});

describe('slugifyKey', () => {
  it('slugifies a label', () => {
    expect(slugifyKey('Order ID', [])).toBe('order_id');
  });

  it('dedupes against existing keys', () => {
    expect(slugifyKey('Order ID', ['order_id'])).toBe('order_id_2');
  });
});
