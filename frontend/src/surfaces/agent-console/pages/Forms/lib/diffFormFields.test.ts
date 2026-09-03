import { describe, expect, it } from 'vitest';
import type { FormField } from '@support/types';
import { diffFormFields } from './diffFormFields.ts';

const field = (overrides: Partial<FormField> = {}): FormField => ({
  key: 'order_id',
  label: 'Order ID',
  type: 'short_text',
  isRequired: true,
  position: 0,
  ...overrides,
});

describe('diffFormFields', () => {
  it('reports an added field', () => {
    const entries = diffFormFields([], [field()]);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'added', description: 'Field "Order ID" added' },
    ]);
  });

  it('reports a removed field', () => {
    const entries = diffFormFields([field()], []);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'removed', description: 'Field "Order ID" removed' },
    ]);
  });

  it('reports a label change', () => {
    const entries = diffFormFields([field()], [field({ label: 'Order Number' })]);
    expect(entries).toEqual([
      {
        key: 'order_id',
        kind: 'changed',
        description: 'Field "Order Number": label changed from "Order ID"',
      },
    ]);
  });

  it('reports a required-flag change', () => {
    const entries = diffFormFields([field()], [field({ isRequired: false })]);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'changed', description: 'Field "Order ID": required → optional' },
    ]);
  });

  it('reports a type change', () => {
    const entries = diffFormFields([field()], [field({ type: 'long_text' })]);
    expect(entries).toEqual([
      {
        key: 'order_id',
        kind: 'changed',
        description: 'Field "Order ID": type changed from short_text to long_text',
      },
    ]);
  });

  it('reports an options change on a choice field', () => {
    const choice = field({ type: 'choice', options: ['A', 'B'] });
    const entries = diffFormFields([choice], [{ ...choice, options: ['A', 'B', 'C'] }]);
    expect(entries).toEqual([
      { key: 'order_id', kind: 'changed', description: 'Field "Order ID": options changed' },
    ]);
  });

  it('returns nothing for two identical field lists', () => {
    expect(diffFormFields([field()], [field()])).toEqual([]);
  });
});
