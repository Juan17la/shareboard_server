/**
 * Active boards live in memory; MongoDB is only touched when a board goes cold
 * or on the periodic safety flush (docs/06-loading-exporting).
 */
import { nanoid } from 'nanoid';

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
}

const active = new Map<string, ActiveBoard>();
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

/** Marks the board changed so the next flush persists it. */
export function touch(board: ActiveBoard): void {
  board.lastActivityAt = Date.now();
  board.dirty = true;
  board.meta.updatedAt = board.lastActivityAt;
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
      id: `brd_${nanoid(12)}`,
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

  remember(board);
  await flush(board);
  return board;
}

/** Hot from memory, otherwise cold from Mongo. Throws BOARD_NOT_FOUND. */
export async function getBoard(id: string): Promise<ActiveBoard> {
  const hot = active.get(id);
  if (hot) return hot;

  const doc = await db.findBoard(id);
  if (!doc) throw notFound();
  return remember(fromDoc(doc));
}

export async function resolveShortCode(shortCode: string): Promise<string> {
  const cached = codeIndex.get(shortCode);
  if (cached) return cached;

  const id = await db.findBoardIdByCode(shortCode);
  if (!id) throw notFound();
  codeIndex.set(shortCode, id);
  return id;
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

export async function flush(board: ActiveBoard): Promise<void> {
  if (!board.dirty || !db.persistenceEnabled()) return;
  await db.saveBoard(toDoc(board));
  board.dirty = false;
}

/** Persists dirty boards and evicts the ones that have been idle too long. */
async function sweep(): Promise<void> {
  const now = Date.now();
  for (const board of active.values()) {
    const idle = now - board.lastActivityAt;
    if (idle < config.idleFlushMs) {
      await flush(board);
      continue;
    }
    if (board.participants.size > 0) continue;
    await flush(board);
    active.delete(board.meta.id);
    codeIndex.delete(board.meta.shortCode);
  }
}

export function startSweeper(): NodeJS.Timeout {
  return setInterval(() => void sweep(), config.safetyFlushMs).unref();
}

/** Ordered shutdown: persist everything still dirty. */
export async function flushAll(): Promise<void> {
  await Promise.all([...active.values()].map(flush));
}
