import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.ts';

const valid = {
  DATABASE_URL: 'postgres://support_app:pw@localhost:5432/support',
  ADMIN_DATABASE_URL: 'postgres://crm_admin:crm_admin@localhost:5432/support',
  MIGRATION_DATABASE_URL: 'postgres://support_owner:pw@localhost:5432/support',
  REDIS_URL: 'redis://localhost:6379',
  WEAVIATE_URL: 'https://weaviate-test.example.com',
  WEAVIATE_API_KEY: 'weaviate-test-api-key',
  PLAYER_JWT_SECRET: 'x'.repeat(32),
  AGENT_SESSION_JWT_SECRET: 'y'.repeat(32),
  OPENAI_MODEL: 'gpt-5.4-mini',
};

describe('loadEnv', () => {
  it('applies the documented defaults', () => {
    const env = loadEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.PLAYER_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.SESSION_TIMEOUT_MINUTES).toBe(30);
    expect(env.SURFACE_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('coerces numeric strings', () => {
    expect(loadEnv({ ...valid, PORT: '5000' }).PORT).toBe(5000);
  });

  it('splits and trims SURFACE_ORIGINS', () => {
    const env = loadEnv({ ...valid, SURFACE_ORIGINS: 'https://a.test, https://b.test' });
    expect(env.SURFACE_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('throws when PLAYER_JWT_SECRET is too short to be worth having', () => {
    expect(() => loadEnv({ ...valid, PLAYER_JWT_SECRET: 'short' })).toThrow(/PLAYER_JWT_SECRET/);
  });

  it('fails validation when OPENAI_MODEL is missing', () => {
    const { OPENAI_MODEL, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/OPENAI_MODEL/);
  });
});
