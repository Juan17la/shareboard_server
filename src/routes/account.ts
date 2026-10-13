/**
 * Accounts: register, sign in, and "My whiteboards".
 *
 * An account is what sharing a board needs. It gives its owner an id nobody
 * else can claim (`usr_…`, checked against the session token), so a board's
 * creator is never asked for its PIN, and every board the account has got into
 * follows it to any device without the PIN being asked again.
 */
import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { AppError, forbidden } from '../errors.js';
import { validateCredentials } from '../model/validate.js';
import { hashPin as hashPassword, verifyPin as verifyPassword } from '../pin.js';
import { allow } from '../rate-limit.js';
import * as boards from '../store/boards.js';
import * as users from '../store/users.js';
import { issueSessionToken } from '../tokens.js';
import { accountOf, isAccountId } from './auth.js';

/** Compared against when the username does not exist, so both failures take as long. */
const NO_USER_HASH = hashPassword('no-such-user');

const publicAccount = (u: users.User) => ({
  id: u._id,
  username: u.username,
  nickname: u.nickname,
  ...(u.avatar ? { avatar: u.avatar } : {}),
});

const signedIn = (u: users.User) => ({ token: issueSessionToken(u._id), account: publicAccount(u) });

/** A guest id the device has been using: its boards become the account's. */
async function adoptGuestBoards(deviceId: string | undefined, accountId: string): Promise<void> {
  // ponytail: a guest id proves nothing (it never did — anyone could join as a
  // board's creator by sending its id), so this trusts the device as before.
  if (deviceId && !isAccountId(deviceId)) await boards.transferBoards(deviceId, accountId);
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (req, reply) => {
    if (!allow(`register:${req.ip}`, config.registerPerHour, 3_600_000)) {
      throw new AppError('RATE_LIMITED', 'Too many accounts created from this address');
    }
    const body = validateCredentials(req.body, true);
    const user: users.User = {
      _id: users.newAccountId(),
      username: body.username,
      passwordHash: hashPassword(body.password),
      nickname: body.nickname!,
      ...(body.avatar ? { avatar: body.avatar } : {}),
      createdAt: Date.now(),
    };
    if (!(await users.createUser(user))) {
      throw new AppError('USERNAME_TAKEN', 'That username is taken');
    }
    await adoptGuestBoards(body.deviceId, user._id);
    return reply.code(201).send(signedIn(user));
  });

  app.post('/auth/login', async (req) => {
    const body = validateCredentials(req.body, false);
    if (
      !allow(`login:${req.ip}`, config.loginAttemptsPerMinute, 60_000) ||
      !allow(`login:${body.username}`, config.loginAttemptsPerMinute, 60_000)
    ) {
      throw new AppError('RATE_LIMITED', 'Too many sign-in attempts, try again shortly');
    }
    const user = await users.findByUsername(body.username);
    const ok = verifyPassword(body.password, user?.passwordHash ?? NO_USER_HASH);
    if (!user || !ok) throw new AppError('LOGIN_INVALID', 'Wrong username or password');
    await adoptGuestBoards(body.deviceId, user._id);
    return signedIn(user);
  });

  app.get('/me', async (req) => {
    const user = await users.findById(accountOf(req));
    if (!user) throw new AppError('AUTH_REQUIRED', 'This account no longer exists');
    return publicAccount(user);
  });

  /** Every board the account made or has got into, newest first. */
  app.get('/me/boards', async (req) => ({ boards: await boards.listBoardsFor(accountOf(req)) }));

  /** Takes a board off the list; a private one asks for its PIN again next time. */
  app.delete<{ Params: { id: string } }>('/me/boards/:id', async (req, reply) => {
    const userId = accountOf(req);
    const board = await boards.getBoard(req.params.id);
    if (board.meta.creatorId === userId) throw forbidden('You made this board: delete it instead');
    boards.removeMember(board, userId);
    return reply.code(204).send();
  });
}
