import { describe, expect, it } from 'vitest'
import {
  DECLARED_FIELD_KEYS,
  IncidentBody,
  PROVIDER_FIELD_KEYS,
  PlayerTokenRequest,
  SessionEndBody,
  SessionStartBody,
  coerceInstant,
} from '../src/index.ts'

// Verbatim from docs/specs/2026-08-04-sdk-wire-contract.md
const START_EXAMPLE = {
  session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  entry_point: 'settings_menu',
  started_at: '2026-08-04T09:12:00Z',
  snapshot: {
    player_id: 'UserId7661',
    client_version: '6.2.01',
    platform: 'ios',
    os_version: '26.5.2',
    device_model: 'iPhone 13 Pro Max',
    locale: 'en-GB',
    player_level: 34,
    total_spend: 0.0,
    spend_tier: 'non-payer',
    account_created_at: '2026-07-27T09:12:00Z',
    last_session_at: '2026-08-03T08:40:00Z',
    extra: { ab_bucket: 'B', collection_status: 'event_in_progress' },
    degraded_reason: null,
  },
}

describe('SessionStartBody', () => {
  it('accepts the spec example unchanged', () => {
    const parsed = SessionStartBody.parse(START_EXAMPLE)
    expect(parsed.session_id).toBe(START_EXAMPLE.session_id)
    expect(parsed.entry_point).toBe('settings_menu')
    expect(parsed.snapshot).toEqual(START_EXAMPLE.snapshot)
  })

  it('ignores unknown request fields rather than rejecting them', () => {
    const parsed = SessionStartBody.parse({ ...START_EXAMPLE, invented_by_a_newer_sdk: true })
    expect(parsed.session_id).toBe(START_EXAMPLE.session_id)
  })

  it('accepts an unknown entry_point as-is', () => {
    const parsed = SessionStartBody.parse({ ...START_EXAMPLE, entry_point: 'brand_new_screen' })
    expect(parsed.entry_point).toBe('brand_new_screen')
  })

  it('falls back rather than failing on a missing or absurd entry_point', () => {
    expect(SessionStartBody.parse({ ...START_EXAMPLE, entry_point: undefined }).entry_point).toBe('unknown')
    expect(SessionStartBody.parse({ ...START_EXAMPLE, entry_point: 42 }).entry_point).toBe('unknown')
  })

  it('keeps a garbage snapshot instead of rejecting the request', () => {
    expect(SessionStartBody.parse({ ...START_EXAMPLE, snapshot: 'not an object' }).snapshot).toBe('not an object')
    expect(SessionStartBody.parse({ ...START_EXAMPLE, snapshot: undefined }).snapshot).toBeUndefined()
  })

  it('rejects a body with no usable session_id — that one is unparseable', () => {
    expect(SessionStartBody.safeParse({ ...START_EXAMPLE, session_id: 'nope' }).success).toBe(false)
    expect(SessionStartBody.safeParse({ ...START_EXAMPLE, session_id: undefined }).success).toBe(false)
  })
})

describe('SessionEndBody', () => {
  it('accepts the spec example', () => {
    const parsed = SessionEndBody.parse({
      session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      duration_ms: 184200,
      conversation_created: false,
      articles_read: ['a_123', 'a_456'],
    })
    expect(parsed.duration_ms).toBe(184200)
    expect(parsed.articles_read).toEqual(['a_123', 'a_456'])
  })

  it('tolerates every untrusted field being absent or wrong-typed', () => {
    const parsed = SessionEndBody.parse({ session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
    expect(parsed.duration_ms).toBeNull()
    expect(parsed.conversation_created).toBeNull()
    expect(parsed.articles_read).toEqual([])
  })
})

describe('IncidentBody', () => {
  it('accepts the spec example', () => {
    const parsed = IncidentBody.parse({
      incident_id: 'c7a2ffff-4f89-11d3-9a0c-0305e82c3301',
      session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      kind: 'token_timeout',
      detail: '5s elapsed, no response',
      sdk_version: '1.0.2',
      client_version: '6.2.01',
    })
    expect(parsed.kind).toBe('token_timeout')
  })

  it('accepts a null session_id — the SDK may fail before a session exists', () => {
    expect(IncidentBody.parse({ kind: 'webview_init_failed', session_id: null }).session_id).toBeNull()
  })

  it('accepts an unknown kind', () => {
    expect(IncidentBody.parse({ kind: 'something_new' }).kind).toBe('something_new')
  })

  it('tolerates a missing incident_id and session_id', () => {
    const parsed = IncidentBody.parse({ kind: 'webview_init_failed' })
    expect(parsed.incident_id).toBeNull()
    expect(parsed.session_id).toBeNull()
  })

  it('tolerates a wrong-typed incident_id and session_id', () => {
    const parsed = IncidentBody.parse({ kind: 'webview_init_failed', incident_id: 42, session_id: 42 })
    expect(parsed.incident_id).toBeNull()
    expect(parsed.session_id).toBeNull()
  })
})

describe('PlayerTokenRequest', () => {
  it('accepts the spec example', () => {
    expect(PlayerTokenRequest.parse({ external_player_id: 'UserId7661' }).external_player_id).toBe('UserId7661')
  })

  it('rejects a malformed external_player_id', () => {
    expect(PlayerTokenRequest.safeParse({ external_player_id: '' }).success).toBe(false)
    expect(PlayerTokenRequest.safeParse({ external_player_id: 'a'.repeat(200) }).success).toBe(false)
    expect(PlayerTokenRequest.safeParse({ external_player_id: 'has space' }).success).toBe(false)
    expect(PlayerTokenRequest.safeParse({}).success).toBe(false)
  })
})

describe('declared field constants', () => {
  it('lists the 11 keys expected on every conversation', () => {
    expect(DECLARED_FIELD_KEYS).toHaveLength(11)
    expect([...DECLARED_FIELD_KEYS]).toEqual([
      'player_id',
      'client_version',
      'platform',
      'os_version',
      'device_model',
      'locale',
      'player_level',
      'total_spend',
      'spend_tier',
      'account_created_at',
      'last_session_at',
    ])
  })

  it('lists the 6 provider-supplied keys as a subset', () => {
    expect(PROVIDER_FIELD_KEYS).toHaveLength(6)
    for (const key of PROVIDER_FIELD_KEYS) expect(DECLARED_FIELD_KEYS).toContain(key)
  })
})

describe('coerceInstant', () => {
  const fallback = new Date('2026-08-04T10:00:00Z')

  it('accepts a sane ISO-8601 timestamp', () => {
    expect(coerceInstant('2026-08-04T09:12:00Z', fallback).toISOString()).toBe('2026-08-04T09:12:00.000Z')
  })

  it('falls back on junk, on a device clock in the far future, and on a prehistoric one', () => {
    expect(coerceInstant('yesterday-ish', fallback)).toEqual(fallback)
    expect(coerceInstant('2099-01-01T00:00:00Z', fallback)).toEqual(fallback)
    expect(coerceInstant('1999-01-01T00:00:00Z', fallback)).toEqual(fallback)
    expect(coerceInstant(undefined, fallback)).toEqual(fallback)
  })
})
