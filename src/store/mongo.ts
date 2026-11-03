/**
 * MongoDB persistence. Required (see index.ts); only with MEMORY_ONLY=true is
 * there no client, and every call here is a no-op.
 */
import { MongoClient, type Collection } from 'mongodb';

import { config } from '../config.js';
import type { BoardElement, BoardMeta, UserId } from '../model/types.js';

/** One document per board, as described in docs/05-model-date. */
export interface BoardDoc extends Omit<BoardMeta, 'id' | 'hasPin'> {
  _id: string;
  pinHash: string | null;
  elements: BoardElement[];
  /** Accounts that have joined it since its PIN was last set; absent on older boards. */
  members?: UserId[];
}

/** One document per account. */
export interface UserDoc {
  _id: UserId;
  /** Lower-case; unique. */
  username: string;
  passwordHash: string;
  nickname: string;
  avatar?: string;
  createdAt: number;
  /** Lower-case; unique when present. Accounts from before emails have none until they add one. */
  email?: string;
  emailVerified?: boolean;
  /** Bumped when the password changes: sessions issued before it stop working. Absent = 0. */
  tokenVersion?: number;
  /** Outstanding emailed codes, one per purpose. */
  codes?: Partial<Record<CodePurpose, EmailCode>>;
}

export type CodePurpose = 'verify' | 'reset';

export interface EmailCode {
  /** HMAC of the code (tokens.ts `codeHash`), never the code. */
  hash: string;
  exp: number;
  /** Wrong guesses so far. */
  tries: number;
  /** verify only: the address it was sent to, so a code cannot verify a later one. */
  email?: string;
}

let client: MongoClient | null = null;
let boards: Collection<BoardDoc> | null = null;
let users: Collection<UserDoc> | null = null;

export const persistenceEnabled = () => boards !== null;

export async function connectMongo(): Promise<boolean> {
  if (!config.mongoUrl) return false;
  client = new MongoClient(config.mongoUrl, {
    appName: 'shareboard-server',
    maxPoolSize: config.mongoPoolSize,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  boards = client.db(config.mongoDb).collection<BoardDoc>('boards');
  await boards.createIndex({ shortCode: 1 }, { unique: true });
  await boards.createIndex({ updatedAt: -1 });
  // "My whiteboards": the boards an account made or has joined.
  await boards.createIndex({ creatorId: 1 });
  await boards.createIndex({ members: 1 });
  users = client.db(config.mongoDb).collection<UserDoc>('users');
  await users.createIndex({ username: 1 }, { unique: true });
  await users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
  return true;
}

/** Round-trip to the primary, for the health check. */
export async function pingMongo(): Promise<boolean> {
  if (!client) return false;
  try {
    await client.db(config.mongoDb).command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = null;
  boards = null;
  users = null;
}

export async function findBoard(id: string): Promise<BoardDoc | null> {
  return boards ? boards.findOne({ _id: id }) : null;
}

export async function findBoardIdByCode(shortCode: string): Promise<string | null> {
  const doc = await boards?.findOne({ shortCode }, { projection: { _id: 1 } });
  return doc?._id ?? null;
}

export async function shortCodeExists(shortCode: string): Promise<boolean> {
  return boards ? (await boards.countDocuments({ shortCode }, { limit: 1 })) > 0 : false;
}

export async function saveBoard(doc: BoardDoc): Promise<void> {
  await boards?.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function deleteBoard(id: string): Promise<void> {
  await boards?.deleteOne({ _id: id });
}

/** Board documents an account made or is a member of, newest first, without their elements. */
export async function findBoardsFor(userId: UserId, limit: number): Promise<Omit<BoardDoc, 'elements'>[]> {
  if (!boards) return [];
  return boards
    .find({ $or: [{ creatorId: userId }, { members: userId }] }, { projection: { elements: 0 } })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
}

/** Hands every stored board one creator made to another (a guest's boards to their new account). */
export async function transferBoards(from: UserId, to: UserId): Promise<void> {
  await boards?.updateMany({ creatorId: from }, { $set: { creatorId: to } });
}

/** Which unique field a duplicate-key error is about, or null for any other error. */
function duplicateOf(err: unknown): 'username' | 'email' | null {
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e.code !== 11000) return null;
  return e.keyPattern && 'email' in e.keyPattern ? 'email' : 'username';
}

/** Inserts an account; the field that is taken when it cannot. */
export async function insertUser(doc: UserDoc): Promise<'username' | 'email' | null> {
  if (!users) return null;
  try {
    await users.insertOne(doc);
    return null;
  } catch (err) {
    const taken = duplicateOf(err);
    if (taken) return taken;
    throw err;
  }
}

/** Sets (and with `undefined`, removes) top-level fields; 'email' when the new email is someone else's. */
export async function updateUser(id: UserId, patch: Partial<UserDoc>): Promise<'email' | null> {
  if (!users) return null;
  const $set: Partial<UserDoc> = {};
  const $unset: Record<string, ''> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) $unset[k] = '';
    else ($set as Record<string, unknown>)[k] = v;
  }
  try {
    await users.updateOne({ _id: id }, { $set, $unset });
    return null;
  } catch (err) {
    if (duplicateOf(err) === 'email') return 'email';
    throw err;
  }
}

export async function findUserByEmail(email: string): Promise<UserDoc | null> {
  return users ? users.findOne({ email }) : null;
}

export async function findUserByName(username: string): Promise<UserDoc | null> {
  return users ? users.findOne({ username }) : null;
}

export async function findUserById(id: UserId): Promise<UserDoc | null> {
  return users ? users.findOne({ _id: id }) : null;
}
