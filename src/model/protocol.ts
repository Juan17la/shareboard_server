/** WebSocket wire protocol — mirrors mobile/docs/07-websockets. */
import type { BoardElement, BoardMeta, Op, Participant, Point, UserId } from './types.js';

export type ClientMessage =
  /** `tab`: which tab (page load) of this user it is, so two tabs keep a socket each; optional. */
  | { type: 'join'; boardId: string; userId: UserId; nickname: string; pin?: string; tab?: string }
  /** `seq` is the sender's own counter, echoed back for debugging. */
  | { type: 'op'; boardId: string; ops: Op[]; seq: number }
  | { type: 'cursor'; boardId: string; at: Point }
  /** What this client now has selected: it holds those elements (`Participant.selection`). */
  | { type: 'select'; boardId: string; ids: string[] }
  | { type: 'leave'; boardId: string }
  | { type: 'ping'; t: number };

export type ServerMessage =
  | {
      type: 'joined';
      meta: BoardMeta;
      elements: BoardElement[];
      participants: Participant[];
      you: Participant;
      seq: number;
    }
  /**
   * `seq` is the board-wide monotonic counter; clients apply in order. `from`
   * is `'server'` for a correction: the current state of elements whose edit
   * was refused because someone else holds them.
   */
  /** `tab`: the sending tab, so a tab tells its own echo from the same user's other tabs. */
  | { type: 'op'; ops: Op[]; from: UserId; tab?: string; seq: number }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'cursor'; from: UserId; at: Point }
  | { type: 'permissions'; meta: BoardMeta; you: Participant }
  /**
   * The board as it stands, sent after a batch of ops was rejected: the sender
   * applied it optimistically and would otherwise keep showing what the
   * server never accepted.
   */
  | { type: 'resync'; elements: BoardElement[]; seq: number }
  | { type: 'error'; code: ServerErrorCode; message: string }
  | { type: 'pong'; t: number };

export type ServerErrorCode =
  | 'BOARD_NOT_FOUND'
  | 'PIN_REQUIRED'
  | 'PIN_INVALID'
  | 'FORBIDDEN'
  | 'NICKNAME_TAKEN'
  | 'RATE_LIMITED'
  | 'VALIDATION'
  | 'INTERNAL';

export const CloseCode = {
  BAD_REQUEST: 4000,
  /** Another session took this (userId, boardId) slot. */
  REPLACED: 4001,
  FORBIDDEN: 4003,
  NOT_FOUND: 4004,
  RATE_LIMITED: 4008,
  PIN_REQUIRED: 4009,
} as const;

/** Tunables the clients also use. */
export const REALTIME = {
  /** Server drops a socket that has been silent this long. */
  idleTimeoutMs: 40_000,
  maxMessageBytes: 256 * 1024,
  maxOpsPerSecond: 60,
} as const;
