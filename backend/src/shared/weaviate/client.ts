import weaviate, { type WeaviateClient } from 'weaviate-client';
import { getEnv } from '../../env.ts';

let client: WeaviateClient | undefined;

/** Memoised so repeated calls in the same process reuse one connection. */
export async function getWeaviateClient(): Promise<WeaviateClient> {
  if (!client) {
    const env = getEnv();
    const openaiKey = env.OPENAI_APIKEY || process.env.OPENAI_API_KEY;
    client = await weaviate.connectToWeaviateCloud(env.WEAVIATE_URL, {
      authCredentials: new weaviate.ApiKey(env.WEAVIATE_API_KEY),
      ...(openaiKey ? { headers: { 'X-OpenAI-Api-Key': openaiKey } } : {}),
    });
  }
  return client;
}

/** Tests only — resets memoization so each test starts from a clean slate. */
export function resetWeaviateClientCache(): void {
  client = undefined;
}
