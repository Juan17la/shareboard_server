/** Entry point: connect Mongo (optional), start timers, serve, flush on exit. */
import { buildApp } from './app.js';
import { config, DEV_SECRET } from './config.js';
import { verifyMail } from './mail.js';
import { startRateLimitCleanup } from './rate-limit.js';
import { flushAll, startSweeper } from './store/boards.js';
import { closeMongo, connectMongo } from './store/mongo.js';
import { isFirstProcess, isWorker, runPrimary, serveFromPrimary } from './workers.js';

async function serve(): Promise<void> {
  const app = await buildApp();

  // Anyone who knows the default could sign tokens for any account.
  if (config.production && config.tokenSecret === DEV_SECRET) {
    app.log.fatal('TOKEN_SECRET is not set: refusing to sign sessions with the development secret.');
    process.exit(1);
  }
  // Not awaited: a slow or unreachable mail server must not hold up the start.
  if (isFirstProcess) void verifyMail(app.log);

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

  if (isWorker) {
    await app.ready();
    serveFromPrimary(app.server);
  } else {
    await app.listen({ port: config.port, host: config.host });
  }

  // Ordered shutdown: persist every dirty board before exiting.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      app.log.info('Shutting down, flushing boards…');
      await app.close();
      await flushAll();
      await closeMongo();
      process.exit(0);
    })();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // The primary is gone, so nothing sends this worker any more connections.
  if (isWorker) process.once('disconnect', stop);
}

if (config.workers > 1 && !isWorker) {
  // Accounts and boards in memory would exist in one worker only.
  if (config.memoryOnly) {
    console.error('WORKERS needs MongoDB: with MEMORY_ONLY=true each process would have its own data.');
    process.exit(1);
  }
  runPrimary();
} else {
  await serve();
}
