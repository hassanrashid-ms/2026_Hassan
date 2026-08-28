# Implementation plan: reassign conversations & correct classification

Spec: `docs/specs/2026-08-24-reassign-and-reclassify-design.md`

## Global constraints

- No AI/code-review subagent per task. Each implementer writes vitest (backend) or existing test
  tooling (frontend, if present) covering its own change, runs it, and reports pass/fail output.
  A single final validation pass (done by the controller, not a subagent) checks the merged work
  against the spec at the end — no per-task review dispatch.
- Follow existing patterns exactly: `claimConversation`/`takeOverConversation` in
  `backend/src/agent/services/conversationsService.ts` for service shape; `TagPicker.tsx` for
  picker components; `agent.botConfig.test.ts` / `agent.conversations.test.ts` for backend test
  shape (standalone express app + `requireAgentSession` + router under test, `truncateAll` in
  `beforeEach`, `seedWorkspace`/`seedAgent`/`seedWorkspaceMember`/`seedConversation` from
  `tests/helpers/db.ts`).
- Register every new route + schema in `backend/src/docs/openapi.ts` (CLAUDE.md rule).
- No AI-driven validation, no essays in commit messages or reports — state what changed, not why in prose.

## Task 1 — Backend: reassign endpoint

Files: `backend/src/agent/services/conversationsService.ts`,
`backend/src/agent/controllers/conversationsController.ts`,
`backend/src/agent/routers/conversationsRouter.ts`, `backend/src/docs/openapi.ts`,
new test file `backend/tests/agent.reassign.test.ts`.

### 1a. Service — `conversationsService.ts`

Add below `takeOverConversation`:

```ts
export type ReassignResult =
  | { ok: true; status: string; posted: PostedMessageRow }
  | { ok: false; reason: 'not_found' | 'invalid_status' | 'agent_not_found' | 'agent_not_active' };

async function postReassignedNotice(
  tx: Tx,
  ctx: AgentContext,
  conversationId: string,
  targetAgentId: string,
): Promise<PostedMessageRow> {
  const [actor] = await tx
    .select({ displayName: agent.displayName })
    .from(agent)
    .where(eq(agent.id, ctx.agentId))
    .limit(1);
  const [target] = await tx
    .select({ displayName: agent.displayName })
    .from(agent)
    .where(eq(agent.id, targetAgentId))
    .limit(1);
  return postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId,
    authorType: 'system',
    actorId: null,
    body: `Reassigned to ${target?.displayName ?? 'an agent'} by ${actor?.displayName ?? 'an agent'}.`,
    visibility: 'internal',
  });
}

export async function reassignConversation(
  ctx: AgentContext,
  conversationId: string,
  targetAgentId: string,
): Promise<ReassignResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };
    if (!ACTIVE_AGENT_STATUSES.includes(conv.status))
      return { ok: false, reason: 'invalid_status' };

    const [member] = await tx
      .select({ id: workspaceMember.id })
      .from(workspaceMember)
      .where(
        and(
          eq(workspaceMember.workspaceId, ctx.workspaceId),
          eq(workspaceMember.agentId, targetAgentId),
          isNull(workspaceMember.deactivatedAt),
        ),
      )
      .limit(1);
    if (!member) return { ok: false, reason: 'agent_not_found' };

    const [targetAgent] = await tx
      .select({ status: agent.status })
      .from(agent)
      .where(eq(agent.id, targetAgentId))
      .limit(1);
    if (!targetAgent || targetAgent.status !== 'active')
      return { ok: false, reason: 'agent_not_active' };

    const [row] = await tx
      .update(conversation)
      .set({ assignedAgentId: targetAgentId })
      .where(eq(conversation.id, conversationId))
      .returning({ id: conversation.id, status: conversation.status });

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_reassigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: targetAgentId, reassigned_by: ctx.agentId, via: 'reassign' },
    });
    const posted = await postReassignedNotice(tx, ctx, conversationId, targetAgentId);
    return { ok: true, status: row!.status, posted };
  });
}
```

