export function buildArticleSearchParams(filter: { q?: string; intentId?: string }): URLSearchParams {
  const params = new URLSearchParams()
  const q = filter.q?.trim()
  if (q) params.set('q', q)
  if (filter.intentId) params.set('intentId', filter.intentId)
  return params
}
