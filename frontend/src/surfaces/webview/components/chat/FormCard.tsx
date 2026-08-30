import { useMemo, useState } from 'react';
import type { FormField, PlayerFormView } from '@support/types';
import { SupportButton } from '@/surfaces/webview/components/SupportButton';
import { post } from '@/services/bridgeService';
import { cn } from '@/surfaces/webview/lib/cn';

type FormCardProps = {
  form: PlayerFormView;
  onAnswer: (fieldKey: string, value: unknown) => Promise<unknown>;
  onSubmit: () => void;
  onSkip: () => void;
  busy: boolean;
  /**
   * The attachment field's own send-and-advance path, separate from
   * onAnswer/advance: a picked file that uploads successfully has no
   * "unchanged, don't resubmit" case the way a re-shown text field does, so
   * it bypasses the draft/committed/advance machinery entirely. Optional so
   * existing callers/tests that seed no attachment field are unaffected.
   */
  onSendAttachment?: (fieldKey: string, file: File) => Promise<void>;
};

/** Empty means "nothing to send": a blank value is never posted, required or not. */
function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
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
export function FormCard({
  form,
  onAnswer,
  onSubmit,
  onSkip,
  busy,
  onSendAttachment,
}: FormCardProps) {
  const fields = useMemo(
    () => [...form.fields].sort((a, b) => a.position - b.position),
    [form.fields],
  );

  // The value the server already holds for each field. `draft` diverges from it
  // as the player types; the difference is exactly what decides whether Next
  // posts anything.
  const [committed, setCommitted] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(form.answers.map((a) => [a.field_key, a.value])),
  );
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(form.answers.map((a) => [a.field_key, a.value])),
  );
  const [index, setIndex] = useState(() => {
    const answered = new Set(form.answers.map((a) => a.field_key));
    const first = fields.findIndex((f) => !answered.has(f.key));
    return first === -1 ? Math.max(fields.length - 1, 0) : first;
  });
  const [sending, setSending] = useState(false);

  const field = fields[index];
  if (!field) return null;

  const isLast = index === fields.length - 1;
  const value = draft[field.key];
  const changed = !isEmpty(value) && value !== committed[field.key];
  const disabled = busy || sending;

  // A field's effective answer: the one on screen reads its live draft, every
  // other field reads what the server already has. Used both to gate Next on
  // the current question and to decide whether Skip may still be shown at all.
  const effectiveValue = (f: FormField) => (f.key === field.key ? value : committed[f.key]);
  const currentRequiredUnanswered = field.isRequired && isEmpty(effectiveValue(field));
  const anyRequiredUnanswered = fields.some((f) => f.isRequired && isEmpty(effectiveValue(f)));

  const advance = async () => {
    setSending(true);
    try {
      // Pressing Next on an unchanged prefilled answer writes nothing:
      // re-submitting an identical value would inflate the correction rate with
      // events that record no correction, and grow an append-only table with
      // rows that differ only by timestamp.
      if (changed) {
        await onAnswer(field.key, value);
        setCommitted((current) => ({ ...current, [field.key]: value }));
      }
      if (isLast) onSubmit();
      else setIndex((current) => current + 1);
    } finally {
      setSending(false);
    }
  };

  const set = (next: unknown) => setDraft((current) => ({ ...current, [field.key]: next }));

  // The attachment field's own advance path: no draft/changed value to
  // compare, since a picked file that uploaded successfully is always a
  // "yes, send this" — there is no re-shown-unchanged case to skip posting
  // for. This mirrors advance()'s isLast/onSubmit/setIndex tail without its
  // changed-value branch.
  const handleAttachmentPicked = async (fieldKey: string, file: File) => {
    if (!onSendAttachment) return;
    setSending(true);
    try {
      await onSendAttachment(fieldKey, file);
      setCommitted((current) => ({ ...current, [fieldKey]: true }));
      if (isLast) onSubmit();
      else setIndex((current) => current + 1);
    } finally {
      setSending(false);
    }
  };

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

      <div className="flex flex-col gap-1">
        <p className="flex items-baseline gap-2 text-xl font-bold tracking-tight text-text">
          <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-accent" />
          {field.label}
          {field.isRequired && (
            <span aria-hidden="true" className="text-accent">
              *
            </span>
          )}
        </p>
        {field.helperText && <p className="text-sm text-muted">{field.helperText}</p>}
      </div>

      <FieldInput
        field={field}
        value={value}
        onChange={set}
        disabled={disabled}
        onAttachmentPicked={(file) => void handleAttachmentPicked(field.key, file)}
      />

      <SupportButton
        variant="primary"
        className="w-full"
        // A required field must have a value before Next may advance.
        disabled={disabled || currentRequiredUnanswered}
        onClick={() => void advance()}
      >
        {isLast ? 'Submit' : 'Next'}
      </SupportButton>

      {/* Hidden, not merely disabled, while any required field in the form is
          unanswered: a player may not reach an agent around a required answer. */}
      {!anyRequiredUnanswered && (
        <button
          type="button"
          className="min-h-11 text-sm text-muted underline"
          onClick={onSkip}
          disabled={disabled}
        >
          Skip and talk to an agent
        </button>
      )}
    </div>
  );
}

/**
 * A map from the six usable types to inputs. `choice` renders as buttons, not a
 * <select> — the product mockup draws it that way and it is one tap on a phone.
 * `time` is unreachable: no seeded form uses it.
 */
function FieldInput({
  field,
  value,
  onChange,
  disabled,
  onAttachmentPicked,
}: {
  field: FormField;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled: boolean;
  onAttachmentPicked: (file: File) => void;
}) {
  // Older form versions may not include a placeholder. Keep those inputs
  // actionable by using the field label as a frontend-only fallback.
  const placeholder = field.placeholder ?? field.label;

  const inputClass = cn(
    'min-h-11 w-full rounded-card bg-surface px-4 py-3 text-base text-text placeholder:text-muted',
    'border border-muted/30 focus:border-accent outline-none disabled:opacity-60',
  );

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
      );
    case 'long_text':
      return (
        <textarea
          rows={3}
          aria-label={field.label}
          placeholder={placeholder}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, 'resize-none')}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          inputMode="decimal"
          aria-label={field.label}
          placeholder={placeholder}
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={inputClass}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          aria-label={field.label}
          // A support form never has a legitimate reason to ask about a date that
          // hasn't happened yet — "when did you buy this" and "when did it break"
          // are both always in the past. Not enforced server-side, unlike isRequired.
          max={today()}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          className={inputClass}
        />
      );
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
      );
    case 'attachment':
      // Bypasses draft/onChange entirely: picking a file drives its own
      // upload-then-advance path in FormCard (handleAttachmentPicked), not
      // the changed-value comparison Next relies on for typed fields.
      return (
        <div className="flex flex-col gap-2">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
            aria-label="Attach image or video"
            disabled={disabled}
            // Must post before the native picker opens (it starts as this
            // click's default action): the SDK's resume watchdog needs to
            // already know to expect the pause it's about to see.
            onClick={() => post({ type: 'expect_native_dialog' })}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onAttachmentPicked(file);
            }}
          />
        </div>
      );
    case 'short_text':
    default:
      return (
        <input
          type="text"
          aria-label={field.label}
          placeholder={placeholder}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      );
  }
}

/** Local YYYY-MM-DD, matching the `<input type="date">` value format exactly. */
function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}
