import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/env.ts';
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

let app: Client;
let wsA: string;
let wsB: string;
let conversationA: string;
let formA: string;
let formB: string;
let submissionA: string;

beforeAll(async () => {
  app = new Client({ connectionString: getEnv().DATABASE_URL });
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await closeOwnerPool();
});

async function asWorkspace<T>(id: string, fn: () => Promise<T>): Promise<T> {
  await app.query('begin');
  try {
    await app.query(`select set_config('app.workspace_id', $1, true)`, [id]);
    const result = await fn();
    await app.query('commit');
    return result;
  } catch (error) {
    await app.query('rollback');
    throw error;
  }
}

beforeEach(async () => {
  await truncateAll();
  wsA = await seedWorkspace({ slug: `a-${randomUUID().slice(0, 8)}` });
  wsB = await seedWorkspace({ slug: `b-${randomUUID().slice(0, 8)}` });
  const playerA = await seedPlayer(wsA);
  conversationA = await seedConversation({ workspaceId: wsA, playerId: playerA });
  formA = await seedForm({ workspaceId: wsA, name: 'Purchase receipt' });
  formB = await seedForm({ workspaceId: wsB, name: 'Purchase receipt' });
  await seedFormVersion({ workspaceId: wsA, formId: formA, version: 1, publishedAt: new Date() });
  await seedFormVersion({ workspaceId: wsB, formId: formB, version: 1, publishedAt: new Date() });
  submissionA = await seedFormSubmission({
    workspaceId: wsA,
    conversationId: conversationA,
    formId: formA,
  });
});

describe('form_answer is append-only, enforced not conventional', () => {
  it('refuses an UPDATE and a DELETE as support_app', async () => {
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'store',
      value: 'Other',
    });

    await expect(
      asWorkspace(wsA, () => app.query(`update form_answer set value = '"tampered"'::jsonb`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(asWorkspace(wsA, () => app.query('delete from form_answer'))).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('composite FKs block the cross-tenant edge at the database, not in a handler', () => {
  it('refuses a form_submission whose form belongs to another workspace', async () => {
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 1)`,
          [wsA, conversationA, formB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it('refuses a form_submission whose conversation belongs to another workspace', async () => {
    const playerB = await seedPlayer(wsB);
    const conversationB = await seedConversation({ workspaceId: wsB, playerId: playerB });
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 1)`,
          [wsA, conversationB, formA],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it('refuses a form_answer whose submission belongs to another workspace', async () => {
    const playerB = await seedPlayer(wsB);
    const conversationB = await seedConversation({ workspaceId: wsB, playerId: playerB });
    const submissionB = await seedFormSubmission({
      workspaceId: wsB,
      conversationId: conversationB,
      formId: formB,
    });
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_answer (workspace_id, form_submission_id, field_key, field_type, value)
           values ($1, $2, 'store', 'short_text', '"Other"'::jsonb)`,
          [wsA, submissionB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it('refuses a subintent pointing at another workspace form', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [wsA],
    );
    const intentId = rows[0]!.id;
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into subintent (workspace_id, intent_id, name, form_id) values ($1, $2, 'Double Charge', $3)`,
          [wsA, intentId, formB],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });
});

describe('offered once per conversation', () => {
  it('refuses a second submission for the same (conversation_id, form_id)', async () => {
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 1)`,
          [wsA, conversationA, formA],
        ),
      ),
    ).rejects.toThrow(/duplicate key value/i);
  });
});

describe('the version snapshot is enforced, not merely resolvable', () => {
  it('refuses a submission naming a (form_id, form_version) with no matching version row', async () => {
    const playerA2 = await seedPlayer(wsA);
    const conversationA2 = await seedConversation({ workspaceId: wsA, playerId: playerA2 });
    await expect(
      asWorkspace(wsA, () =>
        app.query(
          `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
           values ($1, $2, $3, 99)`,
          [wsA, conversationA2, formA],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });
});

describe('corrections are additions', () => {
  it('keeps both rows and reads the newest created_at as current', async () => {
    const older = new Date(Date.now() - 60_000);
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'order_or_receipt_id',
      value: 'typo',
      createdAt: older,
    });
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'order_or_receipt_id',
      value: 'GPA.1234-5678',
    });

    const rows = await asWorkspace(
      wsA,
      async () =>
        (
          await app.query<{ value: string; n: string }>(
            `select value::text as value, count(*) over () as n
             from form_answer
            where form_submission_id = $1 and field_key = 'order_or_receipt_id'
            order by created_at desc
            limit 1`,
            [submissionA],
          )
        ).rows,
    );
    expect(rows[0]?.n).toBe('2');
    expect(JSON.parse(rows[0]!.value)).toBe('GPA.1234-5678');
  });
});

describe('unanswered is the absence of a row', () => {
  it('derives missing fields as the version keys minus the answered keys, with no null-valued row', async () => {
    const keys = ['store', 'order_or_receipt_id', 'purchase_date', 'what_you_expected'];
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'store',
      value: 'Other',
    });
    await seedFormAnswer({
      workspaceId: wsA,
      formSubmissionId: submissionA,
      fieldKey: 'purchase_date',
      fieldType: 'date',
      value: '2026-08-16',
    });

    const answered = await asWorkspace(wsA, async () =>
      (
        await app.query<{ field_key: string }>(
          `select distinct field_key from form_answer where form_submission_id = $1`,
          [submissionA],
        )
      ).rows.map((r) => r.field_key),
    );
    expect(keys.filter((k) => !answered.includes(k))).toEqual([
      'order_or_receipt_id',
      'what_you_expected',
    ]);

    const { rows: nulls } = await ownerPool.query(`select 1 from form_answer where value is null`);
    expect(nulls).toHaveLength(0);
  });
});

describe('RLS covers all four new tables', () => {
  const NEW_TABLES = ['form', 'form_version', 'form_submission', 'form_answer'];

  it('gives each one a tenant policy with FORCE row level security', async () => {
    const { rows } = await ownerPool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `select relname, relforcerowsecurity from pg_class where relname = any($1::text[])`,
      [NEW_TABLES],
    );
    expect(rows).toHaveLength(NEW_TABLES.length);
    for (const row of rows) expect(row.relforcerowsecurity, row.relname).toBe(true);

    const { rows: policies } = await ownerPool.query<{ tablename: string }>(
      `select tablename from pg_policies where policyname = 'tenant' and tablename = any($1::text[])`,
      [NEW_TABLES],
    );
    expect(policies.map((p) => p.tablename).sort()).toEqual([...NEW_TABLES].sort());
  });

  it('hides another workspace rows entirely', async () => {
    const rows = await asWorkspace(wsA, async () => (await app.query('select id from form')).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(formA);
  });
});
