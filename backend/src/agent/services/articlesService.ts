import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import JSZip from 'jszip';
import type {
  AgentArticleDetail,
  AgentArticlesResponse,
  ArticleAttachmentView,
  ArticleDraftView,
  ArticleVersionedField,
  ArticleVersionSnapshotView,
  ArticleVersionsListResponse,
  BulkImportArticleResult,
  FinalizeArticleAttachmentBody,
} from '@support/types';
import type { z } from 'zod';
import { agent, article, articleAttachment, articleVersion, intent } from '../../shared/db/schema/index.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  copyObject,
  deleteObject,
  getObjectBuffer,
  headObject,
  presignGetObject,
} from '../../shared/storage/presign.ts';
import { deleteArticleObject, upsertArticleObject } from '../../shared/weaviate/articlesIndex.ts';
import { parseMarkdownEntry, MAX_IMPORT_FILES } from './articleMarkdownImport.ts';

function toDetail(row: typeof article.$inferSelect): Omit<AgentArticleDetail, 'attachments' | 'draft'> {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    keywords: row.keywords,
    state: row.state,
    version: row.version,
    intent_id: row.intentId,
    created_by: row.createdBy,
    published_by: row.publishedBy,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

async function attachmentsFor(tx: Tx, articleId: string): Promise<ArticleAttachmentView[]> {
  const attachmentRows = await tx
    .select()
    .from(articleAttachment)
    .where(
      and(
        eq(articleAttachment.articleId, articleId),
        isNull(articleAttachment.removedAt),
        eq(articleAttachment.draftOnly, false),
      ),
    );

  return Promise.all(
    attachmentRows.map(async (a) => ({
      id: a.id,
      filename: a.filename,
      mime_type: a.mimeType,
      byte_size: a.byteSize,
      url: await presignGetObject(a.storageKey).catch(() => null),
    })),
  );
}

async function draftFor(tx: Tx, articleId: string): Promise<ArticleDraftView> {
  const [draft] = await tx
    .select()
    .from(articleVersion)
    .where(and(eq(articleVersion.articleId, articleId), eq(articleVersion.status, 'draft')))
    .limit(1);
  if (!draft) return null;

  const attachmentRows = await tx
    .select()
    .from(articleAttachment)
    .where(
      and(
        eq(articleAttachment.articleId, articleId),
        isNull(articleAttachment.removedAt),
        or(isNull(articleAttachment.pendingRemovalAt), eq(articleAttachment.draftOnly, true)),
      ),
    );
  const attachments = await Promise.all(
    attachmentRows.map(async (a) => ({
      id: a.id,
      filename: a.filename,
      mime_type: a.mimeType,
      byte_size: a.byteSize,
      url: await presignGetObject(a.storageKey).catch(() => null),
    })),
  );

  return {
    title: draft.title,
    body: draft.body,
    keywords: draft.keywords,
    attachments,
    updated_at: draft.updatedAt.toISOString(),
  };
}

export async function listArticles(ctx: AgentContext): Promise<AgentArticlesResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx.select().from(article).orderBy(desc(article.createdAt));
    const draftArticleIds = new Set(
      (
        await tx
          .select({ articleId: articleVersion.articleId })
          .from(articleVersion)
          .where(eq(articleVersion.status, 'draft'))
      ).map((r) => r.articleId),
    );
    return {
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        state: r.state,
        version: r.version,
        has_draft: draftArticleIds.has(r.id),
        intent_id: r.intentId,
        created_at: r.createdAt.toISOString(),
        published_at: r.publishedAt ? r.publishedAt.toISOString() : null,
      })),
    };
  });
}

export async function getArticle(
  ctx: AgentContext,
  id: string,
): Promise<AgentArticleDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!row) return null;

    return {
      ...toDetail(row),
      attachments: await attachmentsFor(tx, id),
      draft: await draftFor(tx, id),
    };
  });
}

export type CreateArticleInput = {
  title: string;
  body: string;
  keywords?: string[];
  intentId?: string;
};
export type CreateArticleResult =
  { ok: true; article: AgentArticleDetail } | { ok: false; reason: 'intent_not_found' };

