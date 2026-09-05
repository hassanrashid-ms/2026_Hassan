import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlayerFormView } from '@support/types';
import { FormCard } from './FormCard.tsx';

const FORM: PlayerFormView = {
  submission_id: 's1',
  form_id: 'f1',
  form_name: 'Purchase receipt',
  version: 1,
  fields: [
    {
      key: 'store',
      label: 'Store',
      type: 'choice',
      isRequired: true,
      position: 0,
      options: ['Apple App Store', 'Google Play'],
    },
    {
      key: 'order_id',
      label: 'Order or receipt ID',
      type: 'short_text',
      isRequired: true,
      position: 1,
      placeholder: 'e.g. GPA.1234-5678',
    },
    {
      key: 'purchase_date',
      label: 'Date of purchase',
      type: 'date',
      isRequired: true,
      position: 2,
      helperText: "Can't be in the future.",
    },
  ],
  answers: [],
};

function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}

function setup(form: PlayerFormView = FORM) {
  const onAnswer = vi.fn().mockResolvedValue({ ok: true, is_correction: false });
  const onSubmit = vi.fn();
  const onSkip = vi.fn();
  render(
    <FormCard form={form} onAnswer={onAnswer} onSubmit={onSubmit} onSkip={onSkip} busy={false} />,
  );
  return { onAnswer, onSubmit, onSkip };
}

