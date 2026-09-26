/**
 * Board tokens — short-lived HMAC-signed payloads handed out by `join` and
 * presented on the WebSocket and on owner-only REST calls.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import type { Role, UserId } from './model/types.js';

const TTL_MS = 12 * 60 * 60 * 1000;

export interface BoardTokenPayload {
  boardId: string;
  userId: UserId;
  role: Role;
  exp: number;
}

function sign(data: string): string {
  return createHmac('sha256', config.tokenSecret).update(data).digest('base64url');
}

export function issueBoardToken(boardId: string, userId: UserId, role: Role): string {
  const payload: BoardTokenPayload = { boardId, userId, role, exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Returns null when the token is malformed, forged or expired. */
export function verifyBoardToken(token: string | undefined): BoardTokenPayload | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as BoardTokenPayload;
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