export async function createArticle(
  ctx: AgentContext,
  input: CreateArticleInput,
): Promise<CreateArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    if (input.intentId) {
      const [found] = await tx
        .select({ id: intent.id })
        .from(intent)
        .where(eq(intent.id, input.intentId))
        .limit(1);
      if (!found) return { ok: false, reason: 'intent_not_found' };
    }
    const [row] = await tx
      .insert(article)
      .values({
        workspaceId: ctx.workspaceId,
        intentId: input.intentId ?? null,
        title: input.title,
        body: input.body,
        keywords: input.keywords ?? [],
        createdBy: ctx.agentId,
      })
      .returning();
    // A just-created article can't have attachments yet — nothing to upload
    // against an id that didn't exist a moment ago.
    return { ok: true, article: { ...toDetail(row!), attachments: [], draft: null } };
  });
}

export type BulkImportArticlesResult =
  | {
      ok: true;
      results: BulkImportArticleResult[];
      summary: { total: number; created: number; failed: number };
    }
  | { ok: false; reason: 'not_found' | 'invalid_zip' | 'no_markdown_files' | 'too_many_files' };

/**
 * Best-effort, one createArticle() transaction per entry — a bad file must
 * never roll back the good ones in the same batch. The pending zip is deleted
 * after it's read regardless of outcome; it is never needed again.
 */
