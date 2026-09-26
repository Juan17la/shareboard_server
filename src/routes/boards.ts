/**
 * REST surface. Everything that is not realtime lives here; see
 * docs/02-backend-connection for the canonical endpoint list.
 */
import type { FastifyInstance } from 'fastify';

import { draw } from '../ai.js';
import { config } from '../config.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { applyOps, isOverElementLimit, visibleElements } from '../model/ops.js';
import { CloseCode } from '../model/protocol.js';
import { canEdit, roleFor } from '../model/rules.js';
import { isValidShortCode, normalizeShortCode } from '../model/short-code.js';
import type { BoardSnapshot, Op, Participant, Point } from '../model/types.js';
import {
  validateCreateBoard,
  validateJoin,
  validatePermissions,
  validateSnapshot,
} from '../model/validate.js';
import { hashPin, verifyPin } from '../pin.js';
import { allow } from '../rate-limit.js';
import * as store from '../store/boards.js';
import { issueBoardToken } from '../tokens.js';
import * as hub from '../ws/hub.js';
import { PRESENCE_COLORS } from '../model/types.js';
import { tokenFor, userIdOf } from './auth.js';

/** Only the creator may rename or change permissions. */
function assertCreator(board: store.ActiveBoard, userId: string): void {
  if (board.meta.creatorId !== userId) throw forbidden('Only the board creator can do that');
}

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  app.post('/boards', async (req, reply) => {
    if (!allow(`create:${req.ip}`, config.createBoardPerHour, 3_600_000)) {
      throw new AppError('RATE_LIMITED', 'Too many boards created from this address');
    }
    const body = validateCreateBoard(req.body);
    const board = await store.createBoard({
      name: body.name,
      access: body.access,
      editPolicy: body.editPolicy,
      creatorId: body.creatorId,
      pinHash: body.pin ? hashPin(body.pin) : null,
    });
    return reply.code(201).send(board.meta);
  });

  app.get<{ Params: { id: string } }>('/boards/:id', async (req) => {
    const board = await store.getBoard(req.params.id);
    return board.meta;
  });

  app.get<{ Params: { code: string } }>('/boards/code/:code', async (req) => {
    const code = normalizeShortCode(req.params.code);
    if (!isValidShortCode(code)) throw notFound();
    return { boardId: await store.resolveShortCode(code) };
  });

  /** Join: validates the PIN, assigns a role and issues the WebSocket token. */
  app.post<{ Params: { id: string } }>('/boards/:id/join', async (req) => {
    const board = await store.getBoard(req.params.id);
    const body = validateJoin(req.body);

    if (board.pinHash) {
      if (!allow(`pin:${req.ip}:${board.meta.id}`, config.pinAttemptsPerMinute, 60_000)) {
        throw new AppError('RATE_LIMITED', 'Too many PIN attempts, try again shortly');
      }
      if (!body.pin) throw new AppError('PIN_REQUIRED', 'This board requires a PIN');
      if (!verifyPin(body.pin, board.pinHash)) throw new AppError('PIN_INVALID', 'Incorrect PIN');
    }
    if (store.isNicknameTaken(board, body.nickname, body.userId)) {
      throw new AppError('NICKNAME_TAKEN', 'That nickname is in use here');
    }

    // Presence colour: the client may ask for one (the mobile app lets people
    // pick their own on the nickname screen), and it is honoured unless someone
    // already on the board has it — two identical cursors are worse than not
    // getting your favourite colour. Otherwise the server assigns in join order.
    const existing = board.participants.get(body.userId);
    const taken = new Set(
      [...board.participants.values()].filter((p) => p.userId !== body.userId).map((p) => p.color),
    );
    const requested = body.color && !taken.has(body.color) ? body.color : null;
    const you: Participant = {
      userId: body.userId,
      nickname: body.nickname,
      color:
        requested ??
        existing?.color ??
        PRESENCE_COLORS[board.participants.size % PRESENCE_COLORS.length]!,
      ...(body.avatar ? { avatar: body.avatar } : {}),
      role: roleFor(board.meta, body.userId),
      lastSeen: Date.now(),
    };
    board.participants.set(you.userId, you);

    return {
      boardToken: issueBoardToken(board.meta.id, you.userId, you.role),
      meta: board.meta,
      you,
    };
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>('/boards/:id', async (req) => {
    const board = await store.getBoard(req.params.id);
    assertCreator(board, tokenFor(req, board.meta.id).userId);

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name) board.meta.name = name.slice(0, 80);
    store.touch(board);
    return board.meta;
  });

  /**
   * Delete. Creator only. Everyone still on the board is told why their socket
   * is about to close, then closed with NOT_FOUND so no client reconnects.
   */
  app.delete<{ Params: { id: string } }>('/boards/:id', async (req, reply) => {
    const board = await store.getBoard(req.params.id);
    assertCreator(board, tokenFor(req, board.meta.id).userId);
    for (const client of hub.clientsOf(board.meta.id)) {
      client.send({ type: 'error', code: 'BOARD_NOT_FOUND', message: 'This board was deleted' });
      client.close(CloseCode.NOT_FOUND, 'Board deleted');
    }
    await store.deleteBoard(board);
    return reply.code(204).send();
  });

  /** Permission changes recompute every role and are pushed over the socket. */
  app.patch<{ Params: { id: string } }>('/boards/:id/permissions', async (req) => {
    const board = await store.getBoard(req.params.id);
    assertCreator(board, tokenFor(req, board.meta.id).userId);
    const patch = validatePermissions(req.body);

    if (patch.pin !== undefined) board.pinHash = patch.pin === null ? null : hashPin(patch.pin);
    board.meta = {
      ...board.meta,
      access: patch.access ?? board.meta.access,
      editPolicy: patch.editPolicy ?? board.meta.editPolicy,
      editors: patch.editors ?? board.meta.editors,
      hasPin: board.pinHash !== null,
    };
    store.touch(board);

    for (const [userId, p] of board.participants) {
      board.participants.set(userId, { ...p, role: roleFor(board.meta, userId) });
    }
    for (const client of hub.clientsOf(board.meta.id)) {
      const you = board.participants.get(client.userId);
      if (you) client.send({ type: 'permissions', meta: board.meta, you });
    }
    return board.meta;
  });

  /** Server-side export; also used for backups. Members only. */
  app.get<{ Params: { id: string } }>('/boards/:id/snapshot', async (req) => {
    const board = await store.getBoard(req.params.id);
    tokenFor(req, board.meta.id);

    const snapshot: BoardSnapshot = {
      format: 'live-whiteboard',
      version: 1,
      meta: { name: board.meta.name },
      elements: visibleElements(board.elements),
      exportedAt: Date.now(),
    };
    return snapshot;
  });

  /**
   * "Draw with AI". The drawing lands centred on `at` (the caller's viewport
   * centre) and reaches every client as ordinary ops, sent `from: 'ai'` so the
   * caller applies them too instead of taking them for its own echo.
   */
  app.post<{ Params: { id: string }; Body: { prompt?: unknown; at?: Point } }>(
    '/boards/:id/ai',
    async (req) => {
      const board = await store.getBoard(req.params.id);
      const { userId } = tokenFor(req, board.meta.id);
      if (!canEdit(board.meta, userId)) throw forbidden('You do not have edit permission on this board');
      if (!allow(`ai:${userId}`, config.aiPerMinute, 60_000)) {
        throw new AppError('RATE_LIMITED', 'Too many AI requests, wait a minute');
      }

      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0, 1000) : '';
      if (!prompt) throw new AppError('VALIDATION', 'Say what to draw');
      const at = req.body?.at;
      const center =
        typeof at?.x === 'number' && typeof at.y === 'number' && Number.isFinite(at.x + at.y)
          ? at
          : { x: 0, y: 0 };

      const { reply, elements } = await draw(prompt, userId, center);
      if (elements.length > 0) {
        if (isOverElementLimit(board.elements, elements.length)) {
          throw new AppError('VALIDATION', 'This board has reached its element limit');
        }
        const ops: Op[] = elements.map((el) => ({ t: 'add', el }));
        board.topZ = applyOps(board.elements, ops, board.topZ);
        board.seq += 1;
        store.touch(board);
        hub.broadcast(board.meta.id, { type: 'op', ops, from: 'ai', seq: board.seq });
      }
      return { reply, added: elements.length };
    },
  );

  /** Import always creates a new board; a shared one is never overwritten. */
  app.post<{ Body: { snapshot?: unknown; creatorId?: unknown } }>(
    '/boards/import',
    async (req, reply) => {
      if (!allow(`create:${req.ip}`, config.createBoardPerHour, 3_600_000)) {
        throw new AppError('RATE_LIMITED', 'Too many boards created from this address');
      }
      const snapshot = validateSnapshot(req.body?.snapshot);
      const board = await store.createBoard({
        name: snapshot.meta.name,
        access: 'public',
        editPolicy: 'everyone',
        creatorId: userIdOf(req),
        elements: snapshot.elements,
      });
      return reply.code(201).send(board.meta);
    },
  );
}
