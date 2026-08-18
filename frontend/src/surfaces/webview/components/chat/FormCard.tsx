import { useMemo, useState } from 'react'
import type { FormField, PlayerFormView } from '@support/types'
import { SupportButton } from '@/surfaces/webview/components/SupportButton'
import { cn } from '@/surfaces/webview/lib/cn'

type FormCardProps = {
  form: PlayerFormView
  onAnswer: (fieldKey: string, value: unknown) => Promise<unknown>
  onSubmit: () => void
  onSkip: () => void
  busy: boolean
}

/** Empty means "nothing to send": a blank value is never posted, required or not. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/**
 * The questions, one at a time, pinned above the composer — not a modal and not
 * conversation turns. The card writes no message rows: answers live in
 * form_answer, and duplicating them into the transcript would put the same fact
 * in two tables that can disagree while filling the agent's thread with
 * questionnaire noise.
 *
 * Progress state (which question, what has been typed) is local and deliberately
 * never refetched mid-form. `form.answers` seeds it once — that is what makes a
 * reconnect resume at the right question rather than at question one.
 */
export function FormCard({ form, onAnswer, onSubmit, onSkip, busy }: FormCardProps) {
  const fields = useMemo(() => [...form.fields].sort((a, b) => a.position - b.position), [form.fields])

  // The value the server already holds for each field. `draft` diverges from it
  // as the player types; the difference is exactly what decides whether Next
  // posts anything.
  const [committed, setCommitted] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(form.answers.map((a) => [a.field_key, a.value])),
  )
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(form.answers.map((a) => [a.field_key, a.value])),
  )
  const [index, setIndex] = useState(() => {
    const answered = new Set(form.answers.map((a) => a.field_key))
    const first = fields.findIndex((f) => !answered.has(f.key))
    return first === -1 ? Math.max(fields.length - 1, 0) : first
  })
  const [sending, setSending] = useState(false)

  const field = fields[index]
  if (!field) return null

  const isLast = index === fields.length - 1
  const value = draft[field.key]
  const changed = !isEmpty(value) && value !== committed[field.key]
  const disabled = busy || sending

  const advance = async () => {
    setSending(true)
    try {
      // Pressing Next on an unchanged prefilled answer writes nothing:
      // re-submitting an identical value would inflate the correction rate with
      // events that record no correction, and grow an append-only table with
      // rows that differ only by timestamp.
      if (changed) {
        await onAnswer(field.key, value)
        setCommitted((current) => ({ ...current, [field.key]: value }))
      }
      if (isLast) onSubmit()
      else setIndex((current) => current + 1)
    } finally {
      setSending(false)
    }
  }

  const set = (next: unknown) => setDraft((current) => ({ ...current, [field.key]: next }))

  return (
    <div role="group" aria-label={form.form_name} className="flex flex-col gap-4">
      {/* One line, not a paragraph: it only needs to set expectations once,
          before the player invests in typing an answer. */}
      {index === 0 && (
        <p className="text-xs leading-snug text-muted sm:text-sm">
          Quick questions before we connect you with support
        </p>
      )}

      <div className="flex items-center justify-between">
        {/* Back is not politeness: a player who mistypes a receipt ID on a
            four-question form has no other recovery. */}
        {index > 0 ? (
          <button
            type="button"
            className="min-h-11 text-sm text-muted"
            onClick={() => setIndex((current) => current - 1)}
            disabled={disabled}
          >
            Back
          </button>
        ) : (
          <span />
        )}
        <span className="text-sm text-muted">{`${index + 1} of ${fields.length}`}</span>
      </div>

      <p className="text-lg font-semibold text-text">{field.label}</p>

      <FieldInput field={field} value={value} onChange={set} disabled={disabled} />

      <SupportButton
        variant="primary"
        className="w-full"
        // Required fields do not block Next. isRequired is soft, because
        // nothing about a form may block a player reaching a human.
        disabled={disabled}
        onClick={() => void advance()}
      >
        {isLast ? 'Submit' : 'Next'}
      </SupportButton>

      {/* The product spec's own label. Present on every question, first to last,
          and never removable. */}
      <button
        type="button"
        className="min-h-11 text-sm text-muted underline"
        onClick={onSkip}
        disabled={disabled}
      >
        Skip and talk to an agent
      </button>
    </div>
  )
}

/**
 * A map from the six usable types to inputs. `choice` renders as buttons, not a
 * <select> — the product mockup draws it that way and it is one tap on a phone.
 * `attachment` and `time` are unreachable: no seeded form uses either, and the
 * answer route rejects attachment outright.
 */
function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FormField
  value: unknown
  onChange: (next: unknown) => void
  disabled: boolean
}) {
  const inputClass = cn(
    'min-h-11 w-full rounded-card bg-surface px-4 py-3 text-base text-text placeholder:text-muted',
    'border border-muted/30 focus:border-accent outline-none disabled:opacity-60',
  )

  switch (field.type) {
    case 'choice':
      return (
        <div className="flex flex-col gap-2">
          {(field.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={value === option}
              disabled={disabled}
              onClick={() => onChange(option)}
              className={cn(
                'min-h-11 rounded-card px-4 py-2.5 text-base',
                value === option ? 'bg-accent text-accent-fg' : 'bg-surface text-text',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )
    case 'long_text':
      return (
        <textarea
          rows={3}
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, 'resize-none')}
        />
      )
    case 'number':
      return (
        <input
          type="number"
          inputMode="decimal"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={inputClass}
        />
      )
    case 'date':
      return (
        <input
          type="date"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={inputClass}
        />
      )
    case 'time':
      return (
        <input
          type="time"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={inputClass}
        />
      )
    case 'attachment':
      // Declared but inert until the attachment table exists. Rendering nothing
      // still leaves Next and Skip live, so it can never trap a player.
      return <p className="text-sm text-muted">This question cannot be answered here yet.</p>
    case 'short_text':
    default:
      return (
        <input
          type="text"
          aria-label={field.label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )
  }
}
