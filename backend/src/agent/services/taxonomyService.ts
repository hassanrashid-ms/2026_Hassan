import { asc, eq } from 'drizzle-orm'
import type { CreateIntentResponse, CreateSubintentResponse, IntentsResponse } from '@support/types'
import { intent, subintent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

export async function listIntents(ctx: AgentContext): Promise<IntentsResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const intents = await tx.select({ id: intent.id, name: intent.name }).from(intent).orderBy(asc(intent.name))
    const subintents = await tx
      .select({
        id: subintent.id,
        name: subintent.name,
        intentId: subintent.intentId,
        formId: subintent.formId,
        archivedAt: subintent.archivedAt,
      })
      .from(subintent)
      .orderBy(asc(subintent.name))
    return {
      intents: intents.map((i) => ({
        id: i.id,
        name: i.name,
        subintents: subintents
          .filter((s) => s.intentId === i.id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            formId: s.formId,
            archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
          })),
      })),
    }
  })
}

export async function createIntent(ctx: AgentContext, name: string): Promise<CreateIntentResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .insert(intent)
      .values({ workspaceId: ctx.workspaceId, name })
      .returning({ id: intent.id, name: intent.name })
    return row!
  })
}

export type CreateSubintentResult = { ok: true; subintent: CreateSubintentResponse } | { ok: false; reason: 'intent_not_found' }

export async function createSubintent(ctx: AgentContext, intentId: string, name: string): Promise<CreateSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [parent] = await tx.select({ id: intent.id }).from(intent).where(eq(intent.id, intentId)).limit(1)
    if (!parent) return { ok: false, reason: 'intent_not_found' }
    const [row] = await tx
      .insert(subintent)
      .values({ workspaceId: ctx.workspaceId, intentId, name })
      .returning({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
    return { ok: true, subintent: { id: row!.id, name: row!.name, intent_id: row!.intentId } }
  })
}
