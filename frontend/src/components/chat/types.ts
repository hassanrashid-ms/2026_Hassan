export type ChatAuthorType = 'player' | 'agent' | 'bot' | 'system'

/**
 * Serializer-agnostic on purpose: this is not @support/types's PlayerMessageView
 * or AgentMessageView. ChatThread renders this shape regardless of which
 * audience's API produced the data — only the caller (SupportSurface vs the
 * agent console pages) knows which serializer's response it mapped from.
 */
export type ChatMessage = {
  id: string
  authorType: ChatAuthorType
  body: string
  createdAt: string
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  visibility?: 'public' | 'internal'
}
