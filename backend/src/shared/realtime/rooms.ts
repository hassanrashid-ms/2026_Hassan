export const playerRoom = (conversationId: string): string => `conv:${conversationId}:player`
export const agentRoom = (conversationId: string): string => `conv:${conversationId}:agents`
export const inboxRoom = (workspaceId: string): string => `workspace:${workspaceId}:inbox`
