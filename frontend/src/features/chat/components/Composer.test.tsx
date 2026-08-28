import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer.tsx';

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

describe('Composer attachments', () => {
  it('shows no attach control when allowAttachments is not set', () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.queryByLabelText('Attach image or video')).not.toBeInTheDocument();
  });

  it('calls onUpload with the picked file, then onSend with the returned attachment on submit', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/agent/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    const file = makeFile('shot.png', 'image/png', 3);
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByAltText('shot.png');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onUpload).toHaveBeenCalledWith(file);
    expect(onSend).toHaveBeenCalledWith('', undefined, {
      key: 'pending/ws/agent/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
  });

  it('calls onCancelUpload when the pending thumbnail is removed', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/agent/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
    const onCancelUpload = vi.fn();
    render(
      <Composer
        onSend={() => {}}
        allowAttachments
        onUpload={onUpload}
        onCancelUpload={onCancelUpload}
      />,
    );

    fireEvent.change(screen.getByLabelText('Attach image or video'), {
      target: { files: [makeFile('shot.png', 'image/png', 3)] },
    });
    await screen.findByAltText('shot.png');

    fireEvent.click(screen.getByLabelText('Remove attachment'));
    expect(onCancelUpload).toHaveBeenCalledWith('pending/ws/agent/uuid.png');
    expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument();
  });

  it('rejects an oversized file client-side, without calling onUpload', () => {
    const onUpload = vi.fn();
    render(<Composer onSend={() => {}} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    const big = makeFile('huge.png', 'image/png', 11 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [big] } });

    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByText(/10 MB or smaller/)).toBeInTheDocument();
  });

  it('shows an error and stops the spinner when onUpload rejects', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('network error'));
    render(<Composer onSend={() => {}} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    fireEvent.change(input, { target: { files: [makeFile('shot.png', 'image/png', 3)] } });

    await screen.findByText(/Upload failed/);
    expect(screen.getByLabelText('Attach image or video')).not.toBeDisabled();
  });

  it('calls onUpload with a picked video, then onSend with the returned attachment on submit', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/agent/uuid.mp4',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      byteSize: 20 * 1024 * 1024,
    });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    const file = makeFile('clip.mp4', 'video/mp4', 20 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByTestId('pending-video-preview');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onUpload).toHaveBeenCalledWith(file);
    expect(onSend).toHaveBeenCalledWith('', undefined, {
      key: 'pending/ws/agent/uuid.mp4',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      byteSize: 20 * 1024 * 1024,
    });
  });

  it('rejects a video over the 50 MB video cap client-side, without calling onUpload', () => {
    const onUpload = vi.fn();
    render(<Composer onSend={() => {}} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    const big = makeFile('huge.mp4', 'video/mp4', 51 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [big] } });

    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByText(/50 MB or smaller/)).toBeInTheDocument();
  });

  it('accepts a video between the image cap and the video cap', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/agent/uuid.webm',
      filename: 'clip.webm',
      mimeType: 'video/webm',
      byteSize: 30 * 1024 * 1024,
    });
    render(<Composer onSend={() => {}} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image or video');
    fireEvent.change(input, {
      target: { files: [makeFile('clip.webm', 'video/webm', 30 * 1024 * 1024)] },
    });

    await screen.findByTestId('pending-video-preview');
    expect(onUpload).toHaveBeenCalled();
  });
});
