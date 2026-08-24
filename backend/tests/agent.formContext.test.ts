import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FormField, FormSubmissionStatus } from '@support/types';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import {
  buildFormFieldViews,
  getFormView,
} from '../src/agent/services/conversationContextService.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedForm,
  seedFormAnswer,
  seedFormSubmission,
  seedFormVersion,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const V1_FIELDS: FormField[] = [
  {
    key: 'store',
    label: 'Store',
    type: 'choice',
    isRequired: true,
    position: 0,
    options: ['Apple App Store', 'Google Play', 'Other'],
  },
  {
    key: 'order_or_receipt_id',
    label: 'Order or receipt ID',
    type: 'short_text',
    isRequired: true,
    position: 1,
  },
  { key: 'purchase_date', label: 'Date of purchase', type: 'date', isRequired: true, position: 2 },
  {
    key: 'what_you_expected',
    label: 'What you expected',
    type: 'long_text',
    isRequired: true,
    position: 3,
  },
];

describe('buildFormFieldViews', () => {
  it('renders every field in position order when all are answered', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, [
      { fieldKey: 'what_you_expected', fieldType: 'long_text', value: 'A refund' },
      { fieldKey: 'store', fieldType: 'choice', value: 'Google Play' },
      { fieldKey: 'purchase_date', fieldType: 'date', value: '2026-08-16' },
      { fieldKey: 'order_or_receipt_id', fieldType: 'short_text', value: 'GPA.1234' },
    ]);

    expect(rows.map((r) => r.key)).toEqual([
      'store',
      'order_or_receipt_id',
      'purchase_date',
      'what_you_expected',
    ]);
    expect(rows.every((r) => r.answered)).toBe(true);
    expect(answeredCount).toBe(4);
  });

  // The assertion that carries the product requirement: a gap is a row, not an
  // omission. An agent has to be able to tell "the player did not answer this"
  // from "this was never asked".
  it('keeps unanswered fields as rows rather than dropping them', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, [
      { fieldKey: 'store', fieldType: 'choice', value: 'Google Play' },
      { fieldKey: 'order_or_receipt_id', fieldType: 'short_text', value: 'GPA.1234' },
    ]);

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.answered)).toEqual([true, true, false, false]);
    expect(rows[2]).toMatchObject({
      key: 'purchase_date',
      label: 'Date of purchase',
      value: null,
      answered: false,
    });
    expect(answeredCount).toBe(2);
  });

  it('renders every field as a gap when nothing was answered', () => {
    const { rows, answeredCount } = buildFormFieldViews(V1_FIELDS, []);
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.answered)).toBe(false);
    expect(answeredCount).toBe(0);
  });

  // The answer snapshots its own field_type precisely so the value is
  // interpretable without resolving the version. A field retyped in v2 must not
  // change how a v1 answer reads.
  it('takes field_type from the answer, and only the label from the version', () => {
    const { rows } = buildFormFieldViews(
      [
        {
          key: 'purchase_date',
          label: 'Date of purchase',
          type: 'short_text',
          isRequired: true,
          position: 0,
        },
      ],
      [{ fieldKey: 'purchase_date', fieldType: 'date', value: '2026-08-16' }],
    );
    expect(rows[0]).toMatchObject({
      label: 'Date of purchase',
      field_type: 'date',
      value: '2026-08-16',
    });
  });

  it('takes field_type from the version for an unanswered field', () => {
    const { rows } = buildFormFieldViews(
      [
        {
          key: 'purchase_date',
          label: 'Date of purchase',
          type: 'date',
          isRequired: true,
          position: 0,
        },
      ],
      [],
    );
    expect(rows[0]).toMatchObject({ field_type: 'date', answered: false });
  });

  it('sorts by position rather than trusting array order', () => {
    const { rows } = buildFormFieldViews(
      [
        { key: 'b', label: 'B', type: 'short_text', isRequired: false, position: 1 },
        { key: 'a', label: 'A', type: 'short_text', isRequired: false, position: 0 },
      ],
      [],
    );
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
  });

  // Cannot normally occur — the answer route validates field_key against this
  // same version — but appending beats dropping, exactly as getPlayerStateView
  // does for a blob key with no declared_field row. answered_count stays on the
  // questions actually asked, so "2 of 4" never reads above its denominator.
  it('appends an answer whose key is not in the version, labelled by its key', () => {
    const { rows, answeredCount } = buildFormFieldViews(
      [{ key: 'a', label: 'A', type: 'short_text', isRequired: false, position: 0 }],
      [
        { fieldKey: 'a', fieldType: 'short_text', value: 'yes' },
        { fieldKey: 'ghost', fieldType: 'short_text', value: 'orphan' },
      ],
    );
    expect(rows.map((r) => r.key)).toEqual(['a', 'ghost']);
    expect(rows[1]).toMatchObject({ label: 'ghost', answered: true });
    expect(answeredCount).toBe(1);
  });
});

