/**
 * Accounts. Stored in Mongo; with MEMORY_ONLY=true they live in this process
 * and go with it, like the boards.
 */
import { randomUUID } from 'node:crypto';

import type { UserId } from '../model/types.js';
import * as db from './mongo.js';

export type User = db.UserDoc;

const memory = new Map<UserId, User>();

export const newAccountId = (): UserId => `usr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** False when the username is taken. */
export async function createUser(user: User): Promise<boolean> {
  if (db.persistenceEnabled()) return db.insertUser(user);
  if ([...memory.values()].some((u) => u.username === user.username)) return false;
  memory.set(user._id, user);
  return true;
}

export async function findByUsername(username: string): Promise<User | null> {
  if (db.persistenceEnabled()) return db.findUserByName(username);
  return [...memory.values()].find((u) => u.username === username) ?? null;
}

export async function findById(id: UserId): Promise<User | null> {
  if (db.persistenceEnabled()) return db.findUserById(id);
  return memory.get(id) ?? null;
}
