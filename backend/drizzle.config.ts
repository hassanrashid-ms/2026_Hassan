import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/shared/db/schema/index.ts',
  out: './drizzle',
  // DDL runs as the owner; the app never has DDL rights.
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? '' },
  verbose: true,
  strict: false,
})
