import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type {
  ArchiveIntentResponse,
  CreateIntentResponse,
  CreateSubintentResponse,
  IntentsResponse,
  RenameIntentResponse,
} from '@support/types'
import { article, intent, subintent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts'

export async function listIntents(ctx: AgentContext): Promise<IntentsResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const intents = await tx
      .select({ id: intent.id, name: intent.name, isSystem: intent.isSystem, archivedAt: intent.archivedAt })
      .from(intent)
      .orderBy(asc(intent.name))
    const subintents = await tx
      .select({
        id: subintent.id,
        name: subintent.name,
        intentId: subintent.intentId,
        formId: subintent.formId,
        archivedAt: subintent.archivedAt,
        defaultPriority: subintent.defaultPriority,
        mergedIntoId: subintent.mergedIntoId,
      })
      .from(subintent)
      .orderBy(asc(subintent.name))
    return {
      intents: intents.map((i) => ({
        id: i.id,
        name: i.name,
        isSystem: i.isSystem,
        archivedAt: i.archivedAt ? i.archivedAt.toISOString() : null,
        subintents: subintents
          .filter((s) => s.intentId === i.id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            formId: s.formId,
            archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
            defaultPriority: s.defaultPriority,
            mergedIntoId: s.mergedIntoId,
          })),
      })),
    }
  })
}

export async function createIntent(ctx: AgentContext, name: string): Promise<CreateIntentResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .insert(intent)
      .values({ workspaceId: ctx.workspaceId, name })
      .returning({ id: intent.id, name: intent.name })
    return row!
  })
}

export type CreateSubintentResult = { ok: true; subintent: CreateSubintentResponse } | { ok: false; reason: 'intent_not_found' }

export async function createSubintent(ctx: AgentContext, intentId: string, name: string): Promise<CreateSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [parent] = await tx.select({ id: intent.id }).from(intent).where(eq(intent.id, intentId)).limit(1)
    if (!parent) return { ok: false, reason: 'intent_not_found' }
    const [row] = await tx
      .insert(subintent)
      .values({ workspaceId: ctx.workspaceId, intentId, name })
      .returning({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
    return { ok: true, subintent: { id: row!.id, name: row!.name, intent_id: row!.intentId } }
  })
}

export type RenameIntentResult = { ok: true; intent: RenameIntentResponse } | { ok: false; reason: 'not_found' | 'name_taken' }

export async function renameIntent(ctx: AgentContext, id: string, name: string): Promise<RenameIntentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx.select({ id: intent.id, name: intent.name }).from(intent).where(eq(intent.id, id)).limit(1)
    if (!current) return { ok: false, reason: 'not_found' }

    const [collision] = await tx
      .select({ id: intent.id })
      .from(intent)
      .where(and(eq(intent.workspaceId, ctx.workspaceId), eq(intent.name, name), ne(intent.id, id)))
      .limit(1)
    if (collision) return { ok: false, reason: 'name_taken' }

    const [row] = await tx.update(intent).set({ name }).where(eq(intent.id, id)).returning({ id: intent.id, name: intent.name })
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'intent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'name', before: current.name, after: name }],
    })
    return { ok: true, intent: row! }
  })
}

export type ArchiveIntentResult =
  | { ok: true; intent: ArchiveIntentResponse }
  | { ok: false; reason: 'not_found' | 'is_system' | 'has_active_subintents' | 'has_published_articles' }

export async function archiveIntent(ctx: AgentContext, id: string): Promise<ArchiveIntentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: intent.id, name: intent.name, isSystem: intent.isSystem, archivedAt: intent.archivedAt })
      .from(intent)
      .where(eq(intent.id, id))
      .limit(1)
    if (!current) return { ok: false, reason: 'not_found' }
    if (current.isSystem) return { ok: false, reason: 'is_system' }

    const [activeSubintent] = await tx
      .select({ id: subintent.id })
      .from(subintent)
      .where(and(eq(subintent.intentId, id), isNull(subintent.archivedAt)))
      .limit(1)
    if (activeSubintent) return { ok: false, reason: 'has_active_subintents' }

    const [publishedArticle] = await tx
      .select({ id: article.id })
      .from(article)
      .where(and(eq(article.intentId, id), eq(article.state, 'published')))
      .limit(1)
    if (publishedArticle) return { ok: false, reason: 'has_published_articles' }

    const [row] = await tx
      .update(intent)
      .set({ archivedAt: new Date() })
      .where(eq(intent.id, id))
      .returning({ id: intent.id, name: intent.name, archivedAt: intent.archivedAt })
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'intent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'archived_at', before: current.archivedAt, after: row!.archivedAt }],
    })
    return { ok: true, intent: { id: row!.id, name: row!.name, archivedAt: row!.archivedAt!.toISOString() } }
  })
}