Import `workspaceMember` from `../../shared/db/schema/index.ts` (add to existing import line) — it's
not currently imported in this file. `ACTIVE_AGENT_STATUSES` already exists in this file (line 21);
reuse it as-is.

### 1b. Controller — `conversationsController.ts`

Add below `claimConversationHandler`:

```ts
const ReassignBody = z.object({ agentId: z.uuid() });

const REASSIGN_ERRORS = {
  not_found: [404, 'Conversation not found.'],
  invalid_status: [409, 'Conversation cannot be reassigned in its current status.'],
  agent_not_found: [404, 'Target agent is not an active member of this workspace.'],
  agent_not_active: [409, 'Target agent is not active.'],
} as const;

export const reassignConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = ConversationIdParams.safeParse(req.params);
  const body = ReassignBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid, body must be { agentId: uuid }.');
    return;
  }
  const result = await reassignConversation(ctx, params.data.id, body.data.agentId);
  if (!result.ok) {
    const [status, message] = REASSIGN_ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }
  emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status);
  emitMessageToRooms(
    getIo(),
    params.data.id,
    toPlayerView(result.posted),
    toAgentView(result.posted),
  );
  res.status(200).json({ reassigned: true });
};
```

Add `reassignConversation` to the import from `../services/conversationsService.ts`.

### 1c. Router — `conversationsRouter.ts`

```ts
conversationsRouter.patch(
  '/conversations/:id/assign',
  requireTeamLeadOrAdmin,
  reassignConversationHandler,
);
```

Import `requireTeamLeadOrAdmin` from `'../../shared/middleware/requireTeamLeadOrAdmin.ts'` and
`reassignConversationHandler` from the controller.

### 1d. openapi.ts

Add a `registerPath` block (method `patch`, path `/agent/conversations/{id}/assign`) modelled on the
existing `/agent/conversations/{id}/claim` block: request body `z.object({ agentId: z.uuid() })`,
responses `200: { reassigned: z.boolean() }`, `404`, `409`.

### 1e. Tests — `backend/tests/agent.reassign.test.ts`

Model file structure exactly on `tests/agent.conversations.test.ts` (standalone app with
`requireAgentSession, conversationsRouter`, `createSocketServer`/`closeSocketServer` in
beforeAll/afterAll, `truncateAll` in beforeEach). Use `seedAgentWithRole`-style helper (copy the one
from `tests/agent.botConfig.test.ts`, adapted for a per-workspace agent via `seedWorkspaceMember`) to
get a team_lead/admin/agent token, and `seedAgent` + `seedWorkspaceMember` for the target agent.

Cover:

- 200 + `{ reassigned: true }` when a team_lead reassigns an `open` conversation to an active target agent; conversation row's `assigned_agent_id` updates.
- 200 + `{ reassigned: true }` when an admin (isAdmin true, no team_lead role) does the same.
- 403 when a plain `agent` role calls it.
- 409 `invalid_status` when conversation status is `bot_active`.
- 404 `agent_not_found` when target agent has no workspace_member row in this workspace.
- 404 `agent_not_found` when target's workspace_member row has `deactivatedAt` set.
- 409 `agent_not_active` when target agent's `agent.status` is not `'active'` (seed via direct `ownerPool.query(\`update agent set status = 'inactive' where id = $1\`, ...)`if no seed helper option exists — check`tests/helpers/db.ts`for an`agent.status` seed option first).
- Writes exactly one `conversation_reassigned` event with `payload.agent_id === targetAgentId`.
- Posts an internal system message (assert via `select` on `message` table: `visibility = 'internal'`, `author_type = 'system'`).

Run: `pnpm --filter backend test agent.reassign.test.ts` (check `package.json` for the exact vitest
invocation pattern other single-file runs use, e.g. `pnpm test -- agent.reassign` from `backend/`).

## Task 2 — Backend: reclassify endpoint

