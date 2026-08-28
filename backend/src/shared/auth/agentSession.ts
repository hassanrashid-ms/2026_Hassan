import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../../env.ts';

const ISSUER = 'support-crm';
const AUDIENCE = 'support-agent-dev';

/**
 * Identity only, never authorization — a regular agent and a global admin
 * carry the same shape. Which workspace(s) either can act in is resolved
 * fresh per request/connection (resolveConsoleWorkspace for REST, the socket
 * handshake for realtime), never fixed at sign time. See
 * 2026-08-25-global-inbox-workspace-decoupling-design.md section 1, which
 * generalizes what 2026-08-21-superadmin-workspace-console-access-design.md
 * built for admins only.
 */
export type AgentSessionClaims = { agent_id: string; is_admin: boolean };

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
  claims: { agent_id: string; is_admin?: boolean },
  ttlSeconds: number = 60 * 60 * 12,
): Promise<string> {
  const payload: AgentSessionClaims = {
    agent_id: claims.agent_id,
    is_admin: claims.is_admin ?? false,
  };
  return new SignJWT({ ...payload })
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

  const { agent_id, is_admin } = payload;
  if (typeof agent_id !== 'string') {
    throw new InvalidAgentSession('token is missing a required claim');
  }
  // Rollout: a token minted before this change may still carry workspace_id
  // and no is_admin at all — never read, never trusted for authorization. See
  // "Rollout / mixed-token window" in the design doc.
  return { agent_id, is_admin: is_admin === true };
}
