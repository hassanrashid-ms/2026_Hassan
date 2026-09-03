import { bigserial, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;

/** Unscoped, like workspace/agent — an IP-keyed hit on a pre-auth route has no
 * workspace to attach to, and this is a diagnostics log, not tenant data. */
export const rateLimitHit = pgTable(
  'rate_limit_hit',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    tier: text('tier').notNull(),
    keyType: text('key_type').notNull(),
    keyValue: text('key_value').notNull(),
    path: text('path').notNull(),
    method: text('method').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('rate_limit_hit_tier_created_idx').on(t.tier, t.createdAt),
    index('rate_limit_hit_key_value_created_idx').on(t.keyValue, t.createdAt),
  ],
);