Files: same four backend files as Task 1, new test file `backend/tests/agent.reclassify.test.ts`.
Depends on Task 1 only for the shared import line changes in the same files — implementer must re-read
the current file state before editing (Task 1 will have already landed).

### 2a. Service — `conversationsService.ts`

```ts
export type ReclassifyResult =
  { ok: true; subintentId: string } | { ok: false; reason: 'not_found' | 'invalid_subintent' };

export async function reclassifyConversation(
  ctx: AgentContext,
  conversationId: string,
  subintentId: string,
): Promise<ReclassifyResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversation.id, subintentId: conversation.subintentId })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };

    const [target] = await tx
      .select({ id: subintent.id })
      .from(subintent)
      .where(
        and(
          eq(subintent.id, subintentId),
          eq(subintent.workspaceId, ctx.workspaceId),
          isNull(subintent.archivedAt),
        ),
      )
      .limit(1);
    if (!target) return { ok: false, reason: 'invalid_subintent' };

    await tx
      .update(conversation)
      .set({ subintentId, classificationSource: 'agent' })
      .where(eq(conversation.id, conversationId));

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_reclassified',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: {
        from_subintent_id: conv.subintentId,
        to_subintent_id: subintentId,
        classification_source: 'agent',
      },
    });
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'conversation',
      entityId: conversationId,
      actorId: ctx.agentId,
      changes: [{ field: 'subintent_id', before: conv.subintentId, after: subintentId }],
    });
    return { ok: true, subintentId };
  });
}
```

Import `appendChangeLog` from `'../../shared/changeLog/appendChangeLog.ts'` and `subintent` (already
imported in this file per current content) — verify import list after Task 1's edits.

### 2b. Controller

```ts
const ReclassifyBody = z.object({ subintentId: z.uuid() });

const RECLASSIFY_ERRORS = {
  not_found: [404, 'Conversation not found.'],
  invalid_subintent: [409, 'Target subintent does not exist or is archived.'],
} as const;

export const reclassifyConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = ConversationIdParams.safeParse(req.params);
  const body = ReclassifyBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'id must be a uuid, body must be { subintentId: uuid }.',
    );
    return;
  }
  const result = await reclassifyConversation(ctx, params.data.id, body.data.subintentId);
  if (!result.ok) {
    const [status, message] = RECLASSIFY_ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }
  emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, req.body.__unused ?? '');
  res.status(200).json({ reclassified: true });
};
```

Note: `emitInboxChanged` requires a status string but reclassify never changes status — fetch the
conversation's current `status` in the service result (`ReclassifyResult`'s `ok: true` branch should
also return `status: conv.status` alongside `subintentId`, sourced from the same initial `SELECT`) and
pass that through, matching the reassign handler's approach. Adjust the type/service above accordingly
before wiring the controller — do not emit an empty string.

### 2c. Router

```ts
conversationsRouter.patch('/conversations/:id/subintent', reclassifyConversationHandler);
```

No extra role middleware — `requireAgentSession` (mounted once for the whole agent router) is
sufficient, matching `GET /agent/intents`.

### 2d. openapi.ts

`registerPath`, method `patch`, path `/agent/conversations/{id}/subintent`, body
`{ subintentId: z.uuid() }`, responses `200: { reclassified: z.boolean() }`, `404`, `409`.

### 2e. Tests — `backend/tests/agent.reclassify.test.ts`

Same file-structure template as Task 1's test file. Use `seedIntent`/`seedSubintent` from
`tests/helpers/db.ts`.

Cover:

- 200 + `{ reclassified: true }` for a plain `agent` role (no role gate) on an `open` conversation.
- 200 on a `resolved`/`closed` conversation (no status restriction).
- 404 `not_found` for a conversation outside the workspace.
- 409 `invalid_subintent` for an archived subintent.
- 409 `invalid_subintent` for a subintent id from a different workspace.
- `conversation.subintent_id` and `classification_source = 'agent'` updated in the DB.
- Exactly one `conversation_reclassified` event with correct `from_subintent_id`/`to_subintent_id` payload.
- Exactly one `change_log` row for `field = 'subintent_id'` with correct before/after.
- No message row inserted (no system notice).

