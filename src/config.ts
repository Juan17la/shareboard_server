/** Environment configuration. Every value has a local-dev default. */
const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  /** '*' or a comma-separated origin list. */
  corsOrigin: env.CORS_ORIGIN ?? '*',
  tokenSecret: env.TOKEN_SECRET ?? 'dev-secret-change-me',
  /** Empty means memory-only: boards are not persisted. */
  mongoUrl: env.MONGO_URL ?? '',
  mongoDb: env.MONGO_DB ?? 'shareboard',

  /** Persistence timers, from mobile/docs/06-loading-exporting. */
  idleFlushMs: 5 * 60_000,
  safetyFlushMs: 2 * 60_000,

  /** Rate limits, from mobile/docs/02-backend-connection. */
  createBoardPerHour: 10,
  pinAttemptsPerMinute: 5,
} as const;
