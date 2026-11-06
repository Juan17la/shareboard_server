/**
 * Accounts. Stored in Mongo; with MEMORY_ONLY=true they live in this process
 * and go with it, like the boards.
 */
import { randomUUID } from 'node:crypto';

import type { UserId } from '../model/types.js';
import { onWorkerEvent, publish } from '../workers.js';
import * as db from './mongo.js';

export type User = db.UserDoc;

const memory = new Map<UserId, User>();

export const newAccountId = (): UserId => `usr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** The field that is taken (username or email), or null once created. */
export async function createUser(user: User): Promise<'username' | 'email' | null> {
  if (db.persistenceEnabled()) return db.insertUser(user);
  const all = [...memory.values()];
  if (all.some((u) => u.username === user.username)) return 'username';
  if (user.email && all.some((u) => u.email === user.email)) return 'email';
  memory.set(user._id, user);
  return null;
}

export async function findByUsername(username: string): Promise<User | null> {
  if (db.persistenceEnabled()) return db.findUserByName(username);
  return [...memory.values()].find((u) => u.username === username) ?? null;
}

export async function findByEmail(email: string): Promise<User | null> {
  if (db.persistenceEnabled()) return db.findUserByEmail(email);
  return [...memory.values()].find((u) => u.email === email) ?? null;
}

/** Sign-in takes either: anything with an `@` is an email (usernames cannot have one). */
export const findByLogin = (login: string) => (login.includes('@') ? findByEmail(login) : findByUsername(login));

export async function findById(id: UserId): Promise<User | null> {
  if (db.persistenceEnabled()) return db.findUserById(id);
  return memory.get(id) ?? null;
}

/** Applies `patch` to the stored account and to `user`; 'email' when that email is someone else's. */
export async function updateUser(user: User, patch: Partial<User>): Promise<'email' | null> {
  if (patch.email && patch.email !== user.email) {
    const owner = db.persistenceEnabled() ? null : await findByEmail(patch.email);
    if (owner && owner._id !== user._id) return 'email';
  }
  if (db.persistenceEnabled()) {
    const taken = await db.updateUser(user._id, patch);
    if (taken) return taken;
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (user as unknown as Record<string, unknown>)[k];
    else (user as unknown as Record<string, unknown>)[k] = v;
  }
  sessionCache.delete(user._id);
  publish({ kind: 'session', id: user._id });
  return null;
}

/**
 * What every signed-in request checks: the account still exists, its token
 * version, whether its email is verified. Cached briefly so a request costs no
 * database round-trip; writes from this machine's workers clear the entry at once.
 * ponytail: with several machines another one's password change takes up to
 * SESSION_CACHE_MS to end a session here; publish invalidations if that matters.
 */
export interface SessionState {
  tokenVersion: number;
  emailVerified: boolean;
}

const SESSION_CACHE_MS = 30_000;
const sessionCache = new Map<UserId, SessionState & { at: number }>();
onWorkerEvent('session', ({ id }) => sessionCache.delete(id));

export async function sessionState(id: UserId): Promise<SessionState | null> {
  const now = Date.now();
  const hit = sessionCache.get(id);
  if (hit && now - hit.at < SESSION_CACHE_MS) return hit;
  const user = await findById(id);
  if (!user) return null;
  // ponytail: cleared wholesale when big; an LRU if 10k active accounts is ever normal.
  if (sessionCache.size > 10_000) sessionCache.clear();
  const state = { tokenVersion: user.tokenVersion ?? 0, emailVerified: user.emailVerified === true, at: now };
  sessionCache.set(id, state);
  return state;
}
