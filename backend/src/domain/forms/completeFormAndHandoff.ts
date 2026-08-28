import { and, desc, eq, asc } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import {
  attachment,
  conversation,
  event,
  form,
  formAnswer,
  formSubmission,
  formVersion,
} from '../../shared/db/schema/index.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { assignOnHandoff } from '../bot/assignOnHandoff.ts';
import { postMessage, type PostedMessageRow } from '../conversations/postMessage.ts';
import { formSummaryMessage } from './messages.ts';
import { NO_AGENTS_ONLINE_MESSAGE } from '../bot/messages.ts';

export type FormTerminationReason = 'submit' | 'skip' | 'timeout';
export type TerminalFormStatus = 'completed' | 'partial' | 'skipped';

export type CompleteFormContext = {
  workspaceId: string;
  conversationId: string;
  submissionId: string;
  /** 'player' for submit and skip; 'system' with a null actor for the sweeper. */
  actorType: 'player' | 'system';
  actorId: string | null;
  sessionId: string | null;
};

export type CompleteFormResult = {
  conversationId: string;
  formStatus: TerminalFormStatus;
  answeredCount: number;
  fieldCount: number;
  assignedAgentId: string | null;
  posted: PostedMessageRow;
  /** Set only when assignOnHandoff found nobody online — a second public line. */
  noAgentsOnlinePosted: PostedMessageRow | null;
};

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
      formName: form.name,
    })
    .from(formSubmission)
    .innerJoin(form, eq(form.id, formSubmission.formId))
    .where(
      and(
        eq(formSubmission.id, ctx.submissionId),
        eq(formSubmission.conversationId, ctx.conversationId),
      ),
    )
    .for('update', { of: formSubmission })
    .limit(1);

  if (!submission || submission.status !== 'in_progress') return null;

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
  const fieldCount = version?.fields.length ?? 0;

  // Distinct keys, never row count: a corrected field is two rows and one
  // answered question, and the snapshot on form_completed has to say the latter.
  const answeredRows = await tx
    .selectDistinct({ fieldKey: formAnswer.fieldKey })
    .from(formAnswer)
    .where(eq(formAnswer.formSubmissionId, submission.id));
  const answeredCount = answeredRows.length;

  // §1.3: status records the outcome, not the button. Which action terminated
  // the submission is a fact about the turn and lives in form_completed.
  const formStatus: TerminalFormStatus =
    answeredCount === 0
      ? 'skipped'
      : fieldCount > 0 && answeredCount >= fieldCount
        ? 'completed'
        : 'partial';

  await tx
    .update(formSubmission)
    .set({ status: formStatus, submittedAt: new Date() })
    .where(eq(formSubmission.id, submission.id));

  const assignedAgentId = await assignOnHandoff(tx, ctx.workspaceId);
  await tx
    .update(conversation)
    .set({ status: 'open', confirmPhase: 'none', assignedAgentId })
    .where(eq(conversation.id, ctx.conversationId));

  const noAgentsOnlinePosted =
    assignedAgentId === null
      ? await postMessage(tx, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          authorType: 'system',
          actorId: null,
          body: NO_AGENTS_ONLINE_MESSAGE,
          visibility: 'public',
        })
      : null;

  // The reason belongs to the bot turn that offered the form, so it is read back
  // from that turn's own snapshot. Null rather than a guess if the event is
  // missing: a null reason is a visible bug, an invented one is not.
  const [offer] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.conversationId, ctx.conversationId), eq(event.type, 'form_offered')))
    .orderBy(desc(event.occurredAt))
    .limit(1);
  const reason =
    (offer?.payload as { handoff_reason?: string } | undefined)?.handoff_reason ?? null;

  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'bot_handoff',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: { reason, assigned_agent_id: assignedAgentId },
  });

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
  });

  const posted = await postMessage(tx, {
    workspaceId: ctx.workspaceId,
    conversationId: ctx.conversationId,
    authorType: 'system',
    actorId: null,
    body: formSummaryMessage(formStatus),
    visibility: 'public',
  });

  if (answeredCount > 0) {
    const answerRows = await tx
      .select({
        fieldKey: formAnswer.fieldKey,
        value: formAnswer.value,
      })
      .from(formAnswer)
      .where(eq(formAnswer.formSubmissionId, submission.id))
      .orderBy(asc(formAnswer.createdAt), asc(formAnswer.id));

    // Last row per key wins
    const latestAnswers = new Map<string, any>();
    for (const row of answerRows) {
      latestAnswers.set(row.fieldKey, row.value);
    }

    const orderedFields = [...(version?.fields ?? [])].sort((a, b) => a.position - b.position);

    await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      authorType: 'system',
      actorId: null,
      body: formatFormAnswers(submission.formName, orderedFields, latestAnswers),
      visibility: 'internal',
    });

    // `attachment`-type answers get their own message instead of a line in the
    // summary above: `attachment.messageId` is unique, so one message can never
    // carry two of these, and the summary's body is plain markdown text with no
    // slot for a thumbnail anyway. Each one reuses the player's original upload's
    // storageKey — the object in storage is read-only and immutable, so pointing
    // a second attachment row at the same key needs no copy — per the FK-bypasses-
    // RLS rule, the id is re-confirmed visible with a scoped select before trusting it.
    for (const field of orderedFields) {
      if (field.type !== 'attachment') continue;
      const val = latestAnswers.get(field.key) as { attachmentId?: string } | undefined;
      const attachmentId = val?.attachmentId;
      if (!attachmentId) continue;

      const [source] = await tx
        .select({
          storageKey: attachment.storageKey,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          byteSize: attachment.byteSize,
        })
        .from(attachment)
        .where(and(eq(attachment.id, attachmentId), eq(attachment.workspaceId, ctx.workspaceId)))
        .limit(1);
      if (!source) continue;

      const attachmentMessage = await postMessage(tx, {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId,
        authorType: 'system',
        actorId: null,
        body: escapeMarkdown(String(field.label).trim()) || 'Attachment',
        visibility: 'internal',
      });

      await tx.insert(attachment).values({
        workspaceId: ctx.workspaceId,
        messageId: attachmentMessage.id,
        storageKey: source.storageKey,
        filename: source.filename,
        mimeType: source.mimeType,
        byteSize: source.byteSize,
      });
    }
  }

  return {
    conversationId: ctx.conversationId,
    formStatus,
    answeredCount,
    fieldCount,
    assignedAgentId,
    posted,
    noAgentsOnlinePosted,
  };
}

