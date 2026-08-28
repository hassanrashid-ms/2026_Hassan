import { readMigrationFiles } from 'drizzle-orm/migrator';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { getEnv } from '../../env.ts';

const migrationsFolder = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
  'drizzle',
);

/**
 * Stamps an already-correct database as having applied every current migration,
 * without executing any of them. For the existing dev databases (`support`,
 * `support_test`) that already hold the full schema — running the baseline
 * migration against them would fail on `CREATE TABLE`. Writes the same
 * `drizzle.__drizzle_migrations` bookkeeping table drizzle-orm's node-postgres
 * migrator uses, with matching hashes, so a later `setupDatabase` sees every
 * migration as already applied and is a clean no-op. Idempotent: only inserts
 * hashes not already present.
 */
export async function baselineDatabase(
  url: string = getEnv().MIGRATION_DATABASE_URL,
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    const { rows } = await client.query<{ hash: string }>(
      'SELECT hash FROM drizzle.__drizzle_migrations',
    );
    const existing = new Set(rows.map((row) => row.hash));
    for (const migration of migrations) {
      if (existing.has(migration.hash)) continue;
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [migration.hash, migration.folderMillis],
      );
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('baseline.ts')) {
  const { loadRootEnv } = await import('../../env/loadRootEnv.ts');
  loadRootEnv(import.meta.url);
  const { logger } = await import('../logging/logger.ts');
  await baselineDatabase();
  logger.info('db', 'database baselined');
}
