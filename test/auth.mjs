// Accounts, emails, passwords, sharing and the PIN rules, in memory (no Mongo, no network):
//   npm run check:auth
// The same against a real MongoDB (a throwaway `shareboard_check_auth` database, dropped after):
//   MONGO_URL=mongodb://127.0.0.1:27017 npm run check:auth
import assert from 'node:assert/strict';

// Verification on: these checks cover it; the end turns it off again.
process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
const mongo = Boolean(process.env.MONGO_URL);
if (mongo) process.env.MONGO_DB = 'shareboard_check_auth';
else process.env.MEMORY_ONLY = 'true';
const db = await import('../src/store/mongo.ts');
if (mongo) await db.connectMongo();
const { buildApp } = await import('../src/app.ts');
const { devOutbox } = await import('../src/mail.ts');
const app = await buildApp();
// The 6-digit code in the last email to `to` (sendMail is fire-and-forget: let it run).
const codeFor = async (to) => {
  await new Promise((r) => setImmediate(r));
  const mail = devOutbox.findLast((m) => m.to === to);
  return mail?.text.match(/\b\d{6}\b/)?.[0];
};

let ip = 0;
const call = async (method, url, { body, token, userId } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (userId) headers['x-user-id'] = userId;
  // A fresh address per call: the PIN and login limits are per address.
  const res = await app.inject({ method, url, payload: body, headers, remoteAddress: `10.0.0.${++ip % 250}` });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const code = (res) => res.body?.error?.code;

// Register: the guest's id is handed over, the account is signed in.
const reg = await call('POST', '/auth/register', {
  body: { username: 'Ana.B', email: 'Ana@Example.com', password: 'correct horse', nickname: 'Ana', deviceId: 'guest-ana' },
});
assert.equal(reg.status, 201);
assert.equal(reg.body.account.username, 'ana.b');
assert.equal(reg.body.account.email, 'ana@example.com');
assert.equal(reg.body.account.emailVerified, false);
assert.match(reg.body.account.id, /^usr_/);
const ana = { id: reg.body.account.id, token: reg.body.token };

const newUser = (extra) => ({ username: 'bob', email: 'bob@example.com', password: 'whatever12', nickname: 'X', ...extra });
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ username: 'ana.b' }) })), 'USERNAME_TAKEN');
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ email: 'ANA@example.com' }) })), 'EMAIL_TAKEN');
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ username: 'bo' }) })), 'VALIDATION');
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ password: 'short' }) })), 'VALIDATION');
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ password: 'Password123' }) })), 'VALIDATION');
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ password: 'bob@example.com' }) })), 'VALIDATION');
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ email: 'not-an-email' }) })), 'VALIDATION');
assert.equal(code(await call('POST', '/auth/register', { body: newUser({ email: undefined }) })), 'VALIDATION');

// Login: wrong password and unknown user fail the same way; username or email both work.
assert.equal(code(await call('POST', '/auth/login', { body: { username: 'ana.b', password: 'nope nope' } })), 'LOGIN_INVALID');
assert.equal(code(await call('POST', '/auth/login', { body: { username: 'nobody', password: 'nope nope' } })), 'LOGIN_INVALID');
assert.equal(code(await call('POST', '/auth/login', { body: { login: 'nobody@example.com', password: 'nope nope' } })), 'LOGIN_INVALID');
const login = await call('POST', '/auth/login', { body: { username: 'ANA.B', password: 'correct horse' } });
assert.equal(login.status, 200);
assert.equal(login.body.account.id, ana.id);
assert.equal((await call('POST', '/auth/login', { body: { login: 'ana@EXAMPLE.com', password: 'correct horse' } })).body.account.id, ana.id);
assert.equal((await call('GET', '/me', { token: login.body.token })).body.nickname, 'Ana');

