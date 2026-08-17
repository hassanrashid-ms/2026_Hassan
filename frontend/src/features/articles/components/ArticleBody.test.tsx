import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

describe('ArticleBody tables', () => {
  it('renders a GFM table inside its own horizontally scrolling container', () => {
    const markdown = ['| Plan | Price |', '| --- | --- |', '| Free | $0 |'].join('\n')
    const { container } = render(<ArticleBody markdown={markdown} />)

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    // A wide table must scroll within itself, not make the whole drawer
    // scroll sideways.
    expect(table?.parentElement?.className).toContain('overflow-x-auto')
    expect(screen.getByRole('cell', { name: '$0' })).toBeInTheDocument()
  })
})

describe('ArticleBody images', () => {
  it('renders an image lazily at its natural size, capped to the container', () => {
    const { container } = render(<ArticleBody markdown={'![A happy cat](https://cdn.example.com/cat.gif)'} />)

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/cat.gif')
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.className).toContain('max-w-full')
  })

  // Third-party image hosts rot. Degrade to the alt text, not to a broken glyph.
  it('falls back to the alt text when the image fails to load', () => {
    const { container } = render(<ArticleBody markdown={'![A happy cat](https://cdn.example.com/gone.gif)'} />)

    fireEvent.error(container.querySelector('img')!)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('A happy cat')).toBeInTheDocument()
  })

  it('renders nothing at all when a broken image has no alt text', () => {
    const { container } = render(<ArticleBody markdown={'![](https://cdn.example.com/gone.gif)'} />)

    fireEvent.error(container.querySelector('img')!)

    expect(container.querySelector('img')).toBeNull()
  })
})
