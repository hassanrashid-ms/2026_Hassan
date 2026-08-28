import { and, desc, eq, isNull } from 'drizzle-orm';
import { adminDb } from '../../shared/db/adminClient.ts';
import { workspaceSecret } from '../../shared/db/schema/index.ts';
import { generateWorkspaceSecret } from '../../shared/auth/workspaceSecret.ts';

const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SecretMetadata = { created_at: Date; expires_at: Date | null };

export async function getSecretMetadata(workspaceId: string): Promise<SecretMetadata[]> {
  const rows = await adminDb
    .select({ createdAt: workspaceSecret.createdAt, expiresAt: workspaceSecret.expiresAt })
    .from(workspaceSecret)
    .where(and(eq(workspaceSecret.workspaceId, workspaceId), isNull(workspaceSecret.revokedAt)))
    .orderBy(desc(workspaceSecret.createdAt));

  return rows.map((row) => ({ created_at: row.createdAt, expires_at: row.expiresAt }));
}

/**
 * Inserts the new secret and gives the previous active row a 24h grace window
 * rather than invalidating it immediately, so a game studio can redeploy its
 * backend with the new secret without an outage. Returns the raw secret exactly
 * once — it is never retrievable again after this call returns.
 */
export async function rotateSecret(
  workspaceId: string,
  slug: string,
): Promise<{ secret: string; created_at: Date }> {
  const { secret, secretHash } = generateWorkspaceSecret(slug);

  await adminDb
    .update(workspaceSecret)
    .set({ expiresAt: new Date(Date.now() + GRACE_WINDOW_MS) })
    .where(
      and(
        eq(workspaceSecret.workspaceId, workspaceId),
        isNull(workspaceSecret.expiresAt),
        isNull(workspaceSecret.revokedAt),
      ),
    );

  const [row] = await adminDb
    .insert(workspaceSecret)
    .values({ workspaceId, secretHash })
    .returning({ createdAt: workspaceSecret.createdAt });
  if (!row) throw new Error('workspace_secret insert returned nothing');

  return { secret, created_at: row.createdAt };
}
