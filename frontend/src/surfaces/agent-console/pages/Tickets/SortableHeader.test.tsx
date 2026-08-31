import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortableHeader } from './SortableHeader.tsx';

describe('SortableHeader', () => {
  it('shows no arrow when this column is not the primary or secondary sort', () => {
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Player" sortKey="player" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={vi.fn()} />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.queryByLabelText(/sorted/i)).not.toBeInTheDocument();
  });

  it('shows a primary-styled ascending arrow when this column is the primary sort', () => {
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Priority" sortKey="priority" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={vi.fn()} />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByLabelText('sorted ascending, primary')).toBeInTheDocument();
  });

  it('clicking an inactive column promotes it to primary', async () => {
    const onSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Assignee" sortKey="assignee" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={onSort} />
          </tr>
        </thead>
      </table>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Assignee' }));
    expect(onSort).toHaveBeenCalledWith({
      primary: 'assignee',
      primaryDir: 'asc',
      secondary: 'priority',
      secondaryDir: 'asc',
    });
  });

  it('clicking the active primary column flips its direction only', async () => {
    const onSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Priority" sortKey="priority" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={onSort} />
          </tr>
        </thead>
      </table>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Priority' }));
    expect(onSort).toHaveBeenCalledWith({
      primary: 'priority',
      primaryDir: 'desc',
      secondary: 'created',
      secondaryDir: 'asc',
    });
  });

  it('clicking the active secondary column flips its direction only', async () => {
    const onSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Created" sortKey="created" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={onSort} />
          </tr>
        </thead>
      </table>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Created' }));
    expect(onSort).toHaveBeenCalledWith({
      primary: 'priority',
      primaryDir: 'asc',
      secondary: 'created',
      secondaryDir: 'desc',
    });
  });
});
