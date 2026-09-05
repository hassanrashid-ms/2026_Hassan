import { useState } from 'react';
import type { FormField, PlayerFormView } from '@support/types';
import { FormCard } from '@/features/forms/components/FormCard';
import { MobilePreviewFrame } from './MobilePreviewFrame.tsx';

/**
 * Renders the same FormCard a player sees, wired to fully local, mocked
 * handlers — no network call is ever made. The whole session remounts (via
 * `key={fieldsKey}`) whenever the admin's draft fields change: FormCard seeds
 * its progress state once from props and never re-reads it, by design, so a
 * real player's reconnect resumes mid-form instead of resetting. That same
 * behavior would otherwise leave a stale preview after every edit here.
 */
export function FormLivePreview({ formName, fields }: { formName: string; fields: FormField[] }) {
  if (fields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        Add a field to see the live preview.
      </div>
    );
  }

  return (
    <MobilePreviewFrame>
      <PreviewSession key={JSON.stringify(fields)} formName={formName} fields={fields} />
    </MobilePreviewFrame>
  );
}

function PreviewSession({ formName, fields }: { formName: string; fields: FormField[] }) {
  const [finished, setFinished] = useState(false);
  const [restartToken, setRestartToken] = useState(0);

  if (finished) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm text-[var(--color-text)]">Preview complete.</p>
        <button
          type="button"
          className="text-sm text-[var(--color-accent)] underline"
          onClick={() => {
            setFinished(false);
            setRestartToken((t) => t + 1);
          }}
        >
          Restart preview
        </button>
      </div>
    );
  }

  const form: PlayerFormView = {
    submission_id: 'preview-submission',
    form_id: 'preview-form',
    form_name: formName || 'Untitled form',
    version: 1,
    fields,
    answers: [],
  };

  return (
    <FormCard
      key={restartToken}
      form={form}
      busy={false}
      onAnswer={async () => ({ ok: true })}
      onSubmit={() => setFinished(true)}
      onSkip={() => setFinished(true)}
      onUploadAttachment={async (file) => ({
        key: `preview/${file.name}`,
        filename: file.name,
        mimeType: file.type,
        byteSize: file.size,
      })}
      onSendAttachment={async () => undefined}
    />
  );
}
