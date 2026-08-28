import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiSelectFilter } from './MultiSelectFilter.tsx';

const OPTIONS = [
  { value: 'p1', label: 'P1' },
  { value: 'p2', label: 'P2' },
];

describe('MultiSelectFilter', () => {
  it('shows the selected count on the trigger', () => {
    render(
      <MultiSelectFilter label="Priority" options={OPTIONS} selected={['p1']} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Priority/ })).toHaveTextContent('(1)');
  });

  it('adds a value when an unselected option is clicked', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelectFilter label="Priority" options={OPTIONS} selected={[]} onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Priority/ }));
    await userEvent.click(await screen.findByText('P1'));

    expect(onChange).toHaveBeenCalledWith(['p1']);
  });

  it('removes a value when an already-selected option is clicked', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="Priority"
        options={OPTIONS}
        selected={['p1', 'p2']}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Priority/ }));
    await userEvent.click(await screen.findByText('P1'));

    expect(onChange).toHaveBeenCalledWith(['p2']);
  });
});
