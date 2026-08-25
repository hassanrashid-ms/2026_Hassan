import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImageInsertDialog } from './ImageInsertDialog.tsx';

function baseProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    mode: 'new' as const,
    uploading: false,
    error: null,
    onUpload: vi.fn(),
    onLink: vi.fn(),
  };
}

describe('ImageInsertDialog', () => {
  it('renders both tabs', () => {
    render(<ImageInsertDialog {...baseProps()} />);
    expect(screen.getByRole('tab', { name: 'Upload' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Link' })).toBeTruthy();
  });

  it('fires onUpload on browse-select', async () => {
    const props = baseProps();
    render(<ImageInsertDialog {...props} />);
    const file = new File([new Uint8Array(3)], 'pic.png', { type: 'image/png' });
    const input = screen.getByLabelText('Browse for an image') as HTMLInputElement;
    await userEvent.upload(input, file);
    expect(props.onUpload).toHaveBeenCalledWith(file, '');
  });

  it('fires onUpload on drop', () => {
    const props = baseProps();
    render(<ImageInsertDialog {...props} />);
    const file = new File([new Uint8Array(3)], 'pic.png', { type: 'image/png' });
    const zone = screen.getByLabelText('Drag and drop an image, paste, or click to browse');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(props.onUpload).toHaveBeenCalledWith(file, '');
  });

  it('fires onUpload on paste', () => {
    const props = baseProps();
    render(<ImageInsertDialog {...props} />);
    const file = new File([new Uint8Array(3)], 'pic.png', { type: 'image/png' });
    const item = { type: 'image/png', getAsFile: () => file };
    const event = new Event('paste');
    Object.defineProperty(event, 'clipboardData', { value: { items: [item] } });
    document.dispatchEvent(event);
    expect(props.onUpload).toHaveBeenCalledWith(file, '');
  });

  it('fires onLink and closes on Link-tab submit', async () => {
    const props = baseProps();
    render(<ImageInsertDialog {...props} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Link' }));
    await userEvent.type(screen.getByPlaceholderText('https://...'), 'https://example.com/a.png');
    await userEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(props.onLink).toHaveBeenCalledWith('https://example.com/a.png', '');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows error text when passed', () => {
    render(<ImageInsertDialog {...baseProps()} error="Only PNG, JPEG, WebP or GIF images are supported." />);
    expect(
      screen.getByText('Only PNG, JPEG, WebP or GIF images are supported.'),
    ).toBeTruthy();
  });

  it('disables the zone while uploading', () => {
    render(<ImageInsertDialog {...baseProps()} uploading />);
    const input = screen.getByLabelText('Browse for an image') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
