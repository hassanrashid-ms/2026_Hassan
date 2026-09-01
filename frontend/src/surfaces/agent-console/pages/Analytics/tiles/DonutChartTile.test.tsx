import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DonutChartTile } from './DonutChartTile.tsx'

describe('DonutChartTile', () => {
  it('renders the title and a legend entry per slice', () => {
    render(
      <DonutChartTile
        title="Status"
        data={[
          { label: 'open', value: 3 },
          { label: 'resolved', value: 1 },
        ]}
      />,
    )
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(screen.getByText('resolved')).toBeInTheDocument()
  })
})
