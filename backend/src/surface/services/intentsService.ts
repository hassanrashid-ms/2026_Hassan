import { and, asc, eq, isNull } from 'drizzle-orm'
import type { PublicIntentsResponse } from '@support/types'
import { article, intent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

export async function listPublicIntents(ctx: PlayerContext): Promise<PublicIntentsResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .selectDistinct({ id: intent.id, name: intent.name })
      .from(intent)
      .innerJoin(article, eq(article.intentId, intent.id))
      .where(and(isNull(intent.archivedAt), eq(article.state, 'published')))
      .orderBy(asc(intent.name))
    return { intents: rows }
  })
}
