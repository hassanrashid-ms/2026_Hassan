import { count, eq } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { workspace, workspaceMember } from '../../shared/db/schema/index.ts';

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  member_count: number;
  created_at: Date;
};

/** One query across every workspace — this is what crm_admin's BYPASSRLS is for. */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const rows = await adminDb
    .select({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      memberCount: count(workspaceMember.id),
      createdAt: workspace.createdAt,
    })
    .from(workspace)
    .leftJoin(workspaceMember, eq(workspaceMember.workspaceId, workspace.id))
    .groupBy(workspace.id)
    .orderBy(workspace.createdAt);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    member_count: row.memberCount,
    created_at: row.createdAt,
  }));
}

export class SlugTaken extends Error {}

export async function createWorkspace(args: {
  name: string;
  slug: string;
}): Promise<WorkspaceSummary> {
  try {
    const [row] = await adminDb
      .insert(workspace)
      .values({ name: args.name, slug: args.slug })
      .returning({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt,
      });
    if (!row) throw new Error('workspace insert returned nothing');
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      created_at: row.createdAt,
      member_count: 0,
    };
  } catch (error) {
    // Postgres unique_violation
    if (error && typeof error === 'object') {
      const isUniqueViolation =
        ('code' in error && error.code === '23505') ||
        ('cause' in error &&
          typeof error.cause === 'object' &&
          error.cause &&
          'code' in error.cause &&
          (error.cause as any).code === '23505');
      if (isUniqueViolation) {
        throw new SlugTaken(args.slug);
      }
    }
    throw error;
  }
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceSummary | null> {
  const [row] = await adminDb
    .update(workspace)
    .set({ name })
    .where(eq(workspace.id, id))
    .returning({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
    });
  if (!row) return null;

  const result = await adminDb
    .select({ memberCount: count(workspaceMember.id) })
    .from(workspaceMember)
    .where(eq(workspaceMember.workspaceId, id));
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_at: row.createdAt,
    member_count: result[0]!.memberCount,
  };
}