describe('FormCard', () => {
  it('shows one question at a time with a counter', () => {
    setup();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Store')).toBeInTheDocument();
    expect(screen.queryByText('Order or receipt ID')).not.toBeInTheDocument();
  });

  it('renders choice as buttons, not a select', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Google Play' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('hides skip while any required field in the form is unanswered, and shows it once all are answered', async () => {
    const { onSkip } = setup();
    expect(
      screen.queryByRole('button', { name: /skip and talk to an agent/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('2 of 3');
    expect(
      screen.queryByRole('button', { name: /skip and talk to an agent/i }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('e.g. GPA.1234-5678'), {
      target: { value: 'GPA.1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('3 of 3');
    fireEvent.change(screen.getByLabelText('Date of purchase'), {
      target: { value: '2026-01-01' },
    });

    expect(screen.getByRole('button', { name: /skip and talk to an agent/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /skip and talk to an agent/i }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('blocks Next on an unanswered required field', async () => {
    setup();
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.queryByText('2 of 3')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    expect(screen.getByRole('button', { name: /^next$/i })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(await screen.findByText('2 of 3')).toBeInTheDocument();
  });

  it('marks a required field label with an asterisk', () => {
    setup();
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('does not mark an optional field label with an asterisk', () => {
    setup({ ...FORM, fields: [{ ...FORM.fields[0]!, isRequired: false }] });
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  it('posts an answer when the value changed and advances', async () => {
    const { onAnswer } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(onAnswer).toHaveBeenCalledWith('store', 'Google Play');
    expect(await screen.findByText('2 of 3')).toBeInTheDocument();
  });

  it('hides Back on question one and shows it afterwards, prefilled', async () => {
    const { onAnswer } = setup();
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('2 of 3');
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google Play' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    onAnswer.mockClear();
    // Unchanged prefill: pressing Next writes nothing. Re-submitting an identical
    // value would inflate the correction rate with events recording no correction.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('posts a correction when a prefilled answer is changed', async () => {
    const { onAnswer } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('2 of 3');
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    onAnswer.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Apple App Store' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(onAnswer).toHaveBeenCalledWith('store', 'Apple App Store');
  });

  it('resumes at the first unanswered question with earlier answers prefilled', () => {
    setup({ ...FORM, answers: [{ field_key: 'store', value: 'Google Play' }] });
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument();
  });

  it('shows a placeholder inside an empty text field', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(await screen.findByPlaceholderText('e.g. GPA.1234-5678')).toBeInTheDocument();
  });

  it('uses the field label when a text placeholder is missing', () => {
    setup({
      ...FORM,
      fields: [
        {
          key: 'details',
          label: 'Purchase details',
          type: 'long_text',
          isRequired: false,
          position: 0,
        },
      ],
    });

    expect(screen.getByPlaceholderText('Purchase details')).toBeInTheDocument();
  });

  it('shows helper text under the question when the field has one', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. GPA.1234-5678'), {
      target: { value: 'GPA.1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(await screen.findByText("Can't be in the future.")).toBeInTheDocument();
  });

  it('caps the date field at today, so a purchase cannot be dated in the future', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. GPA.1234-5678'), {
      target: { value: 'GPA.1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    const todayStr = new Date().toISOString().slice(0, 10);
    expect(await screen.findByLabelText('Date of purchase')).toHaveAttribute('max', todayStr);
  });

  it('calls onSubmit from the last question', async () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Google Play' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. GPA.1234-5678'), {
      target: { value: 'GPA.1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByText('3 of 3');
    fireEvent.change(screen.getByLabelText('Date of purchase'), {
      target: { value: '2026-01-01' },
    });
    expect(screen.getByRole('button', { name: /^submit$/i })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it('renders an attach-image control for the attachment field type instead of the inert message', () => {
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={vi.fn()}
        onSendAttachment={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Attach image or video')).toBeInTheDocument();
    expect(
      screen.queryByText('This question cannot be answered here yet.'),
    ).not.toBeInTheDocument();
  });

  it('uploads on pick but waits for Next to send the answer and advance', async () => {
    const onSubmit = vi.fn();
    const onUploadAttachment = vi.fn().mockResolvedValue({
      key: 'pending/ws/player/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
    const onSendAttachment = vi.fn().mockResolvedValue(undefined);
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={onSubmit}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={onUploadAttachment}
        onSendAttachment={onSendAttachment}
      />,
    );
    const file = new File([new Uint8Array(3)], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [file] } });

    await waitFor(() =>
      expect(onUploadAttachment).toHaveBeenCalledWith(file, expect.any(Function)),
    );
    // Uploaded, but nothing sent and no advance until the player confirms.
    expect(onSendAttachment).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(onSendAttachment).toHaveBeenCalledWith('proof', {
        key: 'pending/ws/player/uuid.png',
        filename: 'shot.png',
        mimeType: 'image/png',
        byteSize: 3,
      }),
    );
    expect(onSubmit).toHaveBeenCalled();
  });

  it('lets the player remove a picked file and pick a different one before confirming', async () => {
    const onUploadAttachment = vi
      .fn()
      .mockResolvedValueOnce({
        key: 'pending/ws/player/first.png',
        filename: 'first.png',
        mimeType: 'image/png',
        byteSize: 3,
      })
      .mockResolvedValueOnce({
        key: 'pending/ws/player/second.png',
        filename: 'second.png',
        mimeType: 'image/png',
        byteSize: 3,
      });
    const onSendAttachment = vi.fn().mockResolvedValue(undefined);
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={onUploadAttachment}
        onSendAttachment={onSendAttachment}
      />,
    );
    const first = makeFile('first.png', 'image/png', 3);
    fireEvent.change(screen.getByLabelText('Attach image or video'), {
      target: { files: [first] },
    });
    await screen.findByAltText('first.png');

    fireEvent.click(screen.getByLabelText('Remove attachment'));
    expect(screen.queryByAltText('first.png')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /tap to attach a photo or video/i }),
    ).toBeInTheDocument();

    const second = makeFile('second.png', 'image/png', 3);
    fireEvent.change(screen.getByLabelText('Attach image or video'), {
      target: { files: [second] },
    });
    await screen.findByAltText('second.png');

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(onSendAttachment).toHaveBeenCalledWith(
        'proof',
        expect.objectContaining({ filename: 'second.png' }),
      ),
    );
    expect(onSendAttachment).not.toHaveBeenCalledWith(
      'proof',
      expect.objectContaining({ filename: 'first.png' }),
    );
  });

  it('posts expect_native_dialog before the native picker opens for an attachment field', () => {
    const post = vi.fn();
    window.SupportBridge = { post };
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={vi.fn()}
        onSendAttachment={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('Attach image or video'));

    expect(post).toHaveBeenCalledWith({ type: 'expect_native_dialog' });
    delete window.SupportBridge;
  });

  it('shows a clickable container with an attachment icon before any file is picked', () => {
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={vi.fn()}
        onSendAttachment={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /tap to attach a photo or video/i }),
    ).toBeInTheDocument();
  });

  it('rejects an oversized image client-side without calling onUploadAttachment', () => {
    const onUploadAttachment = vi.fn();
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={onUploadAttachment}
        onSendAttachment={vi.fn()}
      />,
    );
    const big = makeFile('huge.png', 'image/png', 11 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [big] } });

    expect(onUploadAttachment).not.toHaveBeenCalled();
    expect(screen.getByText(/10 MB or smaller/)).toBeInTheDocument();
  });

  it('rejects an oversized video client-side without calling onUploadAttachment', () => {
    const onUploadAttachment = vi.fn();
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a video',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={onUploadAttachment}
        onSendAttachment={vi.fn()}
      />,
    );
    const big = makeFile('huge.mp4', 'video/mp4', 51 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [big] } });

    expect(onUploadAttachment).not.toHaveBeenCalled();
    expect(screen.getByText(/50 MB or smaller/)).toBeInTheDocument();
  });

  it('rejects an unsupported file type client-side without calling onUploadAttachment', () => {
    const onUploadAttachment = vi.fn();
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={onUploadAttachment}
        onSendAttachment={vi.fn()}
      />,
    );
    const bad = makeFile('doc.pdf', 'application/pdf', 100);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [bad] } });

    expect(onUploadAttachment).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Only PNG, JPEG, WebP, GIF images or MP4\/WebM videos are supported\./),
    ).toBeInTheDocument();
  });

  it('shows the picked file as a preview with a progress overlay while uploading, then clears it once uploaded', async () => {
    let resolveUpload!: (v: {
      key: string;
      filename: string;
      mimeType: string;
      byteSize: number;
    }) => void;
    const onUploadAttachment = vi.fn(
      (_file: File, onProgress: (percent: number) => void) =>
        new Promise<{ key: string; filename: string; mimeType: string; byteSize: number }>(
          (resolve) => {
            onProgress(42);
            resolveUpload = resolve;
          },
        ),
    );
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={vi.fn()}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={onUploadAttachment}
        onSendAttachment={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const file = makeFile('shot.png', 'image/png', 3);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [file] } });

    await screen.findByAltText('shot.png');
    expect(screen.getByTestId('upload-progress-overlay')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /tap to attach a photo or video/i }),
    ).not.toBeInTheDocument();

    resolveUpload({
      key: 'pending/ws/player/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });

    await screen.findByLabelText('Remove attachment');
    expect(screen.queryByTestId('upload-progress-overlay')).not.toBeInTheDocument();
  });

  it('reverts to the idle container and shows an error when the upload fails', async () => {
    const onSubmit = vi.fn();
    const onUploadAttachment = vi.fn().mockRejectedValue(new Error('network error'));
    const form: PlayerFormView = {
      submission_id: 's1',
      form_id: 'f1',
      form_name: 'Proof of purchase',
      version: 1,
      fields: [
        {
          key: 'proof',
          label: 'Upload a photo',
          type: 'attachment',
          isRequired: false,
          position: 0,
        },
      ],
      answers: [],
    };
    render(
      <FormCard
        form={form}
        onAnswer={vi.fn()}
        onSubmit={onSubmit}
        onSkip={vi.fn()}
        busy={false}
        onUploadAttachment={onUploadAttachment}
        onSendAttachment={vi.fn()}
      />,
    );
    const file = makeFile('shot.png', 'image/png', 3);
    fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [file] } });

    await screen.findByText(/Upload failed/);
    expect(
      screen.getByRole('button', { name: /tap to attach a photo or video/i }),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
