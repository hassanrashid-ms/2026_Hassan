import { z } from 'zod';
import type { ConversationStatusValue } from './chat.ts';

/**
 * NOT part of the frozen SDK contract in the sdk-wire sense, but the type union
 * IS frozen once for the same reason: a shipped client parses it. `attachment`
 * is declared now and inert until the `attachment` table exists — the submission
 * service rejects it as unsupported, and the form-builder must not offer it.
 * `time` is likewise declared and unused: no seeded form uses it, and removing a
 * value from a shipped pg enum is a migration for no gain.
 *
 * This array is the canonical list. `schema/enums.ts`'s `form_field_type` mirrors
 * it in the same order, and `tests/schema.test.ts` asserts the two match, so they
 * cannot drift.
 */
export const FORM_FIELD_TYPES = [
  'short_text',
  'long_text',
  'number',
  'date',
  'time',
  'choice',
  'attachment',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/**
 * One question. `key` is a stable string that survives reordering and
 * relabelling without touching a single answer row — which is the whole reason
 * fields are jsonb here rather than a `form_field` table (spec-contradictions
 * §14). `position` is the render order and is snapshotted into events later, so
 * it must be present and unique.
 *
 * `isRequired` blocks progress: the webview refuses to advance past an
 * unanswered required field and hides "Skip and talk to an agent" while any
 * required field in the form is unanswered, and `POST /surface/form/submit`
 * and `/skip` reject the same condition server-side (see `terminateForm` in
 * `formService.ts`). The one exception is the form-timeout sweeper, which
 * force-closes a stale submission regardless — see `formTimeout.ts`.
 */
export const formFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'A field key is lower-case letters, digits and underscores only.'),
  label: z.string().min(1).max(200),
  type: z.enum(FORM_FIELD_TYPES),
  isRequired: z.boolean(),
  position: z.number().int().nonnegative(),
  options: z.array(z.string().min(1)).min(2).optional(),
  /** Grey example text inside an empty input — "e.g. ABC-123456" — never a value. */
  placeholder: z.string().min(1).max(200).optional(),
  /** One line under the question, for context the label alone doesn't carry. */
  helperText: z.string().min(1).max(300).optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

/**
 * The cross-field rules a single field cannot express.
 * An EMPTY array is accepted here: `form_version.fields` defaults to `[]` and a
 * draft legitimately has no questions yet.
 */
export const formFieldsSchema = z.array(formFieldSchema).superRefine((fields, ctx) => {
  const seenKeys = new Set<string>();
  const seenPositions = new Set<number>();
  fields.forEach((field, i) => {
    if (seenKeys.has(field.key)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'key'],
        message: `Duplicate field key "${field.key}".`,
      });
    }
    seenKeys.add(field.key);

    if (seenPositions.has(field.position)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'position'],
        message: `Duplicate field position ${field.position}.`,
      });
    }
    seenPositions.add(field.position);

    if (field.type === 'choice' && field.options === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'options'],
        message: 'A choice field needs options.',
      });
    }
    if (field.type !== 'choice' && field.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'options'],
        message: `A ${field.type} field must not carry options.`,
      });
    }
  });
});

/** The publish-time rule: a version with no questions asks nothing. */
export const publishedFormFieldsSchema = formFieldsSchema.refine((fields) => fields.length > 0, {
  message: 'A published form version must have at least one field.',
});

/**
 * The `form_answer.value` jsonb shape, keyed by the field's declared type.
 *
 * `choice` membership cannot be expressed standalone — it depends on that
 * field's `options` — so it is checked in the same guard that resolves the
 * field, never here.
 */
export const formAnswerValueSchemas = {
  short_text: z.string().min(1).max(500),
  long_text: z.string().min(1).max(5000),
  number: z.number().finite(),
  date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  choice: z.string().min(1),
  // Deliberately a shape regex, not `z.uuid()`: zod 4's `z.uuid()` enforces the
  // RFC variant nibble, which rejects the all-ones ids the tests and seeds use.
  // Any well-formed uuid string is what this contract needs.
  attachment: z.object({
    attachmentId: z
      .string()
      .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
  }),
} satisfies Record<FormFieldType, z.ZodType>;

/**
 * Admin authoring wire contract for `formsRouter`/`formsService`. Not part of
 * the SDK-frozen contract above this comment — these ship with the server.
 */
export const CreateFormBody = z.object({ name: z.string().min(1).max(200) });

/** `fields`, when present, is validated shape-wise here; the attachment/time
 * builder-policy rejection is a service-layer check the schema doesn't express. */
export const UpdateFormBody = z.object({
  name: z.string().min(1).max(200).optional(),
  fields: formFieldsSchema.optional(),
});

export const SetFormSubintentsBody = z.object({ subintentIds: z.array(z.uuid()) });

export type FormSummary = {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  mappedSubintentCount: number;
  publishedVersion: number | null;
  hasDraft: boolean;
};
export type FormsListResponse = { forms: FormSummary[] };

export type CreateFormResponse = { id: string; draftVersionId: string };

export type FormMappedSubintent = { id: string; name: string; intentId: string };

export type FormVersionView = { version: number; fields: FormField[]; publishedAt: string | null };

export type FormDetail = {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  draft: FormVersionView | null;
  published: FormVersionView | null;
  subintents: FormMappedSubintent[];
};

export type FormSubmissionStatus = 'in_progress' | 'completed' | 'partial' | 'skipped';

/** The latest answer for a field. Older rows are history and never reach a player. */
export type PlayerFormAnswerView = { field_key: string; value: unknown };

/**
 * Everything the pinned card needs to render from cold, including a reconnect
 * mid-form. `fields` comes from the submission's snapshotted version, never the
 * current one, so a form edited to v2 does not renumber a v1 card mid-answer.
 */
export type PlayerFormView = {
  submission_id: string;
  form_id: string;
  form_name: string;
  version: number;
  fields: FormField[];
  answers: PlayerFormAnswerView[];
};

/**
 * `value` is `unknown` on the wire on purpose: which schema validates it depends
 * on the resolved field's declared type, which only the server can look up.
 * `session_id` is best-effort attribution — verified server-side, degraded to
 * null on any miss, and never a gate on the answer being accepted.
 */
export const FormAnswerBody = z.object({
  field_key: z.string().min(1).max(64),
  value: z.unknown(),
  session_id: z.uuid().optional(),
});

/** Submit and skip carry nothing but attribution. Which one was called is the whole difference. */
export const FormTerminateBody = z.object({ session_id: z.uuid().optional() });

export type FormAnswerResponse = { ok: true; is_correction: boolean };

export type FormTerminateResponse = {
  confirm_phase: 'none';
  status: ConversationStatusValue;
  form_status: Exclude<FormSubmissionStatus, 'in_progress'>;
};
