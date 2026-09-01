import { describe, expect, it } from 'vitest';
import { parseMarkdownEntry } from '../src/agent/services/articleMarkdownImport.ts';

describe('parseMarkdownEntry', () => {
  it('reads title and tags from frontmatter, leaving the rest as body', () => {
    const content = [
      '---',
      'title: Refund Policy',
      'tags: [refund, billing]',
      '---',
      '# Refund Policy',
      '',
      'We refund within 30 days.',
    ].join('\n');

    const result = parseMarkdownEntry(content, 'refund-policy.md');

    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('Refund Policy');
    expect(result.keywords).toEqual(['refund', 'billing']);
    expect(result.body).toContain('We refund within 30 days.');
  });

  it('falls back to the first H1 when frontmatter has no title', () => {
    const content = '# Getting Started\n\nSome body text.';
    const result = parseMarkdownEntry(content, 'ignored.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('Getting Started');
  });

  it('falls back to the filename when there is no frontmatter title or H1', () => {
    const content = 'Just some plain text, no heading.';
    const result = parseMarkdownEntry(content, 'nested/path/my-article.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('my-article.md');
  });

  it('parses comma-separated string tags and dedupes them', () => {
    const content = '---\ntitle: X\ntags: "billing, billing, refund"\n---\nBody.';
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.keywords).toEqual(['billing', 'refund']);
  });

  it('truncates a title longer than 200 characters instead of failing', () => {
    const longTitle = 'x'.repeat(250);
    const content = `---\ntitle: ${longTitle}\n---\nBody.`;
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toHaveLength(200);
  });

  it('errors on a file that is empty after stripping frontmatter', () => {
    const content = '---\ntitle: X\n---\n   \n';
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBe('empty_file');
  });

  it('treats malformed frontmatter as plain body, falling back on title', () => {
    const content = '---\ntitle: [unterminated\n# Fallback Title\nBody text.';
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('Fallback Title');
  });
});