const app = express();
app.use(express.json());
app.use(requireAgentSession, conversationsRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Agent One') returning id`,
    [`a-${workspaceId.slice(0, 8)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  return {
    agentId,
    token: await signAgentSession({ agent_id: agentId, workspace_id: workspaceId }),
  };
}

async function setupSubmission(args: { status?: FormSubmissionStatus; v1Fields?: FormField[] }) {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({ workspaceId, playerId });
  const formId = await seedForm({ workspaceId, name: 'Purchase receipt' });
  await seedFormVersion({
    workspaceId,
    formId,
    version: 1,
    fields: args.v1Fields ?? V1_FIELDS,
    publishedAt: new Date('2026-08-01T00:00:00Z'),
  });
  const submissionId = await seedFormSubmission({
    workspaceId,
    conversationId,
    formId,
    formVersion: 1,
    status: args.status ?? 'in_progress',
  });
  return { workspaceId, playerId, conversationId, formId, submissionId };
}

describe('getFormView', () => {
  it('returns null when the conversation has no submission', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));
    expect(view).toBeNull();
  });

  it('names the form and the snapshotted version', async () => {
    const { workspaceId, conversationId } = await setupSubmission({ status: 'skipped' });
    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));

    expect(view).toMatchObject({
      form_name: 'Purchase receipt',
      form_version: 1,
      status: 'skipped',
      field_count: 4,
      answered_count: 0,
    });
  });

  it('reads the greatest created_at per field_key and hides the older row', async () => {
    const { workspaceId, conversationId, submissionId } = await setupSubmission({});
    await seedFormAnswer({
      workspaceId,
      formSubmissionId: submissionId,
      fieldKey: 'order_or_receipt_id',
      fieldType: 'short_text',
      value: 'GPA.0000',
      createdAt: new Date('2026-08-17T10:00:00Z'),
    });
    await seedFormAnswer({
      workspaceId,
      formSubmissionId: submissionId,
      fieldKey: 'order_or_receipt_id',
      fieldType: 'short_text',
      value: 'GPA.1234',
      createdAt: new Date('2026-08-17T10:05:00Z'),
    });

    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));
    const row = view!.fields.find((f) => f.key === 'order_or_receipt_id');
    expect(row).toMatchObject({ value: 'GPA.1234', answered: true });
    // A correction is one row in the rail, not two: revision history is noise.
    expect(view!.fields.filter((f) => f.key === 'order_or_receipt_id')).toHaveLength(1);
    expect(view!.answered_count).toBe(1);
  });

  // The whole reason form_submission.form_version exists. Editing a live form
  // creates v2; answers already collected stay readable against v1.
  it('labels against the submission version after the form is edited to v2', async () => {
    const { workspaceId, conversationId, formId, submissionId } = await setupSubmission({});
    await seedFormAnswer({
      workspaceId,
      formSubmissionId: submissionId,
      fieldKey: 'purchase_date',
      fieldType: 'date',
      value: '2026-08-16',
    });
    await seedFormVersion({
      workspaceId,
      formId,
      version: 2,
      fields: [
        {
          key: 'purchase_date',
          label: 'When you bought it',
          type: 'short_text',
          isRequired: true,
          position: 0,
        },
      ],
      publishedAt: new Date('2026-08-17T00:00:00Z'),
    });

    const view = await withWorkspace(workspaceId, (tx) => getFormView(tx, conversationId));
    expect(view!.form_version).toBe(1);
    expect(view!.field_count).toBe(4);
    const row = view!.fields.find((f) => f.key === 'purchase_date');
    expect(row!.label).toBe('Date of purchase');
    // Type comes off the answer, so retyping the field in v2 changes nothing here.
    expect(row!.field_type).toBe('date');
  });
});

describe('GET /agent/conversations/:id/context form block', () => {
  it('returns form: null when the conversation was never offered one', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}/context`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.form).toBeNull();
    // The other two sections are unaffected by an absent form.
    expect(res.body.player_state).toBeDefined();
    expect(res.body.tickets).toBeDefined();
  });

  it('carries the partial form with its gaps intact', async () => {
    const { workspaceId, conversationId, submissionId } = await setupSubmission({
      status: 'partial',
    });
    await seedFormAnswer({
      workspaceId,
      formSubmissionId: submissionId,
      fieldKey: 'store',
      fieldType: 'choice',
      value: 'Google Play',
    });
    await seedFormAnswer({
      workspaceId,
      formSubmissionId: submissionId,
      fieldKey: 'order_or_receipt_id',
      fieldType: 'short_text',
      value: 'GPA.1234',
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}/context`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.form.status).toBe('partial');
    expect(res.body.form.answered_count).toBe(2);
    expect(res.body.form.field_count).toBe(4);
    expect(res.body.form.fields.map((f: { answered: boolean }) => f.answered)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('404s a conversation in another workspace rather than leaking its form', async () => {
    const { conversationId } = await setupSubmission({});
    const otherWorkspaceId = await seedWorkspace();
    const { token } = await setupAgent(otherWorkspaceId);

    const res = await request(app)
      .get(`/conversations/${conversationId}/context`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
