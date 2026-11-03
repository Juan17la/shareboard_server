/**
 * Signed tokens — HMAC payloads, nothing stored server-side.
 *
 * Board tokens are short-lived, handed out by `join` and presented on the
 * WebSocket and on owner-only REST calls. Session tokens prove an account:
 * handed out by register/login, sent as `Authorization: Bearer` on the calls
 * that act as that account (create, import, join, /me).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import type { Role, UserId } from './model/types.js';

const TTL_MS = 12 * 60 * 60 * 1000;
// A session carries its account's `tokenVersion`; changing or resetting the
// password bumps it, which ends every other session (routes/auth.ts checks it).
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface BoardTokenPayload {
  boardId: string;
  userId: UserId;
  role: Role;
  exp: number;
}

interface SessionTokenPayload {
  kind: 'session';
  userId: UserId;
  /** The account's tokenVersion when issued; absent on tokens from before it existed (= 0). */
  tv: number;
  exp: number;
}

function sign(data: string): string {
  return createHmac('sha256', config.tokenSecret).update(data).digest('base64url');
}

function issue(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** The payload, or null when the token is malformed, forged or expired. */
function verify(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    return typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export function issueBoardToken(boardId: string, userId: UserId, role: Role): string {
  return issue({ boardId, userId, role, exp: Date.now() + TTL_MS } satisfies BoardTokenPayload);
}

/** Returns null when the token is malformed, forged, expired or not a board token. */
export function verifyBoardToken(token: string | undefined): BoardTokenPayload | null {
  const payload = verify(token);
  return payload && typeof payload.boardId === 'string' ? (payload as unknown as BoardTokenPayload) : null;
}

export function issueSessionToken(userId: UserId, tokenVersion: number): string {
  return issue({
    kind: 'session',
    userId,
    tv: tokenVersion,
    exp: Date.now() + SESSION_TTL_MS,
  } satisfies SessionTokenPayload);
}

/** The account the token claims and the version it was issued at, or null. Not yet checked against the account. */
export function verifySessionToken(token: string | undefined): { userId: UserId; tv: number } | null {
  const payload = verify(token);
  if (payload?.kind !== 'session' || typeof payload.userId !== 'string') return null;
  return { userId: payload.userId, tv: typeof payload.tv === 'number' ? payload.tv : 0 };
}

/** What an emailed code is stored as: keyed by the secret, so a leaked database cannot be brute-forced offline. */
export function codeHash(purpose: string, userId: UserId, code: string): string {
  return sign(`code:${purpose}:${userId}:${code}`);
}

/** Constant-time comparison of two `codeHash` results. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
