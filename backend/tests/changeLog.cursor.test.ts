import { describe, expect, it } from 'vitest';
import { decodeChangeLogCursor, encodeChangeLogCursor } from '../src/shared/changeLog/cursor.ts';

describe('change log cursor', () => {
  it('round-trips a timestamp and a bigserial id', () => {
    const changedAt = new Date('2026-08-12T10:20:30.456Z');
    const encoded = encodeChangeLogCursor({ changedAt, id: '9007199254740993' });
    const decoded = decodeChangeLogCursor(encoded);
    expect(decoded).toEqual({ changedAt, id: '9007199254740993' });
  });

  it('is opaque — no readable timestamp in the token', () => {
    const encoded = encodeChangeLogCursor({
      changedAt: new Date('2026-08-12T10:20:30.456Z'),
      id: '1',
    });
    expect(encoded).not.toContain('2026');
    expect(encoded).not.toContain('|');
  });

  it('is url-safe', () => {
    for (let id = 1; id <= 40; id += 1) {
      const encoded = encodeChangeLogCursor({
        changedAt: new Date(1_760_000_000_000 + id),
        id: String(id),
      });
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('returns null for junk rather than throwing', () => {
    expect(decodeChangeLogCursor('')).toBeNull();
    expect(decodeChangeLogCursor('not-base64!!')).toBeNull();
    expect(decodeChangeLogCursor(Buffer.from('only-one-part').toString('base64url'))).toBeNull();
    expect(decodeChangeLogCursor(Buffer.from('nope|1').toString('base64url'))).toBeNull();
    expect(
      decodeChangeLogCursor(Buffer.from('2026-08-12T10:20:30.456Z|abc').toString('base64url')),
    ).toBeNull();
  });

  it('returns null for a negative or oversized id', () => {
    expect(
      decodeChangeLogCursor(Buffer.from('2026-08-12T10:20:30.456Z|-1').toString('base64url')),
    ).toBeNull();
    expect(
      decodeChangeLogCursor(
        Buffer.from(`2026-08-12T10:20:30.456Z|${'9'.repeat(40)}`).toString('base64url'),
      ),
    ).toBeNull();
  });
});
