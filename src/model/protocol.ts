/** WebSocket wire protocol — mirrors mobile/docs/07-websockets. */
import type { BoardElement, BoardMeta, Op, Participant, Point, UserId } from './types.js';

export type ClientMessage =
  /** `tab`: which tab (page load) of this user it is, so two tabs keep a socket each; optional. */
  | { type: 'join'; boardId: string; userId: UserId; nickname: string; pin?: string; tab?: string }
  /** `seq` is the sender's own counter, echoed back for debugging. */
  | { type: 'op'; boardId: string; ops: Op[]; seq: number }
  /** `laser`: the sender is pointing with the laser; the others draw a fading trail behind the cursor. */
  | { type: 'cursor'; boardId: string; at: Point; laser?: boolean }
  /** An emoji that floats up on everyone's screen, with the sender's name. Relayed, never stored. */
  | { type: 'react'; boardId: string; emoji: Reaction }
  /** Starts a countdown for everyone (`ms` long), or stops it (`null`). */
  | { type: 'timer'; boardId: string; ms: number | null }
  /** What this client now has selected: it holds those elements (`Participant.selection`). */
  | { type: 'select'; boardId: string; ids: string[] }
  /** What this client is drawing or dragging now; `null` when it is done. Relayed, never stored. */
  | { type: 'preview'; boardId: string; preview: Preview | null }
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
      /** A countdown running on this board: how long it still has to go. */
      timerLeft?: number;
    }
  /**
   * `seq` is the board-wide monotonic counter; clients apply in order. `from`
   * is `'server'` for a correction: the current state of elements whose edit
   * was refused because someone else holds them.
   */
  /** `tab`: the sending tab, so a tab tells its own echo from the same user's other tabs. */
  | { type: 'op'; ops: Op[]; from: UserId; tab?: string; seq: number }
  | { type: 'participants'; participants: Participant[] }
  | { type: 'cursor'; from: UserId; at: Point; laser?: boolean }
  | { type: 'react'; from: UserId; emoji: Reaction }
  /** `left`: how long the countdown still runs, in ms, as of now (no clock is shared); `null`: stopped. */
  | { type: 'timer'; from: UserId; left: number | null }
  | { type: 'preview'; from: UserId; preview: Preview | null }
  | { type: 'permissions'; meta: BoardMeta; you: Participant }
  /**
   * The board as it stands, sent after a batch of ops was rejected: the sender
   * applied it optimistically and would otherwise keep showing what the
   * server never accepted.
   */
  | { type: 'resync'; elements: BoardElement[]; seq: number }
  | { type: 'error'; code: ServerErrorCode; message: string }
  | { type: 'pong'; t: number };

/**
 * What someone is drawing or dragging right now, shown to the others and never
 * stored: `el` is a stroke or figure not on the board yet; `edit` is a drag of
 * elements that are (the clients' `LiveEdit`, replayed there with `editPatches`).
 */
export interface Preview {
  el?: BoardElement;
  edit?: {
    ids: string[];
    mode: 'move' | 'resize';
    handle: number;
    start: Point;
    dx: number;
    dy: number;
    patch: Partial<BoardElement> | null;
    patches?: Record<string, Partial<BoardElement>>;
  };
}

/** The emoji a reaction may carry. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '👏'] as const;
export type Reaction = (typeof REACTIONS)[number];

export type ServerErrorCode =
  | 'BOARD_NOT_FOUND'
  | 'PIN_REQUIRED'
  | 'PIN_INVALID'
  /** The call needs an account (sharing a board), or the session token is missing, bad or expired. */
  | 'AUTH_REQUIRED'
  /** Wrong username or password. */
  | 'LOGIN_INVALID'
  | 'USERNAME_TAKEN'
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
  /** A preview over this is dropped: the peers see the result on the lift, as before. */
  maxPreviewBytes: 64 * 1024,
  /** Clients send ~30 a second; past this the extra ones are dropped. */
  maxPreviewsPerSecond: 40,
  maxReactionsPerSecond: 5,
  /** The longest countdown: three hours, a long college class. */
  maxTimerMs: 3 * 60 * 60 * 1000,
} as const;
