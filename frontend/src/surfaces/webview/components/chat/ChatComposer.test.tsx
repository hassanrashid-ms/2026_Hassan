import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer.tsx';

describe('ChatComposer attachments', () => {
  it('shows no attach control when allowAttachments is not set', () => {
    render(<ChatComposer onSend={() => {}} />);
    expect(screen.queryByLabelText('Attach image or video')).not.toBeInTheDocument();
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
    expect(screen.getByLabelText('Attach image or video')).toBeInTheDocument();
  });

  it('shows a muted video preview for a picked video, not an img', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/player/uuid.mp4',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      byteSize: 20 * 1024 * 1024,
    });
    render(<ChatComposer onSend={() => {}} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    const file = new File([new Uint8Array(20)], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [file] } });

    const video = await screen.findByTestId('pending-video-preview');
    expect(video.tagName).toBe('VIDEO');
  });

  it('rejects a video over the 50 MB video cap client-side', () => {
    const onUpload = vi.fn();
    render(<ChatComposer onSend={() => {}} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    const big = new File([new Uint8Array(1)], 'huge.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });

    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByText(/50 MB or smaller/)).toBeInTheDocument();
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

    fireEvent.click(screen.getByLabelText('Choose image or video'));

    expect(post).toHaveBeenCalledWith({ type: 'expect_native_dialog' });
  });
});
