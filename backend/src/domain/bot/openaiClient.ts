import OpenAI from 'openai'
import { observeOpenAI } from '@langfuse/openai'
import { getEnv } from '../../env.ts'
import type { ChatMessage } from './contextAssembly.ts'

export type ToolCall = { id: string; name: string; arguments: string }
export type ModelResponse = { toolCalls: ToolCall[]; text: string | null }
export type ModelTraceContext = {
  workspaceId: string
  conversationId: string
  confirmPhase: string
  iteration: number
  enabledToolNames: string[]
}

export class ModelTimeoutError extends Error {
  constructor() {
    super('OpenAI call exceeded 15000ms')
    this.name = 'ModelTimeoutError'
  }
}

export class ModelRefusalError extends Error {
  constructor(refusal: string) {
    super(`Model refused: ${refusal}`)
    this.name = 'ModelRefusalError'
  }
}

const CALL_TIMEOUT_MS = 15_000

let client: OpenAI | undefined
function getClient(trace?: ModelTraceContext): OpenAI {
  // The Langfuse wrapper takes its trace configuration when it is created. A
  // short-lived proxy around the shared OpenAI client means every generation
  // keeps the SDK's automatic token/cost capture but is labelled with the
  // product operation that caused it rather than the generic `openai.chat`.
  client ??= new OpenAI({ apiKey: getEnv().OPENAI_APIKEY })
  return observeOpenAI(
    client,
    trace
      ? {
          traceName: 'bot-turn',
          generationName: `bot.decide.${trace.confirmPhase}`,
          sessionId: trace.conversationId,
          tags: ['bot', `phase:${trace.confirmPhase}`],
          generationMetadata: {
            feature: 'bot_turn',
            workspace_id: trace.workspaceId,
            conversation_id: trace.conversationId,
            iteration: trace.iteration,
            enabled_tools: trace.enabledToolNames,
          },
        }
      : { traceName: 'bot-turn', generationName: 'bot.decide' },
  ) as unknown as OpenAI
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ModelTimeoutError()), CALL_TIMEOUT_MS)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * The only file that imports `openai`. Returns a validated response or
 * throws a typed error — `toolLoop` maps errors to reasons and never
 * inspects an SDK exception shape directly.
 */
export async function callModel(messages: ChatMessage[], tools?: unknown[], trace?: ModelTraceContext): Promise<ModelResponse> {
  const response = await withTimeout(
    getClient(trace).chat.completions.create({
      model: getEnv().OPENAI_MODEL,
      temperature: 0,
      messages: messages as never,
      ...(tools && tools.length > 0 ? { tools: tools as never } : {}),
    }) as unknown as Promise<{ choices: [{ message: { content: string | null; refusal?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }] }>,
  )

  const msg = response.choices[0].message
  if (msg.refusal) throw new ModelRefusalError(msg.refusal)

  const toolCalls = (msg.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }))
  return { toolCalls, text: toolCalls.length === 0 ? msg.content : null }
}
