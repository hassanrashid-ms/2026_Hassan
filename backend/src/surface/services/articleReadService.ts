import { and, eq } from 'drizzle-orm';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { session } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts';

export type ArticleReadInput = { session_id: string; article_id: string };

/**
 * The player browses articles inside the webview, so the web app writes one
 * article_read event per article opened, against the authenticated session.
 *
 * This is what p40's funnel counts and what "articles read per session" divides by.
 * It is NOT article_feedback: reading an article and answering "did this help?" are
 * separate signals, and that second one arrives with the article UI.
 *
 * No dedupe: three reads of the same article are three events. The funnel counts
 * distinct sessions and the average counts events; collapsing them here would lose
 * the second.
 */
export async function recordArticleRead(
  ctx: PlayerContext,
  body: ArticleReadInput,
): Promise<boolean> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [owned] = await tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, body.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1);

    if (!owned) return false;

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'article_read',
      sessionId: owned.id,
      actorId: ctx.playerId,
      actorType: 'player',
      // Snapshotted, not a FK: the article table does not exist yet, and once it
      // does, an event must record what happened rather than point at live content.
      payload: { article_id: body.article_id },
    });
    return true;
  });
}
