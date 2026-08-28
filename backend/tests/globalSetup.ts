import { Client } from 'pg';
import { setupDatabase } from '../src/shared/db/setup.ts';
import { getEnv } from '../src/env.ts';

/**
 * Creates the test database if it is absent, then runs the same setup pipeline the
 * dev database uses — so a schema mistake fails a test rather than surviving to
 * production.
 */
export default async function globalSetup(): Promise<void> {
  const migrationUrl = getEnv().MIGRATION_DATABASE_URL;
  const dbName = migrationUrl.slice(migrationUrl.lastIndexOf('/') + 1).split('?')[0] ?? '';

  // truncateAll() wipes every table, so pointing the suite at a real database would
  // destroy it. The name is the guard.
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${dbName}" — the database name must end in _test`,
    );
  }

  const adminUrl = migrationUrl.replace(/\/[^/]+$/, '/postgres');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [
      dbName,
    ]);
    // Identifiers cannot be parameterised, so the name is validated above and
    // double-quoted here.
    if (rowCount === 0) await client.query(`create database "${dbName}"`);
  } finally {
    await client.end();
  }

  await setupDatabase(migrationUrl);
}
