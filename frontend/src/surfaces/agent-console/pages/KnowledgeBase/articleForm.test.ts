import { describe, expect, it } from 'vitest';
import {
  canEditFields,
  canPublish,
  EmptyMarkdownFileError,
  parseKeywordsInput,
  parseMarkdownImport,
} from './articleForm.ts';

describe('canEditFields', () => {
  it('allows edits while draft or published, not archived', () => {
    expect(canEditFields('draft')).toBe(true);
    expect(canEditFields('published')).toBe(true);
    expect(canEditFields('archived')).toBe(false);
  });
});

describe('canPublish', () => {
  it('requires draft or published state and non-blank title and body', () => {
    expect(canPublish('draft', 'Title', 'Body')).toBe(true);
    expect(canPublish('draft', '  ', 'Body')).toBe(false);
    expect(canPublish('draft', 'Title', '  ')).toBe(false);
    expect(canPublish('published', 'Title', 'Body')).toBe(true);
    expect(canPublish('archived', 'Title', 'Body')).toBe(false);
  });
});

describe('parseKeywordsInput', () => {
  it('splits on commas, trims, drops empties, and dedupes', () => {
    expect(parseKeywordsInput('refund, billing ,, refund')).toEqual(['refund', 'billing']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseKeywordsInput('   ')).toEqual([]);
  });
});

describe('parseMarkdownImport', () => {
  it('reads title and tags from frontmatter, leaving the rest as body', () => {
    const content = [
      '---',
      'title: Refund Policy',
      'tags: [refund, billing]',
      'category: Billing',
      '---',
      '# Refund Policy',
      '',
      'We refund within 30 days.',
    ].join('\n');

    const result = parseMarkdownImport(content, 'refund-policy.md');

    expect(result.title).toBe('Refund Policy');
    expect(result.keywordsInput).toBe('refund, billing');
    expect(result.body).toContain('We refund within 30 days.');
    expect(result.frontmatterError).toBe(false);
  });

  it('accepts tags as a comma-separated string', () => {
    const content = ['---', 'tags: refund, billing', '---', 'Body text.'].join('\n');
    const result = parseMarkdownImport(content, 'notes.md');
    expect(result.keywordsInput).toBe('refund, billing');
  });

  it('falls back to the first H1 for title when frontmatter has none', () => {
    const content = '# Cancelling a Subscription\n\nSome body text.';
    const result = parseMarkdownImport(content, 'cancel-sub.md');
    expect(result.title).toBe('Cancelling a Subscription');
  });

  it('falls back to the filename when there is no frontmatter title and no H1', () => {
    const content = 'Just some plain body text, no heading.';
    const result = parseMarkdownImport(content, 'plain-notes.md');
    expect(result.title).toBe('plain-notes');
  });

  it('treats the whole file as body when there is no frontmatter block', () => {
    const content = '# Plain File\n\nNo frontmatter here.';
    const result = parseMarkdownImport(content, 'plain.md');
    expect(result.body).toBe(content);
    expect(result.keywordsInput).toBe('');
    expect(result.frontmatterError).toBe(false);
  });

  it('falls back to whole-file-as-body and flags frontmatterError on malformed frontmatter', () => {
    const content = ['---', 'title: [unterminated', '---', 'Body text.'].join('\n');
    const result = parseMarkdownImport(content, 'broken.md');
    expect(result.frontmatterError).toBe(true);
    expect(result.body).toBe(content.trim());
    expect(result.title).toBe('broken');
  });

  it('throws EmptyMarkdownFileError for blank content', () => {
    expect(() => parseMarkdownImport('   \n  ', 'empty.md')).toThrow(EmptyMarkdownFileError);
  });
});
