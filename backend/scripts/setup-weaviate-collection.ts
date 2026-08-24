export {};

// One-off script: run manually against Weaviate Cloud to create the "Article" collection,
// then seed the database (workspace, intents, subintents, articles) via the same `seed()`
// used by `pnpm db:seed` — the collection must exist first since seeding indexes published
// articles into it. Never invoked at app boot.
//
// The `text2VecOpenAI` vectorizer requires OPENAI_API_KEY configured on the Weaviate Cloud
// cluster itself (a cluster-level setting, not an app env var). Per the design doc, this is
// pre-wired for a future RAG feature and is unused by BM25 search in this slice.
//
// weaviate-client@3.14.0 (the installed version) exports `configure`, `dataType`, and
// `tokenization` as lowercase objects (not `Configure`/`DataType`/`Tokenization`) — confirmed
// against node_modules/weaviate-client/dist/node/esm/collections/configure/index.d.ts.
//
// `configure.vectorizer` is deprecated in favor of `configure.vectors` (same
// text2VecOpenAI() call, new namespace) — same file, index.d.ts:75.
//
// Lives under backend/ (not the repo-root scripts/) so Node's ESM resolver can find
// `weaviate-client`, which is a backend-only dependency — a script outside the backend
// workspace package can't resolve it. Run with:
//   cd backend && node --experimental-strip-types scripts/setup-weaviate-collection.ts
const { loadRootEnv } = await import('../src/env/loadRootEnv.ts');
loadRootEnv(import.meta.url);

import weaviate, { configure, dataType, tokenization } from 'weaviate-client';
import { getEnv } from '../src/env.ts';

async function main() {
  const env = getEnv();

  console.log('Setting up Weaviate collection...');
  const client = await weaviate.connectToWeaviateCloud(env.WEAVIATE_URL, {
    authCredentials: new weaviate.ApiKey(env.WEAVIATE_API_KEY),
  });

  const collections = await client.collections.listAll();
  const articleCollectionExists = collections.some((c) => c.name === 'Article');

  if (!articleCollectionExists) {
    await client.collections.create({
      name: 'Article',
      vectorizers: configure.vectors.text2VecOpenAI(),
      properties: [
        { name: 'title', dataType: dataType.TEXT, tokenization: tokenization.TRIGRAM },
        { name: 'body', dataType: dataType.TEXT, tokenization: tokenization.TRIGRAM },
        { name: 'keywords', dataType: dataType.TEXT_ARRAY, tokenization: tokenization.TRIGRAM },
        {
          name: 'intentId',
          dataType: dataType.TEXT,
          tokenization: tokenization.FIELD,
          skipVectorization: true,
        },
        {
          name: 'articleId',
          dataType: dataType.TEXT,
          tokenization: tokenization.FIELD,
          skipVectorization: true,
        },
        {
          name: 'workspaceId',
          dataType: dataType.TEXT,
          tokenization: tokenization.FIELD,
          skipVectorization: true,
        },
      ],
    });
    console.log('✓ Created "Article" collection in Weaviate Cloud.');
  } else {
    console.log('✓ "Article" collection already exists in Weaviate Cloud.');
  }

  console.log('Seeding database (workspace, intents, subintents, articles)...');
  const { seed } = await import('../src/shared/db/seed.ts');
  const { closeDb } = await import('../src/shared/db/client.ts');
  await seed();
  await closeDb();
}

await main();
console.log('\n✓ Setup complete: Weaviate collection created and database seeded.');
