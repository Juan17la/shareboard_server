/** Entry point: connect Mongo (optional), start timers, serve, flush on exit. */
import { buildApp } from './app.js';
import { config } from './config.js';
import { startRateLimitCleanup } from './rate-limit.js';
import { flushAll, startSweeper } from './store/boards.js';
import { closeMongo, connectMongo } from './store/mongo.js';

const app = await buildApp();

const persisted = await connectMongo();
app.log.info(
  persisted
    ? `Persistence enabled (${config.mongoDb})`
    : 'Running in memory only — set MONGO_URL to persist boards',
);

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
