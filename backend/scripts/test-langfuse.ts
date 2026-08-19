import { loadRootEnv } from '../src/env/loadRootEnv.ts'
loadRootEnv(import.meta.url)

import { initLangfuse, shutdownLangfuse } from '../src/shared/observability/langfuse.ts'
import { callModel } from '../src/domain/bot/openaiClient.ts'

async function main() {
  initLangfuse()
  console.log("Testing callModel...");
  try {
    const res = await callModel([{ role: 'user', content: 'Say hello to langfuse test' }], []);
    console.log(res.text)
  } catch (e) {
    console.error(e)
  }
  await shutdownLangfuse()
}
main()
