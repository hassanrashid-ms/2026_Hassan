import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../../env.ts';

const ISSUER = 'support-crm';
const AUDIENCE = 'support-player';

export type PlayerClaims = {
  workspace_id: string;
  player_id: string;
  external_player_id: string;
};

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().PLAYER_JWT_SECRET);
}

/**
 * Short-lived because it travels in a URL fragment. The web app refreshes against
 * its own session rather than by re-reading the fragment, so 15 minutes is a ceiling
 * on the fragment's usefulness, not on the player's visit.
 */
export async function signPlayerToken(
  claims: PlayerClaims,
  ttlSeconds: number = getEnv().PLAYER_TOKEN_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key());
}

export class InvalidPlayerToken extends Error {}

export async function verifyPlayerToken(token: string): Promise<PlayerClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch (error) {
    throw new InvalidPlayerToken(error instanceof Error ? error.message : 'token rejected');
  }

  const { workspace_id, player_id, external_player_id } = payload;
  if (
    typeof workspace_id !== 'string' ||
    typeof player_id !== 'string' ||
    typeof external_player_id !== 'string'
  ) {
    throw new InvalidPlayerToken('token is missing a required claim');
  }
  return { workspace_id, player_id, external_player_id };
}
