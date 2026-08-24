import { describe, expect, it } from 'vitest';
import { DECLARED_FIELD_KEYS } from '@support/types';
import { splitSnapshot } from '../src/shared/playerState/split.ts';

const ALL_DECLARED = new Set<string>(DECLARED_FIELD_KEYS);
const SPEC_SNAPSHOT = {
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
};

describe('splitSnapshot', () => {
  it('splits the spec example into eleven declared keys and the two extras', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661');
    expect(Object.keys(result.declared).sort()).toEqual([...DECLARED_FIELD_KEYS].sort());
    expect(result.declared.player_level).toBe(34);
    expect(result.raw).toEqual({ ab_bucket: 'B', collection_status: 'event_in_progress' });
    expect(result.isMissing).toBe(false);
    expect(result.degradedReason).toBeNull();
  });

  it('never nests extra inside raw', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661');
    expect(result.raw.extra).toBeUndefined();
  });

  it('is non-retroactive: an unpromoted key goes to raw even though a later set would claim it', () => {
    const before = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661');
    expect(before.raw.ab_bucket).toBe('B');
    expect(before.declared.ab_bucket).toBeUndefined();

    const after = splitSnapshot(
      SPEC_SNAPSHOT,
      new Set([...ALL_DECLARED, 'ab_bucket']),
      'UserId7661',
    );
    expect(after.declared.ab_bucket).toBe('B');
    expect(after.raw.ab_bucket).toBeUndefined();
  });

  it('sends everything to raw when nothing has been declared yet', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, new Set(), 'UserId7661');
    expect(result.declared).toEqual({});
    expect(result.raw.platform).toBe('ios');
    expect(result.raw.ab_bucket).toBe('B');
  });

  it('lets a top-level key win a collision with extra', () => {
    const result = splitSnapshot(
      { ...SPEC_SNAPSHOT, extra: { platform: 'smuggled', ab_bucket: 'B' } },
      ALL_DECLARED,
      'UserId7661',
    );
    expect(result.declared.platform).toBe('ios');
    expect(result.raw.platform).toBeUndefined();
  });

  it('drops nothing — every candidate key lands somewhere exactly once', () => {
    const result = splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661');
    const landed = new Set([...Object.keys(result.declared), ...Object.keys(result.raw)]);
    for (const key of ['player_id', 'platform', 'ab_bucket', 'collection_status']) {
      expect(landed.has(key), key).toBe(true);
    }
    const overlap = Object.keys(result.declared).filter((k) => k in result.raw);
    expect(overlap).toEqual([]);
  });

  it('lifts and truncates degraded_reason', () => {
    const long = 'x'.repeat(900);
    expect(
      splitSnapshot(
        { ...SPEC_SNAPSHOT, degraded_reason: 'provider threw on total_spend' },
        ALL_DECLARED,
        'UserId7661',
      ).degradedReason,
    ).toBe('provider threw on total_spend');
    expect(
      splitSnapshot({ ...SPEC_SNAPSHOT, degraded_reason: long }, ALL_DECLARED, 'UserId7661')
        .degradedReason,
    ).toHaveLength(500);
    expect(
      splitSnapshot({ ...SPEC_SNAPSHOT, degraded_reason: 12 }, ALL_DECLARED, 'UserId7661')
        .degradedReason,
    ).toBeNull();
    expect(
      splitSnapshot({ ...SPEC_SNAPSHOT, degraded_reason: 'x' }, ALL_DECLARED, 'UserId7661').raw
        .degraded_reason,
    ).toBeUndefined();
  });

  it('treats an absent, null, non-object, array or empty snapshot as missing', () => {
    for (const input of [undefined, null, 'nope', 42, [], {}]) {
      const result = splitSnapshot(input, ALL_DECLARED, 'UserId7661');
      expect(result.isMissing, JSON.stringify(input) ?? 'undefined').toBe(true);
      expect(result.declared).toEqual({});
      expect(result.raw).toEqual({});
    }
  });

  it('judges is_missing on the provider fields alone, not the device fields', () => {
    // A provider that threw on all six. Device fields still arrive.
    const deviceOnly = {
      client_version: '6.2.01',
      platform: 'ios',
      os_version: '26.5.2',
      device_model: 'iPhone 13 Pro Max',
      locale: 'en-GB',
      degraded_reason: 'provider threw on every field',
    };
    const result = splitSnapshot(deviceOnly, ALL_DECLARED, 'UserId7661');
    expect(result.isMissing).toBe(true);
    expect(result.degradedReason).toBe('provider threw on every field');
    expect(result.declared.platform).toBe('ios');
  });

  it('is not missing when even one provider field arrived', () => {
    const result = splitSnapshot({ platform: 'ios', player_level: 34 }, ALL_DECLARED, 'UserId7661');
    expect(result.isMissing).toBe(false);
  });

  it('treats a null provider value as absent but keeps the key', () => {
    const result = splitSnapshot(
      { platform: 'ios', player_level: null },
      ALL_DECLARED,
      'UserId7661',
    );
    expect(result.isMissing).toBe(true);
    expect('player_level' in result.declared).toBe(true);
    expect(result.declared.player_level).toBeNull();
  });

  it('records a player_id mismatch in raw without failing', () => {
    const result = splitSnapshot(
      { ...SPEC_SNAPSHOT, player_id: 'SomeoneElse' },
      ALL_DECLARED,
      'UserId7661',
    );
    expect(result.declared.player_id).toBe('SomeoneElse');
    expect(result.raw.__player_id_mismatch).toEqual({
      claimed: 'SomeoneElse',
      authenticated: 'UserId7661',
    });
  });

  it('records no mismatch when the ids agree or the snapshot omits player_id', () => {
    expect(
      splitSnapshot(SPEC_SNAPSHOT, ALL_DECLARED, 'UserId7661').raw.__player_id_mismatch,
    ).toBeUndefined();
    expect(
      splitSnapshot({ platform: 'ios' }, ALL_DECLARED, 'UserId7661').raw.__player_id_mismatch,
    ).toBeUndefined();
  });

  // Regression: a `raw[key] = value` assignment on an ordinary object invokes
  // Object.prototype's `__proto__` accessor instead of creating an own property,
  // silently swallowing the payload. Parsed from a JSON string, not written as an
  // object literal — a literal `{ __proto__: ... }` is special-cased by the JS
  // parser (it sets the prototype, not an own property) and would not reproduce
  // the wire case where the SDK's JSON body is parsed by the server.
  //
  // declared/raw are built with Object.defineProperty (see setOwn in split.ts),
  // not Object.create(null): defineProperty uses [[DefineOwnProperty]] rather than
  // [[Set]], so it never invokes the inherited __proto__ accessor either — but the
  // result keeps a normal Object.prototype, which is what makes it safe to pass
  // straight into drizzle-orm's .values() (its is() helper reads
  // Object.getPrototypeOf(value).constructor unconditionally and throws on a
  // null-prototype value).
  it('keeps a wire __proto__ key as real, visible data in raw instead of dropping it', () => {
    const snapshot = JSON.parse('{"platform":"ios","__proto__":{"polluted":true}}');
    const result = splitSnapshot(snapshot, new Set(['platform']), 'UserId7661');
    expect(Object.keys(result.raw)).toEqual(['__proto__']);
    expect(JSON.stringify(result.raw)).toBe('{"__proto__":{"polluted":true}}');
    expect(result.raw.__proto__).toEqual({ polluted: true });
    expect(result.raw.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result.raw, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result.raw)).toBe(Object.prototype);
  });

  it('preserves a malformed (non-object) extra under raw.__extra_malformed instead of discarding it', () => {
    const result = splitSnapshot(
      { platform: 'ios', extra: ['a', 'b'] },
      ALL_DECLARED,
      'UserId7661',
    );
    expect(result.raw.__extra_malformed).toEqual(['a', 'b']);
    expect(result.declared.platform).toBe('ios');
  });

  it('does not flag a null or absent extra as malformed', () => {
    expect(
      splitSnapshot({ platform: 'ios', extra: null }, ALL_DECLARED, 'UserId7661').raw
        .__extra_malformed,
    ).toBeUndefined();
    expect(
      splitSnapshot({ platform: 'ios' }, ALL_DECLARED, 'UserId7661').raw.__extra_malformed,
    ).toBeUndefined();
  });

  it('flags a player_id mismatch even when the claimed id is not a string', () => {
    const mismatched = splitSnapshot(
      { ...SPEC_SNAPSHOT, player_id: 7661 },
      ALL_DECLARED,
      'UserId7661',
    );
    expect(mismatched.raw.__player_id_mismatch).toEqual({
      claimed: 7661,
      authenticated: 'UserId7661',
    });

    const agreeing = splitSnapshot({ ...SPEC_SNAPSHOT, player_id: 7661 }, ALL_DECLARED, '7661');
    expect(agreeing.raw.__player_id_mismatch).toBeUndefined();
  });
});
