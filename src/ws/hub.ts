/**
 * Registry of live sockets per board. Kept separate from the socket handler so
 * REST routes can push messages (e.g. a permissions change) without a cycle.
 *
 * One user may have several sockets on a board — two tabs, a laptop and a
 * phone — and every one of them gets the board's traffic. Only a socket from
 * the same tab (`tab`, sent in `join`) replaces an older one: that is the tab
 * reconnecting, and the old socket is a leftover.
 */
import type { ServerMessage } from '../model/protocol.js';
import type { UserId } from '../model/types.js';

export interface Client {
  userId: UserId;
  /** The sender's tab (page load); empty for clients that don't send one. */
  tab: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

const rooms = new Map<string, Set<Client>>();

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
  const room = rooms.get(boardId);
  if (!room?.delete(client)) return; // already replaced by a newer socket
  if (room.size === 0) rooms.delete(boardId);
}

// ponytail: rooms are per process, so one instance serves every board. To run
// several, publish here to a Redis channel per board and deliver on each
// instance's subscriber (rooms stay local; only the fan-out crosses processes).
export function broadcast(boardId: string, msg: ServerMessage, exceptUserId?: UserId): void {
  for (const client of rooms.get(boardId) ?? []) {
    if (client.userId !== exceptUserId) client.send(msg);
  }
}

export function clientsOf(boardId: string): Client[] {
  return [...(rooms.get(boardId) ?? [])];
}
