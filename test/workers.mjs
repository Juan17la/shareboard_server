/**
 * `npm run check:workers`. The routing rules always; with MONGO_URL also the
 * whole thing, against `dist/` with 3 workers on a throwaway database: boards
 * reachable from any path, one live copy, batched broadcasts in order, a guest's
 * boards transferred across workers, a clean stop that saves, a dead worker back.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import { WebSocket } from 'ws';

import { boardOfRequestLine, routeOf, shardOf } from '../src/workers.ts';

// ---------- routing ----------
const board = (line) => boardOfRequestLine(`${line} HTTP/1.1`);
assert.equal(board('GET /ws?boardId=brd_a&token=x'), 'brd_a');
assert.equal(board('GET /ws?token=x&boardId=brd_a'), 'brd_a');
assert.equal(board('GET /ws?boardId=brd%5Fa'), 'brd_a');
assert.equal(board('POST /boards/brd_a/join'), 'brd_a');
assert.equal(board('GET /boards/brd_a'), 'brd_a');
assert.equal(board('GET /boards/brd_a?x=1'), 'brd_a');
assert.equal(board('PATCH /boards/brd_a/permissions'), 'brd_a');
assert.equal(board('DELETE /me/boards/brd_a'), 'brd_a');
for (const free of ['POST /boards', 'POST /boards/import', 'GET /boards/code/ABC', 'GET /me/boards', 'POST /auth/login', 'GET /health']) {
  assert.equal(board(free), null, free);
}
assert.equal(routeOf('GET /boards/brd_a HTTP/1.1\r\n\r\n', '1.1.1.1', 8, 0), shardOf('brd_a', 8));
assert.equal(routeOf('GET /ws?boardId=brd_a HTTP/1.1\r\n\r\n', '9.9.9.9', 8, 0), shardOf('brd_a', 8));
const viaProxy = (xff) => routeOf(`POST /auth/login HTTP/1.1\r\nX-Forwarded-For: ${xff}\r\n\r\n`, '10.0.0.1', 8, 1);
assert.equal(viaProxy('6.6.6.6, 2.2.2.2'), shardOf('2.2.2.2', 8), 'the hop we trust, not what the client wrote');
assert.equal(routeOf('POST /auth/login HTTP/1.1\r\nX-Forwarded-For: 2.2.2.2\r\n\r\n', '10.0.0.1', 8, 0), shardOf('10.0.0.1', 8));
const spread = new Set(Array.from({ length: 200 }, (_, i) => shardOf(`brd_${i}`, 4)));
assert.equal(spread.size, 4, 'ids spread over every worker');
console.log('routing ok');

// ---------- end to end ----------
if (!process.env.MONGO_URL) {
  console.log('MONGO_URL not set: skipping the end-to-end part');
  process.exit(0);
}
const PORT = 3191;
const API = `http://127.0.0.1:${PORT}`;
const DB = 'shareboard_workers_test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/index.js'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, WORKERS: '3', PORT: String(PORT), HOST: '127.0.0.1', MONGO_DB: DB, CREATE_BOARD_PER_HOUR: '100000', REGISTER_PER_HOUR: '100000' },
});
const mongo = new MongoClient(process.env.MONGO_URL);
const done = async (code) => {
  server.kill('SIGKILL');
  await mongo.db(DB).dropDatabase();
  await mongo.close();
  process.exit(code);
};
process.on('uncaughtException', async (err) => {
  console.error(err);
  await done(1);
});
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${API}/health`)).ok) break;
  } catch {}
  await sleep(250);
}

const call = async (method, path, body, token) => {
  const res = await fetch(API + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, connection: res.headers.get('connection'), body: res.status === 204 ? null : await res.json() };
};
const signup = async (name, deviceId) => (await call('POST', '/auth/register', { username: name, email: `${name}@x.test`, password: 'correct horse battery', nickname: name, ...(deviceId ? { deviceId } : {}) })).body;

const ana = await signup('ana');
assert.ok(ana.token, 'register works through a worker');

const health = await call('GET', '/health');
assert.equal(health.connection, 'close', 'REST never keeps a connection a worker might not own');

// Every board is reachable, whichever worker made it, by id and by short code.
const boards = [];
for (let i = 0; i < 24; i++) {
  const created = await call('POST', '/boards', { name: `b${i}`, access: 'public', editPolicy: 'everyone', creatorId: ana.account.id }, ana.token);
  assert.equal(created.status, 201);
  boards.push(created.body);
}
for (const b of boards) {
  assert.equal((await call('GET', `/boards/${b.id}`)).body.name, b.name);
  assert.equal((await call('GET', `/boards/code/${b.shortCode}`)).body.boardId, b.id);
}
assert.ok(new Set(boards.map((b) => shardOf(b.id, 3))).size > 1, 'boards spread over workers');
assert.equal((await call('GET', '/me/boards', null, ana.token)).body.boards.length, 24);

// A socket lands on its board's worker: two people see each other, in order.
const open = async (boardId, userId) => {
  const joined = await call('POST', `/boards/${boardId}/join`, { userId, nickname: userId });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?boardId=${boardId}&token=${joined.body.boardToken}`);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(String(raw))));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'join', boardId, userId, nickname: userId, tab: 't' }));
  for (let i = 0; i < 100 && !inbox.some((m) => m.type === 'joined'); i++) await sleep(20);
  assert.ok(inbox.some((m) => m.type === 'joined'), 'joined');
  return { ws, inbox };
};
const target = boards.find((b) => shardOf(b.id, 3) === 2) ?? boards[0];
const a = await open(target.id, 'gst_a');
const b = await open(target.id, 'gst_b');
for (let x = 0; x < 50; x++) a.ws.send(JSON.stringify({ type: 'cursor', boardId: target.id, at: { x, y: 0 } }));
a.ws.send(JSON.stringify({ type: 'ping', t: 7 }));
for (let i = 0; i < 100 && b.inbox.filter((m) => m.type === 'cursor').length < 50; i++) await sleep(20);
assert.deepEqual(b.inbox.filter((m) => m.type === 'cursor').map((m) => m.at.x), Array.from({ length: 50 }, (_, x) => x), 'every cursor, in order');
assert.equal(a.inbox.filter((m) => m.type === 'cursor').length, 0, 'never echoed to the sender');
for (let i = 0; i < 50 && !a.inbox.some((m) => m.type === 'pong'); i++) await sleep(20);
assert.ok(a.inbox.some((m) => m.type === 'pong'));

// A direct send never overtakes what is queued for that socket.
a.ws.send(JSON.stringify({ type: 'cursor', boardId: target.id, at: { x: 999, y: 0 } }));
b.ws.send(JSON.stringify({ type: 'ping', t: 8 }));
for (let i = 0; i < 50 && !b.inbox.some((m) => m.type === 'pong' && m.t === 8); i++) await sleep(20);

// A guest's live board on any worker becomes the account's, and stays so after a save.
const guest = 'gst_device1';
const bea = await signup('bea');
// It has to live on a worker other than the one handling this address's sign-up, or this proves nothing.
let made;
do {
  made = (await call('POST', '/boards', { name: 'guest', access: 'public', editPolicy: 'everyone', creatorId: bea.account.id }, bea.token)).body;
} while (shardOf(made.id, 3) === shardOf('127.0.0.1', 3));
await mongo.db(DB).collection('boards').updateOne({ _id: made.id }, { $set: { creatorId: guest } });
const liveOnOwner = await open(made.id, 'gst_watch');
const adopter = await signup('carl', guest);
assert.ok(adopter.token);
liveOnOwner.ws.send(JSON.stringify({ type: 'op', boardId: made.id, seq: 0, ops: [{ t: 'add', el: { id: 's1', kind: 'text', at: { x: 1, y: 1 }, text: 'hi', color: '#111111', fontSize: 18, createdBy: 'gst_watch', createdAt: 1, updatedAt: 1, z: 1 } }] }));
await sleep(1500);
// That op made the live copy save: without the transfer it would write the old owner back.
const stored = await mongo.db(DB).collection('boards').findOne({ _id: made.id });
assert.equal(stored.creatorId, adopter.account.id, 'the live copy took the transfer');

// The PIN path runs on the thread pool and still answers correctly.
const pinned = (await call('POST', '/boards', { name: 'p', access: 'public', editPolicy: 'everyone', creatorId: ana.account.id, pin: '4827' }, ana.token)).body;
assert.equal((await call('POST', `/boards/${pinned.id}/join`, { userId: 'gst_p', nickname: 'p', pin: '0000' })).body.error.code, 'PIN_INVALID');
assert.equal((await call('POST', `/boards/${pinned.id}/join`, { userId: 'gst_p', nickname: 'p', pin: '4827' })).status, 200);

// A dead worker comes back, and its boards with it.
const pgrep = spawn('pgrep', ['-P', String(server.pid)]);
let children = '';
pgrep.stdout.on('data', (d) => (children += d));
await once(pgrep, 'exit');
const pids = children.trim().split('\n').map(Number);
assert.equal(pids.length, 3, 'one process per worker');
process.kill(pids[1], 'SIGKILL');
await sleep(4000);
for (const b of boards) assert.equal((await call('GET', `/boards/${b.id}`)).status, 200, 'every board answers after the restart');

// A clean stop persists what is dirty, even from a socket.
a.ws.send(JSON.stringify({ type: 'op', boardId: target.id, seq: 0, ops: [{ t: 'add', el: { id: 'last', kind: 'text', at: { x: 1, y: 1 }, text: 'bye', color: '#111111', fontSize: 18, createdBy: 'gst_a', createdAt: 1, updatedAt: 1, z: 1 } }] }));
await sleep(100);
server.kill('SIGTERM');
const [exitCode] = await Promise.race([once(server, 'exit'), sleep(15000).then(() => ['timeout'])]);
assert.equal(exitCode, 0, 'the primary waits for its workers and exits clean');
const saved = await mongo.db(DB).collection('boards').findOne({ _id: target.id });
assert.ok(saved.elements.some((e) => e.id === 'last'), 'flushed on the way out');

console.log('end to end ok');
await done(0);