export async function bulkImportArticles(
  ctx: AgentContext,
  key: string,
): Promise<BulkImportArticlesResult> {
  const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.agentId}/`;
  if (!key.startsWith(expectedPrefix)) return { ok: false, reason: 'not_found' };

  const meta = await headObject(key);
  if (!meta) return { ok: false, reason: 'not_found' };

  const buffer = await getObjectBuffer(key);
  await deleteObject(key);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { ok: false, reason: 'invalid_zip' };
  }

  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && /\.(md|markdown)$/i.test(f.name),
  );
  if (entries.length === 0) return { ok: false, reason: 'no_markdown_files' };
  if (entries.length > MAX_IMPORT_FILES) return { ok: false, reason: 'too_many_files' };

  const results: BulkImportArticleResult[] = [];
  for (const entry of entries) {
    const filename = entry.name.split('/').pop()!;
    try {
      const content = await entry.async('string');
      const parsed = parseMarkdownEntry(content, filename);
      if (parsed.error !== null) {
        results.push({ filename, status: 'error', reason: parsed.error });
        continue;
      }
      const created = await createArticle(ctx, {
        title: parsed.title,
        body: parsed.body,
        keywords: parsed.keywords,
      });
      if (!created.ok) {
        results.push({ filename, status: 'error', reason: created.reason });
        continue;
      }
      results.push({
        filename,
        status: 'created',
        title: parsed.title,
        article_id: created.article.id,
      });
    } catch {
      results.push({ filename, status: 'error', reason: 'unreadable_entry' });
    }
  }

  const created = results.filter((r) => r.status === 'created').length;
  return {
    ok: true,
    results,
    summary: { total: results.length, created, failed: results.length - created },
  };
}

export type UpdateArticleInput = {
  title?: string;
  body?: string;
  keywords?: string[];
  intentId?: string | null;
};
export type UpdateArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'intent_not_found' };

export async function updateArticle(
  ctx: AgentContext,
  id: string,
  patch: UpdateArticleInput,
): Promise<UpdateArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' };
    if (patch.intentId) {
      const [found] = await tx
        .select({ id: intent.id })
        .from(intent)
        .where(eq(intent.id, patch.intentId))
        .limit(1);
      if (!found) return { ok: false, reason: 'intent_not_found' };
    }
    const [row] = await tx
      .update(article)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
        ...(patch.intentId !== undefined ? { intentId: patch.intentId } : {}),
      })
      .where(eq(article.id, id))
      .returning();
    return {
      ok: true,
      article: {
        ...toDetail(row!),
        attachments: await attachmentsFor(tx, id),
        draft: await draftFor(tx, id),
      },
    };
  });
}

export type SaveArticleDraftInput = { title?: string; body?: string; keywords?: string[] };
export type SaveArticleDraftResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_published' };

export async function saveArticleDraft(
  ctx: AgentContext,
  id: string,
  patch: SaveArticleDraftInput,
): Promise<SaveArticleDraftResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'published') return { ok: false, reason: 'not_published' };

    const [current] = await tx
      .select()
      .from(articleVersion)
      .where(and(eq(articleVersion.articleId, id), eq(articleVersion.status, 'draft')))
      .limit(1);

    if (current) {
      await tx
        .update(articleVersion)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
          actorId: ctx.agentId,
          updatedAt: new Date(),
        })
        .where(eq(articleVersion.id, current.id));
    } else {
      await tx.insert(articleVersion).values({
        articleId: id,
        status: 'draft',
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        keywords: patch.keywords ?? existing.keywords,
        actorId: ctx.agentId,
      });
    }

    return {
      ok: true,
      article: {
        ...toDetail(existing),
        attachments: await attachmentsFor(tx, id),
        draft: await draftFor(tx, id),
      },
    };
  });
}

export type DiscardArticleDraftResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'no_draft' };

export async function discardArticleDraft(
  ctx: AgentContext,
  id: string,
): Promise<DiscardArticleDraftResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    const [draft] = await tx
      .select()
      .from(articleVersion)
      .where(and(eq(articleVersion.articleId, id), eq(articleVersion.status, 'draft')))
      .limit(1);
    if (!draft) return { ok: false, reason: 'no_draft' };

    await tx
      .update(articleVersion)
      .set({ status: 'discarded' })
      .where(eq(articleVersion.id, draft.id));
    await tx
      .update(articleAttachment)
      .set({ removedAt: new Date() })
      .where(and(eq(articleAttachment.articleId, id), eq(articleAttachment.draftOnly, true)));
    await tx
      .update(articleAttachment)
      .set({ pendingRemovalAt: null })
      .where(
        and(eq(articleAttachment.articleId, id), isNotNull(articleAttachment.pendingRemovalAt)),
      );

    return {
      ok: true,
      article: {
        ...toDetail(existing),
        attachments: await attachmentsFor(tx, id),
        draft: null,
      },
    };
  });
}

export type ListArticleVersionsResult =
  | { ok: true; versions: ArticleVersionsListResponse }
  | { ok: false; reason: 'not_found' };

export async function listArticleVersions(
  ctx: AgentContext,
  articleId: string,
  opts: { limit: number; cursor?: number },
): Promise<ListArticleVersionsResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select({ id: article.id }).from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    const where =
      opts.cursor === undefined
        ? and(eq(articleVersion.articleId, articleId), eq(articleVersion.status, 'published'))
        : and(
            eq(articleVersion.articleId, articleId),
            eq(articleVersion.status, 'published'),
            lt(articleVersion.version, opts.cursor),
          );

    const found = await tx
      .select({
        version: articleVersion.version,
        createdAt: articleVersion.createdAt,
        changedFields: articleVersion.changedFields,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(articleVersion)
      .innerJoin(agent, eq(agent.id, articleVersion.actorId))
      .where(where)
      .orderBy(desc(articleVersion.version))
      .limit(opts.limit + 1);

    const page = found.slice(0, opts.limit);
    const versions = page.map((row) => ({
      version: row.version!,
      changed_fields: row.changedFields as ArticleVersionedField[],
      created_at: row.createdAt.toISOString(),
      actor: { id: row.actorId, display_name: row.actorDisplayName, email: row.actorEmail },
    }));
    const last = versions.at(-1);
    const nextCursor = found.length > opts.limit && last ? last.version : null;

    return { ok: true, versions: { versions, next_cursor: nextCursor } };
  });
}

export type GetArticleVersionResult =
  | { ok: true; version: ArticleVersionSnapshotView }
  | { ok: false; reason: 'not_found' };

export async function getArticleVersion(
  ctx: AgentContext,
  articleId: string,
  versionNumber: number,
): Promise<GetArticleVersionResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        version: articleVersion.version,
        title: articleVersion.title,
        body: articleVersion.body,
        keywords: articleVersion.keywords,
        attachmentIds: articleVersion.attachmentIds,
        changedFields: articleVersion.changedFields,
        createdAt: articleVersion.createdAt,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(articleVersion)
      .innerJoin(agent, eq(agent.id, articleVersion.actorId))
      .where(
        and(
          eq(articleVersion.articleId, articleId),
          eq(articleVersion.status, 'published'),
          eq(articleVersion.version, versionNumber),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };

    const attachmentRows =
      row.attachmentIds.length === 0
        ? []
        : await tx.select().from(articleAttachment).where(inArray(articleAttachment.id, row.attachmentIds));
    const attachments = await Promise.all(
      attachmentRows.map(async (a) => ({
        id: a.id,
        filename: a.filename,
        mime_type: a.mimeType,
        byte_size: a.byteSize,
        url: await presignGetObject(a.storageKey).catch(() => null),
      })),
    );

    return {
      ok: true,
      version: {
        version: row.version!,
        title: row.title,
        body: row.body,
        keywords: row.keywords,
        attachments,
        changed_fields: row.changedFields as ArticleVersionedField[],
        created_at: row.createdAt.toISOString(),
        actor: { id: row.actorId, display_name: row.actorDisplayName, email: row.actorEmail },
      },
    };
  });
}

export async function restoreArticleVersion(
  ctx: AgentContext,
  articleId: string,
  versionNumber: number,
): Promise<SaveArticleDraftResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'published') return { ok: false, reason: 'not_published' };

    const [snapshot] = await tx
      .select()
      .from(articleVersion)
      .where(
        and(
          eq(articleVersion.articleId, articleId),
          eq(articleVersion.status, 'published'),
          eq(articleVersion.version, versionNumber),
        ),
      )
      .limit(1);
    if (!snapshot) return { ok: false, reason: 'not_found' };

    return saveArticleDraft(ctx, articleId, {
      title: snapshot.title,
      body: snapshot.body,
      keywords: snapshot.keywords,
    });
  });
}

export type FinalizeArticleAttachmentResult =
  | { ok: true; attachment: ArticleAttachmentView; pendingKey: string }
  | {
      ok: false;
      reason: 'not_found' | 'not_draft' | 'attachment_not_found' | 'attachment_mismatch';
    };

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export async function finalizeArticleAttachment(
  ctx: AgentContext,
  articleId: string,
  body: z.infer<typeof FinalizeArticleAttachmentBody>,
): Promise<FinalizeArticleAttachmentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    // Draft-state articles: unchanged, draft-only. Published articles: only
    // allowed as a draftOnly staged upload (body.draft must be true) — an
    // attachment can't land directly on the live article outside the draft flow.
    if (existing.state !== 'draft' && !(existing.state === 'published' && body.draft)) {
      return { ok: false, reason: 'not_draft' };
    }

    // Same ownership-prefix check as sendAgentMessage's chat claim: only this
    // agent's own pending prefix may be claimed. A wrong-tenant/wrong-agent
    // key collapses into the same outcome as "missing".
    const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.agentId}/`;
    if (!body.key.startsWith(expectedPrefix)) {
      return { ok: false, reason: 'attachment_not_found' };
    }

    const real = await headObject(body.key);
    if (!real) return { ok: false, reason: 'attachment_not_found' };
    if (real.contentType !== body.mime_type || real.contentLength !== body.byte_size) {
      return { ok: false, reason: 'attachment_mismatch' };
    }
    // Defense-in-depth: re-check the allowlist/size cap against the
    // HEAD-verified values, not only the client-declared ones.
    if (
      !ALLOWED_IMAGE_MIME_TYPES.includes(
        real.contentType as (typeof ALLOWED_IMAGE_MIME_TYPES)[number],
      ) ||
      real.contentLength > MAX_ATTACHMENT_BYTES
    ) {
      return { ok: false, reason: 'attachment_mismatch' };
    }

    const destKey = `ws/${ctx.workspaceId}/attachments/${randomUUID()}.${extensionFor(real.contentType)}`;
    await copyObject({ sourceKey: body.key, destKey });

    const [row] = await tx
      .insert(articleAttachment)
      .values({
        workspaceId: ctx.workspaceId,
        articleId,
        storageKey: destKey,
        filename: body.filename,
        mimeType: body.mime_type,
        byteSize: body.byte_size,
        draftOnly: existing.state === 'published',
      })
      .returning();

    return {
      ok: true,
      pendingKey: body.key,
      attachment: {
        id: row!.id,
        filename: row!.filename,
        mime_type: row!.mimeType,
        byte_size: row!.byteSize,
        url: await presignGetObject(destKey),
      },
    };
  });
}

export type RemoveArticleAttachmentResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' };

export async function removeArticleAttachment(
  ctx: AgentContext,
  articleId: string,
  attachmentId: string,
): Promise<RemoveArticleAttachmentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    const [attachment] = await tx
      .select()
      .from(articleAttachment)
      .where(and(eq(articleAttachment.id, attachmentId), eq(articleAttachment.articleId, articleId)))
      .limit(1);
    if (!attachment) return { ok: false, reason: 'not_found' };

    if (existing.state === 'published' && !attachment.draftOnly) {
      // Live attachment on a published article: stage the removal, applied at publish.
      await tx
        .update(articleAttachment)
        .set({ pendingRemovalAt: new Date() })
        .where(eq(articleAttachment.id, attachmentId));
    } else {
      // Draft-state article, or a draftOnly attachment that was never live: no
      // staging needed, soft-remove now (never a DELETE).
      await tx
        .update(articleAttachment)
        .set({ removedAt: new Date() })
        .where(eq(articleAttachment.id, attachmentId));
    }

    return {
      ok: true,
      article: {
        ...toDetail(existing),
        attachments: await attachmentsFor(tx, articleId),
        draft: await draftFor(tx, articleId),
      },
    };
  });
}

export type PublishArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'empty_fields' };

async function liveAttachmentIdsFor(tx: Tx, articleId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: articleAttachment.id })
    .from(articleAttachment)
    .where(
      and(
        eq(articleAttachment.articleId, articleId),
        isNull(articleAttachment.removedAt),
        eq(articleAttachment.draftOnly, false),
      ),
    );
  return rows.map((r) => r.id);
}