## Task 3 — Frontend: AssignPicker

Files: new `frontend/src/surfaces/agent-console/pages/Inbox/components/AssignPicker.tsx`,
edits to `frontend/src/surfaces/agent-console/api/agentApi.ts` and `ThreadPanel.tsx`.
No backend edits — depends on Tasks 1–2 only for the API surface (endpoint paths/response shapes),
not for file conflicts, so this can be dispatched once Task 1 is complete without waiting on Task 2.

### 3a. `agentApi.ts` — add reassign call

```ts
export function reassignConversation(
  token: string,
  conversationId: string,
  agentId: string,
): Promise<{ reassigned: boolean }> {
  return call(`/agent/conversations/${conversationId}/assign`, token, {
    method: 'PATCH',
    body: JSON.stringify({ agentId }),
  });
}
```

Place it near `takeOverConversation`/`claimConversation`. Reuse the existing
`fetchWorkspaceAgents(token)` (already defined, hits `/agent/agents`, returns
`{ agents: WorkspaceAgentOption[] }` where `WorkspaceAgentOption = { id, display_name }`) as the
picker's data source — do not add a new fetch function.

### 3b. `AssignPicker.tsx`

Model directly on `TagPicker.tsx` (Popover + Command + `useMutation`), differences:

- Trigger button renders the current assignee's `display_name` or the string `"Unassigned"`, not an
  icon-only `+` button — props: `{ token, conversationId, currentAssigneeId, currentAssigneeName }`.
