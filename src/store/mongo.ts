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

/** Inserts an account; false when the username is taken. */
export async function insertUser(doc: UserDoc): Promise<boolean> {
  if (!users) return false;
  try {
    await users.insertOne(doc);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export async function findUserByName(username: string): Promise<UserDoc | null> {
  return users ? users.findOne({ username }) : null;
}

export async function findUserById(id: UserId): Promise<UserDoc | null> {
  return users ? users.findOne({ _id: id }) : null;
}
