/** Environment configuration. Every value has a local-dev default. */
const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  /** '*' or a comma-separated origin list. */
  corsOrigin: env.CORS_ORIGIN ?? '*',
  tokenSecret: env.TOKEN_SECRET ?? 'dev-secret-change-me',
  /** Empty means memory-only: boards are not persisted. Required when NODE_ENV=production. */
  mongoUrl: env.MONGO_URL ?? '',
  mongoDb: env.MONGO_DB ?? 'shareboard',
  production: env.NODE_ENV === 'production',
  /** Connections per server process. The driver's default (100) is far more than one instance needs. */
  mongoPoolSize: Number(env.MONGO_POOL_SIZE ?? 20),

  /** Every change reaches Mongo within this window; edits inside it share one write. */
  writeDelayMs: Number(env.WRITE_DELAY_MS ?? 1000),
  retryDelayMs: 5_000,
  /** Boards idle this long with nobody on them leave memory (they are already saved). */
  idleFlushMs: 5 * 60_000,
  sweepMs: 60_000,

  /** "Draw with AI" — provider presets live in src/ai.ts. */
  aiProvider: env.AI_PROVIDER ?? 'gemini',
  aiApiKey: env.AI_API_KEY ?? '',
  /** Optional overrides of the preset's model / endpoint (any OpenAI-compatible API). */
  aiModel: env.AI_MODEL ?? '',
  aiBaseUrl: env.AI_BASE_URL ?? '',
  aiPerMinute: 10,

  /** Rate limits, from mobile/docs/02-backend-connection. */
  createBoardPerHour: 10,
  pinAttemptsPerMinute: 5,
} as const;
