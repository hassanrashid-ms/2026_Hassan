import { and, desc, eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { conversation, event, formAnswer, formSubmission, formVersion } from '../../shared/db/schema/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { assignOnHandoff } from '../bot/assignOnHandoff.ts'
import { postMessage, type PostedMessageRow } from '../conversations/postMessage.ts'
import { formSummaryMessage } from './messages.ts'

export type FormTerminationReason = 'submit' | 'skip' | 'timeout'
export type TerminalFormStatus = 'completed' | 'partial' | 'skipped'

export type CompleteFormContext = {
  workspaceId: string
  conversationId: string
  submissionId: string
  /** 'player' for submit and skip; 'system' with a null actor for the sweeper. */
  actorType: 'player' | 'system'
  actorId: string | null
  sessionId: string | null
}

export type CompleteFormResult = {
  conversationId: string
  formStatus: TerminalFormStatus
  answeredCount: number
  fieldCount: number
  assignedAgentId: string | null
  posted: PostedMessageRow
}

/**
 * The terminal half of the split handoff, and the only writer of it. Three
 * callers — POST /surface/form/submit, POST /surface/form/skip, and the
 * form-timeout sweeper — share this one transaction shape, so a form the player
 * skipped and a form the sweeper closed reach an identical end state and differ
 * only in `form_completed.terminated_by`. That is deliberate: the two need
 * opposite fixes, and the difference has to be a fact on a row rather than
 * something inferred from what is absent.
 *
 * Returns null when the submission is not in_progress. The guard is a
 * SELECT … FOR UPDATE inside this transaction rather than a check in each
 * caller, so a submit racing the sweeper serialises instead of double-writing.
 *
 * The caller owns the transaction and must call emitFormTerminated only after it
 * commits.
 */
export async function completeFormAndHandoff(
  tx: Tx,
  ctx: CompleteFormContext,
  terminatedBy: FormTerminationReason,
): Promise<CompleteFormResult | null> {
  const [submission] = await tx
    .select({
      id: formSubmission.id,
      status: formSubmission.status,
      formId: formSubmission.formId,
      formVersion: formSubmission.formVersion,
    })
    .from(formSubmission)
    .where(and(eq(formSubmission.id, ctx.submissionId), eq(formSubmission.conversationId, ctx.conversationId)))
    .for('update')
    .limit(1)

  if (!submission || submission.status !== 'in_progress') return null

  const [version] = await tx
    .select({ fields: formVersion.fields })
    .from(formVersion)
    .where(and(eq(formVersion.formId, submission.formId), eq(formVersion.version, submission.formVersion)))
    .limit(1)
  const fieldCount = version?.fields.length ?? 0

  // Distinct keys, never row count: a corrected field is two rows and one
  // answered question, and the snapshot on form_completed has to say the latter.
  const answeredRows = await tx
    .selectDistinct({ fieldKey: formAnswer.fieldKey })
    .from(formAnswer)
    .where(eq(formAnswer.formSubmissionId, submission.id))
  const answeredCount = answeredRows.length

  // §1.3: status records the outcome, not the button. Which action terminated
  // the submission is a fact about the turn and lives in form_completed.
  const formStatus: TerminalFormStatus =
    answeredCount === 0 ? 'skipped' : fieldCount > 0 && answeredCount >= fieldCount ? 'completed' : 'partial'

  await tx
    .update(formSubmission)
    .set({ status: formStatus, submittedAt: new Date() })
    .where(eq(formSubmission.id, submission.id))

  const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId)
  await tx
    .update(conversation)
    .set({ status: 'open', confirmPhase: 'none', assignedAgentId })
    .where(eq(conversation.id, ctx.conversationId))

  // The reason belongs to the bot turn that offered the form, so it is read back
  // from that turn's own snapshot. Null rather than a guess if the event is
  // missing: a null reason is a visible bug, an invented one is not.
  const [offer] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.conversationId, ctx.conversationId), eq(event.type, 'form_offered')))
    .orderBy(desc(event.occurredAt))
    .limit(1)
  const reason = (offer?.payload as { handoff_reason?: string } | undefined)?.handoff_reason ?? null

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'bot_handoff',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: { reason, assigned_agent_id: assignedAgentId },
  })

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'form_completed',
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    actorId: ctx.actorId,
    actorType: ctx.actorType,
    payload: {
      status: formStatus,
      terminated_by: terminatedBy,
      answered_count: answeredCount,
      field_count: fieldCount,
    },
  })

  const posted = await postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId: ctx.conversationId,
    authorType: 'system',
    actorId: null,
    body: formSummaryMessage(formStatus),
    visibility: 'public',
  })

  return { conversationId: ctx.conversationId, formStatus, answeredCount, fieldCount, assignedAgentId, posted }
}
