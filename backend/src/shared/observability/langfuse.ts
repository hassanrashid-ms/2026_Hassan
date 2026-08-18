import { NodeSDK } from '@opentelemetry/sdk-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { getEnv } from '../../env.ts'
import { logger } from '../logging/logger.ts'

let sdk: NodeSDK | undefined

export function initLangfuse(): void {
  const env = getEnv()
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    return
  }

  if (!sdk) {
    const processor = new LangfuseSpanProcessor({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
    })
    sdk = new NodeSDK({
      spanProcessors: [processor],
    })
    sdk.start()
    logger.info('langfuse', 'OpenTelemetry Langfuse span processor initialized')
  }
}

export async function shutdownLangfuse(): Promise<void> {
  if (sdk) {
    await sdk.shutdown()
    sdk = undefined
  }
}
