import { describe, expect, it } from 'vitest'
import { InvalidAgentSession, signAgentSession, verifyAgentSession } from '../src/shared/auth/agentSession.ts'

describe('agent session token', () => {
  it('round-trips valid claims', async () => {
    const token = await signAgentSession({ agent_id: 'a1', workspace_id: 'w1' })
    const claims = await verifyAgentSession(token)
    expect(claims).toEqual({ agent_id: 'a1', workspace_id: 'w1' })
  })

  it('rejects an expired token', async () => {
    const token = await signAgentSession({ agent_id: 'a1', workspace_id: 'w1' }, -1)
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession)
  })

  it('rejects a token signed with a different audience', async () => {
    const { SignJWT } = await import('jose')
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET)
    const token = await new SignJWT({ agent_id: 'a1', workspace_id: 'w1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('some-other-audience')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key)
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession)
  })

  it('round-trips admin claims with no workspace_id', async () => {
    const token = await signAgentSession({ agent_id: 'a1', is_admin: true })
    const claims = await verifyAgentSession(token)
    expect(claims).toEqual({ agent_id: 'a1', is_admin: true })
  })

  it('rejects a token missing a required claim', async () => {
    const { SignJWT } = await import('jose')
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET)
    const token = await new SignJWT({ agent_id: 'a1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('support-agent-dev')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key)
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession)
  })
})