// Sharing waits for the email: a wrong code counts, the right one verifies.
const draft = { name: 'D', access: 'public', editPolicy: 'everyone', creatorId: ana.id };
assert.equal(code(await call('POST', '/boards', { body: draft, token: ana.token, userId: ana.id })), 'EMAIL_UNVERIFIED');
const anaCode = await codeFor('ana@example.com');
assert.match(anaCode, /^\d{6}$/);
const wrong = anaCode === '000000' ? '111111' : '000000';
assert.equal(code(await call('POST', '/me/email/verify', { body: { code: wrong }, token: ana.token })), 'CODE_INVALID');
assert.equal(code(await call('POST', '/me/email/verify', { body: { code: anaCode } })), 'AUTH_REQUIRED');
assert.equal((await call('POST', '/me/email/verify', { body: { code: anaCode }, token: ana.token })).body.emailVerified, true);
// Spent: the same code does nothing twice.
assert.equal(code(await call('POST', '/me/email/verify', { body: { code: anaCode }, token: ana.token })), 'CODE_INVALID');
assert.equal(code(await call('POST', '/me/email/resend', { token: ana.token })), 'VALIDATION');

// Sharing needs an account: a guest cannot create or import a live board.
const board = { name: 'Private', access: 'private', editPolicy: 'everyone', pin: '1234' };
assert.equal(code(await call('POST', '/boards', { body: { ...board, creatorId: 'guest-x' }, userId: 'guest-x' })), 'AUTH_REQUIRED');
const snapshot = { format: 'live-whiteboard', version: 1, meta: { name: 's' }, elements: [], exportedAt: 1 };
assert.equal(code(await call('POST', '/boards/import', { body: { snapshot }, userId: 'guest-x' })), 'AUTH_REQUIRED');
// ...nor create one in an account's name.
assert.equal(code(await call('POST', '/boards', { body: { ...board, creatorId: ana.id }, token: 'forged.token' })), 'AUTH_REQUIRED');

const created = await call('POST', '/boards', { body: { ...board, creatorId: ana.id }, token: ana.token, userId: ana.id });
assert.equal(created.status, 201);
const id = created.body.id;
const join = (userId, extra = {}) =>
  call('POST', `/boards/${id}/join`, { body: { userId, nickname: userId.slice(0, 20), ...extra.body }, token: extra.token, userId });

// The creator is never asked for the PIN.
assert.equal((await join(ana.id, { token: ana.token })).status, 200);
// Nobody can claim the creator's id to skip it.
assert.equal(code(await join(ana.id)), 'AUTH_REQUIRED');
assert.equal(code(await join(ana.id, { token: 'garbage' })), 'AUTH_REQUIRED');

// A guest is asked every time.
assert.equal(code(await join('guest-g')), 'PIN_REQUIRED');
assert.equal((await join('guest-g', { body: { pin: '1234' } })).status, 200);
assert.equal(code(await join('guest-g')), 'PIN_REQUIRED');

// An account is asked once; after that the board is on its list.
const bob = (await call('POST', '/auth/register', { body: { username: 'bob', email: 'bob@example.com', password: 'bob password', nickname: 'Bob' } })).body;
assert.equal(code(await join(bob.account.id, { token: bob.token })), 'PIN_REQUIRED');
assert.equal(code(await join(bob.account.id, { token: bob.token, body: { pin: '0000' } })), 'PIN_INVALID');
assert.equal((await join(bob.account.id, { token: bob.token, body: { pin: '1234' } })).status, 200);
assert.equal((await join(bob.account.id, { token: bob.token })).status, 200);
const bobBoards = (await call('GET', '/me/boards', { token: bob.token })).body.boards;
assert.deepEqual(bobBoards.map((b) => [b.id, b.role, b.hasPin]), [[id, 'member', true]]);
assert.equal((await call('GET', '/me/boards', { token: ana.token })).body.boards[0].role, 'creator');
assert.equal(code(await call('GET', '/me/boards')), 'AUTH_REQUIRED');

