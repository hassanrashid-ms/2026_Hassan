# Declared Fields — Lock Seeded Rows Except Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an admin from changing a seeded declared field's `type` (only `label` stays editable), so already-captured historical player-state snapshots stop having their displayed type silently reinterpreted when a seeded field's taxonomy is edited.

**Architecture:** No schema change. A seeded row is defined as `declaredField.declaredBy IS NULL` — already true for exactly the eleven seed rows and never true for anything created or revived through `createDeclaredField` (which always stamps `declaredBy = ctx.agentId`). The backend service `updateDeclaredField` rejects a `type`-bearing patch when the target row's `declaredBy` is `null`, surfaced as a new `409 seeded_field_locked` error. The frontend `DeclaredFieldRow` disables its `type` select for the same rows.

**Tech Stack:** Express 5 + Zod + Drizzle (backend), React + TanStack Query + shadcn/ui `Select` (frontend), Vitest + supertest (backend tests), Vitest + React Testing Library (frontend tests).

## Global Constraints

- No hard deletes, no schema migration — this change adds zero columns (per `docs/specs/2026-08-31-declared-fields-lock-seeded-fields-design.md`, "What counts as 'seeded'" section: `declaredBy IS NULL` is reused, not a new `isSystem` flag).
- `label` edits must keep working unrestricted on every row, seeded or not.
- `key` stays immutable for all rows — unchanged by this plan, already enforced (controller never accepts `key` in `UpdateDeclaredFieldBody`).
- A seeded row that is archived and later re-promoted via `createDeclaredField`'s revive path gets `declaredBy` set to the reviving admin and becomes fully editable from then on — this is intentional per the spec, not a bug to guard against.
- Backend tests need Postgres up (`pnpm db:setup` from repo root first if not already running).

---

### Task 1: Backend — reject `type` changes on seeded declared fields

**Files:**

- Modify: `backend/src/errors.ts:5-33` (add `'seeded_field_locked'` to `ErrorCode`)
- Modify: `backend/src/agent/services/declaredFieldService.ts:128-171` (`updateDeclaredField`)
- Modify: `backend/src/agent/controllers/declaredFieldController.ts:34-52` (`updateDeclaredFieldHandler`)
- Test: `backend/tests/agent.declaredFields.test.ts` (extend the existing `describe('PATCH /declared-fields/:id', ...)` block)

**Interfaces:**

- Consumes: existing `declaredField` Drizzle table (`backend/src/shared/db/schema/index.ts` re-export), existing `withWorkspace`, `appendChangeLog`, `sendError` helpers — no new imports needed beyond what these files already have.
- Produces: `UpdateDeclaredFieldResult` gains a third variant `{ ok: false; reason: 'seeded_type_locked' }` (alongside the existing `{ ok: true; field }` and `{ ok: false; reason: 'not_found' }`). The controller maps this new reason to HTTP `409` with error code `seeded_field_locked`. No other file in this task depends on new exports.

- [ ] **Step 1: Write the failing backend test**

Add this test inside the existing `describe('PATCH /declared-fields/:id', () => { ... })` block in `backend/tests/agent.declaredFields.test.ts`, right after the `'404s on an archived field'` test (around line 273). It inserts a seeded-style row directly (no `declaredBy`, mirroring the real seed) rather than going through `promote()`, which always stamps `declaredBy`:

```ts
it('rejects a type change on a seeded field (no declaredBy), but allows the label', async () => {
  const workspaceId = await seedWorkspace();
  const { token } = await seedAgentWithRole(workspaceId, 'admin');

  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into declared_field (workspace_id, key, label, type, status)
       values ($1, 'player_level', 'Player level', 'number', 'active')
       returning id`,
    [workspaceId],
  );
  const seededId = rows[0]!.id;

  await request(app)
    .patch(`/declared-fields/${seededId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ type: 'string' })
    .expect(409);

  const res = await request(app)
    .patch(`/declared-fields/${seededId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ label: 'Player Level (v2)' })
    .expect(200);

  expect(res.body).toMatchObject({
    key: 'player_level',
    label: 'Player Level (v2)',
    type: 'number',
  });
});

