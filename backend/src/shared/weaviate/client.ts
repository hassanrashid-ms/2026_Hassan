import weaviate, { type WeaviateClient } from 'weaviate-client'
import { getEnv } from '../../env.ts'

let client: WeaviateClient | undefined

/** Memoised so repeated calls in the same process reuse one connection. */
export async function getWeaviateClient(): Promise<WeaviateClient> {
  if (!client) {
    client = await weaviate.connectToWeaviateCloud(getEnv().WEAVIATE_URL, {
      authCredentials: new weaviate.ApiKey(getEnv().WEAVIATE_API_KEY),
    })
  }
  return client
}

/** Tests only — resets memoization so each test starts from a clean slate. */
export function resetWeaviateClientCache(): void {
  client = undefined
}
