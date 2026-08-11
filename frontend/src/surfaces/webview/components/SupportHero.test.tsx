import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { resolveHeroAsset, SupportHero } from './SupportHero.tsx'

describe('resolveHeroAsset', () => {
  it('returns the default url when the glob resolves a module', () => {
    expect(resolveHeroAsset({ '/src/assets/hero.png': { default: '/hero.png' } })).toBe('/hero.png')
  })

  it('returns null when the glob is empty', () => {
    expect(resolveHeroAsset({})).toBeNull()
  })

  it('picks by sorted key, not enumeration order, when multiple assets are present', () => {
    // Inserted out of sorted order on purpose: if resolveHeroAsset ever switched to
    // "first key seen" instead of a sort, this would still pass by accident unless
    // the insertion order disagrees with the sort order, which it does here.
    const modules = {
      '/src/assets/hero.webp': { default: '/hero.webp' },
      '/src/assets/hero.png': { default: '/hero.png' },
    }
    expect(resolveHeroAsset(modules)).toBe('/hero.png')
  })
})

describe('SupportHero', () => {
  it('renders an img with the given src when imageUrl is provided', () => {
    const { container } = render(<SupportHero gameName="Neon Drift" imageUrl="/banner.png" onSearchTap={vi.fn()} />)

    expect(screen.getByText('Neon Drift')).toBeInTheDocument()
    expect(screen.getByText('Search help')).toBeInTheDocument()
    const img = within(container).getByRole('presentation', { hidden: true }) as HTMLImageElement
    expect(img.src).toContain('/banner.png')
  })

  it('renders no img — the gradient fallback — when no imageUrl is given and the glob is empty', () => {
    const { container } = render(<SupportHero gameName="Neon Drift" onSearchTap={vi.fn()} />)

    expect(screen.getByText('Neon Drift')).toBeInTheDocument()
    expect(screen.getByText('Search help')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})
