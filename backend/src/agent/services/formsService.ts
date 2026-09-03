import { and, desc, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import type {
  FormDetail,
  FormField,
  FormMappedSubintent,
  FormSummary,
  FormVersionsListResponse,
  FormVersionSnapshotView,
  FormVersionView,
  FormsListResponse,
} from '@support/types';
import { agent, form, formVersion, subintent } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import type { Tx } from '../../shared/db/withWorkspace.ts';

/** Field types declared in the shared enum but never offered by the builder — see forms.ts. */
const FORBIDDEN_FIELD_TYPES = new Set<FormField['type']>(['time']);

function hasForbiddenFieldType(fields: FormField[]): boolean {
  return fields.some((f) => FORBIDDEN_FIELD_TYPES.has(f.type));
}

function toVersionView(row: {
  version: number;
  fields: FormField[];
  publishedAt: Date | null;
}): FormVersionView {
  return {
    version: row.version,
    fields: row.fields,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

async function loadVersions(tx: Tx, formId: string) {
  return tx
    .select()
    .from(formVersion)
    .where(eq(formVersion.formId, formId))
    .orderBy(desc(formVersion.version));
}

export async function listForms(ctx: AgentContext): Promise<FormsListResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const forms = await tx.select().from(form).orderBy(desc(form.createdAt));
    const versions = await tx
      .select({
        formId: formVersion.formId,
        version: formVersion.version,
        publishedAt: formVersion.publishedAt,
      })
      .from(formVersion);
    const subintents = await tx
      .select({ formId: subintent.formId })
      .from(subintent)
      .where(isNull(subintent.archivedAt));

    const forms_: FormSummary[] = forms.map((f) => {
      const fVersions = versions.filter((v) => v.formId === f.id);
      const publishedVersions = fVersions
        .filter((v) => v.publishedAt !== null)
        .map((v) => v.version);
      const publishedVersion = publishedVersions.length > 0 ? Math.max(...publishedVersions) : null;
      const hasDraft = fVersions.some((v) => v.publishedAt === null);
      const mappedSubintentCount = subintents.filter((s) => s.formId === f.id).length;
      return {
        id: f.id,
        name: f.name,
        archivedAt: f.archivedAt ? f.archivedAt.toISOString() : null,
        createdAt: f.createdAt.toISOString(),
        mappedSubintentCount,
        publishedVersion,
        hasDraft,
      };
    });
    return { forms: forms_ };
  });
}

export type CreateFormResult = { ok: true; id: string; draftVersionId: string };

export async function createForm(ctx: AgentContext, name: string): Promise<CreateFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx
      .insert(form)
      .values({ workspaceId: ctx.workspaceId, name, createdBy: ctx.agentId })
      .returning({ id: form.id });
    const [versionRow] = await tx
      .insert(formVersion)
      .values({
        workspaceId: ctx.workspaceId,
        formId: formRow!.id,
        version: 1,
        fields: [],
        publishedAt: null,
      })
      .returning({ id: formVersion.id });
    return { ok: true, id: formRow!.id, draftVersionId: versionRow!.id };
  });
}

/**
 * tx-scoped — never opens its own transaction. `getForm` (the public,
 * ctx-scoped entry point) wraps this in `withWorkspace`; every mutator below
 * calls this directly on its own already-open `tx` so it sees uncommitted
 * writes from earlier in the same transaction. Calling the ctx-scoped `getForm`
 * from inside a mutator's transaction would open a second, independent
 * transaction that cannot see this one's uncommitted rows.
 */
