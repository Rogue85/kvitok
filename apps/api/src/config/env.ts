import { LOCALES, type Locale } from '@kvitok/i18n';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  /** The release the process runs: set in the image at build time (`0.2.0`, `edge-1a2b3c4`); `dev` otherwise. */
  APP_VERSION: z.string().min(1).default('dev'),
  /** Interface language of the installation: UI, API messages, system texts. */
  APP_LOCALE: z.enum(LOCALES).default('en'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  APP_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** `auto`: Secure when the request came over HTTPS (directly or through a proxy's X-Forwarded-Proto). */
  COOKIE_SECURE: z.union([z.literal('auto'), z.stringbool()]).default('auto'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  QUEUE_PREFIX: z.string().min(1).default('bull'),
  REPLY_UNDO_SECONDS: z.coerce.number().int().min(0).max(300).default(10),
  STORAGE_DIR: z.string().min(1).default('./storage'),
  /** The built web interface (`nuxt generate`) the API serves on the same origin; in development Nuxt serves it. */
  WEB_DIR: z.string().min(1).optional(),
  MAIL_POLL_SECONDS: z.coerce.number().int().min(10).default(60),
  REOPEN_WINDOW_DAYS: z.coerce.number().int().min(1).default(30),
  INTEGRATION_SYNC_MINUTES: z.coerce.number().int().min(1).default(15),
  INTEGRATION_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
  /** VAPID keys for web push (base64url); without them the keys are generated once and stored in the database. */
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  /** A contact for push services: `mailto:` or an https URL. Without it — WEB_ORIGIN or the superadmin's email (`VapidKeysService`). */
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/, 'must be mailto:you@example.com or an https URL')
    .optional(),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  version: string;
  locale: Locale;
  databaseUrl: string;
  redisUrl: string;
  appSecret: string;
  sessionTtlDays: number;
  cookieSecure: boolean | 'auto';
  webOrigin: string;
  /** Sign-in attempts per minute from one IP. */
  loginRateLimit: number;
  queuePrefix: string;
  /** Delay before a reply is sent, during which it can be cancelled. */
  replyUndoSeconds: number;
  storageDir: string;
  webDir: string | null;
  mailPollSeconds: number;
  /** An email to a ticket closed earlier than this creates a new ticket. */
  reopenWindowDays: number;
  /** How often the worker syncs integration manifests. */
  integrationSyncMinutes: number;
  /** Timeout of a single request to an integration. */
  integrationTimeoutMs: number;
  vapid: { publicKey: string; privateKey: string } | null;
  /** Set explicitly; null — chosen by `VapidKeysService`. */
  vapidSubject: string | null;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }

  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    version: e.APP_VERSION,
    locale: e.APP_LOCALE,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appSecret: e.APP_SECRET,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    cookieSecure: e.COOKIE_SECURE,
    webOrigin: e.WEB_ORIGIN,
    loginRateLimit: e.LOGIN_RATE_LIMIT,
    queuePrefix: e.QUEUE_PREFIX,
    replyUndoSeconds: e.REPLY_UNDO_SECONDS,
    storageDir: e.STORAGE_DIR,
    webDir: e.WEB_DIR ?? null,
    mailPollSeconds: e.MAIL_POLL_SECONDS,
    reopenWindowDays: e.REOPEN_WINDOW_DAYS,
    integrationSyncMinutes: e.INTEGRATION_SYNC_MINUTES,
    integrationTimeoutMs: e.INTEGRATION_TIMEOUT_MS,
    vapid: e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY } : null,
    vapidSubject: e.VAPID_SUBJECT ?? null,
  };
}
