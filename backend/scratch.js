import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from 'dotenv';
config({ path: '../.env.test' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/crm_test' });
const db = drizzle(pool);
const w = pgTable('workspace', { name: text('name'), slug: text('slug') });
try {
  await db.insert(w).values({ name: 'A', slug: 'taken' });
  await db.insert(w).values({ name: 'B', slug: 'taken' });
} catch (e) {
  console.log("Error keys:", Object.keys(e));
  console.log("Error typeof:", typeof e);
  console.log("e.code:", e.code);
  console.log("e.cause?:", e.cause);
  if (e.cause) console.log("cause keys:", Object.keys(e.cause), "cause.code:", e.cause.code);
}
await pool.end();
