import { z } from 'zod'

export const CreateTagBody = z.object({ name: z.string().min(1).max(120) })
export const RenameTagBody = z.object({ name: z.string().min(1).max(120) })
export const AttachTagBody = z.object({ tagId: z.uuid() })

export type TagView = { id: string; name: string; colorIndex: number }
export type TagsResponse = { tags: TagView[] }
export type CreateTagResponse = TagView
export type RenameTagResponse = TagView
export type ArchiveTagResponse = { id: string; name: string; archivedAt: string }
export type AttachTagResponse = { ok: true }
export type DetachTagResponse = { ok: true }
