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
import weaviate, { configure, dataType, tokenization } from 'weaviate-client'

async function main() {
  const url = process.env.WEAVIATE_URL
  const apiKey = process.env.WEAVIATE_API_KEY
  if (!url || !apiKey) {
    throw new Error('WEAVIATE_URL and WEAVIATE_API_KEY must be set in the environment.')
  }

  const client = await weaviate.connectToWeaviateCloud(url, { authCredentials: new weaviate.ApiKey(apiKey) })

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
