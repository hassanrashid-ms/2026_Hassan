import type { ArticleStateValue } from '@support/types';
import fm from 'front-matter';

export function canEditFields(state: ArticleStateValue): boolean {
  return state === 'draft' || state === 'published';
}

export function canPublish(state: ArticleStateValue, title: string, body: string): boolean {
  return (state === 'draft' || state === 'published') && title.trim() !== '' && body.trim() !== '';
}

export function parseKeywordsInput(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '') seen.add(trimmed);
  }
  return [...seen];
}

export class EmptyMarkdownFileError extends Error {}

export type MarkdownImport = {
  title: string;
  body: string;
  keywordsInput: string;
  /** True when the file had a frontmatter block that failed to parse — body falls back to the raw file content. */
  frontmatterError: boolean;
};

function titleFromContent(body: string, filename: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  return filename.replace(/\.[^/.]+$/, '');
}

/** Category/intent is deliberately never derived from frontmatter — intentId is a foreign key
 * into an existing intent list and there is no reliable way to resolve an arbitrary string to it. */
export function parseMarkdownImport(content: string, filename: string): MarkdownImport {
  if (content.trim() === '') throw new EmptyMarkdownFileError('File is empty');

  let attributes: Record<string, unknown> = {};
  let body = content;
  let frontmatterError = false;
  try {
    const parsed = fm<Record<string, unknown>>(content);
    attributes = parsed.attributes ?? {};
    body = parsed.body;
  } catch {
    frontmatterError = true;
  }

  const rawTitle = attributes.title;
  const title =
    typeof rawTitle === 'string' && rawTitle.trim() !== ''
      ? rawTitle.trim()
      : titleFromContent(body, filename);

  const rawTags = attributes.tags;
  let keywordsInput = '';
  if (Array.isArray(rawTags)) {
    keywordsInput = rawTags.filter((tag) => typeof tag === 'string').join(', ');
  } else if (typeof rawTags === 'string') {
    keywordsInput = rawTags;
  }

  return { title, body: body.trim(), keywordsInput, frontmatterError };
}
