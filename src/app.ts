/** Fastify instance: CORS, the shared error envelope, REST routes and the socket. */
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { config } from './config.js';
import { AppError } from './errors.js';
import { REALTIME } from './model/protocol.js';
import { boardRoutes } from './routes/boards.js';
import { realtimeRoutes } from './ws/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((o) => o.trim()),
    // PATCH is not in @fastify/cors's default list, and rename + permissions
    // both use it — without this the browser preflight blocks them.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
  });
  await app.register(websocket, {
    options: { maxPayload: REALTIME.maxMessageBytes },
  });

  // Every 4xx/5xx uses { error: { code, message } }.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send(err.toBody());
    if (err.validation || err.statusCode === 400) {
      return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } });
    }
    app.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Unexpected server error' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'BOARD_NOT_FOUND', message: 'Route not found' } }),
  );

  await app.register(boardRoutes);
  await app.register(realtimeRoutes);
  return app;
}
