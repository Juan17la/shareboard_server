/** Entry point: connect Mongo (optional), start timers, serve, flush on exit. */
import { buildApp } from './app.js';
import { config } from './config.js';
import { startRateLimitCleanup } from './rate-limit.js';
import { flushAll, startSweeper } from './store/boards.js';
import { closeMongo, connectMongo } from './store/mongo.js';

const app = await buildApp();

// Memory-only was the silent default and lost every board on restart.
if (!config.mongoUrl && !config.memoryOnly) {
  app.log.fatal(
    'MONGO_URL is not set, so boards would be lost on every restart. Add it to server/.env ' +
      '(e.g. MONGO_URL=mongodb://127.0.0.1:27017), or set MEMORY_ONLY=true for a throwaway run.',
  );
  process.exit(1);
}
try {
  const persisted = await connectMongo();
  app.log.info(
    persisted
      ? `Persistence enabled (${config.mongoDb})`
      : 'MEMORY_ONLY=true: boards are lost on restart',
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