it('allows a type change on a promoted (non-seeded) field', async () => {
  const workspaceId = await seedWorkspace();
  const { token } = await seedAgentWithRole(workspaceId, 'admin');
  const created = await promote(app, token, workspaceId);

  await request(app)
    .patch(`/declared-fields/${created.id}`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ type: 'number' })
    .expect(200);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @support/api test -- agent.declaredFields`
Expected: FAIL — the first new test's `.expect(409)` call fails because the current `updateDeclaredField` applies the type change unconditionally (it will actually get a `200`, so supertest's `.expect(409)` throws an assertion error naming the actual status).

- [ ] **Step 3: Add the error code**

In `backend/src/errors.ts`, add `'seeded_field_locked'` to the `ErrorCode` union (`errors.ts:5-33`), next to the existing `'not_archivable'` entry:

```ts
  | 'name_taken'
  | 'key_taken'
  | 'not_archivable'
  | 'seeded_field_locked'
  | 'invalid_status'
```

- [ ] **Step 4: Reject the type change in the service**

In `backend/src/agent/services/declaredFieldService.ts`, update the `UpdateDeclaredFieldResult` type and `updateDeclaredField` function (replacing lines 128-171):

```ts
export type UpdateDeclaredFieldResult =
  | { ok: true; field: UpdateDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'seeded_type_locked' };

/**
 * Operates on `active` or `inactive` rows. An `archived` row 404s, same as a
 * missing id. A row with no `declaredBy` is one of the seeded fields — its
 * `type` is locked because historical player-state snapshots don't store
 * type/label, they're looked up live from this table on every render
 * (conversationContextService.getPlayerStateView), so editing a seeded
 * field's type retroactively relabels every already-captured snapshot.
 * `label` stays editable on every row, seeded or not.
 */
export async function updateDeclaredField(
  ctx: AgentContext,
  id: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({
        id: declaredField.id,
        label: declaredField.label,
        type: declaredField.type,
        declaredBy: declaredField.declaredBy,
      })
      .from(declaredField)
      .where(and(eq(declaredField.id, id), ne(declaredField.status, 'archived')))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    if (patch.type !== undefined && current.declaredBy === null) {
      return { ok: false, reason: 'seeded_type_locked' };
    }

    const changes: { field: string; before: unknown; after: unknown }[] = [];
    if (patch.label !== undefined)
      changes.push({ field: 'label', before: current.label, after: patch.label });
    if (patch.type !== undefined)
      changes.push({ field: 'type', before: current.type, after: patch.type });

    const [row] = await tx
      .update(declaredField)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
      })
      .where(eq(declaredField.id, id))
      .returning(RETURNING);

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId: ctx.agentId,
      changes,
    });

    return { ok: true, field: toDeclaredFieldView(row!) };
  });
}
```

- [ ] **Step 5: Map the new result to a 409 in the controller**

In `backend/src/agent/controllers/declaredFieldController.ts`, replace the `updateDeclaredFieldHandler` (lines 34-52):

```ts
export const updateDeclaredFieldHandler: RequestHandler = async (req, res) => {
  const params = DeclaredFieldIdParams.safeParse(req.params);
  const body = UpdateDeclaredFieldBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'A valid id and at least one of label/type are required.',
    );
    return;
  }
  const result = await updateDeclaredField(req.agent!, params.data.id, body.data);
  if (!result.ok) {
    if (result.reason === 'seeded_type_locked') {
      sendError(
        res,
        409,
        'seeded_field_locked',
        'This field is built in — only its label can be changed.',
      );
      return;
    }
    sendError(res, 404, 'not_found', 'Declared field not found.');
    return;
  }
  res.status(200).json(result.field);
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @support/api test -- agent.declaredFields`
Expected: PASS — all tests in the file, including the two new ones.

- [ ] **Step 7: Run the full backend suite**

Run: `pnpm --filter @support/api test`
Expected: PASS — no other suite touches `updateDeclaredField`, so this should be a clean run.

- [ ] **Step 8: Commit**

```bash
git add backend/src/errors.ts backend/src/agent/services/declaredFieldService.ts backend/src/agent/controllers/declaredFieldController.ts backend/tests/agent.declaredFields.test.ts
git commit -m "fix: lock type edits on seeded declared fields"
```

---

### Task 2: Frontend — disable the type select for seeded rows

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx:82-98`
- Test: `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.test.tsx`