// A new PIN is asked of members again; the creator still isn't asked.
const owner = (await join(ana.id, { token: ana.token })).body.boardToken;
assert.equal((await call('PATCH', `/boards/${id}/permissions`, { body: { pin: '5678' }, token: owner })).status, 200);
assert.equal(code(await join(bob.account.id, { token: bob.token })), 'PIN_REQUIRED');
assert.equal((await call('GET', '/me/boards', { token: bob.token })).body.boards.length, 0);
assert.equal((await join(ana.id, { token: ana.token })).status, 200);

// Taking a board off the list; the creator's own can only be deleted.
assert.equal((await join(bob.account.id, { token: bob.token, body: { pin: '5678' } })).status, 200);
assert.equal((await call('DELETE', `/me/boards/${id}`, { token: bob.token })).status, 204);
assert.equal((await call('GET', '/me/boards', { token: bob.token })).body.boards.length, 0);
assert.equal(code(await call('DELETE', `/me/boards/${id}`, { token: ana.token })), 'FORBIDDEN');

// A guest's boards follow it into the account it signs in to.
const legacy = await import('../src/store/boards.ts');
const old = await legacy.createBoard({ name: 'Old', access: 'public', editPolicy: 'everyone', creatorId: 'guest-bob' });
await call('POST', '/auth/login', { body: { username: 'bob', password: 'bob password', deviceId: 'guest-bob' } });
assert.equal(old.meta.creatorId, bob.account.id);

// Offline-board AI: an account id needs its session there too.
assert.equal(code(await call('POST', '/ai', { body: { prompt: 'x' }, userId: ana.id })), 'AUTH_REQUIRED');

// A code dies after five wrong guesses, even if the sixth is right.
const carl = (await call('POST', '/auth/register', { body: { username: 'carl', email: 'carl@example.com', password: 'carl password', nickname: 'Carl' } })).body;
const carlCode = await codeFor('carl@example.com');
const miss = carlCode === '000000' ? '111111' : '000000';
for (let i = 0; i < 5; i++) await call('POST', '/me/email/verify', { body: { code: miss }, token: carl.token });
assert.equal(code(await call('POST', '/me/email/verify', { body: { code: carlCode }, token: carl.token })), 'CODE_INVALID');
// Asking again at once is refused (one email a minute).
assert.equal(code(await call('POST', '/me/email/resend', { token: carl.token })), 'RATE_LIMITED');

// Changing the password needs the current one; it ends the other sessions, not this one.
const other = (await call('POST', '/auth/login', { body: { login: 'bob', password: 'bob password' } })).body.token;
assert.equal(code(await call('POST', '/me/password', { body: { password: 'wrong one', newPassword: 'new bob password' }, token: bob.token })), 'LOGIN_INVALID');
assert.equal(code(await call('POST', '/me/password', { body: { password: 'bob password', newPassword: 'short' }, token: bob.token })), 'VALIDATION');
const changed = await call('POST', '/me/password', { body: { password: 'bob password', newPassword: 'new bob password' }, token: bob.token });
assert.equal(changed.status, 200);
assert.equal(code(await call('GET', '/me', { token: other })), 'AUTH_REQUIRED');
assert.equal(code(await call('GET', '/me', { token: bob.token })), 'AUTH_REQUIRED');
assert.equal((await call('GET', '/me', { token: changed.body.token })).status, 200);
assert.equal(code(await call('POST', '/auth/login', { body: { login: 'bob', password: 'bob password' } })), 'LOGIN_INVALID');

