import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BarChartTile } from './BarChartTile.tsx';

describe('BarChartTile', () => {
  it('renders the title', () => {
    render(
      <BarChartTile
        title="By priority"
        data={[
          { label: 'p1', value: 2 },
          { label: 'p2', value: 5 },
        ]}
      />,
    );
    expect(screen.getByText('By priority')).toBeInTheDocument();
  });
});
