import { count, eq, ilike, or } from 'drizzle-orm'
import { adminDb } from '../../shared/db/adminClient.ts'
import { agent } from '../../shared/db/schema/index.ts'

export type AgentSummary = {
  id: string
  email: string
  display_name: string
  status: string
  is_admin: boolean
  is_super_admin: boolean
}

function toSummary(row: {
  id: string
  email: string
  displayName: string
  status: string
  isAdmin: boolean
  isSuperAdmin: boolean
}): AgentSummary {
  return {
    id: row.id,
    email: row.email,
    display_name: row.displayName,
    status: row.status,
    is_admin: row.isAdmin,
    is_super_admin: row.isSuperAdmin,
  }
}

export async function listAgents(query?: string): Promise<AgentSummary[]> {
  const rows = await adminDb
    .select({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      isAdmin: agent.isAdmin,
      isSuperAdmin: agent.isSuperAdmin,
    })
    .from(agent)
    .where(query ? or(ilike(agent.email, `%${query}%`), ilike(agent.displayName, `%${query}%`)) : undefined)
    .orderBy(agent.displayName)

  return rows.map(toSummary)
}

export class SelfDemotion extends Error {}
export class LastSuperAdmin extends Error {}

export async function setAdminFlag(args: {
  targetAgentId: string
  callerAgentId: string
  isAdmin: boolean
}): Promise<AgentSummary> {
  if (!args.isAdmin && args.targetAgentId === args.callerAgentId) {
    throw new SelfDemotion()
  }
  const [row] = await adminDb
    .update(agent)
    .set({ isAdmin: args.isAdmin })
    .where(eq(agent.id, args.targetAgentId))
    .returning({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      isAdmin: agent.isAdmin,
      isSuperAdmin: agent.isSuperAdmin,
    })
  if (!row) throw new Error('agent not found')
  return toSummary(row)
}

export async function setSuperAdminFlag(args: {
  targetAgentId: string
  callerAgentId: string
  isSuperAdmin: boolean
}): Promise<AgentSummary> {
  if (!args.isSuperAdmin && args.targetAgentId === args.callerAgentId) {
    throw new SelfDemotion()
  }
  if (!args.isSuperAdmin) {
    const result = await adminDb
      .select({ remaining: count() })
      .from(agent)
      .where(eq(agent.isSuperAdmin, true))
    if (result[0]!.remaining <= 1) throw new LastSuperAdmin()
  }
  const [row] = await adminDb
    .update(agent)
    .set({ isSuperAdmin: args.isSuperAdmin })
    .where(eq(agent.id, args.targetAgentId))
    .returning({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      isAdmin: agent.isAdmin,
      isSuperAdmin: agent.isSuperAdmin,
    })
  if (!row) throw new Error('agent not found')
  return toSummary(row)
}
