/**
 * MongoDB persistence. Optional in development: with no MONGO_URL the server
 * keeps everything in memory and every call here is a no-op (boards vanish on
 * restart). Production refuses to start without it (see index.ts).
 */
import { MongoClient, type Collection } from 'mongodb';

import { config } from '../config.js';
import type { BoardElement, BoardMeta } from '../model/types.js';

/** One document per board, as described in docs/05-model-date. */
export interface BoardDoc extends Omit<BoardMeta, 'id' | 'hasPin'> {
  _id: string;
  pinHash: string | null;
  elements: BoardElement[];
}

let client: MongoClient | null = null;
let boards: Collection<BoardDoc> | null = null;

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
