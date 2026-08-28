import { randomUUID } from 'node:crypto';
import type { FormField } from '@support/types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveSubintentForm } from '../src/domain/forms/resolveSubintentForm.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedForm,
  seedFormVersion,
  seedIntent,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const FIELDS: FormField[] = [
  {
    key: 'what_you_expected',
    label: 'What you expected',
    type: 'long_text',
    isRequired: true,
    position: 3,
  },
  {
    key: 'store',
    label: 'Store',
    type: 'choice',
    isRequired: true,
    position: 0,
    options: ['A', 'B'],
  },
  { key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 2 },
  {
    key: 'order_or_receipt_id',
    label: 'Order or receipt ID',
    type: 'short_text',
    isRequired: true,
    position: 1,
  },
];

let workspaceId: string;
let intentId: string;

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(async () => {
  await truncateAll();
  workspaceId = await seedWorkspace({ slug: `ws-${randomUUID().slice(0, 8)}` });
  intentId = await seedIntent(workspaceId);
});

async function mapSubintentToForm(subintentId: string, formId: string): Promise<void> {
  await ownerPool.query(`update subintent set form_id = $1 where id = $2`, [formId, subintentId]);
}

describe('resolveSubintentForm', () => {
  it('returns null, without throwing, when the subintent has no form_id', async () => {
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'How to Play' });
    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId));
    expect(result).toBeNull();
  });

  it('returns null, without throwing, when the form is archived', async () => {
    const formId = await seedForm({ workspaceId, name: 'Retired', archivedAt: new Date() });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: FIELDS,
      publishedAt: new Date(),
    });
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Double Charge' });
    await mapSubintentToForm(subintentId, formId);

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId));
    expect(result).toBeNull();
  });

  it('returns null, without throwing, when no version is published', async () => {
    const formId = await seedForm({ workspaceId, name: 'Draft only' });
    await seedFormVersion({ workspaceId, formId, version: 1, fields: FIELDS, publishedAt: null });
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Missing Purchase' });
    await mapSubintentToForm(subintentId, formId);

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId));
    expect(result).toBeNull();
  });

  it('returns null for a subintent id that does not exist at all', async () => {
    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, randomUUID()));
    expect(result).toBeNull();
  });

  it('returns the highest published version, ignoring an unpublished higher one', async () => {
    const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: FIELDS,
      publishedAt: new Date(),
    });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 2,
      fields: FIELDS,
      publishedAt: new Date(),
    });
    await seedFormVersion({ workspaceId, formId, version: 3, fields: FIELDS, publishedAt: null });
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund Status' });
    await mapSubintentToForm(subintentId, formId);

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId));
    expect(result).not.toBeNull();
    expect(result?.formId).toBe(formId);
    expect(result?.formName).toBe('Purchase receipt');
    expect(result?.version).toBe(2);
  });

  it('returns fields in position order regardless of how they are stored', async () => {
    const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 1,
      fields: FIELDS,
      publishedAt: new Date(),
    });
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Billing Errors' });
    await mapSubintentToForm(subintentId, formId);

    const result = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, subintentId));
    expect(result?.fields.map((f) => f.key)).toEqual([
      'store',
      'order_or_receipt_id',
      'purchase_date',
      'what_you_expected',
    ]);
    expect(result?.fields.map((f) => f.position)).toEqual([0, 1, 2, 3]);
  });
});
