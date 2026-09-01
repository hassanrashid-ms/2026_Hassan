import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NumberTile } from './NumberTile.tsx'

describe('NumberTile', () => {
  it('renders a count value', () => {
    render(<NumberTile title="Open tickets" value={42} />)
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('formats a percent value', () => {
    render(<NumberTile title="Containment" value={0.4} format="percent" />)
    expect(screen.getByText('40%')).toBeInTheDocument()
  })

  it('formats a duration value in minutes when over 60 seconds', () => {
    render(<NumberTile title="First response" value={125} format="duration" />)
    expect(screen.getByText('2m 5s')).toBeInTheDocument()
  })

  it('renders an em dash when value is null', () => {
    render(<NumberTile title="Containment" value={null} format="percent" />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('shows a positive delta against the previous value', () => {
    render(<NumberTile title="Open tickets" value={10} previousValue={8} />)
    expect(screen.getByText('+2')).toBeInTheDocument()
  })
})