export async function publishArticle(ctx: AgentContext, id: string): Promise<PublishArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    const [draftRow] = await tx
      .select()
      .from(articleVersion)
      .where(and(eq(articleVersion.articleId, id), eq(articleVersion.status, 'draft')))
      .limit(1);

    if (!draftRow) {
      // First-ever publish: existing draft-state-article flow, unchanged, plus a v1
      // version row.
      if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' };
      if (existing.title.trim() === '' || existing.body.trim() === '')
        return { ok: false, reason: 'empty_fields' };

      const [row] = await tx
        .update(article)
        .set({ state: 'published', publishedBy: ctx.agentId, publishedAt: new Date(), version: 1 })
        .where(eq(article.id, id))
        .returning();
      const liveAttachmentIds = await liveAttachmentIdsFor(tx, id);
      await tx.insert(articleVersion).values({
        articleId: id,
        status: 'published',
        version: 1,
        title: row!.title,
        body: row!.body,
        keywords: row!.keywords,
        attachmentIds: liveAttachmentIds,
        actorId: ctx.agentId,
        changedFields: ['title', 'body', 'keywords'],
      });
      await upsertArticleObject({
        id: row!.id,
        title: row!.title,
        body: row!.body,
        keywords: row!.keywords,
        intentId: row!.intentId,
        workspaceId: row!.workspaceId,
      });
      return {
        ok: true,
        article: {
          ...toDetail(row!),
          attachments: await attachmentsFor(tx, id),
          draft: null,
        },
      };
    }

    // Promoting a draft on an already-published article.
    if (draftRow.title.trim() === '' || draftRow.body.trim() === '')
      return { ok: false, reason: 'empty_fields' };

    const changedFields: string[] = [];
    if (draftRow.title !== existing.title) changedFields.push('title');
    if (draftRow.body !== existing.body) changedFields.push('body');
    if (JSON.stringify(draftRow.keywords) !== JSON.stringify(existing.keywords))
      changedFields.push('keywords');

    await tx
      .update(articleAttachment)
      .set({ draftOnly: false })
      .where(and(eq(articleAttachment.articleId, id), eq(articleAttachment.draftOnly, true)));
    await tx
      .update(articleAttachment)
      .set({ removedAt: new Date(), pendingRemovalAt: null })
      .where(
        and(eq(articleAttachment.articleId, id), isNotNull(articleAttachment.pendingRemovalAt)),
      );
    const liveAttachmentIds = await liveAttachmentIdsFor(tx, id);
    if (changedFields.length === 0 && liveAttachmentIds.length === draftRow.attachmentIds.length) {
      // Nothing actually changed (draft saved, then untouched) — still clear it, but
      // don't mint an empty version.
      await tx.update(articleVersion).set({ status: 'discarded' }).where(eq(articleVersion.id, draftRow.id));
      return {
        ok: true,
        article: { ...toDetail(existing), attachments: await attachmentsFor(tx, id), draft: null },
      };
    }
    if (liveAttachmentIds.sort().join(',') !== draftRow.attachmentIds.slice().sort().join(',')) {
      changedFields.push('attachments');
    }

    const nextVersion = existing.version + 1;
    const [row] = await tx
      .update(article)
      .set({
        title: draftRow.title,
        body: draftRow.body,
        keywords: draftRow.keywords,
        version: nextVersion,
        publishedBy: ctx.agentId,
        publishedAt: new Date(),
      })
      .where(eq(article.id, id))
      .returning();
    await tx
      .update(articleVersion)
      .set({
        status: 'published',
        version: nextVersion,
        attachmentIds: liveAttachmentIds,
        changedFields,
        actorId: ctx.agentId,
      })
      .where(eq(articleVersion.id, draftRow.id));
    await upsertArticleObject({
      id: row!.id,
      title: row!.title,
      body: row!.body,
      keywords: row!.keywords,
      intentId: row!.intentId,
      workspaceId: row!.workspaceId,
    });

    return {
      ok: true,
      article: { ...toDetail(row!), attachments: await attachmentsFor(tx, id), draft: null },
    };
  });
}

