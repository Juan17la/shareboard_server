/**
 * Accounts: register, sign in, and "My whiteboards".
 *
 * An account is what sharing a board needs. It gives its owner an id nobody
 * else can claim (`usr_…`, checked against the session token), so a board's
 * creator is never asked for its PIN, and every board the account has got into
 * follows it to any device without the PIN being asked again.
 */
import { randomInt } from 'node:crypto';

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { AppError, forbidden } from '../errors.js';
import { sendMail } from '../mail.js';
import {
  field,
  validateCode,
  validateEmail,
  validateLogin,
  validateNewPassword,
  validateRegister,
} from '../model/validate.js';
import { hashPassword, needsRehash, verifyPassword } from '../pin.js';
import { allow } from '../rate-limit.js';
import * as boards from '../store/boards.js';
import type { CodePurpose } from '../store/mongo.js';
import * as users from '../store/users.js';
import { codeHash, issueSessionToken, sameHash } from '../tokens.js';
import { accountOf, isAccountId } from './auth.js';

/** Compared against when the account does not exist, so both failures take as long. */
const NO_USER_HASH = hashPassword('no-such-user');

const publicAccount = (u: users.User) => ({
  id: u._id,
  username: u.username,
  nickname: u.nickname,
  ...(u.avatar ? { avatar: u.avatar } : {}),
  email: u.email ?? null,
  emailVerified: u.emailVerified === true,
  /** Whether sharing waits for `emailVerified` (REQUIRE_EMAIL_VERIFICATION): the apps show the code step only then. */
  verificationRequired: config.requireEmailVerification,
});

const signedIn = (u: users.User) => ({
  token: issueSessionToken(u._id, u.tokenVersion ?? 0),
  account: publicAccount(u),
});

/** A guest id the device has been using: its boards become the account's. */
async function adoptGuestBoards(deviceId: string | undefined, accountId: string): Promise<void> {
  // ponytail: a guest id proves nothing (it never did — anyone could join as a
  // board's creator by sending its id), so this trusts the device as before.
  if (deviceId && !isAccountId(deviceId)) await boards.transferBoards(deviceId, accountId);
}

const rateLimited = (message: string) => new AppError('RATE_LIMITED', message);
const badCode = () => new AppError('CODE_INVALID', 'That code is wrong or has expired, ask for a new one');

/** One email a minute per purpose and `mailsPerHour` an hour per account; false once over. */
const mayEmail = (userId: string, purpose: CodePurpose) =>
  allow(`mail-min:${purpose}:${userId}`, 1, 60_000) && allow(`mail:${userId}`, config.mailsPerHour, 3_600_000);

const MAIL = {
  verify: {
    subject: 'Shareboard: verifica tu correo / verify your email',
    body: (code: string) =>
      `Tu código de verificación es ${code}. Caduca en 15 minutos.\n` +
      `Your verification code is ${code}. It expires in 15 minutes.`,
  },
  reset: {
    subject: 'Shareboard: restablece tu contraseña / reset your password',
    body: (code: string) =>
      `Tu código para restablecer la contraseña es ${code}. Caduca en 15 minutos.\n` +
      `Your password reset code is ${code}. It expires in 15 minutes.\n\n` +
      'Si no lo pediste, ignora este correo: tu contraseña no cambia.\n' +
      "If you didn't ask for it, ignore this email: your password stays the same.",
  },
} satisfies Record<CodePurpose, { subject: string; body: (code: string) => string }>;

const IGNORE_IF_YOU =
  'Si no fuiste tú, restablece tu contraseña ya. / If this was not you, reset your password now.';

/**
 * Emails a fresh 6-digit code for `purpose` to the account's address, replacing
 * any earlier one. False (and nothing sent) when the account is over its limit.
 */
async function sendCode(user: users.User, purpose: CodePurpose, log: FastifyBaseLogger): Promise<boolean> {
  if (!user.email || !mayEmail(user._id, purpose)) return false;
  const code = String(randomInt(1_000_000)).padStart(6, '0');
  await users.updateUser(user, {
    codes: {
      ...user.codes,
      [purpose]: {
        hash: codeHash(purpose, user._id, code),
        exp: Date.now() + config.codeTtlMs,
        tries: 0,
        ...(purpose === 'verify' ? { email: user.email } : {}),
      },
    },
  });
  sendMail({ to: user.email, subject: MAIL[purpose].subject, text: MAIL[purpose].body(code) }, log);
  return true;
}

