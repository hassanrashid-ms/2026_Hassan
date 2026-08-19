import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type {
  ArchiveIntentResponse,
  ArchiveSubintentResponse,
  ConversationPriority,
  CreateIntentResponse,
  CreateSubintentResponse,
  IntentsResponse,
  MoveSubintentResponse,
  RenameIntentResponse,
  RenameSubintentResponse,
} from '@support/types'
import { article, intent, subintent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'
import { appendChangeLog } from '../../shared/changeLog/appendChangeLog.ts'
import { resolveFallbackSubintent } from '../../domain/bot/fallbackSubintent.ts'

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

export type RenameSubintentResult =
  | { ok: true; subintent: RenameSubintentResponse }
  | { ok: false; reason: 'not_found' | 'name_taken' }

export async function renameSubintent(
  ctx: AgentContext,
  id: string,
  patch: { name?: string; defaultPriority?: ConversationPriority },
): Promise<RenameSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: subintent.id, name: subintent.name, intentId: subintent.intentId, defaultPriority: subintent.defaultPriority })
      .from(subintent)
      .where(eq(subintent.id, id))
      .limit(1)
    if (!current) return { ok: false, reason: 'not_found' }

    if (patch.name === undefined && patch.defaultPriority === undefined) {
      return { ok: true, subintent: { id: current.id, name: current.name, defaultPriority: current.defaultPriority } }
    }

    if (patch.name !== undefined && patch.name !== current.name) {
      const [collision] = await tx
        .select({ id: subintent.id })
        .from(subintent)
        .where(
          and(
            eq(subintent.workspaceId, ctx.workspaceId),
            eq(subintent.intentId, current.intentId),
            eq(subintent.name, patch.name),
            ne(subintent.id, id),
          ),
        )
        .limit(1)
      if (collision) return { ok: false, reason: 'name_taken' }
    }

    const changes: { field: string; before: unknown; after: unknown }[] = []
    if (patch.name !== undefined) changes.push({ field: 'name', before: current.name, after: patch.name })
    if (patch.defaultPriority !== undefined) {
      changes.push({ field: 'default_priority', before: current.defaultPriority, after: patch.defaultPriority })
    }

    const [row] = await tx
      .update(subintent)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.defaultPriority !== undefined ? { defaultPriority: patch.defaultPriority } : {}),
      })
      .where(eq(subintent.id, id))
      .returning({ id: subintent.id, name: subintent.name, defaultPriority: subintent.defaultPriority })

    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'subintent',
      entityId: id,
      actorId: ctx.agentId,
      changes,
    })
    return { ok: true, subintent: row! }
  })
}

export type ArchiveSubintentResult =
  | { ok: true; subintent: ArchiveSubintentResponse }
  | { ok: false; reason: 'not_found' | 'is_other' }

export async function archiveSubintent(ctx: AgentContext, id: string): Promise<ArchiveSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: subintent.id, name: subintent.name, archivedAt: subintent.archivedAt })
      .from(subintent)
      .where(eq(subintent.id, id))
      .limit(1)
    if (!current) return { ok: false, reason: 'not_found' }

    const otherId = await resolveFallbackSubintent(tx, ctx.workspaceId)
    if (current.id === otherId) return { ok: false, reason: 'is_other' }

    const [row] = await tx
      .update(subintent)
      .set({ archivedAt: new Date() })
      .where(eq(subintent.id, id))
      .returning({ id: subintent.id, name: subintent.name, archivedAt: subintent.archivedAt })
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'subintent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'archived_at', before: current.archivedAt, after: row!.archivedAt }],
    })
    return { ok: true, subintent: { id: row!.id, name: row!.name, archivedAt: row!.archivedAt!.toISOString() } }
  })
}

export type MoveSubintentResult =
  | { ok: true; subintent: MoveSubintentResponse }
  | { ok: false; reason: 'not_found' | 'target_not_found' }

export async function moveSubintent(ctx: AgentContext, id: string, targetIntentId: string): Promise<MoveSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx
      .select({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
      .from(subintent)
      .where(eq(subintent.id, id))
      .limit(1)
    if (!current) return { ok: false, reason: 'not_found' }

    const [target] = await tx
      .select({ id: intent.id })
      .from(intent)
      .where(and(eq(intent.id, targetIntentId), isNull(intent.archivedAt)))
      .limit(1)
    if (!target) return { ok: false, reason: 'target_not_found' }

    const [row] = await tx
      .update(subintent)
      .set({ intentId: targetIntentId })
      .where(eq(subintent.id, id))
      .returning({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
    await appendChangeLog(tx, {
      workspaceId: ctx.workspaceId,
      entityType: 'subintent',
      entityId: id,
      actorId: ctx.agentId,
      changes: [{ field: 'intent_id', before: current.intentId, after: row!.intentId }],
    })
    return { ok: true, subintent: row! }
  })
}
