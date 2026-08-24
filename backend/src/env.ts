import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ADMIN_DATABASE_URL: z.string().min(1, 'ADMIN_DATABASE_URL is required'),
  MIGRATION_DATABASE_URL: z.string().min(1, 'MIGRATION_DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  WEAVIATE_URL: z.string().min(1, 'WEAVIATE_URL is required'),
  WEAVIATE_API_KEY: z.string().min(1, 'WEAVIATE_API_KEY is required'),
  OPENAI_APIKEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1, 'OPENAI_MODEL is required'),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().optional(),
  PLAYER_JWT_SECRET: z.string().min(32, 'PLAYER_JWT_SECRET must be at least 32 characters'),
  PLAYER_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  AGENT_SESSION_JWT_SECRET: z
    .string()
    .min(32, 'AGENT_SESSION_JWT_SECRET must be at least 32 characters'),
  SESSION_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z.enum(['none', 'mild', 'verbose']).default('mild'),
  SURFACE_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  return parsed.data;
}

let cached: Env | undefined;

/** Memoised so a bad env fails once, loudly, rather than on every call. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Tests only — forces the next getEnv() to re-read process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
