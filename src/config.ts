/** Environment configuration. Every value has a local-dev default. */
const env = process.env;

export const DEV_SECRET = 'dev-secret-change-me';

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  /** '*' or a comma-separated origin list. */
  corsOrigin: env.CORS_ORIGIN ?? '*',
  tokenSecret: env.TOKEN_SECRET ?? DEV_SECRET,
  production: env.NODE_ENV === 'production',
  /**
   * Proxies in front of this server whose X-Forwarded-For can be believed, so
   * `req.ip` (and every per-address rate limit) is the caller's and not the
   * load balancer's. Unset: 0. A hop count, not `true`: the left of the
   * header is whatever the client wrote.
   */
  trustProxy: Number(env.TRUST_PROXY ?? 0),
  /** Required: the server refuses to start without it unless MEMORY_ONLY=true. */
  mongoUrl: env.MONGO_URL?.trim() ?? '',
  mongoDb: env.MONGO_DB ?? 'shareboard',
  /** Throwaway runs only: boards vanish on every restart. */
  memoryOnly: env.MEMORY_ONLY === 'true',
  /** Connections per server process. The driver's default (100) is far more than one instance needs. */
  mongoPoolSize: Number(env.MONGO_POOL_SIZE ?? 20),

  /**
   * Node processes on this machine (workers.ts). Up to one per physical core,
   * leaving room for Mongo if it shares the machine: more than that adds
   * overhead, and a quota of 1 CPU or a one-core instance (t3.small) gains
   * little. Every worker has its own heap, so the memory limit has to fit them.
   */
  workers: Math.max(1, Math.floor(Number(env.WORKERS ?? 1)) || 1),
  /**
   * Broadcasts wait up to this long to share one write per socket. The biggest
   * lever on the realtime path; 0 sends each one at once, as a fair comparison
   * or if the delay is ever noticed. A live cursor updates every 45 ms anyway.
   */
  broadcastFlushMs: Math.max(0, Number(env.BROADCAST_FLUSH_MS ?? 25) || 0),

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

  /** Rate limits, from mobile/docs/02-backend-connection. Env overrides are for load tests only. */
  createBoardPerHour: Number(env.CREATE_BOARD_PER_HOUR ?? 10),
  pinAttemptsPerMinute: Number(env.PIN_PER_MINUTE ?? 5),
  registerPerHour: Number(env.REGISTER_PER_HOUR ?? 10),
  /** Per address and per username. */
  loginAttemptsPerMinute: Number(env.LOGIN_PER_MINUTE ?? 10),
  /**
   * Sharing needs a verified email, and new emails get a code. Off (the
   * default for now): accounts share as soon as they exist; emails are still
   * stored, and still used for password resets.
   */
  requireEmailVerification: env.REQUIRE_EMAIL_VERIFICATION === 'true',
  /** Emails (verification and reset codes) to one account; one a minute on top. */
  mailsPerHour: 6,
  /** Wrong guesses one emailed code allows before it is spent. */
  codeAttempts: 5,
  codeTtlMs: 15 * 60_000,

  /**
   * Outgoing mail over SMTP. Defaults are Gmail's: SMTP_USER is the Gmail
   * address, SMTP_PASS an App Password (Google Account → Security → 2-Step
   * Verification → App passwords), never the account password. Unset:
   * emails are printed to the log (dev only). Any SMTP server works, e.g.
   * Amazon SES's (email-smtp.<region>.amazonaws.com, 587).
   */
  smtpHost: env.SMTP_HOST ?? 'smtp.gmail.com',
  smtpPort: Number(env.SMTP_PORT ?? 465),
  smtpUser: env.SMTP_USER ?? '',
  smtpPass: env.SMTP_PASS ?? '',
  /** The From address; Gmail only sends as the signed-in account (or its verified aliases). */
  mailFrom: env.MAIL_FROM ?? env.SMTP_USER ?? '',
  mailFromName: env.MAIL_FROM_NAME ?? 'Shareboard',
} as const;
