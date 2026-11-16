import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool,
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  BACKEND_URL: z.string().default('http://localhost:8080'),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(10).optional(),
  ADMIN_NAME: z.string().default('Administrator'),

  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().optional().default(''),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional().default(''),

  TOKEN_ENCRYPTION_KEY: z.string().min(1, 'TOKEN_ENCRYPTION_KEY is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),

  // ---- AI providers (keys can be overridden from the admin Settings page) ----
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  OPENAI_FALLBACK_MODEL: z.string().default('gpt-4.1-mini'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-2.0-flash'),
  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_MODELS: z.string().default('meta-llama/llama-3.3-70b-instruct:free'),
  AI_PROVIDER_ORDER: z.string().default('openai,gemini,openrouter'),
  AI_FALLBACK_ENABLED: z.string().optional().transform((v) => v !== 'false'),
  AI_CACHE_ENABLED: z.string().optional().transform((v) => v !== 'false'),
  AI_CACHE_TTL: z.coerce.number().default(3600),
  AI_MAX_RETRIES: z.coerce.number().default(3),
  AI_TIMEOUT_MS: z.coerce.number().default(45000),
  AI_LOGGING: z.string().optional().transform((v) => v !== 'false'),

  EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'none']).default('none'),
  EMAIL_PROVIDER_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().optional().default(''),
  EMAIL_TO: z.string().optional().default(''),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),

  APP_TIMEZONE: z.string().default('UTC'),
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  RUN_SCHEDULER_IN_API: bool,
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Never print values, only which variables are wrong.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();

export const isProd = env.NODE_ENV === 'production';

export const allowedOrigins = env.FRONTEND_URL.split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

export const googleOAuthConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI,
);
