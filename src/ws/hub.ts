/**
 * Registry of live sockets per board. Kept separate from the socket handler so
 * REST routes can push messages (e.g. a permissions change) without a cycle.
 *
 * One user may have several sockets on a board — two tabs, a laptop and a
 * phone — and every one of them gets the board's traffic. Only a socket from
 * the same tab (`tab`, sent in `join`) replaces an older one: that is the tab
 * reconnecting, and the old socket is a leftover.
 *
 * Broadcasts are serialized once and sent in batches: the realtime path's
 * largest cost is the `writev` per frame and per recipient (46 % of the main
 * thread under load, against ~7 % for building the frames), so each socket
 * gets one write per event-loop turn, whatever its frames that turn add up to.
 * The busier the server, the longer a turn and the bigger the batch; idle, a
 * frame waits for nothing. A fixed 25 ms window measured +25 ms on every
 * broadcast's p50 in all five environments (`config.broadcastFlushMs`).
 */
import { config } from '../config.js';
import type { ServerMessage } from '../model/protocol.js';
import type { UserId } from '../model/types.js';

export interface Client {
  userId: UserId;
  /** The sender's tab (page load); empty for clients that don't send one. */
  tab: string;
  /** Sends now, after whatever is queued, so a client sees messages in order. */
  send(msg: ServerMessage): void;
  /** Queues an already serialized frame for the next `flush`. */
  enqueue(text: string): void;
  /** Writes the queued frames in one go. */
  flush(): void;
  close(code: number, reason: string): void;
}

const rooms = new Map<string, Set<Client>>();
const dirty = new Set<Client>();
let flushTimer: NodeJS.Timeout | NodeJS.Immediate | null = null;

function flushDirty(): void {
  flushTimer = null;
  for (const client of dirty) client.flush();
  dirty.clear();
}

/** Adds a client, returning the one it replaced from the same tab, if any. */
export function join(boardId: string, client: Client): Client | undefined {
  let room = rooms.get(boardId);
  if (!room) rooms.set(boardId, (room = new Set()));
  const previous = [...room].find((c) => c.userId === client.userId && c.tab === client.tab);
  if (previous) room.delete(previous);
  room.add(client);
  return previous;
}

export function leave(boardId: string, client: Client): void {
  dirty.delete(client);
  const room = rooms.get(boardId);
  if (!room?.delete(client)) return; // already replaced by a newer socket
  if (room.size === 0) rooms.delete(boardId);
}

// Rooms are per process, and a board's sockets all land on the worker that owns
// it (workers.ts), so this never has to cross processes on one machine.
// ponytail: across machines, route the same way at the load balancer.
export function broadcast(boardId: string, msg: ServerMessage, exceptUserId?: UserId): void {
  const room = rooms.get(boardId);
  if (!room) return;
  let text: string | undefined;
  for (const client of room) {
    if (client.userId === exceptUserId) continue;
    client.enqueue((text ??= JSON.stringify(msg)));
    dirty.add(client);
  }
  if (dirty.size > 0) {
    flushTimer ??= config.broadcastFlushMs > 0 ? setTimeout(flushDirty, config.broadcastFlushMs) : setImmediate(flushDirty);
  }
}

export function clientsOf(boardId: string): Client[] {
  return [...(rooms.get(boardId) ?? [])];
}
