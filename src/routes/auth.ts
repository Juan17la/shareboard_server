/** Request-level identity helpers (docs/02-backend-connection → "Cabeceras estándar"). */
import type { FastifyRequest } from 'fastify';

import { AppError, forbidden, invalid } from '../errors.js';
import type { UserId } from '../model/types.js';
import { verifyBoardToken, verifySessionToken, type BoardTokenPayload } from '../tokens.js';

/** Account ids are `usr_…`; a guest's is the UUID its device made up. */
export const isAccountId = (userId: string) => userId.startsWith('usr_');

/** `X-User-Id` — the device-generated id every request carries. */
export function userIdOf(req: FastifyRequest): UserId {
  const userId = req.headers['x-user-id'];
  if (typeof userId !== 'string' || !userId) throw invalid('Missing "X-User-Id" header');
  return assertIdentity(req, userId);
}

/** `Authorization: Bearer <boardToken>`, checked against the board being acted on. */
export function tokenFor(req: FastifyRequest, boardId: string): BoardTokenPayload {
  const payload = verifyBoardToken(bearer(req));
  if (!payload || payload.boardId !== boardId) throw forbidden('Invalid or expired board token');
  return payload;
}

/** `Authorization: Bearer <sessionToken>`: the signed-in account, or null for a guest. */
export function sessionOf(req: FastifyRequest): UserId | null {
  return verifySessionToken(bearer(req));
}

/** The signed-in account; AUTH_REQUIRED for a guest or an expired session. */
export function accountOf(req: FastifyRequest): UserId {
  const userId = sessionOf(req);
  if (!userId) throw new AppError('AUTH_REQUIRED', 'Sign in to do that');
  return userId;
}

/**
 * A claimed user id, checked: anyone may claim a guest id (it proves nothing,
 * as before accounts), but an account's id only with that account's session.
 * Without this, joining as a board's creator would skip its PIN.
 */
export function assertIdentity(req: FastifyRequest, userId: UserId): UserId {
  if (isAccountId(userId) && sessionOf(req) !== userId) {
    throw new AppError('AUTH_REQUIRED', 'Your session has expired, sign in again');
  }
  return userId;
}

function bearer(req: FastifyRequest): string {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}
