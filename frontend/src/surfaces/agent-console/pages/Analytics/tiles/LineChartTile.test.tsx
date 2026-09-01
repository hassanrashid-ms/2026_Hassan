import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LineChartTile } from './LineChartTile.tsx'

describe('LineChartTile', () => {
  it('renders the title', () => {
    render(
      <LineChartTile
        title="Volume"
        series={[{ bucket: '2026-08-01', opened: 3, resolved: 1 }]}
        dataKeys={['opened', 'resolved']}
      />,
    )
    expect(screen.getByText('Volume')).toBeInTheDocument()
  })

  it('renders an empty message when series is empty', () => {
    render(<LineChartTile title="Volume" series={[]} dataKeys={['opened']} />)
    expect(screen.getByText(/no data/i)).toBeInTheDocument()
  })
})
