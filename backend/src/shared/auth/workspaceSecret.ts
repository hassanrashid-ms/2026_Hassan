import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sk_';

/**
 * Format: sk_<workspace-slug>.<43 base64url chars of 32 random bytes>
 *
 * The slug travels in the secret so verification is a single indexed lookup. The
 * alternative — a bare random string — would mean hashing the candidate against
 * every workspace row on every call.
 *
 * sha256, not bcrypt/argon2: the secret is 256 bits of CSPRNG output, so there is no
 * guessable password to slow an attacker down to. A slow KDF would buy nothing and
 * cost a native dependency. This reasoning does NOT transfer to agent passwords,
 * which are human-chosen and will need a real KDF when agent auth ships.
 */
export function generateWorkspaceSecret(slug: string): { secret: string; secretHash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { secret: `${PREFIX}${slug}.${raw}`, secretHash: hashSecret(raw) };
}

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function parseWorkspaceSecret(secret: string): { slug: string; raw: string } | null {
  if (!secret.startsWith(PREFIX)) return null;
  const rest = secret.slice(PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { slug: rest.slice(0, dot), raw: rest.slice(dot + 1) };
}

export function secretMatches(raw: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashSecret(raw), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would leak through the
  // difference between a 500 and a 401.
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/** True if `raw` matches ANY of the given hashes — used when a grace-window rotation leaves two active secrets. */
export function secretMatchesAny(raw: string, hashes: readonly string[]): boolean {
  return hashes.some((hash) => secretMatches(raw, hash));
}
