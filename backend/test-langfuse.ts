import { initLangfuse, shutdownLangfuse } from './src/shared/observability/langfuse.ts';
import { callModel } from './src/domain/bot/openaiClient.ts';

async function run() {
  initLangfuse();
  console.log('Langfuse initialized');
  try {
    const res = await callModel({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say hello to langfuse test' }]
    }, { workspaceId: 'test-ws', threadId: 'test-thread' });
    console.log('Response:', res.choices[0].message.content);
  } catch (e) {
    console.error(e);
  } finally {
    await shutdownLangfuse();
  }
}

run();
