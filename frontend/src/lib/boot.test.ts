import { describe, expect, it, vi } from 'vitest'
import { readBoot, scrubToken } from './boot.ts'

describe('readBoot', () => {
  it('reads the session and entry point from the query and the token from the fragment', () => {
    const boot = readBoot({ search: '?session=abc-123&entry=settings_menu', hash: '#t=jwt.value.here' })
    expect(boot).toEqual({ sessionId: 'abc-123', entryPoint: 'settings_menu', token: 'jwt.value.here' })
  })

  it('defaults a missing entry point rather than failing', () => {
    expect(readBoot({ search: '?session=abc-123', hash: '#t=jwt' })?.entryPoint).toBe('unknown')
  })

  it('returns null when the token or the session is absent', () => {
    expect(readBoot({ search: '?session=abc-123', hash: '' })).toBeNull()
    expect(readBoot({ search: '', hash: '#t=jwt' })).toBeNull()
    expect(readBoot({ search: '?session=', hash: '#t=jwt' })).toBeNull()
    expect(readBoot({ search: '?session=abc', hash: '#t=' })).toBeNull()
  })

  it('tolerates extra fragment and query parameters', () => {
    const boot = readBoot({ search: '?session=abc&entry=shop&lang=en', hash: '#t=jwt&debug=1' })
    expect(boot?.token).toBe('jwt')
    expect(boot?.entryPoint).toBe('shop')
  })
})

describe('scrubToken', () => {
  it('removes the fragment while keeping the path and query', () => {
    const replaceState = vi.fn()
    scrubToken(
      { replaceState } as unknown as History,
      { pathname: '/support', search: '?session=abc&entry=shop' } as unknown as Location,
    )
    expect(replaceState).toHaveBeenCalledWith(null, '', '/support?session=abc&entry=shop')
  })
})
