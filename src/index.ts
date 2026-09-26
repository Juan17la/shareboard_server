/** Entry point: connect Mongo (optional), start timers, serve, flush on exit. */
import { buildApp } from './app.js';
import { config } from './config.js';
import { startRateLimitCleanup } from './rate-limit.js';
import { flushAll, startSweeper } from './store/boards.js';
import { closeMongo, connectMongo } from './store/mongo.js';

const app = await buildApp();

if (config.production && !config.mongoUrl) {
  app.log.fatal('MONGO_URL is required in production: boards would be lost on every restart');
  process.exit(1);
}
try {
  const persisted = await connectMongo();
  app.log.info(
    persisted
      ? `Persistence enabled (${config.mongoDb})`
      : 'Running in memory only — set MONGO_URL to persist boards',
  );
} catch (err) {
  // A TLS "alert internal error" from Atlas almost always means this host's IP
  // is not in the cluster's Network Access list.
  app.log.fatal(
    err,
    'Cannot reach MongoDB. On Atlas, allow this server under Network Access (Render: 0.0.0.0/0 or the service\'s outbound IPs).',
  );
  process.exit(1);
}

startSweeper();
startRateLimitCleanup();

await app.listen({ port: config.port, host: config.host });

// Ordered shutdown: persist every dirty board before exiting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      app.log.info('Shutting down, flushing boards…');
      await app.close();
      await flushAll();
      await closeMongo();
      process.exit(0);
    })();
  });
}
