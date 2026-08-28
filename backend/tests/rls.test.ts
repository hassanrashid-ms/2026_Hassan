import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { getEnv } from '../src/env.ts';
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts';

let app: Client;
const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const PLAYER_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const PLAYER_B = 'bbbbbbbb-2222-2222-2222-222222222222';

// Every scoped table by name, kept for readable failure messages in loops below.
// The SQL itself no longer hand-maintains this list (it derives "scoped" from the
// presence of a workspace_id column) — this array exists only so the tests can name
// each table individually rather than relying solely on the structural drift guard.
const SCOPED_TABLES = [
  'workspace_member',
  'player',
  'session',
  'player_state_snapshot',
  'declared_field',
  'conversation',
  'message',
  'event',
  'bot_config',
  'bot_config_version',
  'change_log',
  'form',
  'form_version',
  'form_submission',
  'form_answer',
];

beforeAll(async () => {
  app = new Client({ connectionString: getEnv().DATABASE_URL });
  await app.connect();
});

afterAll(async () => {
  await app.end();
  await closeOwnerPool();
});

beforeEach(async () => {
  await truncateAll();
  for (const [id, slug] of [
    [WS_A, 'game-a'],
    [WS_B, 'game-b'],
  ] as const) {
    await ownerPool.query(`insert into workspace (id, name, slug) values ($1, $2, $3)`, [
      id,
      slug,
      slug,
    ]);
  }
  for (const [player, ws, ext] of [
    [PLAYER_A, WS_A, 'p-a'],
    [PLAYER_B, WS_B, 'p-b'],
  ] as const) {
    await ownerPool.query(
      `insert into player (id, workspace_id, external_id) values ($1, $2, $3)`,
      [player, ws, ext],
    );
  }
});

async function asWorkspace<T>(id: string | null, fn: () => Promise<T>): Promise<T> {
  await app.query('begin');
  try {
    if (id !== null) await app.query(`select set_config('app.workspace_id', $1, true)`, [id]);
    const result = await fn();
    await app.query('commit');
    return result;
  } catch (error) {
    await app.query('rollback');
    throw error;
  }
}

