import { eq } from 'drizzle-orm'
import type { Tx } from '../../shared/db/withWorkspace.ts'
import { agent } from '../../shared/db/schema/index.ts'

/**
 * `change_log.actor_id` is NOT NULL with a real FK — "every row is a human
 * act" per the schema comment. Seeding a baseline is the one exception the
 * spec calls out ("actor: 'system'"), so it needs a real `agent` row to point
 * at rather than a nullable actor column that would quietly permit others.
 * `agent` is one of the two unscoped tables, so a single global row is correct.
 */
export const SYSTEM_ACTOR_EMAIL = 'system@internal.support'

export async function getOrCreateSystemActor(tx: Tx): Promise<string> {
  const [existing] = await tx.select({ id: agent.id }).from(agent).where(eq(agent.email, SYSTEM_ACTOR_EMAIL)).limit(1)
  if (existing) return existing.id

  const [created] = await tx
    .insert(agent)
    .values({ email: SYSTEM_ACTOR_EMAIL, displayName: 'System' })
    .onConflictDoNothing({ target: agent.email })
    .returning({ id: agent.id })
  if (created) return created.id

  // Lost a race with a concurrent seed — the row now exists, read it back.
  const [row] = await tx.select({ id: agent.id }).from(agent).where(eq(agent.email, SYSTEM_ACTOR_EMAIL)).limit(1)
  return row!.id
}