export type ArchiveArticleResult =
  { ok: true; article: AgentArticleDetail } | { ok: false; reason: 'not_found' };

export async function archiveArticle(ctx: AgentContext, id: string): Promise<ArchiveArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .update(article)
      .set({ state: 'archived' })
      .where(eq(article.id, id))
      .returning();
    if (!row) return { ok: false, reason: 'not_found' };
    await deleteArticleObject(row.id);
    return {
      ok: true,
      article: {
        ...toDetail(row),
        attachments: await attachmentsFor(tx, row.id),
        draft: await draftFor(tx, row.id),
      },
    };
  });
}

export type UnarchiveArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_archived' };

export async function unarchiveArticle(
  ctx: AgentContext,
  id: string,
): Promise<UnarchiveArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'archived') return { ok: false, reason: 'not_archived' };

    // Content and version are untouched by archive/unarchive — the article
    // still shows whatever it last published as. Only the state flips back and
    // the Weaviate object (removed on archive) is re-indexed from that
    // unchanged content, so the bot can cite it again.
    const [row] = await tx
      .update(article)
      .set({ state: 'published' })
      .where(eq(article.id, id))
      .returning();
    await upsertArticleObject({
      id: row!.id,
      title: row!.title,
      body: row!.body,
      keywords: row!.keywords,
      intentId: row!.intentId,
      workspaceId: row!.workspaceId,
    });
    return {
      ok: true,
      article: {
        ...toDetail(row!),
        attachments: await attachmentsFor(tx, id),
        draft: await draftFor(tx, id),
      },
    };
  });
}

import { callModel } from '../../domain/bot/openaiClient.ts';

export async function generateKeywords(title: string, body: string): Promise<string[]> {
  const prompt = `You are a helpful assistant that generates keywords for an article.
Given the following title and body, extract or generate up to 5 relevant keywords.
Format the output as a comma-separated list of keywords.

Title: ${title}

Body: ${body}

Keywords:`;

  const response = await callModel([{ role: 'user', content: prompt }]);
  const text = response.text || '';
  return text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
