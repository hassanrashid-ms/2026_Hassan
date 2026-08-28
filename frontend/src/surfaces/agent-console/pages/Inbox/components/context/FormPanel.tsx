import type { AgentFormAttachmentValue, AgentFormView } from '@support/types';
import { cn } from '../../../../lib/cn.ts';
import { formAnswerValue } from './formAnswerValue.ts';
import { formStatusLine } from './formStatusLine.ts';
import type { ChatAttachment } from '../../../../../../features/chat/components/types.ts';

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
 * nothing — an `attachment` field's `value` already arrives as
 * `AgentFormAttachmentValue` (url included, signed server-side), so rendering
 * a thumbnail here is presentation, not resolution.
 */
export function FormPanel({
  form,
  onExpandAttachment,
}: {
  form: AgentFormView;
  /** Opens the console's shared lightbox — same one the chat thread uses. */
  onExpandAttachment: (attachment: ChatAttachment) => void;
}) {
  // A skipped form has no answers by construction, so listing every field as
  // "Not answered" would repeat the status line four times. In every other
  // state the gaps are the point and stay visible as rows.
  const showFields = form.status !== 'skipped' && form.fields.length > 0;

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
        <dl className="mt-2 flex flex-col gap-2">
          {form.fields.map((field) => {
            // `filename` is only present once the backend has resolved the raw
            // `{ attachmentId }` answer into a full AgentFormAttachmentValue — a
            // failed lookup/presign leaves the raw shape in place, and that falls
            // through to the generic branch below, which names it "Attachment"
            // via formAnswerValue rather than crashing on a missing url/mimeType.
            const attachmentValue =
              field.field_type === 'attachment' &&
              field.answered &&
              field.value &&
              typeof field.value === 'object' &&
              'filename' in field.value
                ? (field.value as AgentFormAttachmentValue)
                : null;

            if (attachmentValue) {
              const isVideo = attachmentValue.mimeType.startsWith('video/');
              const chatAttachment: ChatAttachment = {
                id: attachmentValue.attachmentId,
                filename: attachmentValue.filename,
                mimeType: attachmentValue.mimeType,
                byteSize: attachmentValue.byteSize,
                url: attachmentValue.url,
              };
              return (
                <div key={field.key} className="flex flex-col gap-1">
                  <dt className="text-xs text-muted">{field.label}</dt>
                  <dd>
                    {attachmentValue.url ? (
                      <button
                        type="button"
                        onClick={() => onExpandAttachment(chatAttachment)}
                        className="group relative block h-32 w-full overflow-hidden rounded-card outline-none"
                      >
                        {isVideo ? (
                          <video src={attachmentValue.url} className="h-full w-full object-cover" />
                        ) : (
                          <img
                            src={attachmentValue.url}
                            alt={attachmentValue.filename}
                            className="h-full w-full object-cover"
                          />
                        )}
                        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-150 group-hover:bg-black/30 group-hover:opacity-100">
                          <span className="text-xs font-medium text-white drop-shadow">
                            {isVideo ? 'Play' : 'Expand'}
                          </span>
                        </div>
                      </button>
                    ) : (
                      <p className="text-sm text-muted italic">Attachment unavailable</p>
                    )}
                  </dd>
                </div>
              );
            }

            return (
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
            );
          })}
        </dl>
      )}
    </section>
  );
}