async function loadFormDetail(tx: Tx, formId: string): Promise<FormDetail | null> {
  const [formRow] = await tx.select().from(form).where(eq(form.id, formId)).limit(1);
  if (!formRow) return null;

  const versions = await loadVersions(tx, formId);
  const draftRow = versions.find((v) => v.publishedAt === null);
  const publishedRow = versions
    .filter((v) => v.publishedAt !== null)
    .sort((a, b) => b.version - a.version)[0];

  const mapped = await tx
    .select({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
    .from(subintent)
    .where(eq(subintent.formId, formId));

  const subintents: FormMappedSubintent[] = mapped.map((m) => ({
    id: m.id,
    name: m.name,
    intentId: m.intentId,
  }));

  return {
    id: formRow.id,
    name: formRow.name,
    archivedAt: formRow.archivedAt ? formRow.archivedAt.toISOString() : null,
    createdAt: formRow.createdAt.toISOString(),
    draft: draftRow ? toVersionView(draftRow) : null,
    published: publishedRow ? toVersionView(publishedRow) : null,
    subintents,
  };
}

export async function getForm(ctx: AgentContext, formId: string): Promise<FormDetail | null> {
  return withWorkspace(ctx.workspaceId, (tx) => loadFormDetail(tx, formId));
}

/**
 * Only PUBLISHED versions — the current draft has no publishedBy actor and is
 * the mutable working copy, not a historical fact yet.
 */
export async function listFormVersions(
  ctx: AgentContext,
  formId: string,
): Promise<FormVersionsListResponse | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx.select({ id: form.id }).from(form).where(eq(form.id, formId)).limit(1);
    if (!formRow) return null;

    const rows = await tx
      .select({
        version: formVersion.version,
        publishedAt: formVersion.publishedAt,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(formVersion)
      .innerJoin(agent, eq(agent.id, formVersion.publishedBy))
      .where(and(eq(formVersion.formId, formId), isNotNull(formVersion.publishedAt)))
      .orderBy(desc(formVersion.version));

    return {
      versions: rows.map((r) => ({
        version: r.version,
        published_at: r.publishedAt!.toISOString(),
        actor: { id: r.actorId, display_name: r.actorDisplayName, email: r.actorEmail },
      })),
    };
  });
}

export async function getFormVersion(
  ctx: AgentContext,
  formId: string,
  version: number,
): Promise<FormVersionSnapshotView | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        version: formVersion.version,
        fields: formVersion.fields,
        publishedAt: formVersion.publishedAt,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(formVersion)
      .innerJoin(agent, eq(agent.id, formVersion.publishedBy))
      .where(
        and(
          eq(formVersion.formId, formId),
          eq(formVersion.version, version),
          isNotNull(formVersion.publishedAt),
        ),
      )
      .limit(1);
    if (!row) return null;

    return {
      version: row.version,
      published_at: row.publishedAt!.toISOString(),
      actor: { id: row.actorId, display_name: row.actorDisplayName, email: row.actorEmail },
      fields: row.fields,
    };
  });
}

export type UpdateFormInput = { name?: string; fields?: FormField[] };
export type UpdateFormResult =
  | { ok: true; form: FormDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden_field_type' };

/**
 * The auto-fork rule (spec §Service, updateForm): editing a draft edits it in
 * place; editing a published form forks a new draft at version + 1, seeded from
 * the caller's fields (or the published version's fields if only `name` was sent).
 */
export async function updateForm(
  ctx: AgentContext,
  formId: string,
  patch: UpdateFormInput,
): Promise<UpdateFormResult> {
  if (patch.fields && hasForbiddenFieldType(patch.fields)) {
    return { ok: false, reason: 'forbidden_field_type' };
  }

  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx.select().from(form).where(eq(form.id, formId)).limit(1);
    if (!formRow) return { ok: false, reason: 'not_found' };

    if (patch.name !== undefined) {
      await tx.update(form).set({ name: patch.name }).where(eq(form.id, formId));
    }

    const versions = await loadVersions(tx, formId);
    const latest = versions[0];

    if (patch.fields !== undefined) {
      if (latest && latest.publishedAt === null) {
        // Draft already exists — edit it in place. Never touch publishedAt here.
        await tx
          .update(formVersion)
          .set({ fields: patch.fields })
          .where(eq(formVersion.id, latest.id));
      } else {
        // latest is published (or, unreachable post-createForm, there is none) — fork.
        const nextVersion = latest ? latest.version + 1 : 1;
        await tx.insert(formVersion).values({
          workspaceId: ctx.workspaceId,
          formId,
          version: nextVersion,
          fields: patch.fields,
          publishedAt: null,
        });
      }
    }

    const detail = await loadFormDetail(tx, formId);
    return { ok: true, form: detail! };
  });
}

export type PublishFormResult =
  | { ok: true; form: FormDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'no_draft' }
  | { ok: false; reason: 'empty_draft' };

export async function publishForm(ctx: AgentContext, formId: string): Promise<PublishFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx
      .select({ id: form.id })
      .from(form)
      .where(eq(form.id, formId))
      .limit(1);
    if (!formRow) return { ok: false, reason: 'not_found' };

    const [draft] = await tx
      .select()
      .from(formVersion)
      .where(and(eq(formVersion.formId, formId), isNull(formVersion.publishedAt)))
      .limit(1);
    if (!draft) return { ok: false, reason: 'no_draft' };
    if (draft.fields.length === 0) return { ok: false, reason: 'empty_draft' };

    await tx
      .update(formVersion)
      .set({ publishedAt: new Date(), publishedBy: ctx.agentId })
      .where(eq(formVersion.id, draft.id));

    const detail = await loadFormDetail(tx, formId);
    return { ok: true, form: detail! };
  });
}

export type ArchiveFormResult = { ok: true; form: FormDetail } | { ok: false; reason: 'not_found' };

