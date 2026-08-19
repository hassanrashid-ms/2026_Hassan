import type { FormField, FormFieldType } from '@support/types'

/**
 * The five types the builder offers. `attachment` and `time` are declared in
 * `FORM_FIELD_TYPES` (`@support/types`) but must never appear in this picker —
 * `attachment` is declared-but-inert until the attachment table exists, `time`
 * is declared and unused, per the forms-builder-admin design doc.
 */
export const BUILDER_FIELD_TYPES = ['short_text', 'long_text', 'number', 'date', 'choice'] as const
export type BuilderFieldType = (typeof BUILDER_FIELD_TYPES)[number]

export const FIELD_TYPE_LABELS: Record<BuilderFieldType, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  number: 'Number',
  date: 'Date',
  choice: 'Choice',
}

/**
 * Client-side mirror of `formFieldsSchema`'s `superRefine` (`@support/types`,
 * `packages/types/src/forms.ts`) — duplicate keys, duplicate positions, a
 * `choice` field with fewer than 2 options, and a non-`choice` field carrying
 * options. This is a subset of the server schema (no key-format regex, no
 * length caps) meant to catch the same shapes so the admin sees the error
 * inline instead of round-tripping to the server for something the shared
 * schema already expresses. The server is still the source of truth.
 */
export function validateFields(fields: FormField[]): string[] {
  const errors: string[] = []
  const seenKeys = new Set<string>()
  const seenPositions = new Set<number>()

  for (const field of fields) {
    if (seenKeys.has(field.key)) {
      errors.push(`Duplicate field key "${field.key}".`)
    }
    seenKeys.add(field.key)

    if (seenPositions.has(field.position)) {
      errors.push(`Duplicate field position ${field.position}.`)
    }
    seenPositions.add(field.position)

    if (field.type === 'choice' && (field.options === undefined || field.options.length < 2)) {
      errors.push(`"${field.label || field.key}" is a choice field and needs at least 2 options.`)
    }
    if (field.type !== 'choice' && field.options !== undefined) {
      errors.push(`"${field.label || field.key}" is a ${field.type} field and must not carry options.`)
    }
  }

  return errors
}

export function isBuilderFieldType(type: FormFieldType): type is BuilderFieldType {
  return (BUILDER_FIELD_TYPES as readonly FormFieldType[]).includes(type)
}

/** Publish-time rule mirrored from `publishedFormFieldsSchema`: no fields, nothing to publish. */
export function canPublish(hasDraft: boolean, draftFields: FormField[]): boolean {
  return hasDraft && draftFields.length > 0 && validateFields(draftFields).length === 0
}

/**
 * `Published v{n}` / `Draft` / `Published v{n} · draft pending` / `Archived` —
 * derived client-side from the three summary fields, per the FormTable spec.
 * Archived always wins (an archived form's mapping is inert but its record is
 * still archived, matching `resolveSubintentForm`'s "archived = no form" rule).
 */
export function formStatusLabel(form: {
  archivedAt: string | null
  publishedVersion: number | null
  hasDraft: boolean
}): string {
  if (form.archivedAt !== null) return 'Archived'
  if (form.publishedVersion !== null) {
    return form.hasDraft ? `Published v${form.publishedVersion} · draft pending` : `Published v${form.publishedVersion}`
  }
  return 'Draft'
}

/** Renumbers `position` to a dense 0..n-1 sequence matching array order — used after add/remove/move. */
export function renumberPositions(fields: FormField[]): FormField[] {
  return fields.map((field, index) => ({ ...field, position: index }))
}

/** Derives a stable `key` from a label: lower-case, underscores, deduped against existing keys. */
export function keyFromLabel(label: string, existingKeys: readonly string[]): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'field'
  if (!existingKeys.includes(base)) return base
  let n = 2
  while (existingKeys.includes(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}