/**
 * Checks and spends an emailed code. A wrong guess counts against it; after
 * `codeAttempts` it is dead and a new one has to be asked for.
 */
async function useCode(user: users.User, purpose: CodePurpose, code: string): Promise<void> {
  const stored = user.codes?.[purpose];
  const valid =
    stored &&
    stored.exp > Date.now() &&
    stored.tries < config.codeAttempts &&
    (purpose !== 'verify' || stored.email === user.email);
  if (!valid) throw badCode();
  if (!sameHash(stored.hash, codeHash(purpose, user._id, code))) {
    await users.updateUser(user, { codes: { ...user.codes, [purpose]: { ...stored, tries: stored.tries + 1 } } });
    throw badCode();
  }
  const { [purpose]: _spent, ...rest } = user.codes ?? {};
  await users.updateUser(user, { codes: Object.keys(rest).length ? rest : undefined });
}

/** The signed-in account's stored record, and its password checked (for changing email or password). */
async function reauthenticate(userId: string, password: unknown): Promise<users.User> {
  if (!allow(`login:${userId}`, config.loginAttemptsPerMinute, 60_000)) {
    throw rateLimited('Too many attempts, try again shortly');
  }
  const user = await users.findById(userId);
  if (!user) throw new AppError('AUTH_REQUIRED', 'This account no longer exists');
  if (!(await verifyPassword(field({ password }, 'password', 128), user.passwordHash))) {
    throw new AppError('LOGIN_INVALID', 'Wrong password');
  }
  return user;
}

