import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TileFrame } from './TileFrame.tsx'

describe('TileFrame', () => {
  it('renders the title and children', () => {
    render(<TileFrame title="Open tickets">42</TileFrame>)
    expect(screen.getByText('Open tickets')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })
})
