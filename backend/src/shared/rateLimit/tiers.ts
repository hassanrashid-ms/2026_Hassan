export const RATE_LIMIT_TIERS = {
  auth: { windowMs: 60_000, ipMax: 60 },
  reads: { windowMs: 60_000, ipMax: 300, identityMax: 60 },
  writes: { windowMs: 60_000, ipMax: 200, identityMax: 30 },
  sessionsUploads: { windowMs: 60_000, ipMax: 100, identityMax: 10 },
} as const;

export type RateLimitTierName = keyof typeof RATE_LIMIT_TIERS;
