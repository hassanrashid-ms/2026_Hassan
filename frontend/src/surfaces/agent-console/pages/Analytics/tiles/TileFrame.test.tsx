import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TileFrame } from './TileFrame.tsx'

describe('TileFrame', () => {
  it('renders the title and children', () => {
    render(<TileFrame title="Open tickets">42</TileFrame>)
    expect(screen.getByText('Open tickets')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('calls onRemove when the remove button is clicked', async () => {
    const onRemove = vi.fn()
    render(
      <TileFrame title="Open tickets" onRemove={onRemove}>
        42
      </TileFrame>,
    )
    await userEvent.click(screen.getByRole('button', { name: /remove/i }))
    expect(onRemove).toHaveBeenCalled()
  })
})
