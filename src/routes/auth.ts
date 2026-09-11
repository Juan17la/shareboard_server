/** Request-level identity helpers (docs/02-backend-connection → "Cabeceras estándar"). */
import type { FastifyRequest } from 'fastify';

import { forbidden, invalid } from '../errors.js';
import type { UserId } from '../model/types.js';
import { verifyBoardToken, type BoardTokenPayload } from '../tokens.js';

/** `X-User-Id` — the device-generated id every request carries. */
export function userIdOf(req: FastifyRequest): UserId {
  const userId = req.headers['x-user-id'];
  if (typeof userId !== 'string' || !userId) throw invalid('Missing "X-User-Id" header');
  return userId;
}

/** `Authorization: Bearer <boardToken>`, checked against the board being acted on. */
export function tokenFor(req: FastifyRequest, boardId: string): BoardTokenPayload {
  const header = req.headers.authorization ?? '';
  const payload = verifyBoardToken(header.replace(/^Bearer\s+/i, ''));
  if (!payload || payload.boardId !== boardId) throw forbidden('Invalid or expired board token');
  return payload;
}
