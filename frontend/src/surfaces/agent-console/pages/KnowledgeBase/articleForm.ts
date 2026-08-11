import type { ArticleStateValue } from '@support/types'

export function canEditFields(state: ArticleStateValue): boolean {
  return state === 'draft'
}

export function canPublish(state: ArticleStateValue, title: string, body: string): boolean {
  return state === 'draft' && title.trim() !== '' && body.trim() !== ''
}

export function parseKeywordsInput(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}
