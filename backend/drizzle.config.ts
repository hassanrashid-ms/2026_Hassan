import { config } from 'dotenv';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

config({ path: join(process.cwd(), '../.env') });
config();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/db/schema/index.ts',
  out: './drizzle',
  // DDL runs as the owner; the app never has DDL rights.
  dbCredentials: {
    url:
      process.env.MIGRATION_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgres://support_owner:support_owner@localhost:5432/support',
  },
  verbose: true,
  strict: false,
});
