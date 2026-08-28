import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type {
  AgentArticleDetail,
  AgentArticlesResponse,
  ArticleAttachmentView,
  ArticleDraftView,
  FinalizeArticleAttachmentBody,
} from '@support/types';
import type { z } from 'zod';
import { article, articleAttachment, articleVersion, intent } from '../../shared/db/schema/index.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  copyObject,
  headObject,
  presignGetObject,
} from '../../shared/storage/presign.ts';
import { deleteArticleObject, upsertArticleObject } from '../../shared/weaviate/articlesIndex.ts';

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
    .where(eq(articleAttachment.articleId, articleId));

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
    return {
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        state: r.state,
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
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' };

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

export type PublishArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'empty_fields' };

export async function publishArticle(ctx: AgentContext, id: string): Promise<PublishArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' };
    if (existing.title.trim() === '' || existing.body.trim() === '')
      return { ok: false, reason: 'empty_fields' };
    const [row] = await tx
      .update(article)
      .set({ state: 'published', publishedBy: ctx.agentId, publishedAt: new Date() })
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
