import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RankedListTile } from './RankedListTile.tsx'

describe('RankedListTile', () => {
  it('renders the title and ranked rows', () => {
    render(
      <RankedListTile
        title="Top cited by bot"
        items={[
          { id: 'a1', label: 'Reset your password', count: 5 },
          { id: 'a2', label: 'Redeem a gift code', count: 2 },
        ]}
      />,
    )
    expect(screen.getByText('Top cited by bot')).toBeInTheDocument()
    expect(screen.getByText('Reset your password')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })

  it('shows the empty state when there are no items', () => {
    render(<RankedListTile title="Top read by players" items={[]} />)
    expect(screen.getByText('No data in this range')).toBeInTheDocument()
  })

  it('disambiguates two distinct articles that share a title', () => {
    render(
      <RankedListTile
        title="Top cited by bot"
        items={[
          { id: 'aaaaaaaa-0000-0000-0000-000000000000', label: 'Troubleshooting Purchase Issues', count: 16 },
          { id: 'bbbbbbbb-0000-0000-0000-000000000000', label: 'Troubleshooting Purchase Issues', count: 14 },
        ]}
      />,
    )
    expect(screen.getByText('#aaaaaaaa')).toBeInTheDocument()
    expect(screen.getByText('#bbbbbbbb')).toBeInTheDocument()
  })
})
