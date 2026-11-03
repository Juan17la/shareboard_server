/** Request-level identity helpers (docs/02-backend-connection → "Cabeceras estándar"). */
import type { FastifyRequest } from 'fastify';

import { config } from '../config.js';
import { AppError, forbidden, invalid } from '../errors.js';
import type { UserId } from '../model/types.js';
import { sessionState } from '../store/users.js';
import { verifyBoardToken, verifySessionToken, type BoardTokenPayload } from '../tokens.js';

/** Account ids are `usr_…`; a guest's is the UUID its device made up. */
export const isAccountId = (userId: string) => userId.startsWith('usr_');

/** `X-User-Id` — the device-generated id every request carries. */
export async function userIdOf(req: FastifyRequest): Promise<UserId> {
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

/**
 * `Authorization: Bearer <sessionToken>`: the signed-in account, or null for a
 * guest. A token whose account is gone, or was issued before the password last
 * changed, is no session.
 */
export async function sessionOf(req: FastifyRequest): Promise<{ userId: UserId; emailVerified: boolean } | null> {
  const claim = verifySessionToken(bearer(req));
  if (!claim || !isAccountId(claim.userId)) return null;
  const state = await sessionState(claim.userId);
  if (!state || state.tokenVersion !== claim.tv) return null;
  return { userId: claim.userId, emailVerified: state.emailVerified };
}

/** The signed-in account; AUTH_REQUIRED for a guest or an expired session. */
export async function accountOf(req: FastifyRequest): Promise<UserId> {
  const session = await sessionOf(req);
  if (!session) throw new AppError('AUTH_REQUIRED', 'Sign in to do that');
  return session.userId;
}

/** The signed-in account, which may share boards: its email is verified, when that is required. */
export async function sharerOf(req: FastifyRequest): Promise<UserId> {
  const session = await sessionOf(req);
  if (!session) throw new AppError('AUTH_REQUIRED', 'Sign in to do that');
  if (config.requireEmailVerification && !session.emailVerified) {
    throw new AppError('EMAIL_UNVERIFIED', 'Verify your email to share boards');
  }
  return session.userId;
}

/**
 * A claimed user id, checked: anyone may claim a guest id (it proves nothing,
 * as before accounts), but an account's id only with that account's session.
 * Without this, joining as a board's creator would skip its PIN.
 */
export async function assertIdentity(req: FastifyRequest, userId: UserId): Promise<UserId> {
  if (isAccountId(userId) && (await sessionOf(req))?.userId !== userId) {
    throw new AppError('AUTH_REQUIRED', 'Your session has expired, sign in again');
  }
  return userId;
}

function bearer(req: FastifyRequest): string {
  return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}