describe('row-level security', () => {
  it('hides another workspace rows entirely', async () => {
    const rows = await asWorkspace(
      WS_A,
      async () => (await app.query('select id from player')).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(PLAYER_A);
  });

  it('returns zero rows when no workspace is set — there is no code path around it', async () => {
    const rows = await asWorkspace(
      null,
      async () => (await app.query('select id from player')).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a write that claims another workspace', async () => {
    await expect(
      asWorkspace(WS_A, () =>
        app.query(`insert into player (workspace_id, external_id) values ($1, 'smuggled')`, [WS_B]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update or delete an event — the spine is append-only', async () => {
    await ownerPool.query(
      `insert into event (workspace_id, type, actor_type) values ($1, 'session_start', 'player')`,
      [WS_A],
    );
    await expect(
      asWorkspace(WS_A, () => app.query(`update event set type = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(asWorkspace(WS_A, () => app.query('delete from event'))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('cannot update or delete a change_log row — an editable audit trail is not one', async () => {
    const agentId = 'cccccccc-3333-3333-3333-333333333333';
    await ownerPool.query(
      `insert into agent (id, email, display_name) values ($1, 'auditor@example.test', 'Auditor')`,
      [agentId],
    );
    await ownerPool.query(
      `insert into change_log (workspace_id, entity_type, entity_id, field, before_value, after_value, actor_id)
       values ($1, 'bot_config', $1, 'is_provisioned', 'false'::jsonb, 'true'::jsonb, $2)`,
      [WS_A, agentId],
    );

    await expect(
      asWorkspace(WS_A, () => app.query(`update change_log set after_value = 'false'::jsonb`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(asWorkspace(WS_A, () => app.query('delete from change_log'))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('cannot update or delete a bot_config_version row — a full-snapshot audit trail is append-only', async () => {
    const agentId = 'ffffffff-3333-3333-3333-333333333333';
    await ownerPool.query(
      `insert into agent (id, email, display_name) values ($1, 'version-auditor@example.test', 'Version Auditor')`,
      [agentId],
    );
    await ownerPool.query(
      `insert into bot_config_version
         (workspace_id, version, prompt, rules, tools_config, limits_config, actor_id, changed_fields)
       values ($1, 1, 'hi', '[]', '[]', '[]', $2, '{prompt}')`,
      [WS_A, agentId],
    );

    await expect(
      asWorkspace(WS_A, () => app.query(`update bot_config_version set prompt = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asWorkspace(WS_A, () => app.query('delete from bot_config_version')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot update or delete a form_answer — a correction is a new row, never an edit', async () => {
    const { rows: formRows } = await ownerPool.query<{ id: string }>(
      `insert into form (workspace_id, name) values ($1, 'Bug report') returning id`,
      [WS_A],
    );
    const formId = formRows[0]!.id;
    await ownerPool.query(
      `insert into form_version (workspace_id, form_id, version, published_at) values ($1, $2, 1, now())`,
      [WS_A, formId],
    );
    // Bump the counter the same way the request path does, so this row's number
    // does not collide with anything else the suite seeded.
    const { rows: seqRows } = await ownerPool.query<{ ticket_seq: number }>(
      `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
      [WS_A],
    );
    const { rows: cRows } = await ownerPool.query<{ id: string }>(
      `insert into conversation (workspace_id, player_id, number) values ($1, $2, $3) returning id`,
      [WS_A, PLAYER_A, seqRows[0]!.ticket_seq],
    );
    const { rows: subRows } = await ownerPool.query<{ id: string }>(
      `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
       values ($1, $2, $3, 1) returning id`,
      [WS_A, cRows[0]!.id, formId],
    );
    await ownerPool.query(
      `insert into form_answer (workspace_id, form_submission_id, field_key, field_type, value)
       values ($1, $2, 'what_happened', 'long_text', '"it crashed"'::jsonb)`,
      [WS_A, subRows[0]!.id],
    );

    await expect(
      asWorkspace(WS_A, () => app.query(`update form_answer set value = '"tampered"'::jsonb`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(asWorkspace(WS_A, () => app.query('delete from form_answer'))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('keeps form_submission updatable — terminating a submission sets status and submitted_at', async () => {
    // Deliberate asymmetry with form_answer. Do not "tidy" the revoke in
    // 002_rls.sql into covering both tables: slice 2 writes the terminal status
    // onto this row.
    const { rows } = await ownerPool.query<{ has_priv: boolean }>(
      `select has_table_privilege('support_app', 'form_submission', 'UPDATE') as has_priv`,
    );
    expect(rows[0]?.has_priv).toBe(true);
  });

  it('keeps bot_config updatable — its writer is ON CONFLICT DO UPDATE', async () => {
    await ownerPool.query(
      `insert into bot_config (workspace_id, is_provisioned, prompt, rules, tools_config, limits_config) values ($1, false, '', '[]', '[]', '[]')`,
      [WS_A],
    );
    const rows = await asWorkspace(WS_A, async () => {
      await app.query(`update bot_config set is_provisioned = true`);
      return (await app.query(`select is_provisioned from bot_config`)).rows;
    });
    expect(rows).toEqual([{ is_provisioned: true }]);

    await expect(asWorkspace(WS_A, () => app.query('delete from bot_config'))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('hides another workspace audit trail entirely', async () => {
    const agentId = 'dddddddd-4444-4444-4444-444444444444';
    await ownerPool.query(
      `insert into agent (id, email, display_name) values ($1, 'other@example.test', 'Other')`,
      [agentId],
    );
    for (const ws of [WS_A, WS_B]) {
      await ownerPool.query(
        `insert into change_log (workspace_id, entity_type, entity_id, field, before_value, after_value, actor_id)
         values ($1, 'bot_config', $1, 'prompt', null, '"hi"'::jsonb, $2)`,
        [ws, agentId],
      );
    }
    const rows = await asWorkspace(
      WS_A,
      async () => (await app.query('select workspace_id from change_log')).rows,
    );
    expect(rows).toEqual([{ workspace_id: WS_A }]);
  });

  it('grants DELETE on nothing at all — no hard deletes anywhere', async () => {
    for (const table of ['player', 'session', 'conversation', 'message', 'player_state_snapshot']) {
      await expect(
        asWorkspace(WS_A, () => app.query(`delete from ${table}`)),
        `delete from ${table}`,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('has no DDL rights — the app role can never alter the schema', async () => {
    await expect(
      asWorkspace(WS_A, () => app.query('create table sneaky (id int)')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('sets FORCE ROW LEVEL SECURITY on every scoped table', async () => {
    // Honest about what this asserts: the catalog flag only. It does NOT prove the
    // owner is actually restricted — see 'the app role cannot escape the policy'
    // and 'owner connections are NOT workspace-scoped' below for why: support_owner
    // is a Postgres superuser locally, and superusers always bypass row security
    // regardless of FORCE. FORCE still matters for any future non-superuser owner.
    const { rows } = await ownerPool.query<{ relforcerowsecurity: boolean; relname: string }>(
      `select relname, relforcerowsecurity from pg_class where relname = any($1::text[])`,
      [SCOPED_TABLES],
    );
    expect(rows).toHaveLength(SCOPED_TABLES.length);
    for (const row of rows) expect(row.relforcerowsecurity, row.relname).toBe(true);
  });

  it('the app role cannot escape the policy', async () => {
    // This is the property production actually rests on, and until now nothing
    // tested it directly: someone adding BYPASSRLS to support_app to unblock a
    // local problem would break tenancy globally while every other test here
    // still passes, because they all exercise the *policy*, not the role's
    // ability to be subject to it in the first place.
    const { rows: direct } = await ownerPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'support_app'`,
    );
    expect(direct).toHaveLength(1);
    expect(direct[0]?.rolsuper).toBe(false);
    expect(direct[0]?.rolbypassrls).toBe(false);

    // Not just support_app itself — also confirm it isn't a member of some other
    // role that carries superuser or BYPASSRLS, which would grant it by inheritance.
    const { rows: inherited } = await ownerPool.query<{ rolname: string }>(
      `select g.rolname
         from pg_auth_members am
         join pg_roles m on m.oid = am.member
         join pg_roles g on g.oid = am.roleid
        where m.rolname = 'support_app'
          and (g.rolsuper or g.rolbypassrls)`,
    );
    expect(inherited).toHaveLength(0);
  });

  it('owner connections are NOT workspace-scoped — this is intentional', async () => {
    // Documentation-as-test: the seed script and every fixture in this file depend
    // on ownerPool being able to see and write both workspaces with no
    // app.workspace_id set at all. Asserting it here, out loud, stops the next
    // person from assuming ownerPool is somehow scoped the way support_app is.
    const { rows } = await ownerPool.query<{ workspace_id: string }>(
      'select workspace_id from player order by workspace_id',
    );
    const seen = new Set(rows.map((r) => r.workspace_id));
    expect(seen).toEqual(new Set([WS_A, WS_B]));
  });

  it('finds no scoped table missing full RLS treatment — the drift guard', async () => {
    // "Scoped" is defined structurally, the same way 002_rls.sql defines it: any
    // base table in public with a workspace_id column. Unlike counting rows and
    // checking two names are absent, this cannot pass by coincidence as new tables
    // arrive — a 23-table schema addition either satisfies this predicate per
    // table or shows up here by name.
    const { rows } = await ownerPool.query<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid
                    and a.attname = 'workspace_id' and a.attnum > 0 and not a.attisdropped)
        and not (c.relrowsecurity and c.relforcerowsecurity
                 and (select count(*) from pg_policy p where p.polrelid = c.oid) = 1
                 and (select bool_and(p.polqual is not null and p.polwithcheck is not null)
                        from pg_policy p where p.polrelid = c.oid))
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('finds no table with RLS enabled but no workspace_id column — the inverse guard', async () => {
    // The complementary drift case: a table that somehow got RLS turned on despite
    // not being workspace-scoped by the same definition. `article_version` is the
    // one known, intentional exception — it scopes through article_id via a
    // subquery onto article.workspace_id instead of holding the column directly
    // (see the hand-written policy in 002_rls.sql), because a version/draft row
    // has no workspace of its own outside the article it belongs to.
    const { rows } = await ownerPool.query<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relrowsecurity = true
        and c.relname <> 'article_version'
        and not exists (select 1 from pg_attribute a where a.attrelid = c.oid
                    and a.attname = 'workspace_id' and a.attnum > 0 and not a.attisdropped)
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('WITH CHECK on every scoped table', () => {
  // "The whole attack" (per the brief) was only probed behaviourally against
  // `player`. These fixtures give every other scoped table a valid parent row to
  // FK against, so the same cross-workspace-insert attack can be attempted against
  // all eight without also tripping an unrelated FK or NOT NULL violation.
  const AGENT_A = 'eeeeeeee-1111-1111-1111-111111111111';
  const SESSION_A = 'dddddddd-1111-1111-1111-111111111111';
  const SESSION_SMUGGLE = 'dddddddd-9999-9999-9999-999999999999';
  let conversationAId: string;
  let formAId: string;
  let submissionAId: string;

  beforeEach(async () => {
    await ownerPool.query(
      `insert into agent (id, email, display_name) values ($1, 'agent-a@example.com', 'Agent A')`,
      [AGENT_A],
    );
    await ownerPool.query(
      `insert into session (id, workspace_id, player_id, entry_point, started_at)
       values ($1, $2, $3, 'help_button', now())`,
      [SESSION_A, WS_A, PLAYER_A],
    );
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into conversation (workspace_id, player_id, session_id, number) values ($1, $2, $3, 1) returning id`,
      [WS_A, PLAYER_A, SESSION_A],
    );
    conversationAId = rows[0]!.id;

    const { rows: formRows } = await ownerPool.query<{ id: string }>(
      `insert into form (workspace_id, name) values ($1, 'Purchase receipt') returning id`,
      [WS_A],
    );
    formAId = formRows[0]!.id;
    await ownerPool.query(
      `insert into form_version (workspace_id, form_id, version, published_at) values ($1, $2, 1, now())`,
      [WS_A, formAId],
    );
    const { rows: subRows } = await ownerPool.query<{ id: string }>(
      `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
       values ($1, $2, $3, 1) returning id`,
      [WS_A, conversationAId, formAId],
    );
    submissionAId = subRows[0]!.id;
  });

  it('refuses a workspace-smuggled insert on every scoped table, not just player', async () => {
    const attempts: Array<{ table: string; sql: string; params: unknown[] }> = [
      {
        table: 'player',
        sql: `insert into player (workspace_id, external_id) values ($1, 'smuggled')`,
        params: [WS_B],
      },
      {
        table: 'session',
        sql: `insert into session (id, workspace_id, player_id, entry_point, started_at)
              values ($1, $2, $3, 'help_button', now())`,
        params: [SESSION_SMUGGLE, WS_B, PLAYER_A],
      },
      {
        table: 'conversation',
        sql: `insert into conversation (workspace_id, player_id, number) values ($1, $2, 1)`,
        params: [WS_B, PLAYER_A],
      },
      {
        table: 'message',
        sql: `insert into message (workspace_id, conversation_id, seq, author_type, body)
              values ($1, $2, 1, 'player', 'hi')`,
        params: [WS_B, conversationAId],
      },
      {
        table: 'player_state_snapshot',
        sql: `insert into player_state_snapshot (workspace_id, session_id, captured_at) values ($1, $2, now())`,
        params: [WS_B, SESSION_A],
      },
      {
        table: 'declared_field',
        sql: `insert into declared_field (workspace_id, key, label, type) values ($1, 'foo', 'Foo', 'string')`,
        params: [WS_B],
      },
      {
        table: 'event',
        sql: `insert into event (workspace_id, type, actor_type) values ($1, 'session_start', 'player')`,
        params: [WS_B],
      },
      {
        table: 'workspace_member',
        sql: `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
        params: [WS_B, AGENT_A],
      },
      {
        table: 'bot_config',
        sql: `insert into bot_config (workspace_id, is_provisioned) values ($1, false)`,
        params: [WS_B],
      },
      {
        table: 'change_log',
        sql: `insert into change_log (workspace_id, entity_type, entity_id, field, before_value, after_value, actor_id)
              values ($1, 'bot_config', $1, 'is_provisioned', null, 'true'::jsonb, $2)`,
        params: [WS_B, AGENT_A],
      },
      {
        table: 'bot_config_version',
        sql: `insert into bot_config_version
              (workspace_id, version, prompt, rules, tools_config, limits_config, actor_id, changed_fields)
              values ($1, 1, 'hi', '[]', '[]', '[]', $2, '{prompt}')`,
        params: [WS_B, AGENT_A],
      },
      {
        table: 'form',
        sql: `insert into form (workspace_id, name) values ($1, 'Smuggled')`,
        params: [WS_B],
      },
      {
        table: 'form_version',
        sql: `insert into form_version (workspace_id, form_id, version) values ($1, $2, 2)`,
        params: [WS_B, formAId],
      },
      {
        table: 'form_submission',
        sql: `insert into form_submission (workspace_id, conversation_id, form_id, form_version)
              values ($1, $2, $3, 1)`,
        params: [WS_B, conversationAId, formAId],
      },
      {
        table: 'form_answer',
        sql: `insert into form_answer (workspace_id, form_submission_id, field_key, field_type, value)
              values ($1, $2, 'store', 'short_text', '"Other"'::jsonb)`,
        params: [WS_B, submissionAId],
      },
    ];

    expect(attempts.map((a) => a.table).sort()).toEqual([...SCOPED_TABLES].sort());

    for (const { table, sql, params } of attempts) {
      await expect(
        asWorkspace(WS_A, () => app.query(sql, params)),
        `insert into ${table} claiming a foreign workspace_id`,
      ).rejects.toThrow(/row-level security/i);
    }
  });
});
