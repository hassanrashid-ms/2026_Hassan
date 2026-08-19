import { getEnv } from '../src/env.ts';
import weaviate from 'weaviate-client';
import { Client } from 'pg';
import { loadRootEnv } from '../src/env/loadRootEnv.ts';

loadRootEnv(import.meta.url);

async function main() {
  const env = getEnv();

  // Clear Postgres
  console.log('Clearing Postgres articles...');
  const pgClient = new Client({ connectionString: env.MIGRATION_DATABASE_URL });
  await pgClient.connect();
  try {
    await pgClient.query('DELETE FROM article;');
    console.log('Cleared postgres articles.');
  } finally {
    await pgClient.end();
  }

  // Clear Weaviate
  console.log('Clearing Weaviate collection...');
  const client = await weaviate.connectToWeaviateCloud(env.WEAVIATE_URL, {
    authCredentials: new weaviate.ApiKey(env.WEAVIATE_API_KEY),
  });

  const collections = await client.collections.listAll();
  const articleCollectionExists = collections.some((c) => c.name === 'Article');

  if (articleCollectionExists) {
    await client.collections.delete('Article');
    console.log('Deleted Article collection from Weaviate.');
  } else {
    console.log('No Article collection found in Weaviate.');
  }
}

main().catch(console.error);
