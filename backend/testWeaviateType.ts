import { getWeaviateClient } from './src/shared/weaviate/client.ts'
async function run() {
  const client = await getWeaviateClient()
  const collection = client.collections.get('Article')
  const result = await collection.query.bm25("test", {
    returnMetadata: ['score']
  })
  // Print the keys of the metadata object
  const meta = result.objects[0]?.metadata;
  console.log("Metadata keys:", meta ? Object.keys(meta) : "no meta");
  console.log("Metadata:", meta);
}
