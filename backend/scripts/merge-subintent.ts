import { getEnv } from '../src/env.ts';
import { Client } from 'pg';
import { loadRootEnv } from '../src/env/loadRootEnv.ts';

loadRootEnv(import.meta.url);

async function main() {
  const env = getEnv();
  const pgClient = new Client({ connectionString: env.MIGRATION_DATABASE_URL });
  await pgClient.connect();

  try {
    // 1. Get the IDs of both subintents
    const targetRes = await pgClient.query(
      `SELECT id FROM subintent WHERE name = 'Missing Purchase' LIMIT 1`,
    );
    const oldRes = await pgClient.query(
      `SELECT id FROM subintent WHERE name = 'Item Not Received' LIMIT 1`,
    );

    if (oldRes.rows.length === 0) {
      console.log('Old subintent not found. Nothing to do.');
      return;
    }

    const targetId = targetRes.rows[0]?.id;
    const oldId = oldRes.rows[0]?.id;

    // 2. Update conversations pointing to the old one
    if (targetId && oldId) {
      console.log('Migrating conversations to Missing Purchase...');
      await pgClient.query(`UPDATE conversation SET subintent_id = $1 WHERE subintent_id = $2`, [
        targetId,
        oldId,
      ]);

      // 3. Delete the old subintent
      console.log('Deleting old Item Not Received subintent...');
      await pgClient.query(`DELETE FROM subintent WHERE id = $1`, [oldId]);

      console.log('Done!');
    }
  } finally {
    await pgClient.end();
  }
}

main().catch(console.error);
