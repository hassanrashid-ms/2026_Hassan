import { and, asc, eq, ne } from 'drizzle-orm';
import type {
  ArchiveDeclaredFieldResponse,
  CreateDeclaredFieldResponse,
  DeactivateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  ReactivateDeclaredFieldResponse,
  UpdateDeclaredFieldResponse,
} from '@support/types';
import { agent, declaredField } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts';

const RETURNING = {
  id: declaredField.id,
  key: declaredField.key,
  label: declaredField.label,
  type: declaredField.type,
  status: declaredField.status,
  declaredAt: declaredField.declaredAt,
  declaredBy: declaredField.declaredBy,
};

/** Shapes a RETURNING row (declaredAt still a Date) into the wire view. */
function toDeclaredFieldView(row: {
  id: string;
  key: string;
  label: string;
  type: DeclaredFieldType;
  status: 'active' | 'inactive' | 'archived';
  declaredAt: Date;
  declaredBy: string | null;
}) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    status: row.status,
    declaredAt: row.declaredAt.toISOString(),
    declaredBy: row.declaredBy,
    declaredByName: null,
  };
}

export async function listDeclaredFields(ctx: AgentContext): Promise<DeclaredFieldsResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .select({
        id: declaredField.id,
        key: declaredField.key,
        label: declaredField.label,
        type: declaredField.type,
        status: declaredField.status,
        declaredAt: declaredField.declaredAt,
        declaredBy: declaredField.declaredBy,
        declaredByName: agent.displayName,
      })
      .from(declaredField)
      .leftJoin(agent, eq(agent.id, declaredField.declaredBy))
      .where(ne(declaredField.status, 'archived'))
      .orderBy(asc(declaredField.key));

    return {
      fields: rows.map((row) => ({
        id: row.id,
        key: row.key,
        label: row.label,
        type: row.type,
        status: row.status,
        declaredAt: row.declaredAt.toISOString(),
        declaredBy: row.declaredBy,
        declaredByName: row.declaredByName,
      })),
    };
  });
}

export type CreateDeclaredFieldResult =
  | { ok: true; field: CreateDeclaredFieldResponse }
  | { ok: false; reason: 'key_taken' };

/**
 * Re-promoting a key that is currently `inactive` or `archived` revives the
 * existing row (new label/type/declaredBy/declaredAt, status back to `active`)
 * instead of inserting a duplicate, which would otherwise hit
 * `declared_field_workspace_key_uk`. There is no separate "unarchive" endpoint —
 * this is the only way back for an archived key. Only a currently-`active` row
 * blocks with a conflict.
 */
export async function createDeclaredField(
  ctx: AgentContext,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx
      .select({ id: declaredField.id, status: declaredField.status })
      .from(declaredField)
      .where(and(eq(declaredField.workspaceId, ctx.workspaceId), eq(declaredField.key, input.key)))
      .limit(1);

    if (existing?.status === 'active') return { ok: false, reason: 'key_taken' };

    const values = {
      workspaceId: ctx.workspaceId,
      key: input.key,
      label: input.label,
      type: input.type,
      status: 'active' as const,
      declaredAt: new Date(),
      declaredBy: ctx.agentId,
    };

    const [row] = existing
      ? await tx
          .update(declaredField)
          .set(values)
          .where(eq(declaredField.id, existing.id))
          .returning(RETURNING)
      : await tx.insert(declaredField).values(values).returning(RETURNING);

    return { ok: true, field: toDeclaredFieldView(row!) };
  });
}

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

export type DeactivateDeclaredFieldResult =
  | { ok: true; field: DeactivateDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' };

/** Only a currently-`active` row can be deactivated. */
export async function deactivateDeclaredField(
  ctx: AgentContext,
  id: string,
): Promise<DeactivateDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: declaredField.id, key: declaredField.key })
      .from(declaredField)
      .where(and(eq(declaredField.id, id), eq(declaredField.status, 'active')))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    await tx.update(declaredField).set({ status: 'inactive' }).where(eq(declaredField.id, id));

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'status', before: 'active', after: 'inactive' }],
    });

    return { ok: true, field: { id: current.id, key: current.key, status: 'inactive' } };
  });
}

export type ReactivateDeclaredFieldResult =
  | { ok: true; field: ReactivateDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' };

/**
 * Only a currently-`inactive` row can be reactivated this way. An `archived`
 * row is deliberately excluded — re-promoting the same key (createDeclaredField)
 * is the only path back from `archived`, so an archived row 404s here too.
 */
export async function reactivateDeclaredField(
  ctx: AgentContext,
  id: string,
): Promise<ReactivateDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: declaredField.id, key: declaredField.key })
      .from(declaredField)
      .where(and(eq(declaredField.id, id), eq(declaredField.status, 'inactive')))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    await tx.update(declaredField).set({ status: 'active' }).where(eq(declaredField.id, id));

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'status', before: 'inactive', after: 'active' }],
    });

    return { ok: true, field: { id: current.id, key: current.key, status: 'active' } };
  });
}

export type ArchiveDeclaredFieldResult =
  | { ok: true; field: ArchiveDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' };

/** Works from `active` or `inactive`. Already-`archived` (or missing) 404s. */
export async function archiveDeclaredField(
  ctx: AgentContext,
  id: string,
): Promise<ArchiveDeclaredFieldResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: declaredField.id, key: declaredField.key, status: declaredField.status })
      .from(declaredField)
      .where(and(eq(declaredField.id, id), ne(declaredField.status, 'archived')))
      .limit(1);
    if (!current) return { ok: false, reason: 'not_found' };

    await tx.update(declaredField).set({ status: 'archived' }).where(eq(declaredField.id, id));

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'status', before: current.status, after: 'archived' }],
    });

    return { ok: true, field: { id: current.id, key: current.key, status: 'archived' } };
  });
}
