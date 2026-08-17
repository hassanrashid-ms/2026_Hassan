import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArticleBody } from './ArticleBody.tsx'

describe('ArticleBody block markdown', () => {
  it('renders a heading as a real heading, not as literal hashes', () => {
    render(<ArticleBody markdown={'## Refund policy\n\nSome text.'} />)

    expect(screen.getByRole('heading', { name: 'Refund policy' })).toBeInTheDocument()
    expect(screen.queryByText(/##/)).not.toBeInTheDocument()
  })

  it('renders emphasis as elements, not as literal asterisks', () => {
    const { container } = render(<ArticleBody markdown={'We refund within **30 days**.'} />)

    expect(container.querySelector('strong')?.textContent).toBe('30 days')
    expect(container.textContent).not.toContain('**')
  })

  it('renders a bulleted list as list items', () => {
    render(<ArticleBody markdown={'- First\n- Second'} />)

    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['First', 'Second'])
  })

  it('renders a blockquote and inline code', () => {
    const { container } = render(<ArticleBody markdown={'> Quoted line\n\nRun `npm test` first.'} />)

    expect(container.querySelector('blockquote')?.textContent).toContain('Quoted line')
    expect(container.querySelector('code')?.textContent).toBe('npm test')
  })

  // No rehype-raw: content must never become markup.
  it('renders raw HTML as literal text', () => {
    const { container } = render(<ArticleBody markdown={'<script>alert(1)</script>'} />)

    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })
})
