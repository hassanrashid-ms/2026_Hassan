import { describe, expect, it } from 'vitest';
import {
  generateWorkspaceSecret,
  hashSecret,
  parseWorkspaceSecret,
  secretMatches,
} from '../src/shared/auth/workspaceSecret.ts';

describe('workspace secret', () => {
  it('mints a secret that carries the slug and hashes the random half only', () => {
    const { secret, secretHash } = generateWorkspaceSecret('demo-game');
    expect(secret.startsWith('sk_demo-game.')).toBe(true);
    const parsed = parseWorkspaceSecret(secret);
    expect(parsed?.slug).toBe('demo-game');
    expect(secretHash).toBe(hashSecret(parsed!.raw));
    expect(secretHash).not.toContain(parsed!.raw);
  });

  it('round-trips through comparison', () => {
    const { secret, secretHash } = generateWorkspaceSecret('demo-game');
    const { raw } = parseWorkspaceSecret(secret)!;
    expect(secretMatches(raw, secretHash)).toBe(true);
    expect(secretMatches(`${raw}x`, secretHash)).toBe(false);
  });

  it('never mints the same secret twice', () => {
    const a = generateWorkspaceSecret('demo-game').secret;
    const b = generateWorkspaceSecret('demo-game').secret;
    expect(a).not.toBe(b);
  });

  it('returns null for anything that is not a workspace secret', () => {
    for (const bad of [
      '',
      'demo-game.abc',
      'sk_',
      'sk_.abc',
      'sk_demo-game',
      'sk_demo-game.',
      'Bearer sk_a.b',
    ]) {
      expect(parseWorkspaceSecret(bad), bad).toBeNull();
    }
  });

  it('does not throw on a hash of the wrong length', () => {
    expect(secretMatches('anything', 'deadbeef')).toBe(false);
  });
});
