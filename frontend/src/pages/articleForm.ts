import type { ArticleStateValue } from '@support/types'

export function canEditFields(state: ArticleStateValue): boolean {
  return state === 'draft'
}

export function canPublish(state: ArticleStateValue, title: string, body: string): boolean {
  return state === 'draft' && title.trim() !== '' && body.trim() !== ''
}
