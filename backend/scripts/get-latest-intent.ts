import { getEnv } from '../src/env.ts';
import { Client } from 'pg';
import { loadRootEnv } from '../src/env/loadRootEnv.ts';

loadRootEnv(import.meta.url);

async function main() {
  const env = getEnv();
  const pgClient = new Client({ connectionString: env.MIGRATION_DATABASE_URL });
  await pgClient.connect();

  try {
    const res = await pgClient.query(`
      SELECT 
        c.id, 
        c.created_at, 
        i.name AS intent_name, 
        s.name AS subintent_name
      FROM conversation c
      LEFT JOIN subintent s ON c.subintent_id = s.id
      LEFT JOIN intent i ON s.intent_id = i.id
      ORDER BY c.created_at DESC
      LIMIT 1;
    `);

    if (res.rows.length === 0) {
      console.log('No conversations found.');
    } else {
      console.log('Latest Conversation ID:', res.rows[0].id);
      console.log('Intent:', res.rows[0].intent_name || 'None');
      console.log('Subintent:', res.rows[0].subintent_name || 'None');
    }
  } finally {
    await pgClient.end();
  }
}

main().catch(console.error);
