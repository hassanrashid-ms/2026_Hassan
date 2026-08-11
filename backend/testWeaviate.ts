import { getWeaviateClient } from './src/shared/weaviate/client.ts'
async function run() {
  const client = await getWeaviateClient()
  const collection = client.collections.get('Article')
  const result = await collection.query.bm25("hassan_does_not_exist", {
    returnMetadata: ['score'],
    limit: 5
  })
  console.log(JSON.stringify(result.objects, null, 2))
}
run().catch(console.error)
