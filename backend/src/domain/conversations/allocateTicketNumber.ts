import { eq, sql } from 'drizzle-orm'
import { workspace } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'

/**
 * The one place that bumps `workspace.ticket_seq`. Always in the caller's
 * transaction, always immediately before the conversation insert that consumes
 * the number — exactly the shape of postMessage()'s message_seq bump.
 *
 * The UPDATE takes a row lock on the workspace row, so a second concurrent
 * creation in the same workspace blocks until this one commits. That lock, not
 * any application-level retry, is what makes the sequence gap-free of
 * duplicates. It serialises conversation creation per workspace; at this scale
 * that is free, and it is the price of a number an agent can read aloud.
 *
 * support_app holds a column-scoped GRANT UPDATE (ticket_seq) on workspace and
 * nothing else on that table — see sql/002_rls.sql. Do not widen this function
 * to write any other workspace column; the grant will refuse it.
 */
export async function allocateTicketNumber(tx: Tx, workspaceId: string): Promise<number> {
  const [bumped] = await tx
    .update(workspace)
    .set({ ticketSeq: sql`${workspace.ticketSeq} + 1` })
    .where(eq(workspace.id, workspaceId))
    .returning({ number: workspace.ticketSeq })

  if (!bumped) {
    throw new Error(`allocateTicketNumber: workspace ${workspaceId} not found`)
  }
  return bumped.number
}