- Data source: `useQuery({ queryKey: ['agents'], queryFn: () => fetchWorkspaceAgents(token), enabled: open })`, list is `data.agents` filtered by the debounced query against `display_name` client-side (no search endpoint param exists on `/agent/agents`, unlike `/agent/tags`).
- No "create" row (agents aren't created from this picker).
- `useMutation({ mutationFn: (agentId: string) => reassignConversation(token, conversationId, agentId), onSuccess: invalidate })` where `invalidate` calls `queryClient.invalidateQueries` for `['conversation', conversationId, 'detail']`, `['tickets']`, `['inbox', 'mine']` — the same three keys `takeOver`/`claim` already invalidate in `ThreadPanel.tsx`.

### 3c. Wire into `ThreadPanel.tsx`

Import `canBuildForms` and `loadAgentSession` from `../../../lib/agentSession.ts` (only
`loadAgentSession` is currently imported — add `canBuildForms` to that import). Render
`<AssignPicker>` in the header row (around line 310, next to the existing `<TagPicker>` render),
gated:

```tsx
{
  conversationId && canBuildForms(loadAgentSession()) && (
    <AssignPicker
      token={token}
      conversationId={conversationId}
      currentAssigneeId={/* not currently a ThreadPanel prop — see below */}
      currentAssigneeName={/* same */}
    />
  );
}
```

`ThreadPanel` does not currently receive the assignee id/name as props. Add two new optional props,
`assignedAgentId?: string | null` and `assignedAgentName?: string | null`, to `ThreadPanel`'s prop
type (alongside `takeOverAvailable`/`claimAvailable`), and thread them through from
`ConversationDetailPane.tsx` (the caller) — check that file for where it currently reads
`assignedAgentId`/agent name off the conversation detail/list data it already has (it computes
`takeOverAvailable`/`claimAvailable` from similar fields) and pass the same values down as the two
new props.

### 3d. Test

No frontend test framework is set up for component-level Vitest tests in this repo per current repo
inspection — verify with `ls frontend/src/**/*.test.tsx` and `cat frontend/vitest.config.*` (or
equivalent) before writing one. If a frontend Vitest setup exists, add a component test for
`AssignPicker` (renders trigger with current assignee name, opens popover, selecting an agent calls
the mutation) following whatever pattern existing frontend tests use. If no frontend test tooling
exists, skip a test for this task and note it in the report — do not introduce new test tooling as
part of this task; `pnpm typecheck` passing is the completion bar for this task instead.

## Task 4 — Frontend: SubintentPicker

Files: new `frontend/src/surfaces/agent-console/pages/Inbox/components/SubintentPicker.tsx`, edits to
`agentApi.ts` and `ThreadPanel.tsx`. Independent of Task 3 (different component, same file
`ThreadPanel.tsx` touched — implementer must re-read `ThreadPanel.tsx`'s current state before editing
if Task 3 landed first).

### 4a. `agentApi.ts` — add reclassify call

```ts
export function reclassifyConversation(
  token: string,
  conversationId: string,
  subintentId: string,
): Promise<{ reclassified: boolean }> {
  return call(`/agent/conversations/${conversationId}/subintent`, token, {
    method: 'PATCH',
    body: JSON.stringify({ subintentId }),
  });
}
```

Reuse existing `fetchIntents(token)` (already defined, hits `/agent/intents`, returns
`IntentsResponse` — `{ intents: IntentView[] }`, each with `subintents: IntentSubintentView[]`).

### 4b. `SubintentPicker.tsx`

Model on `TagPicker.tsx` again:

- Props: `{ token, conversationId, currentSubintentId }`.
- `useQuery({ queryKey: ['intents'], queryFn: () => fetchIntents(token), enabled: open })`.
- Flatten `data.intents` to `{ id, name, intentName }[]` (skip subintents whose own `archivedAt` is
  set, and skip subintents under an archived intent), grouped in the `CommandList` by `intentName`
  using multiple `CommandGroup` blocks (one per intent name), matching how `CategorySidebar` already
  groups intents/subintents — check that file for the exact grouping approach before reinventing one.
- No "create" row.
- `useMutation({ mutationFn: (subintentId: string) => reclassifyConversation(token, conversationId, subintentId), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'context'] }) })` — only this one key, matching the spec (this is where `ThreadPanel` reads `subintent` from).

### 4c. Wire into `ThreadPanel.tsx`

Replace the existing static badge (current lines ~292-296):

```tsx
{
  subintent && (
    <Badge variant="outline">
      {subintent.intent_name} · {subintent.subintent_name}
    </Badge>
  );
}
```

with the same badge as the `PopoverTrigger` for `SubintentPicker`, no role gate. Note: the current
`subintent` object on this page (`contextQuery.data?.tickets.find(...).subintent`) only carries
`intent_name`/`subintent_name` strings, not the subintent's `id` — check
`AgentConversationContextResponse`/`AgentTicketSummarySchema` (`packages/types`, referenced from
`conversationContextService.ts`) for whether the ticket summary row already carries a subintent id
anywhere nearby; if not, this task must also add `subintent_id: string | null` to that ticket
summary's subintent object (both the type in `packages/types` and the `conversationContextService.ts`
query that builds it) so `SubintentPicker` has an id to preselect against. Keep this addition minimal
— just the one field, following the existing `{ intent_name, subintent_name }` shape's pattern.

### 4d. Test

Same rule as Task 3d — check for frontend Vitest tooling first; add a component test if it exists,
otherwise rely on `pnpm typecheck`.

## Final validation (controller, not a subagent)

After all four tasks are complete, the controller (not a dispatched subagent) checks the merged diff
against `docs/specs/2026-08-24-reassign-and-reclassify-design.md` section by section: every check in
the spec's two tables is implemented, both routes are registered in `openapi.ts`, both frontend
controls are wired into `ThreadPanel.tsx`, and nothing in "Out of scope" was accidentally added
(notifications, bulk operations, priority/label correction, auto-assignment changes). Run
`pnpm typecheck` and the full backend `pnpm test` once at the end to confirm nothing broke across
tasks.