// Forgot password: the same answer whether or not the email has an account.
assert.equal((await call('POST', '/auth/password/forgot', { body: { email: 'nobody@example.com' } })).status, 202);
assert.equal((await call('POST', '/auth/password/forgot', { body: { email: 'ana@example.com' } })).status, 202);
const resetCode = await codeFor('ana@example.com');
assert.notEqual(resetCode, anaCode);
const reset = (body) => call('POST', '/auth/password/reset', { body: { email: 'ana@example.com', password: 'brand new pass', ...body } });
assert.equal(code(await reset({ code: resetCode === '000000' ? '111111' : '000000' })), 'CODE_INVALID');
assert.equal(code(await reset({ code: resetCode, password: 'ana.b' })), 'VALIDATION');
assert.equal(code(await call('POST', '/auth/password/reset', { body: { email: 'nobody@example.com', code: resetCode, password: 'brand new pass' } })), 'CODE_INVALID');
const resetOk = await reset({ code: resetCode });
assert.equal(resetOk.status, 200);
assert.equal(resetOk.body.account.id, ana.id);
assert.equal(code(await call('GET', '/me', { token: ana.token })), 'AUTH_REQUIRED');
assert.equal(code(await reset({ code: resetCode })), 'CODE_INVALID');
assert.equal((await call('POST', '/auth/login', { body: { login: 'ana.b', password: 'brand new pass' } })).status, 200);

// An account without an email (from before emails) adds one, with its password.
const usersStore = await import('../src/store/users.ts');
const { hashPin } = await import('../src/pin.ts');
const oldId = usersStore.newAccountId();
await usersStore.createUser({ _id: oldId, username: 'old.timer', passwordHash: hashPin('old password'), nickname: 'Old', createdAt: 1 });
const oldLogin = await call('POST', '/auth/login', { body: { username: 'old.timer', password: 'old password' } });
assert.equal(oldLogin.status, 200);
assert.equal(oldLogin.body.account.email, null);
// The legacy hash was upgraded on that sign-in, and still signs in.
assert.match((await usersStore.findById(oldId)).passwordHash, /^s1\$/);
assert.equal((await call('POST', '/auth/login', { body: { login: 'old.timer', password: 'old password' } })).status, 200);
const oldToken = oldLogin.body.token;
assert.equal(code(await call('POST', '/me/email', { body: { email: 'old@example.com', password: 'nope nope' }, token: oldToken })), 'LOGIN_INVALID');
assert.equal(code(await call('POST', '/me/email', { body: { email: 'carl@example.com', password: 'old password' }, token: oldToken })), 'EMAIL_TAKEN');
const added = await call('POST', '/me/email', { body: { email: 'old@example.com', password: 'old password' }, token: oldToken });
assert.deepEqual([added.body.email, added.body.emailVerified], ['old@example.com', false]);
const oldCode = await codeFor('old@example.com');
assert.equal((await call('POST', '/me/email/verify', { body: { code: oldCode }, token: oldToken })).body.emailVerified, true);
assert.equal((await call('POST', '/boards', { body: { ...draft, creatorId: oldId }, token: oldToken, userId: oldId })).status, 201);

// Verification off (the default): a new account shares at once, and no code is emailed.
const { config } = await import('../src/config.ts');
config.requireEmailVerification = false;
const sent = devOutbox.length;
const dana = (await call('POST', '/auth/register', { body: { username: 'dana', email: 'dana@example.com', password: 'dana password', nickname: 'Dana' } })).body;
assert.deepEqual([dana.account.emailVerified, dana.account.verificationRequired], [false, false]);
await new Promise((r) => setImmediate(r));
assert.equal(devOutbox.length, sent);
assert.equal((await call('POST', '/boards', { body: { ...draft, creatorId: dana.account.id }, token: dana.token, userId: dana.account.id })).status, 201);

// Nothing here is cacheable.
const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${oldToken}` } });
assert.equal(me.headers['cache-control'], 'no-store');

await app.close();
if (mongo) {
  const { MongoClient } = await import('mongodb');
  const client = await MongoClient.connect(process.env.MONGO_URL);
  await client.db('shareboard_check_auth').dropDatabase();
  await client.close();
  await db.closeMongo();
}
console.log(`auth checks passed${mongo ? ' (MongoDB)' : ''}`);
