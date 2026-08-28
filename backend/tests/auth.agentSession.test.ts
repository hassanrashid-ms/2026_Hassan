import { describe, expect, it } from 'vitest';
import {
  InvalidAgentSession,
  signAgentSession,
  verifyAgentSession,
} from '../src/shared/auth/agentSession.ts';

describe('agent session token', () => {
  it('round-trips a regular agent with is_admin false', async () => {
    const token = await signAgentSession({ agent_id: 'a1' });
    const claims = await verifyAgentSession(token);
    expect(claims).toEqual({ agent_id: 'a1', is_admin: false });
  });

  it('round-trips an admin with is_admin true', async () => {
    const token = await signAgentSession({ agent_id: 'a1', is_admin: true });
    const claims = await verifyAgentSession(token);
    expect(claims).toEqual({ agent_id: 'a1', is_admin: true });
  });

  it('carries no workspace_id claim at all — identity only, never authorization', async () => {
    const token = await signAgentSession({ agent_id: 'a1' });
    const { payload } = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as never as { payload: never };
    const decoded = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(decoded.workspace_id).toBeUndefined();
    expect(decoded.agent_id).toBe('a1');
    expect(decoded.is_admin).toBe(false);
    void payload;
  });

  it('rejects an expired token', async () => {
    const token = await signAgentSession({ agent_id: 'a1' }, -1);
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession);
  });

  it('rejects a token signed with a different audience', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET);
    const token = await new SignJWT({ agent_id: 'a1', is_admin: false })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('some-other-audience')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key);
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession);
  });

  it('rejects a token missing a required claim', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('support-agent-dev')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key);
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession);
  });

  it('rollout: tolerates an old-shape token that still carries workspace_id, ignoring the claim', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET);
    const token = await new SignJWT({ agent_id: 'a1', workspace_id: 'w1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('support-agent-dev')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key);
    const claims = await verifyAgentSession(token);
    expect(claims).toEqual({ agent_id: 'a1', is_admin: false });
  });
});
