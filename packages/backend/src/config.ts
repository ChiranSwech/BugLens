import { z } from 'zod';

/**
 * Centralised configuration with strict Zod validation.
 *
 * The server WILL NOT start if any required variable is missing or invalid.
 * This prevents silent misconfigurations in production.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),

  // Database
  DATABASE_URL: z.string().url().startsWith('postgresql://'),

  // Redis
  REDIS_URL: z.string().url(),

  // MinIO / S3-compatible storage
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().default(9000),
  MINIO_USE_SSL: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  MINIO_ACCESS_KEY: z.string().min(3),
  MINIO_SECRET_KEY: z.string().min(8),
  MINIO_BUCKET: z.string().default('buglens-attachments'),

  // Google OAuth 2.0
  GOOGLE_CLIENT_ID: z.string().min(10),
  GOOGLE_CLIENT_SECRET: z.string().min(10),

  // JWT keypair — directory where private/public keys are stored
  JWT_KEYS_DIR: z.string().default('./keys'),

  // Session
  SESSION_SECRET: z.string().min(32),

  // AES-256-GCM encryption key for file attachments (32-byte hex = 64 chars)
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),

  // CORS
  CORS_ORIGIN: z.string().url().or(z.literal('*')),
  
  // API Base URL (used for OAuth redirect URIs)
  API_BASE_URL: z.string().url().default('http://localhost:8080'),

  // Optional: Jira integration
  JIRA_BASE_URL: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return '';
      let trimmed = v.trim();
      if (!trimmed) return '';
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        trimmed = `https://${trimmed}`;
      }
      return trimmed.replace(/\/+$/, '');
    }),
  JIRA_API_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : '')),
  JIRA_EMAIL: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : '')),
  JIRA_PROJECT_KEY: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim().toUpperCase() : '')),

  // Optional: Azure DevOps integration
  AZURE_ORG: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : '')),
  AZURE_PROJECT: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : '')),
  AZURE_PAT: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : '')),

  // Optional: Slack integration (incoming webhook)
  SLACK_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : '')),

  // Optional: OpenAI for AI-generated bug titles/descriptions (server-side)
  OPENAI_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim() : '')),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  // Load .env file automatically if available in environment
  try {
    if (typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile();
    }
  } catch {
    // Ignore if .env is missing or loaded via script command
  }

  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    // Exit immediately — never start with bad config
    console.error(`[CONFIG] Fatal: invalid environment configuration:\n${errors}`);
    process.exit(1);
  }
  return result.data;
}

// Singleton — loaded once at startup
export const config: Config = loadConfig();

export const isDev = config.NODE_ENV === 'development';
export const isProd = config.NODE_ENV === 'production';
