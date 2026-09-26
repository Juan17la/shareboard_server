/**
 * Registry of live sockets per board. Kept separate from the socket handler so
 * REST routes can push messages (e.g. a permissions change) without a cycle.
 */
import type { ServerMessage } from '../model/protocol.js';
import type { UserId } from '../model/types.js';

export interface Client {
  userId: UserId;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

const rooms = new Map<string, Map<UserId, Client>>();

/** Adds a client, returning the one it replaced for the same user, if any. */
export function join(boardId: string, client: Client): Client | undefined {
  let room = rooms.get(boardId);
  if (!room) rooms.set(boardId, (room = new Map()));
  const previous = room.get(client.userId);
  room.set(client.userId, client);
  return previous;
}

export function leave(boardId: string, client: Client): void {
  const room = rooms.get(boardId);
  if (room?.get(client.userId) !== client) return; // already replaced by a newer socket
  room.delete(client.userId);
  if (room.size === 0) rooms.delete(boardId);
}

// ponytail: rooms are per process, so one instance serves every board. To run
// several, publish here to a Redis channel per board and deliver on each
// instance's subscriber (rooms stay local; only the fan-out crosses processes).
export function broadcast(boardId: string, msg: ServerMessage, exceptUserId?: UserId): void {
  const room = rooms.get(boardId);
  if (!room) return;
  for (const [userId, client] of room) {
    if (userId !== exceptUserId) client.send(msg);
  }
}

export function clientsOf(boardId: string): Client[] {
  return [...(rooms.get(boardId)?.values() ?? [])];
}