// Player-supplied form answers and workspace-configured field labels/names ride into a
// `system` message body that MessageBody.tsx renders as markdown. Escaping the markdown-
// significant characters here is what keeps a crafted answer (e.g. "[click](evil)") from
// becoming a live link in the agent console — see the MARKDOWN_AUTHORS contract note there.
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!>|~]/g, '\\$&');
}

function formatFormAnswers(
  formName: string,
  orderedFields: any[],
  latestAnswers: Map<string, any>,
): string {
  const lines: string[] = [`**Form Submitted:** ${escapeMarkdown(formName)}`, ''];
  for (const field of orderedFields) {
    // Attachment answers ride in their own message (see the loop in
    // completeFormAndHandoff, above) so they get a real preview instead of a
    // stringified value — nothing to render for them in this summary.
    if (field.type === 'attachment') continue;

    const val = latestAnswers.get(field.key);
    const displayVal = Array.isArray(val) ? val.join(', ') : val;
    const isEmptyArray = Array.isArray(val) && val.length === 0;
    // Trimmed before wrapping in `**`: CommonMark refuses to close an emphasis
    // run when the closing delimiter is preceded by whitespace, so a label with
    // a trailing space (e.g. a form builder typo) would render its asterisks
    // literally instead of bold.
    const label = escapeMarkdown(String(field.label).trim());
    // A real GFM list marker (`- `), not a bullet character: react-markdown
    // treats consecutive `\n`-joined lines with no blank line between them as
    // one paragraph, where a single `\n` is a soft break that renders as a
    // space — which is why every "bullet" used to run together on one line.
    // List items are a block boundary, so a single `\n` between them is enough.
    if (val !== undefined && val !== null && val !== '' && !isEmptyArray) {
      lines.push(`- **${label}**: ${escapeMarkdown(String(displayVal))}`);
    } else {
      lines.push(`- **${label}**: *(Not answered)*`);
    }
  }
  return lines.join('\n');
}
