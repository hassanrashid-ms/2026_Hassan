import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  formAnswerValueSchemas,
  type ConversationStatusValue,
  type FormAnswerBody,
  type FormField,
  type FormTerminateBody,
} from '@support/types';
import {
  conversation,
  formAnswer,
  formSubmission,
  formVersion,
  session,
} from '../../shared/db/schema/index.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import {
  completeFormAndHandoff,
  emitFormTerminated,
  type TerminalFormStatus,
} from '../../domain/forms/index.ts';
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts';

type AnswerBody = z.infer<typeof FormAnswerBody>;
type TerminateBody = z.infer<typeof FormTerminateBody>;

export type AnswerFormResult =
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'no_form_pending'
        | 'unknown_field'
        | 'invalid_value'
        | 'unsupported_field_type';
    }
  | { ok: true; isCorrection: boolean };

export type TerminateFormResult =
  | { ok: false; reason: 'not_found' | 'no_form_pending' }
  | { ok: true; formStatus: TerminalFormStatus; status: ConversationStatusValue };

/**
 * FK checks bypass RLS and event.session_id is ON DELETE RESTRICT, so an
 * unverified id would roll the whole answer back. Any miss degrades to null.
 * Attribution, never a gate.
 */
async function verifySession(tx: Tx, playerId: string, sessionId?: string): Promise<string | null> {
  if (!sessionId) return null;
  const [found] = await tx
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.playerId, playerId)))
    .limit(1);
  return found?.id ?? null;
}

/**
 * The player's latest conversation and its live submission. No conversation id
 * in any of these requests: the thread is resolved from the token under RLS,
 * the same rule getPlayerMessages and answerResolution follow, so the three can
 * never disagree about which conversation the card belonged to.
 */
async function liveSubmission(tx: Tx, playerId: string) {
  const [conv] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.playerId, playerId))
    .orderBy(desc(conversation.createdAt))
    .limit(1);
  if (!conv) return { conv: null, submission: null };

  const [submission] = await tx
    .select({
      id: formSubmission.id,
      formId: formSubmission.formId,
      formVersion: formSubmission.formVersion,
    })
    .from(formSubmission)
    .where(
      and(eq(formSubmission.conversationId, conv.id), eq(formSubmission.status, 'in_progress')),
    )
    .orderBy(desc(formSubmission.startedAt))
    .limit(1);

  return { conv, submission: submission ?? null };
}

export async function answerForm(ctx: PlayerContext, body: AnswerBody): Promise<AnswerFormResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const sessionId = await verifySession(tx, ctx.playerId, body.session_id);
    const { conv, submission } = await liveSubmission(tx, ctx.playerId);
    if (!conv) return { ok: false as const, reason: 'not_found' as const };
    if (!submission) return { ok: false as const, reason: 'no_form_pending' as const };

    // Resolve against the submission's snapshotted version, never the current
    // one — a field reordered in v2 must not renumber a v1 answer in flight.
    const [version] = await tx
      .select({ fields: formVersion.fields })
      .from(formVersion)
      .where(
        and(
          eq(formVersion.formId, submission.formId),
          eq(formVersion.version, submission.formVersion),
        ),
      )
      .limit(1);

    const field: FormField | undefined = version?.fields.find((f) => f.key === body.field_key);
    // The guard that replaces the FK a form_field table would have given.
    if (!field) return { ok: false as const, reason: 'unknown_field' as const };
    if (field.type === 'attachment')
      return { ok: false as const, reason: 'unsupported_field_type' as const };

    const parsed = formAnswerValueSchemas[field.type].safeParse(body.value);
    if (!parsed.success) return { ok: false as const, reason: 'invalid_value' as const };
    // Membership cannot live in a standalone schema — it depends on this field's options.
    if (field.type === 'choice' && !(field.options ?? []).includes(parsed.data as string)) {
      return { ok: false as const, reason: 'invalid_value' as const };
    }

    const [prior] = await tx
      .select({ id: formAnswer.id })
      .from(formAnswer)
      .where(
        and(eq(formAnswer.formSubmissionId, submission.id), eq(formAnswer.fieldKey, field.key)),
      )
      .limit(1);
    const isCorrection = prior !== undefined;

    // Never an update: REVOKE UPDATE ON form_answer makes the append-only rule
    // structural, and the newest created_at wins on read.
    await tx.insert(formAnswer).values({
      workspaceId: ctx.workspaceId,
      formSubmissionId: submission.id,
      fieldKey: field.key,
      fieldType: field.type,
      value: parsed.data,
    });

    // Same transaction as the row it explains. No answer value in the payload:
    // its durable home is form_answer.value, which is RLS-scoped, append-only
    // and read through one path. The event records that a field was answered
    // and which — the whole of what drop-off analysis needs.
    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'form_field_answered',
      conversationId: conv.id,
      sessionId,
      actorId: ctx.playerId,
      actorType: 'player',
      payload: {
        form_id: submission.formId,
        field_key: field.key,
        field_type: field.type,
        position: field.position,
        is_correction: isCorrection,
      },
    });

    return { ok: true as const, isCorrection };
  });
}

export async function terminateForm(
  ctx: PlayerContext,
  body: TerminateBody,
  terminatedBy: 'submit' | 'skip',
): Promise<TerminateFormResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const sessionId = await verifySession(tx, ctx.playerId, body.session_id);
    const { conv, submission } = await liveSubmission(tx, ctx.playerId);
    if (!conv) return { ok: false as const, reason: 'not_found' as const };
    if (!submission) return { ok: false as const, reason: 'no_form_pending' as const };

    const completed = await completeFormAndHandoff(
      tx,
      {
        workspaceId: ctx.workspaceId,
        conversationId: conv.id,
        submissionId: submission.id,
        actorType: 'player',
        actorId: ctx.playerId,
        sessionId,
      },
      terminatedBy,
    );
    // A terminal submission has no transition out of it. The FOR UPDATE inside
    // completeFormAndHandoff means a submit racing a skip loses here rather than
    // double-writing.
    if (!completed) return { ok: false as const, reason: 'no_form_pending' as const };

    return { ok: true as const, completed };
  });

  if (!result.ok) return result;

  // Emits only after commit.
  emitFormTerminated(ctx.workspaceId, result.completed);
  return { ok: true, formStatus: result.completed.formStatus, status: 'open' };
}
