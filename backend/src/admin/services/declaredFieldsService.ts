import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type {
  ArchiveDeclaredFieldResponse,
  CreateDeclaredFieldResponse,
  DeactivateDeclaredFieldResponse,
  DeclaredFieldsResponse,
  DeclaredFieldType,
  ReactivateDeclaredFieldResponse,
  UpdateDeclaredFieldResponse,
} from '@support/types';
import { adminDb } from '../../shared/db/adminClient.ts';
import { agent, declaredField } from '../../shared/db/schema/index.ts';
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

export async function listDeclaredFields(workspaceId: string): Promise<DeclaredFieldsResponse> {
  const rows = await adminDb
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
    .where(and(eq(declaredField.workspaceId, workspaceId), ne(declaredField.status, 'archived')))
    // Inactive fields sort to the end instead of interleaving with active
    // ones by key — they're paused, not something an admin is scanning for.
    .orderBy(
      sql`case when ${declaredField.status} = 'inactive' then 1 else 0 end`,
      asc(declaredField.key),
    );

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
}

export type CreateDeclaredFieldResult =
  { ok: true; field: CreateDeclaredFieldResponse } | { ok: false; reason: 'key_taken' };

/**
 * Re-promoting a key that is currently `inactive` or `archived` revives the
 * existing row instead of inserting a duplicate (would hit
 * `declared_field_workspace_key_uk`). Only a currently-`active` row blocks
 * with a conflict. Same semantics as the agent-console version this replaces.
 */
export async function createDeclaredField(
  workspaceId: string,
  actorId: string,
  input: { key: string; label: string; type: DeclaredFieldType },
): Promise<CreateDeclaredFieldResult> {
  const [existing] = await adminDb
    .select({ id: declaredField.id, status: declaredField.status })
    .from(declaredField)
    .where(and(eq(declaredField.workspaceId, workspaceId), eq(declaredField.key, input.key)))
    .limit(1);

  if (existing?.status === 'active') return { ok: false, reason: 'key_taken' };

  const values = {
    workspaceId,
    key: input.key,
    label: input.label,
    type: input.type,
    status: 'active' as const,
    declaredAt: new Date(),
    declaredBy: actorId,
  };

  const [row] = existing
    ? await adminDb
        .update(declaredField)
        .set(values)
        .where(eq(declaredField.id, existing.id))
        .returning(RETURNING)
    : await adminDb.insert(declaredField).values(values).returning(RETURNING);

  return { ok: true, field: toDeclaredFieldView(row!) };
}

export type UpdateDeclaredFieldResult =
  | { ok: true; field: UpdateDeclaredFieldResponse }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'seeded_type_locked' };

/**
 * A row with no `declaredBy` is one of the seeded fields — its `type` is
 * locked (see agent-console's original service for why: historical snapshots
 * look the type up live from this table on every render). `label` stays
 * editable on every row, seeded or not.
 */
export async function updateDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
  patch: { label?: string; type?: DeclaredFieldType },
): Promise<UpdateDeclaredFieldResult> {
  const [current] = await adminDb
    .select({
      id: declaredField.id,
      label: declaredField.label,
      type: declaredField.type,
      declaredBy: declaredField.declaredBy,
    })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        ne(declaredField.status, 'archived'),
      ),
    )
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

  const field = await adminDb.transaction(async (tx) => {
    const [row] = await tx
      .update(declaredField)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
      })
      .where(eq(declaredField.id, id))
      .returning(RETURNING);

    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes,
    });

    return row!;
  });

  return { ok: true, field: toDeclaredFieldView(field) };
}

export type DeactivateDeclaredFieldResult =
  { ok: true; field: DeactivateDeclaredFieldResponse } | { ok: false; reason: 'not_found' };

export async function deactivateDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
): Promise<DeactivateDeclaredFieldResult> {
  const [current] = await adminDb
    .select({ id: declaredField.id, key: declaredField.key })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        eq(declaredField.status, 'active'),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  await adminDb.transaction(async (tx) => {
    await tx.update(declaredField).set({ status: 'inactive' }).where(eq(declaredField.id, id));
    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes: [{ field: 'status', before: 'active', after: 'inactive' }],
    });
  });

  return { ok: true, field: { id: current.id, key: current.key, status: 'inactive' } };
}

export type ReactivateDeclaredFieldResult =
  { ok: true; field: ReactivateDeclaredFieldResponse } | { ok: false; reason: 'not_found' };

export async function reactivateDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
): Promise<ReactivateDeclaredFieldResult> {
  const [current] = await adminDb
    .select({ id: declaredField.id, key: declaredField.key })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        eq(declaredField.status, 'inactive'),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  await adminDb.transaction(async (tx) => {
    await tx.update(declaredField).set({ status: 'active' }).where(eq(declaredField.id, id));
    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes: [{ field: 'status', before: 'inactive', after: 'active' }],
    });
  });

  return { ok: true, field: { id: current.id, key: current.key, status: 'active' } };
}

export type ArchiveDeclaredFieldResult =
  { ok: true; field: ArchiveDeclaredFieldResponse } | { ok: false; reason: 'not_found' };

export async function archiveDeclaredField(
  workspaceId: string,
  id: string,
  actorId: string,
): Promise<ArchiveDeclaredFieldResult> {
  const [current] = await adminDb
    .select({ id: declaredField.id, key: declaredField.key, status: declaredField.status })
    .from(declaredField)
    .where(
      and(
        eq(declaredField.id, id),
        eq(declaredField.workspaceId, workspaceId),
        ne(declaredField.status, 'archived'),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, reason: 'not_found' };

  await adminDb.transaction(async (tx) => {
    await tx.update(declaredField).set({ status: 'archived' }).where(eq(declaredField.id, id));
    await appendChangeLog(tx, {
      workspaceId,
      entityType: 'declared_field',
      entityId: id,
      actorId,
      changes: [{ field: 'status', before: current.status, after: 'archived' }],
    });
  });

  return { ok: true, field: { id: current.id, key: current.key, status: 'archived' } };
}
