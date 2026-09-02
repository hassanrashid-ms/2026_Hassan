import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobilePreviewFrame } from './MobilePreviewFrame.tsx';

describe('MobilePreviewFrame', () => {
  it('renders its children', () => {
    render(
      <MobilePreviewFrame>
        <p>Hello</p>
      </MobilePreviewFrame>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('scopes webview theme colors and the mobile base font size to the frame', () => {
    render(
      <MobilePreviewFrame>
        <p>Hello</p>
      </MobilePreviewFrame>,
    );
    const frame = screen.getByTestId('mobile-preview-frame');
    expect(frame.style.getPropertyValue('--color-accent')).toBe('#7c3aed');
    expect(frame.style.getPropertyValue('--color-bg')).toBe('#ffffff');
    expect(frame.style.fontSize).toBe('16px');
  });
});
