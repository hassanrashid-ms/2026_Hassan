import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { FormField } from '@support/types'
import { form, formVersion, subintent } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'

export type ResolvedForm = {
  formId: string
  formName: string
  version: number
  fields: FormField[]
}

/**
 * Does this subintent show a form, and if so which version?
 *
 * All three conditions must hold, per
 * docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md:
 *   1. subintent.form_id IS NOT NULL
 *   2. that form's archived_at IS NULL
 *   3. that form has at least one version with published_at IS NOT NULL
 * The version returned is the highest `version` with published_at IS NOT NULL.
 *
 * A FAILURE OF ANY CONDITION RETURNS null, NEVER AN ERROR. Same shape as the
 * existing rule that missing player state is a state, not an error: the
 * conversation proceeds without a form. Roughly 28 of the seeded subintents map
 * to nothing, so null is the COMMON path, not the exceptional one.
 *
 * One function on purpose, so slice 2 has exactly one place that asks "is there
 * a form here" and cannot answer it two different ways. Do not inline this
 * query anywhere else.
 *
 * Scoping is the caller's transaction: `tx` comes from `withWorkspace`, so RLS
 * already restricts every table below to one workspace.
 */
export async function resolveSubintentForm(tx: Tx, subintentId: string): Promise<ResolvedForm | null> {
  const [row] = await tx
    .select({
      formId: form.id,
      formName: form.name,
      version: formVersion.version,
      fields: formVersion.fields,
    })
    .from(subintent)
    // An inner join is what turns condition 1 into "no row": a null form_id
    // matches nothing, so it needs no separate branch.
    .innerJoin(form, eq(form.id, subintent.formId))
    .innerJoin(formVersion, eq(formVersion.formId, form.id))
    .where(and(eq(subintent.id, subintentId), isNull(form.archivedAt), isNotNull(formVersion.publishedAt)))
    .orderBy(desc(formVersion.version))
    .limit(1)

  if (!row) return null

  return {
    formId: row.formId,
    formName: row.formName,
    version: row.version,
    // Sorted here rather than trusted from storage: `position` is the render
    // order the card and the agent rail both read, and slice 2 snapshots it into
    // event payloads. One sort site beats three callers each remembering to.
    fields: [...row.fields].sort((a, b) => a.position - b.position),
  }
}
