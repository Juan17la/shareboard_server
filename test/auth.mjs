// Accounts, sharing and the PIN rules, in memory (no Mongo, no network):
//   npm run check:auth
import assert from 'node:assert/strict';

process.env.MEMORY_ONLY = 'true';
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

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
  body: { username: 'Ana.B', password: 'correct horse', nickname: 'Ana', deviceId: 'guest-ana' },
});
assert.equal(reg.status, 201);
assert.equal(reg.body.account.username, 'ana.b');
assert.match(reg.body.account.id, /^usr_/);
const ana = { id: reg.body.account.id, token: reg.body.token };

assert.equal(code(await call('POST', '/auth/register', { body: { username: 'ana.b', password: 'whatever12', nickname: 'X' } })), 'USERNAME_TAKEN');
assert.equal(code(await call('POST', '/auth/register', { body: { username: 'bo', password: 'whatever12', nickname: 'X' } })), 'VALIDATION');
assert.equal(code(await call('POST', '/auth/register', { body: { username: 'bob', password: 'short', nickname: 'X' } })), 'VALIDATION');

// Login: wrong password and unknown user fail the same way.
assert.equal(code(await call('POST', '/auth/login', { body: { username: 'ana.b', password: 'nope nope' } })), 'LOGIN_INVALID');
assert.equal(code(await call('POST', '/auth/login', { body: { username: 'nobody', password: 'nope nope' } })), 'LOGIN_INVALID');
const login = await call('POST', '/auth/login', { body: { username: 'ANA.B', password: 'correct horse' } });
assert.equal(login.status, 200);
assert.equal(login.body.account.id, ana.id);
assert.equal((await call('GET', '/me', { token: login.body.token })).body.nickname, 'Ana');

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
const bob = (await call('POST', '/auth/register', { body: { username: 'bob', password: 'bob password', nickname: 'Bob' } })).body;
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

await app.close();
console.log('auth checks passed');
