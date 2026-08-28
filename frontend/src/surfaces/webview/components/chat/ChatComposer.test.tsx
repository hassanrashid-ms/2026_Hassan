import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer.tsx';

describe('ChatComposer attachments', () => {
  it('shows no attach control when allowAttachments is not set', () => {
    render(<ChatComposer onSend={() => {}} />);
    expect(screen.queryByLabelText('Attach image')).not.toBeInTheDocument();
  });

  it('passes allowAttachments and upload handlers through to the shared Composer', () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/player/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
    render(
      <ChatComposer
        onSend={() => {}}
        allowAttachments
        onUpload={onUpload}
        onCancelUpload={() => {}}
      />,
    );
    expect(screen.getByLabelText('Attach image')).toBeInTheDocument();
  });
});

describe('ChatComposer native dialog handoff', () => {
  afterEach(() => {
    delete window.SupportBridge;
  });

  it('posts expect_native_dialog before opening the file picker', () => {
    const post = vi.fn();
    window.SupportBridge = { post };
    render(
      <ChatComposer
        onSend={() => {}}
        allowAttachments
        onUpload={vi.fn().mockResolvedValue({})}
        onCancelUpload={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText('Choose image'));

    expect(post).toHaveBeenCalledWith({ type: 'expect_native_dialog' });
  });
});
