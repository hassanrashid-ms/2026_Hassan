import { and, asc, eq, isNull, like, ne } from 'drizzle-orm'
import type { CreateTagResponse, RenameTagResponse, ArchiveTagResponse, TagView } from '@support/types'
import { conversationTag, tag } from '../../shared/db/schema/index.ts'
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

/** Fixed palette size `colorIndex` hashes into. Shared with the console's Badge variants. */
export const TAG_PALETTE_SIZE = 10

function normalize(name: string): string {
  return name.trim().toLowerCase()
}

/** Simple deterministic string hash, stable across process restarts. */
function hashToColorIndex(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % TAG_PALETTE_SIZE
}

const tagColumns = { id: tag.id, name: tag.name, colorIndex: tag.colorIndex }

export async function listTags(ctx: AgentContext, query?: string): Promise<TagView[]> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const normalizedQuery = query ? normalize(query) : undefined
    const rows = await tx
      .select(tagColumns)
      .from(tag)
      .where(
        normalizedQuery
          ? and(isNull(tag.archivedAt), like(tag.normalizedName, `${normalizedQuery}%`))
          : isNull(tag.archivedAt),
      )
      .orderBy(asc(tag.name))
    return rows
  })
}

export type CreateTagResult = { ok: true; tag: CreateTagResponse; created: boolean }

export async function createTag(ctx: AgentContext, name: string): Promise<CreateTagResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const normalizedName = normalize(name)

    const [active] = await tx
      .select(tagColumns)
      .from(tag)
      .where(and(eq(tag.normalizedName, normalizedName), isNull(tag.archivedAt)))
      .limit(1)
    if (active) return { ok: true, tag: active, created: false }

    const [archived] = await tx
      .select(tagColumns)
      .from(tag)
      .where(eq(tag.normalizedName, normalizedName))
      .limit(1)
    if (archived) {
      const [row] = await tx
        .update(tag)
        .set({ archivedAt: null })
        .where(eq(tag.id, archived.id))
        .returning(tagColumns)
      return { ok: true, tag: row!, created: false }
    }

    const colorIndex = hashToColorIndex(normalizedName)
    const [row] = await tx
      .insert(tag)
      .values({ workspaceId: ctx.workspaceId, name, normalizedName, colorIndex })
      .returning(tagColumns)
    return { ok: true, tag: row!, created: true }
  })
}

export type RenameTagResult = { ok: true; tag: RenameTagResponse } | { ok: false; reason: 'not_found' | 'name_taken' }

export async function renameTag(ctx: AgentContext, id: string, name: string): Promise<RenameTagResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx.select({ id: tag.id }).from(tag).where(eq(tag.id, id)).limit(1)
    if (!current) return { ok: false, reason: 'not_found' }

    const normalizedName = normalize(name)
    const [collision] = await tx
      .select({ id: tag.id })
      .from(tag)
      .where(and(eq(tag.normalizedName, normalizedName), isNull(tag.archivedAt), ne(tag.id, id)))
      .limit(1)
    if (collision) return { ok: false, reason: 'name_taken' }

    const [row] = await tx
      .update(tag)
      .set({ name, normalizedName })
      .where(eq(tag.id, id))
      .returning(tagColumns)
    return { ok: true, tag: row! }
  })
}

export type ArchiveTagResult = { ok: true; tag: ArchiveTagResponse } | { ok: false; reason: 'not_found' }

export async function archiveTag(ctx: AgentContext, id: string): Promise<ArchiveTagResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [current] = await tx.select({ id: tag.id }).from(tag).where(eq(tag.id, id)).limit(1)
    if (!current) return { ok: false, reason: 'not_found' }

    const [row] = await tx
      .update(tag)
      .set({ archivedAt: new Date() })
      .where(eq(tag.id, id))
      .returning({ id: tag.id, name: tag.name, archivedAt: tag.archivedAt })
    return { ok: true, tag: { id: row!.id, name: row!.name, archivedAt: row!.archivedAt!.toISOString() } }
  })
}

export type AttachTagResult = { ok: true } | { ok: false; reason: 'tag_not_found' }

export async function attachTag(ctx: AgentContext, conversationId: string, tagId: string): Promise<AttachTagResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    // FK checks bypass RLS: confirm the tag is visible in this workspace with
    // an explicit scoped SELECT before trusting it as a FK.
    const [visibleTag] = await tx.select({ id: tag.id }).from(tag).where(eq(tag.id, tagId)).limit(1)
    if (!visibleTag) return { ok: false, reason: 'tag_not_found' }

    const [existing] = await tx
      .select({ id: conversationTag.id })
      .from(conversationTag)
      .where(and(eq(conversationTag.conversationId, conversationId), eq(conversationTag.tagId, tagId)))
      .limit(1)

    if (existing) {
      await tx.update(conversationTag).set({ removedAt: null }).where(eq(conversationTag.id, existing.id))
    } else {
      await tx.insert(conversationTag).values({ workspaceId: ctx.workspaceId, conversationId, tagId })
    }
    return { ok: true }
  })
}

export async function detachTag(ctx: AgentContext, conversationId: string, tagId: string): Promise<{ ok: true }> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    await tx
      .update(conversationTag)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(conversationTag.conversationId, conversationId),
          eq(conversationTag.tagId, tagId),
          isNull(conversationTag.removedAt),
        ),
      )
    return { ok: true }
  })
}

/** Currently-attached (removedAt is null) tags for a conversation. Takes an open tx, same pattern as getPlayerStateView/getTicketHistory. */
export async function getConversationTags(tx: Tx, conversationId: string): Promise<TagView[]> {
  const rows = await tx
    .select({ id: tag.id, name: tag.name, colorIndex: tag.colorIndex })
    .from(conversationTag)
    .innerJoin(tag, eq(tag.id, conversationTag.tagId))
    .where(and(eq(conversationTag.conversationId, conversationId), isNull(conversationTag.removedAt)))
    .orderBy(asc(tag.name))
  return rows
}