**Interfaces:**

- Consumes: `DeclaredFieldView.declaredBy: string | null` (`packages/types/src/player-state.ts:77-86`, already on the type and already passed to `DeclaredFieldRow` — no prop changes needed).
- Produces: no new exports; this task only changes `DeclaredFieldRow`'s internal render output (adds `disabled` + a hint span on the existing `type` `Select`).

- [ ] **Step 1: Write the failing frontend test**

Add this test to `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.test.tsx`. It needs a second fixture for a seeded row (`declaredBy: null`) alongside whatever fixture(s) already exist in the file — add it near the existing `activeField` fixture:

```tsx
const seededField: DeclaredFieldView = {
  id: 'f2',
  key: 'player_level',
  label: 'Player level',
  type: 'number',
  status: 'active',
  declaredAt: '2026-01-01T00:00:00Z',
  declaredBy: null,
  declaredByName: null,
};
```

Then add this test in the `describe('DeclaredFieldRow', ...)` block:

```tsx
it('disables the type select for a seeded field but keeps label editable', async () => {
  renderWithClient(<DeclaredFieldRow token="t" field={seededField} />);

  const user = userEvent.setup();
  await user.click(screen.getByText('Edit'));

  expect(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.getByDisplayValue('Player level')).not.toBeDisabled();
});

it('keeps the type select enabled for a promoted (non-seeded) field', async () => {
  renderWithClient(<DeclaredFieldRow token="t" field={activeField} />);

  const user = userEvent.setup();
  await user.click(screen.getByText('Edit'));

  expect(screen.getByRole('combobox')).not.toBeDisabled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/web test -- DeclaredFieldRow`
Expected: FAIL — `toBeDisabled()` fails on the first new test because the `Select`'s trigger has no `disabled` prop yet.

- [ ] **Step 3: Disable the type select and add the hint**

In `frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx`, replace lines 82-98:

```tsx
<td className="px-3 py-2">
  {editing ? (
    <div className="flex items-center gap-2">
      <Select
        value={type}
        onValueChange={(v) => setType(v as DeclaredFieldType)}
        disabled={isSeeded}
      >
        <SelectTrigger className="h-8 w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isSeeded && <span className="text-xs text-muted">Type is locked for built-in fields</span>}
    </div>
  ) : (
    <Badge variant="secondary">{field.type}</Badge>
  )}
</td>
```

Add the `isSeeded` constant next to the existing `dirty`/`isActive` constants (around line 69-70):

```ts
const dirty = label !== field.label || type !== field.type;
const isActive = field.status === 'active';
const isSeeded = field.declaredBy === null;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/web test -- DeclaredFieldRow`
Expected: PASS — both new tests, plus every existing test in the file (they use `activeField`/`inactiveField`, which have `declaredBy` set, so `isSeeded` is `false` for them and prior behavior is unchanged).

- [ ] **Step 5: Run the full frontend suite**

Run: `pnpm --filter @support/web test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.tsx frontend/src/surfaces/agent-console/pages/DeclaredFields/components/DeclaredFieldRow.test.tsx
git commit -m "fix: disable type select for seeded declared fields in the console"
```
