import fm from 'front-matter';

export const MAX_IMPORT_FILES = 200;
const MAX_TITLE_LENGTH = 200;

export type ParsedMarkdownEntry =
  | { error: null; title: string; body: string; keywords: string[] }
  | { error: string };

function titleFromContent(body: string, filename: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  return filename.split('/').pop()!;
}

/**
 * Server-side counterpart to the frontend's parseMarkdownImport
 * (frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts).
 * Kept as a separate implementation deliberately — frontend/backend share
 * code only through packages/types.
 */
export function parseMarkdownEntry(content: string, filename: string): ParsedMarkdownEntry {
  let attributes: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = fm<Record<string, unknown>>(content);
    attributes = parsed.attributes ?? {};
    body = parsed.body;
  } catch {
    body = content;
  }

  body = body.trim();
  if (body === '') return { error: 'empty_file' };

  const rawTitle = attributes.title;
  let title =
    typeof rawTitle === 'string' && rawTitle.trim() !== ''
      ? rawTitle.trim()
      : titleFromContent(body, filename);
  if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH);

  const rawTags = attributes.tags;
  let keywords: string[] = [];
  if (Array.isArray(rawTags)) {
    keywords = rawTags.filter((tag): tag is string => typeof tag === 'string');
  } else if (typeof rawTags === 'string') {
    const seen = new Set<string>();
    for (const part of rawTags.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') seen.add(trimmed);
    }
    keywords = [...seen];
  }

  return { error: null, title, body, keywords };
}