/** Sets a new password and ends every session issued before it. */
async function setPassword(user: users.User, password: string, extra: Partial<users.User> = {}): Promise<void> {
  await users.updateUser(user, {
    ...extra,
    passwordHash: await hashPassword(password),
    tokenVersion: (user.tokenVersion ?? 0) + 1,
  });
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // Tokens and personal data: never kept by a browser or proxy cache.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/auth/register', async (req, reply) => {
    if (!allow(`register:${req.ip}`, config.registerPerHour, 3_600_000)) {
      throw rateLimited('Too many accounts created from this address');
    }
    const body = validateRegister(req.body);
    const user: users.User = {
      _id: users.newAccountId(),
      username: body.username,
      email: body.email,
      emailVerified: false,
      passwordHash: await hashPassword(body.password),
      nickname: body.nickname,
      ...(body.avatar ? { avatar: body.avatar } : {}),
      createdAt: Date.now(),
    };
    const taken = await users.createUser(user);
    if (taken === 'username') throw new AppError('USERNAME_TAKEN', 'That username is taken');
    if (taken === 'email') throw new AppError('EMAIL_TAKEN', 'That email already has an account');
    if (config.requireEmailVerification) await sendCode(user, 'verify', req.log);
    await adoptGuestBoards(body.deviceId, user._id);
    return reply.code(201).send(signedIn(user));
  });

  app.post('/auth/login', async (req) => {
    const body = validateLogin(req.body);
    if (!allow(`login:${req.ip}`, config.loginAttemptsPerMinute, 60_000)) {
      throw rateLimited('Too many sign-in attempts, try again shortly');
    }
    const user = await users.findByLogin(body.login);
    // Per account, whichever of its username or email was typed.
    if (!allow(`login:${user?._id ?? body.login}`, config.loginAttemptsPerMinute, 60_000)) {
      throw rateLimited('Too many sign-in attempts, try again shortly');
    }
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await NO_USER_HASH));
    if (!user || !ok) throw new AppError('LOGIN_INVALID', 'Wrong username, email or password');
    if (needsRehash(user.passwordHash)) {
      await users.updateUser(user, { passwordHash: await hashPassword(body.password) });
    }
    await adoptGuestBoards(body.deviceId, user._id);
    return signedIn(user);
  });

  /** Emails a reset code. Always 202, so it cannot tell anyone which emails have accounts. */
  app.post('/auth/password/forgot', async (req, reply) => {
    const email = validateEmail((req.body as { email?: unknown } | null)?.email);
    if (!allow(`forgot:${req.ip}`, config.loginAttemptsPerMinute, 60_000)) {
      throw rateLimited('Too many requests, try again shortly');
    }
    const user = await users.findByEmail(email);
    if (user) await sendCode(user, 'reset', req.log);
    return reply.code(202).send();
  });

  /** The code from that email and a new password: signs in, and every other session ends. */
  app.post('/auth/password/reset', async (req) => {
    const email = validateEmail(field(req.body, 'email', 254));
    const code = validateCode(field(req.body, 'code', 12));
    if (!allow(`reset:${req.ip}`, config.loginAttemptsPerMinute, 60_000)) {
      throw rateLimited('Too many attempts, try again shortly');
    }
    const user = await users.findByEmail(email);
    if (!user) throw badCode();
    const password = validateNewPassword(field(req.body, 'password', 128), [user.username, email]);
    await useCode(user, 'reset', code);
    // The code reached this address, which proves it is theirs.
    await setPassword(user, password, { emailVerified: true });
    sendMail({ to: email, subject: 'Shareboard: contraseña cambiada / password changed', text: IGNORE_IF_YOU }, req.log);
    return signedIn(user);
  });

  app.get('/me', async (req) => {
    const user = await users.findById(await accountOf(req));
    if (!user) throw new AppError('AUTH_REQUIRED', 'This account no longer exists');
    return publicAccount(user);
  });

  /**
   * Adds or changes the account's email (accounts from before emails have
   * none) and sends it a code. Asks for the password: a stolen session alone
   * must not be able to point password resets at the thief's inbox.
   */
  app.post('/me/email', async (req) => {
    const user = await reauthenticate(await accountOf(req), (req.body as { password?: unknown } | null)?.password);
    const email = validateEmail(field(req.body, 'email', 254));
    if (email === user.email && user.emailVerified) return publicAccount(user);
    const previous = user.emailVerified ? user.email : undefined;
    if (await users.updateUser(user, { email, emailVerified: false, codes: undefined })) {
      throw new AppError('EMAIL_TAKEN', 'That email already has an account');
    }
    if (config.requireEmailVerification) await sendCode(user, 'verify', req.log);
    if (previous && previous !== email) {
      sendMail({ to: previous, subject: 'Shareboard: correo cambiado / email changed', text: IGNORE_IF_YOU }, req.log);
    }
    return publicAccount(user);
  });

  /** Another verification code to the account's email. */
  app.post('/me/email/resend', async (req, reply) => {
    const user = await users.findById(await accountOf(req));
    if (!user?.email || user.emailVerified) throw new AppError('VALIDATION', 'There is no email to verify');
    if (!(await sendCode(user, 'verify', req.log))) throw rateLimited('Wait a minute before asking for another code');
    return reply.code(204).send();
  });

  app.post('/me/email/verify', async (req) => {
    const userId = await accountOf(req);
    const code = validateCode(field(req.body, 'code', 12));
    if (!allow(`verify:${userId}`, config.loginAttemptsPerMinute, 60_000)) {
      throw rateLimited('Too many attempts, try again shortly');
    }
    const user = await users.findById(userId);
    if (!user?.email) throw badCode();
    await useCode(user, 'verify', code);
    await users.updateUser(user, { emailVerified: true });
    return publicAccount(user);
  });

  /** Needs the current password. This device gets a new token; every other session ends. */
  app.post('/me/password', async (req) => {
    const user = await reauthenticate(await accountOf(req), (req.body as { password?: unknown } | null)?.password);
    const next = validateNewPassword(field(req.body, 'newPassword', 128), [user.username, user.email ?? '']);
    await setPassword(user, next);
    if (user.email && user.emailVerified) {
      sendMail({ to: user.email, subject: 'Shareboard: contraseña cambiada / password changed', text: IGNORE_IF_YOU }, req.log);
    }
    return signedIn(user);
  });

  /** Every board the account made or has got into, newest first. */
  app.get('/me/boards', async (req) => ({ boards: await boards.listBoardsFor(await accountOf(req)) }));

  /** Takes a board off the list; a private one asks for its PIN again next time. */
  app.delete<{ Params: { id: string } }>('/me/boards/:id', async (req, reply) => {
    const userId = await accountOf(req);
    const board = await boards.getBoard(req.params.id);
    if (board.meta.creatorId === userId) throw forbidden('You made this board: delete it instead');
    boards.removeMember(board, userId);
    return reply.code(204).send();
  });
}
