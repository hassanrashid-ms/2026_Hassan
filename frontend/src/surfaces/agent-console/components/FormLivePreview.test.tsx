import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FormField } from '@support/types';
import { FormLivePreview } from './FormLivePreview.tsx';

const CHOICE_FIELD: FormField = {
  key: 'store',
  label: 'Store',
  type: 'choice',
  isRequired: true,
  position: 0,
  options: ['Apple App Store', 'Google Play'],
};

const TEXT_FIELD: FormField = {
  key: 'order_id',
  label: 'Order ID',
  type: 'short_text',
  isRequired: false,
  position: 0,
};

describe('FormLivePreview', () => {
  it('shows a prompt to add a field when the draft has none yet', () => {
    render(<FormLivePreview formName="New form" fields={[]} />);
    expect(screen.getByText('Add a field to see the live preview.')).toBeInTheDocument();
  });

  it('renders the shared FormCard inside the mobile frame for the current draft fields', () => {
    render(<FormLivePreview formName="Purchase receipt" fields={[CHOICE_FIELD]} />);
    expect(screen.getByTestId('mobile-preview-frame')).toBeInTheDocument();
    expect(screen.getByText('Store')).toBeInTheDocument();
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('resets to the edited field set when the admin changes the draft fields', () => {
    const { rerender } = render(<FormLivePreview formName="Form" fields={[CHOICE_FIELD]} />);
    expect(screen.getByText('Store')).toBeInTheDocument();

    rerender(<FormLivePreview formName="Form" fields={[TEXT_FIELD]} />);
    expect(screen.queryByText('Store')).not.toBeInTheDocument();
    expect(screen.getByText('Order ID')).toBeInTheDocument();
  });

  it('completes locally with no network call, and can restart from the top', () => {
    render(<FormLivePreview formName="Form" fields={[TEXT_FIELD]} />);
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(screen.getByText('Preview complete.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /restart preview/i }));
    expect(screen.getByText('Order ID')).toBeInTheDocument();
  });
});
