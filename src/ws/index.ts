/**
 * Realtime board sync. One socket per (board, client); the protocol is plain
 * JSON frames over a standard WebSocket — see docs/07-websockets.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import { AppError } from '../errors.js';
import { applyOps, isOverElementLimit, visibleElements } from '../model/ops.js';
import { CloseCode, REALTIME, type ClientMessage, type ServerMessage } from '../model/protocol.js';
import { canEdit, roleFor } from '../model/rules.js';
import { LIMITS, PRESENCE_COLORS, type Participant } from '../model/types.js';
import { validateNickname, validateOps } from '../model/validate.js';
import { allow } from '../rate-limit.js';
import * as store from '../store/boards.js';
import { verifyBoardToken } from '../tokens.js';
import * as hub from './hub.js';

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { boardId?: string; token?: string } }>(
    '/ws',
    { websocket: true },
    (socket: WebSocket, req) => {
      const { boardId, token } = req.query;
      const auth = verifyBoardToken(token);
      if (!boardId || !auth || auth.boardId !== boardId) {
        socket.close(CloseCode.BAD_REQUEST, 'Invalid board token');
        return;
      }

      const send = (msg: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      const client: hub.Client = {
        userId: auth.userId,
        send,
        close: (code, reason) => socket.close(code, reason),
      };

      let joined = false;
      let lastSeenAt = Date.now();

      // The server drops sockets that stop sending traffic (client pings every 20 s).
      const idleCheck = setInterval(() => {
        if (Date.now() - lastSeenAt > REALTIME.idleTimeoutMs) socket.terminate();
      }, REALTIME.idleTimeoutMs / 2);

      async function onJoin(msg: Extract<ClientMessage, { type: 'join' }>) {
        const board = await store.getBoard(boardId!);
        const nickname = validateNickname(msg.nickname);
        if (store.isNicknameTaken(board, nickname, auth!.userId)) {
          throw new AppError('NICKNAME_TAKEN', 'That nickname is in use here');
        }

        // A second socket for the same user replaces the first one.
        hub.join(board.meta.id, client)?.close(CloseCode.REPLACED, 'Replaced by a newer session');

        const existing = board.participants.get(auth!.userId);
        const you: Participant = {
          userId: auth!.userId,
          nickname,
          color:
            existing?.color ?? PRESENCE_COLORS[board.participants.size % PRESENCE_COLORS.length]!,
          ...(existing?.avatar ? { avatar: existing.avatar } : {}),
          role: roleFor(board.meta, auth!.userId),
          lastSeen: Date.now(),
        };
        board.participants.set(you.userId, you);
        joined = true;

        send({
          type: 'joined',
          meta: board.meta,
          elements: visibleElements(board.elements),
          participants: store.participantList(board),
          you,
          seq: board.seq,
        });
        hub.broadcast(board.meta.id, {
          type: 'participants',
          participants: store.participantList(board),
        });
      }

      async function onOp(msg: Extract<ClientMessage, { type: 'op' }>) {
        const board = await store.getBoard(boardId!);
        if (!canEdit(board.meta, auth!.userId)) {
          throw new AppError('FORBIDDEN', 'You do not have edit permission on this board');
        }
        if (!allow(`ops:${auth!.userId}:${boardId}`, REALTIME.maxOpsPerSecond, 1000)) {
          throw new AppError('RATE_LIMITED', 'Slow down');
        }

        let ops = validateOps(msg.ops);
        // Elements someone else holds (has selected) are theirs until let go:
        // an edit to one is dropped, and the sender gets its current state
        // back so its optimistic copy snaps back — no error, the board goes on.
        const held = heldByOthers(board);
        const refused = new Set(
          ops.flatMap((op) => ((op.t === 'update' || op.t === 'delete') && held.has(op.id) ? [op.id] : [])),
        );
        if (refused.size) {
          ops = ops.filter((op) => !((op.t === 'update' || op.t === 'delete') && refused.has(op.id)));
          const current = [...refused].flatMap((id) => {
            const el = board.elements.get(id);
            return el ? [{ t: 'add' as const, el }] : [];
          });
          send({ type: 'op', ops: current, from: 'server', seq: board.seq });
          if (!ops.length) return;
        }
        const added = ops.filter((op) => op.t === 'add').length;
        if (isOverElementLimit(board.elements, added)) {
          throw new AppError('VALIDATION', 'This board has reached its element limit');
        }

        board.topZ = applyOps(board.elements, ops, board.topZ);
        board.seq += 1;
        store.touch(board);
        // Echoed to the sender too, so it can confirm against the board seq.
        hub.broadcast(board.meta.id, { type: 'op', ops, from: auth!.userId, seq: board.seq });
      }

      /** Ids selected by anyone but this socket's user. */
      function heldByOthers(board: store.ActiveBoard): Set<string> {
        const held = new Set<string>();
        for (const p of board.participants.values()) {
          if (p.userId !== auth!.userId) for (const id of p.selection ?? []) held.add(id);
        }
        return held;
      }

      async function onSelect(msg: Extract<ClientMessage, { type: 'select' }>) {
        const board = await store.getBoard(boardId!);
        const you = board.participants.get(auth!.userId);
        if (!you) return;
        // First come, first served: what someone else already holds is not
        // taken; the broadcast tells the sender what it actually got.
        const held = heldByOthers(board);
        const ids = Array.isArray(msg.ids)
          ? [...new Set(msg.ids)]
              .filter((id): id is string => typeof id === 'string' && board.elements.has(id) && !held.has(id))
              .slice(0, LIMITS.maxElements)
          : [];
        // Viewers look but never hold: their selection would lock editors out.
        const next = canEdit(board.meta, you.userId) ? ids : [];
        const before = you.selection ?? [];
        if (next.length === before.length && next.every((id, i) => id === before[i])) return;
        if (next.length) you.selection = next;
        else delete you.selection;
        hub.broadcast(board.meta.id, {
          type: 'participants',
          participants: store.participantList(board),
        });
      }

      async function onCursor(msg: Extract<ClientMessage, { type: 'cursor' }>) {
        const board = await store.getBoard(boardId!);
        const you = board.participants.get(auth!.userId);
        if (!you) return;
        you.cursor = msg.at;
        you.lastSeen = Date.now();
        // Cursors are never persisted and never echoed back to the sender.
        hub.broadcast(board.meta.id, { type: 'cursor', from: you.userId, at: msg.at }, you.userId);
      }

      socket.on('message', (raw) => {
        lastSeenAt = Date.now();
        if (raw.toString().length > REALTIME.maxMessageBytes) {
          socket.close(CloseCode.BAD_REQUEST, 'Message too large');
          return;
        }

        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          send({ type: 'error', code: 'VALIDATION', message: 'Malformed JSON' });
          return;
        }

        if (msg.type === 'ping') {
          send({ type: 'pong', t: msg.t });
          return;
        }
        if (msg.type === 'leave') {
          socket.close(1000, 'Left the board');
          return;
        }
        if (!joined && msg.type !== 'join') {
          send({ type: 'error', code: 'FORBIDDEN', message: 'Send "join" first' });
          return;
        }

        const handlers = { join: onJoin, op: onOp, cursor: onCursor, select: onSelect } as const;
        const run = handlers[msg.type as keyof typeof handlers] as
          | ((m: ClientMessage) => Promise<void>)
          | undefined;
        // A message type this server does not know (a newer client) is ignored.
        if (!run) return;
        const handler = run(msg);

        handler.catch((err: unknown) => {
          if (err instanceof AppError) {
            send({ type: 'error', code: err.code, message: err.message });
            if (err.code === 'BOARD_NOT_FOUND') socket.close(CloseCode.NOT_FOUND, err.message);
            return;
          }
          app.log.error(err);
          send({ type: 'error', code: 'INTERNAL', message: 'Unexpected server error' });
        });
      });

      socket.on('close', () => {
        clearInterval(idleCheck);
        if (!joined) return;
        hub.leave(boardId!, client);

        void store
          .getBoard(boardId!)
          .then((board) => {
            // Only drop presence if no newer socket took this user's slot.
            if (hub.clientsOf(board.meta.id).some((c) => c.userId === auth!.userId)) return;
            board.participants.delete(auth!.userId);
            hub.broadcast(board.meta.id, {
              type: 'participants',
              participants: store.participantList(board),
            });
          })
          // The board may have been deleted while the socket was open.
          .catch(() => {});
      });
    },
  );
}
