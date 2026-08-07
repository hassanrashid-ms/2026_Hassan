// One-off script: run manually against Weaviate Cloud to create the "Article" collection.
// Never invoked at app boot.
//
// The `text2VecOpenAI` vectorizer requires OPENAI_API_KEY configured on the Weaviate Cloud
// cluster itself (a cluster-level setting, not an app env var). Per the design doc, this is
// pre-wired for a future RAG feature and is unused by BM25 search in this slice.
//
// weaviate-client@3.14.0 (the installed version) exports `configure`, `dataType`, and
// `tokenization` as lowercase objects (not `Configure`/`DataType`/`Tokenization`) — confirmed
// against node_modules/weaviate-client/dist/node/esm/collections/configure/index.d.ts.
//
// Lives under backend/ (not the repo-root scripts/) so Node's ESM resolver can find
// `weaviate-client`, which is a backend-only dependency — a script outside the backend
// workspace package can't resolve it. Run with:
//   cd backend && node --experimental-strip-types scripts/setup-weaviate-collection.ts
import weaviate, { configure, dataType, tokenization } from 'weaviate-client'
import { getEnv } from '../src/env.ts'

async function main() {
  const env = getEnv()

  const client = await weaviate.connectToWeaviateCloud(env.WEAVIATE_URL, {
    authCredentials: new weaviate.ApiKey(env.WEAVIATE_API_KEY),
  })

  await client.collections.create({
    name: 'Article',
    vectorizers: configure.vectorizer.text2VecOpenAI(),
    properties: [
      { name: 'title', dataType: dataType.TEXT, tokenization: tokenization.TRIGRAM },
      { name: 'body', dataType: dataType.TEXT, tokenization: tokenization.TRIGRAM },
      { name: 'keywords', dataType: dataType.TEXT_ARRAY, tokenization: tokenization.TRIGRAM },
      { name: 'intentId', dataType: dataType.TEXT, tokenization: tokenization.FIELD, skipVectorization: true },
      { name: 'articleId', dataType: dataType.TEXT, tokenization: tokenization.FIELD, skipVectorization: true },
      { name: 'workspaceId', dataType: dataType.TEXT, tokenization: tokenization.FIELD, skipVectorization: true },
    ],
  })

  console.log('Created "Article" collection in Weaviate Cloud.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
