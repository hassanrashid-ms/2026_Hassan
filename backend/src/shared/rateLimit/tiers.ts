export const RATE_LIMIT_TIERS = {
  auth: { windowMs: 60_000, ipMax: 60 },
  // identityMax raised from 60: the agent-console tickets board fires up to
  // 12 GET requests (6 status summaries + 6 column queries) per filter change.
  reads: { windowMs: 60_000, ipMax: 300, identityMax: 240 },
  writes: { windowMs: 60_000, ipMax: 200, identityMax: 30 },
  sessionsUploads: { windowMs: 60_000, ipMax: 100, identityMax: 10 },
} as const;

export type RateLimitTierName = keyof typeof RATE_LIMIT_TIERS;
