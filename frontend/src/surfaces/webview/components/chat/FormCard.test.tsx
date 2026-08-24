import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('shows skip on the first question and on the last', async () => {
    const { onSkip } = setup();
    expect(screen.getByRole('button', { name: /skip and talk to an agent/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^next$/i }));
    expect(screen.getByRole('button', { name: /skip and talk to an agent/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /skip and talk to an agent/i }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('does not block Next on an unanswered required field', () => {
    setup();
    expect(screen.getByRole('button', { name: /^next$/i })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
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

  it('shows a placeholder inside an empty text field', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByPlaceholderText('e.g. GPA.1234-5678')).toBeInTheDocument();
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

  it('shows helper text under the question when the field has one', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText("Can't be in the future.")).toBeInTheDocument();
  });

  it('caps the date field at today, so a purchase cannot be dated in the future', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    const todayStr = new Date().toISOString().slice(0, 10);
    expect(screen.getByLabelText('Date of purchase')).toHaveAttribute('max', todayStr);
  });

  it('calls onSubmit from the last question', async () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^next$/i }));
    await screen.findByText('3 of 3');
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
