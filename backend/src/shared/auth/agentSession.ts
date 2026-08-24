import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../../env.ts';

const ISSUER = 'support-crm';
const AUDIENCE = 'support-agent-dev';

/**
 * A regular agent's workspace is fixed at login (one row per membership), so it
 * lives in the token. A global admin (agent.is_admin) has no such fixed
 * workspace — see 2026-08-21-superadmin-workspace-console-access-design.md —
 * so their token carries no workspace_id claim at all; the target workspace is
 * resolved fresh per request/connection instead (X-Workspace-Id header for
 * REST, handshake auth for sockets).
 */
export type AgentSessionClaims =
  | { agent_id: string; workspace_id: string; is_admin?: false }
  | { agent_id: string; is_admin: true };

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().AGENT_SESSION_JWT_SECRET);
}

/**
 * Stands in for the real Google-OAuth session this slice defers (see
 * docs/decisions/2026-08-04-agent-auth-google-oauth.md). A separate secret and
 * audience from the player token keep the two credentials from ever being
 * interchangeable, even by accident.
 */
export async function signAgentSession(
  claims: AgentSessionClaims,
  ttlSeconds: number = 60 * 60 * 12,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key());
}

export class InvalidAgentSession extends Error {}

export async function verifyAgentSession(token: string): Promise<AgentSessionClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch (error) {
    throw new InvalidAgentSession(error instanceof Error ? error.message : 'token rejected');
  }

  const { agent_id, workspace_id, is_admin } = payload;
  if (typeof agent_id !== 'string') {
    throw new InvalidAgentSession('token is missing a required claim');
  }
  if (is_admin === true) {
    return { agent_id, is_admin: true };
  }
  if (typeof workspace_id !== 'string') {
    throw new InvalidAgentSession('token is missing a required claim');
  }
  return { agent_id, workspace_id };
}
