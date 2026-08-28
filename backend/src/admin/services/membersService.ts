import { and, eq, isNull } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { agent, workspaceMember } from '../../shared/db/schema/index.ts';
import { invalidateCachedWsAuth } from '../../shared/auth/wsAuthCache.ts';

export type MemberSummary = {
  agent_id: string;
  email: string;
  display_name: string;
  status: string;
  role: 'agent' | 'team_lead';
};

export async function listMembers(workspaceId: string): Promise<MemberSummary[]> {
  const rows = await adminDb
    .select({
      agentId: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
      role: workspaceMember.role,
    })
    .from(workspaceMember)
    .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
    .where(and(eq(workspaceMember.workspaceId, workspaceId), isNull(workspaceMember.deactivatedAt)))
    .orderBy(agent.displayName);

  return rows.map((row) => ({
    agent_id: row.agentId,
    email: row.email,
    display_name: row.displayName,
    status: row.status,
    role: row.role,
  }));
}

/** Upsert: granting access to an email already invited/active in this workspace updates the role instead of erroring. */
export async function addMember(args: {
  workspaceId: string;
  email: string;
  role: 'agent' | 'team_lead';
}): Promise<MemberSummary> {
  // onConflictDoNothing + a defensive re-select, not onConflictDoUpdate with an
  // empty SET (invalid SQL) — mirrors the exact upsert-or-fetch pattern
  // playerTokenRoute.ts already uses for the player upsert, for the same reason:
  // a conflict returns nothing from RETURNING, so the existing row must be
  // fetched explicitly rather than assumed absent.
  const [inserted] = await adminDb
    .insert(agent)
    .values({ email: args.email, displayName: args.email, status: 'invited' })
    .onConflictDoNothing({ target: agent.email })
    .returning({
      id: agent.id,
      email: agent.email,
      displayName: agent.displayName,
      status: agent.status,
    });

  const agentRow =
    inserted ??
    (
      await adminDb
        .select({
          id: agent.id,
          email: agent.email,
          displayName: agent.displayName,
          status: agent.status,
        })
        .from(agent)
        .where(eq(agent.email, args.email))
        .limit(1)
    )[0];
  if (!agentRow) throw new Error('agent upsert-or-fetch returned nothing');

  await adminDb
    .insert(workspaceMember)
    .values({ workspaceId: args.workspaceId, agentId: agentRow.id, role: args.role })
    .onConflictDoUpdate({
      target: [workspaceMember.workspaceId, workspaceMember.agentId],
      set: { role: args.role, deactivatedAt: null },
    });

  return {
    agent_id: agentRow.id,
    email: agentRow.email,
    display_name: agentRow.displayName,
    status: agentRow.status,
    role: args.role,
  };
}

export async function updateMember(args: {
  workspaceId: string;
  agentId: string;
  role?: 'agent' | 'team_lead';
  remove?: boolean;
}): Promise<MemberSummary | null> {
  const [existing] = await adminDb
    .select({ status: agent.status })
    .from(agent)
    .innerJoin(workspaceMember, eq(workspaceMember.agentId, agent.id))
    .where(
      and(
        eq(workspaceMember.workspaceId, args.workspaceId),
        eq(workspaceMember.agentId, args.agentId),
      ),
    )
    .limit(1);
  if (!existing) return null;

  // An invited agent has never signed in — removing them deletes the pending
  // row outright rather than soft-deactivating a membership that never became real.
  if (args.remove && existing.status === 'invited') {
    await adminDb
      .delete(workspaceMember)
      .where(
        and(
          eq(workspaceMember.workspaceId, args.workspaceId),
          eq(workspaceMember.agentId, args.agentId),
        ),
      );
    await invalidateCachedWsAuth(args.agentId, args.workspaceId);
    return null;
  }

  const [row] = await adminDb
    .update(workspaceMember)
    .set({
      role: args.role,
      deactivatedAt: args.remove ? new Date() : undefined,
    })
    .where(
      and(
        eq(workspaceMember.workspaceId, args.workspaceId),
        eq(workspaceMember.agentId, args.agentId),
      ),
    )
    .returning({ role: workspaceMember.role });
  if (!row) return null;
  if (args.remove) {
    await invalidateCachedWsAuth(args.agentId, args.workspaceId);
  }

  const [agentRow] = await adminDb
    .select({ email: agent.email, displayName: agent.displayName, status: agent.status })
    .from(agent)
    .where(eq(agent.id, args.agentId))
    .limit(1);

  return {
    agent_id: args.agentId,
    email: agentRow!.email,
    display_name: agentRow!.displayName,
    status: agentRow!.status,
    role: row.role,
  };
}
