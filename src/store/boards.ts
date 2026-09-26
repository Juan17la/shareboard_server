/**
 * Active boards live in memory and are written behind to MongoDB: a new board
 * is saved before its id is handed out, and every change is saved within
 * `config.writeDelayMs`, so a crash or redeploy loses at most that window.
 * Bursts of edits to one board coalesce into one write, and writes to a board
 * never overlap (an older snapshot can't land after a newer one).
 */
import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import { notFound } from '../errors.js';
import { generateShortCode } from '../model/short-code.js';
import type { BoardElement, BoardMeta, Participant, UserId } from '../model/types.js';
import * as db from './mongo.js';

export interface ActiveBoard {
  meta: BoardMeta;
  pinHash: string | null;
  elements: Map<string, BoardElement>;
  participants: Map<UserId, Participant>;
  /** Monotonic per board; stamped on every broadcast op. */
  seq: number;
  topZ: number;
  lastActivityAt: number;
  dirty: boolean;
  /** Pending write-behind timer. */
  saveTimer?: NodeJS.Timeout;
  /** The write in flight, if any. */
  saving?: Promise<void>;
}

const active = new Map<string, ActiveBoard>();
/** Cold loads in flight: two sockets joining a cold board must share one object. */
const loading = new Map<string, Promise<ActiveBoard>>();
const codeIndex = new Map<string, string>();

function toDoc(board: ActiveBoard): db.BoardDoc {
  const { id, hasPin, ...rest } = board.meta;
  return { _id: id, ...rest, pinHash: board.pinHash, elements: [...board.elements.values()] };
}

function fromDoc(doc: db.BoardDoc): ActiveBoard {
  const { _id, pinHash, elements, ...meta } = doc;
  return {
    meta: { ...meta, id: _id, hasPin: pinHash !== null },
    pinHash,
    elements: new Map(elements.map((el) => [el.id, el])),
    participants: new Map(),
    seq: 0,
    topZ: elements.reduce((max, el) => Math.max(max, el.z), 0),
    lastActivityAt: Date.now(),
    dirty: false,
  };
}

function remember(board: ActiveBoard): ActiveBoard {
  active.set(board.meta.id, board);
  codeIndex.set(board.meta.shortCode, board.meta.id);
  return board;
}

function forget(board: ActiveBoard): void {
  clearTimeout(board.saveTimer);
  board.saveTimer = undefined;
  active.delete(board.meta.id);
  codeIndex.delete(board.meta.shortCode);
}

/** Marks the board changed so the next flush persists it. */
export function touch(board: ActiveBoard): void {
  board.lastActivityAt = Date.now();
  board.dirty = true;
  board.meta.updatedAt = board.lastActivityAt;
  board.saveTimer ??= setTimeout(() => void flush(board), config.writeDelayMs);
}

export async function createBoard(input: {
  name: string;
  access: BoardMeta['access'];
  editPolicy: BoardMeta['editPolicy'];
  creatorId: UserId;
  pinHash?: string | null;
  elements?: BoardElement[];
}): Promise<ActiveBoard> {
  let shortCode = generateShortCode();
  while (codeIndex.has(shortCode) || (await db.shortCodeExists(shortCode))) {
    shortCode = generateShortCode();
  }

  const now = Date.now();
  const elements = input.elements ?? [];
  const board: ActiveBoard = {
    meta: {
      id: `brd_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      shortCode,
      name: input.name,
      access: input.access,
      editPolicy: input.editPolicy,
      editors: [],
      creatorId: input.creatorId,
      hasPin: !!input.pinHash,
      createdAt: now,
      updatedAt: now,
    },
    pinHash: input.pinHash ?? null,
    elements: new Map(elements.map((el, i) => [el.id, { ...el, z: i + 1 }])),
    participants: new Map(),
    seq: 0,
    topZ: elements.length,
    lastActivityAt: now,
    dirty: true,
  };

  // Saved before anyone gets its id: a board that exists is always in the db.
  remember(board);
  try {
    await save(board);
  } catch (err) {
    forget(board);
    throw err;
  }
  return board;
}

/** Hot from memory, otherwise cold from Mongo. Throws BOARD_NOT_FOUND. */
export async function getBoard(id: string): Promise<ActiveBoard> {
  const hot = active.get(id);
  if (hot) return hot;

  let pending = loading.get(id);
  if (!pending) {
    pending = db
      .findBoard(id)
      .then((doc) => {
        if (!doc) throw notFound();
        return remember(fromDoc(doc));
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

export async function resolveShortCode(shortCode: string): Promise<string> {
  const cached = codeIndex.get(shortCode);
  if (cached) return cached;

  const id = await db.findBoardIdByCode(shortCode);
  if (!id) throw notFound();
  codeIndex.set(shortCode, id);
  return id;
}

/** Drops the board everywhere: memory, code index and (if enabled) Mongo. */
export async function deleteBoard(board: ActiveBoard): Promise<void> {
  forget(board);
  // Let an in-flight save land first so it can't bring the board back.
  while (board.saving) await board.saving.catch(() => {});
  await db.deleteBoard(board.meta.id);
}

export function isNicknameTaken(board: ActiveBoard, nickname: string, userId: UserId): boolean {
  const wanted = nickname.toLowerCase();
  return [...board.participants.values()].some(
    (p) => p.userId !== userId && p.nickname.toLowerCase() === wanted,
  );
}

export function participantList(board: ActiveBoard): Participant[] {
  return [...board.participants.values()];
}

/** Writes the board now. Throws if the write fails. */
async function save(board: ActiveBoard): Promise<void> {
  clearTimeout(board.saveTimer);
  board.saveTimer = undefined;
  while (board.saving) await board.saving.catch(() => {});
  // A deleted (or evicted) board object must never be written back.
  if (!board.dirty || active.get(board.meta.id) !== board || !db.persistenceEnabled()) return;
  // Cleared before the write: a change made while it is in flight re-dirties it.
  board.dirty = false;
  board.saving = db.saveBoard(toDoc(board));
  try {
    await board.saving;
  } catch (err) {
    board.dirty = true;
    throw err;
  } finally {
    board.saving = undefined;
  }
}

/** Background save: never throws, retries on the next tick when Mongo fails. */
export async function flush(board: ActiveBoard): Promise<void> {
  try {
    await save(board);
  } catch (err) {
    console.error(`Saving board ${board.meta.id} failed, retrying`, err);
    board.saveTimer ??= setTimeout(() => void flush(board), config.retryDelayMs);
  }
}

/** Evicts boards nobody is on that have been idle too long. */
async function sweep(): Promise<void> {
  const now = Date.now();
  for (const board of active.values()) {
    const idle = now - board.lastActivityAt;
    if (idle < config.idleFlushMs || board.participants.size > 0) continue;
    await flush(board);
    // Keep it in memory until its changes are safely stored.
    if (!board.dirty) forget(board);
  }
}

export function startSweeper(): NodeJS.Timeout {
  return setInterval(() => void sweep(), config.sweepMs).unref();
}

/** Ordered shutdown: persist everything still dirty. */
export async function flushAll(): Promise<void> {
  await Promise.all([...active.values()].map(flush));
}