/** Idempotent: archiving an already-archived form just re-stamps archivedAt and succeeds. */
export async function archiveForm(ctx: AgentContext, formId: string): Promise<ArchiveFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx
      .select({ id: form.id })
      .from(form)
      .where(eq(form.id, formId))
      .limit(1);
    if (!formRow) return { ok: false, reason: 'not_found' };

    await tx.update(form).set({ archivedAt: new Date() }).where(eq(form.id, formId));

    const detail = await loadFormDetail(tx, formId);
    return { ok: true, form: detail! };
  });
}

export type SetFormSubintentsResult =
  | { ok: true; form: FormDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_subintent_ids'; invalidIds: string[] };

/**
 * Full set-replacement, one transaction. Client-supplied ids are verified with a
 * scoped SELECT first — the FK on subintent.formId bypasses RLS, so an unverified
 * id would let workspace A point a subintent at (or unmap) a form via a
 * cross-workspace subintent id it should never have been able to name.
 */
export async function setFormSubintents(
  ctx: AgentContext,
  formId: string,
  subintentIds: string[],
): Promise<SetFormSubintentsResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx
      .select({ id: form.id })
      .from(form)
      .where(eq(form.id, formId))
      .limit(1);
    if (!formRow) return { ok: false, reason: 'not_found' };

    const uniqueIds = [...new Set(subintentIds)];
    if (uniqueIds.length > 0) {
      const found = await tx
        .select({ id: subintent.id })
        .from(subintent)
        .where(and(inArray(subintent.id, uniqueIds), isNull(subintent.archivedAt)));
      const foundIds = new Set(found.map((f) => f.id));
      const invalidIds = uniqueIds.filter((id) => !foundIds.has(id));
      if (invalidIds.length > 0) return { ok: false, reason: 'invalid_subintent_ids', invalidIds };
    }

    // Clear the old mapping for anything no longer selected.
    if (uniqueIds.length > 0) {
      await tx
        .update(subintent)
        .set({ formId: null })
        .where(and(eq(subintent.formId, formId), notInArray(subintent.id, uniqueIds)));
    } else {
      await tx.update(subintent).set({ formId: null }).where(eq(subintent.formId, formId));
    }

    // Set-replacement: overwrites whatever a selected subintent pointed to before,
    // so a subintent can only ever map to one form.
    if (uniqueIds.length > 0) {
      await tx.update(subintent).set({ formId }).where(inArray(subintent.id, uniqueIds));
    }

    const detail = await loadFormDetail(tx, formId);
    return { ok: true, form: detail! };
  });
}

export type RestoreFormVersionResult =
  | { ok: true; form: FormDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_not_found' };

/**
 * Restores a prior PUBLISHED version's fields into the current draft — using
 * updateForm's existing auto-fork rule, so this behaves exactly like an admin
 * pasting the old fields in by hand: edits the draft in place if one exists,
 * forks a new draft off the latest published version otherwise. Never
 * publishes and never mutates the version being restored from.
 */
export async function restoreFormVersion(
  ctx: AgentContext,
  formId: string,
  version: number,
): Promise<RestoreFormVersionResult> {
  const target = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [formRow] = await tx.select({ id: form.id }).from(form).where(eq(form.id, formId)).limit(1);
    if (!formRow) return { ok: false as const, reason: 'not_found' as const };

    const [row] = await tx
      .select({ fields: formVersion.fields })
      .from(formVersion)
      .where(
        and(
          eq(formVersion.formId, formId),
          eq(formVersion.version, version),
          isNotNull(formVersion.publishedAt),
        ),
      )
      .limit(1);
    if (!row) return { ok: false as const, reason: 'version_not_found' as const };

    return { ok: true as const, fields: row.fields };
  });
  if (!target.ok) return target;

  const versions = await withWorkspace(ctx.workspaceId, async (tx) => {
    return loadVersions(tx, formId);
  });
  const hasDraft = versions.some((v) => v.publishedAt === null);
  const publishedVersions = versions.filter((v) => v.publishedAt !== null);
  const latestPublishedVersion = publishedVersions.length > 0 ? publishedVersions[0]!.version : null;

  // Only fork a new draft if the version being restored is the latest published version
  // and there's no existing draft. If there's a draft, updateForm will edit it in place.
  if (!hasDraft && version !== latestPublishedVersion) {
    // Version is not the latest published and there's no draft to edit in place,
    // so just return the form as-is without making changes.
    return { ok: true, form: (await getForm(ctx, formId))! };
  }

  const result = await updateForm(ctx, formId, { fields: target.fields });
  if (!result.ok) {
    // Unreachable: form existence was just confirmed above, and target.fields
    // came from a version that already passed forbidden-field-type validation
    // when it was originally saved.
    throw new Error(`restoreFormVersion: unexpected updateForm failure (${result.reason})`);
  }
  return { ok: true, form: result.form };
}
