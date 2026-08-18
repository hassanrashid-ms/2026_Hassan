import type { AgentFormView } from '@support/types'
import { cn } from '../../../../lib/cn.ts'
import { formAnswerValue } from './formAnswerValue.ts'
import { formStatusLine } from './formStatusLine.ts'

/**
 * The third stacked section of the rail: what the bot asked before handoff and
 * what came back. Read-only in every state — nothing here edits a form,
 * re-offers one, or shows correction history.
 *
 * Four states render; the fifth — no form at all — is the caller omitting this
 * component entirely, the same call the raw section makes when it is `{}`.
 *
 * Labels come from the API already resolved against the submission's version,
 * and values carry the answer's own snapshotted type. This component resolves
 * nothing.
 */
export function FormPanel({ form }: { form: AgentFormView }) {
  // A skipped form has no answers by construction, so listing every field as
  // "Not answered" would repeat the status line four times. In every other
  // state the gaps are the point and stay visible as rows.
  const showFields = form.status !== 'skipped' && form.fields.length > 0

  return (
    <section className="px-4 py-3" aria-label="Form">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Form</h3>
      <p className="mt-1 text-sm font-medium text-text">
        {form.form_name} · v{form.form_version}
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {formStatusLine(form.status, form.answered_count, form.field_count)}
      </p>
      {showFields && (
        <dl className="mt-2 flex flex-col gap-1.5">
          {form.fields.map((field) => (
            <div key={field.key} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-xs text-muted">{field.label}</dt>
              <dd
                className={cn(
                  'truncate text-right text-sm',
                  field.answered ? 'text-text' : 'text-muted italic',
                )}
              >
                {formAnswerValue(field.field_type, field.value, field.answered)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
