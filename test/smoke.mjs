/**
 * End-to-end check against a running server (`npm run dev`, then
 * `node test/smoke.mjs`). Asserts what the clients rely on: an empty text
 * placeholder is accepted, the avatar rides on the participant, a selection
 * holds its elements against everyone else (first come, first served), and
 * deleting a board disconnects everyone else with BOARD_NOT_FOUND.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const API = process.env.API_URL ?? 'http://localhost:3000';
const WS = process.env.WS_URL ?? 'ws://localhost:3000/ws';

const json = async (path, opts = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const open = (boardId, token, userId, nickname) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?boardId=${boardId}&token=${token}`);
    const inbox = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      const w = waiters.shift();
      w ? w(msg) : inbox.push(msg);
    };
    ws.onclose = (e) => {
      ws.closedWith = e.code;
      const msg = { type: 'closed', code: e.code };
      // Queued like any frame when nobody is waiting yet, or it would be lost.
      const w = waiters.shift();
      w ? w(msg) : inbox.push(msg);
      waiters.splice(0).forEach((rest) => rest(msg));
    };
    ws.onerror = reject;
    ws.next = () => new Promise((r) => (inbox.length ? r(inbox.shift()) : waiters.push(r)));
    // Presence frames arrive whenever anyone joins or leaves; skip them.
    ws.nextOf = async (type) => {
      for (;;) {
        const msg = await ws.next();
        if (msg.type === type || msg.type === 'closed' || msg.type === 'error') return msg;
      }
    };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', boardId, userId, nickname }));
      resolve(ws);
    };
  });

const creator = 'u_creator';
const guest = 'u_guest';

const created = await json('/boards', {
  method: 'POST',
  headers: { 'X-User-Id': creator },
  body: { name: 'smoke', access: 'public', editPolicy: 'everyone', creatorId: creator },
});
assert.equal(created.status, 201);
const id = created.body.id;

const joinC = await json(`/boards/${id}/join`, {
  method: 'POST',
  headers: { 'X-User-Id': creator },
  body: { userId: creator, nickname: 'Cre', avatar: '🦊' },
});
assert.equal(joinC.body.you.avatar, '🦊', 'avatar is stored on join');

// A long name (two surnames) fits up to the limit; one character more is refused.
const longNick = 'María José de los Ángeles Fernández-Vill'.slice(0, 40);
assert.equal(longNick.length, 40);
const joinLong = await json(`/boards/${id}/join`, {
  method: 'POST',
  headers: { 'X-User-Id': 'u_long' },
  body: { userId: 'u_long', nickname: longNick },
});
assert.equal(joinLong.status, 200, 'a 40-character nickname is accepted');
assert.equal(joinLong.body.you.nickname, longNick, 'and kept whole');
const tooLong = await json(`/boards/${id}/join`, {
  method: 'POST',
  headers: { 'X-User-Id': 'u_long2' },
  body: { userId: 'u_long2', nickname: `${longNick}x` },
});
assert.equal(tooLong.status, 400, 'a 41-character nickname is refused');

const joinG = await json(`/boards/${id}/join`, {
  method: 'POST',
  headers: { 'X-User-Id': guest },
  body: { userId: guest, nickname: 'Gue' },
});

const c = await open(id, joinC.body.boardToken, creator, 'Cre');
const joined = await c.next();
assert.equal(joined.type, 'joined');
assert.equal(joined.you.avatar, '🦊', 'avatar survives the socket join');

const g = await open(id, joinG.body.boardToken, guest, 'Gue');
assert.equal((await g.next()).type, 'joined');

// 1. An empty text element (the editor's placeholder) is accepted, not rejected.
const now = Date.now();
c.send(
  JSON.stringify({
    type: 'op',
    boardId: id,
    seq: 1,
    ops: [
      {
        t: 'add',
        el: { id: 'txt1', kind: 'text', at: { x: 0, y: 0 }, text: '', color: '#000000',
              fontSize: 28, createdBy: creator, createdAt: now, updatedAt: now, z: 0 },
      },
    ],
  }),
);
const echoed = await g.nextOf('op');
assert.equal(echoed.type, 'op', `guest should receive the op, got ${JSON.stringify(echoed)}`);
assert.equal(echoed.ops[0].el.text, '');

// 1b. A linked, styled arrow round-trips whole, and the paint order survives a
//     "bring to front": the add after it still lands on top.
const el = (id, extra) => ({
  id, kind: 'shape', shape: 'arrow', from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, stroke: '#000000',
  strokeWidth: 2, fill: null, createdBy: creator, createdAt: now, updatedAt: now, z: 0, ...extra,
});
const styled = { headStart: 'circle-outline', headEnd: 'one-many', route: 'elbow', dash: 'dotted', bend: 0.3,
  toLink: { id: 'txt1', u: 0.5, v: 1 }, group: 'grp1' };
c.send(JSON.stringify({ type: 'op', boardId: id, seq: 2, ops: [{ t: 'add', el: el('arr1', styled) }] }));
const arrow = (await g.nextOf('op')).ops[0].el;
for (const k of Object.keys(styled)) assert.deepEqual(arrow[k], styled[k], `${k} round-trips`);
c.send(JSON.stringify({ type: 'op', boardId: id, seq: 3, ops: [{ t: 'add', el: el('bad', { headEnd: 'nope' }) }] }));
assert.equal((await c.nextOf('error')).code, 'VALIDATION', 'an unknown marker is rejected');
c.send(JSON.stringify({ type: 'op', boardId: id, seq: 4, ops: [
  { t: 'update', id: 'txt1', patch: { z: 50 }, updatedAt: now },
  { t: 'add', el: el('arr2', {}) },
] }));
const raised = (await g.nextOf('op')).ops;
assert.ok(raised[1].el.z > 50, `add after a raise lands on top (${raised[1].el.z})`);

// 1c. Selecting holds: first come, first served; an edit to what someone else
//     holds is dropped and its sender gets the current state back; letting go
//     (deselect, or leaving) frees it.
const until = async (ws, pred) => {
  for (;;) {
    const msg = await ws.next();
    if (msg.type === 'closed') throw new Error('socket closed while waiting');
    if (pred(msg)) return msg;
  }
};
const selOf = (msg, user) => msg.participants.find((p) => p.userId === user)?.selection ?? [];
c.send(JSON.stringify({ type: 'select', boardId: id, ids: ['txt1', 'arr1'] }));
await until(g, (m) => m.type === 'participants' && selOf(m, creator).length === 2);
g.send(JSON.stringify({ type: 'select', boardId: id, ids: ['txt1', 'arr2'] }));
const got = await until(g, (m) => m.type === 'participants' && selOf(m, guest).length > 0);
assert.deepEqual(selOf(got, guest), ['arr2'], 'what the creator holds is not taken');
g.send(JSON.stringify({ type: 'op', boardId: id, seq: 5, ops: [
  { t: 'update', id: 'txt1', patch: { text: 'stolen' }, updatedAt: now },
  { t: 'update', id: 'arr2', patch: { bend: 0.5 }, updatedAt: now },
] }));
const fix = await until(g, (m) => m.type === 'op' && m.from === 'server');
assert.equal(fix.ops[0].el.id, 'txt1');
assert.equal(fix.ops[0].el.text, '', 'the refused edit is answered with the current element');
const passed = await until(c, (m) => m.type === 'op' && m.from === guest);
assert.deepEqual(passed.ops.map((o) => o.id), ['arr2'], 'only the edit to its own element goes through');
c.send(JSON.stringify({ type: 'select', boardId: id, ids: [] }));
await until(g, (m) => m.type === 'participants' && selOf(m, creator).length === 0);
g.send(JSON.stringify({ type: 'select', boardId: id, ids: ['txt1'] }));
await until(c, (m) => m.type === 'participants' && selOf(m, guest).includes('txt1'));
// Leaving lets go too: a third user holds something, disconnects, and it is free.
const third = 'u_third';
const joinT = await json(`/boards/${id}/join`, {
  method: 'POST',
  headers: { 'X-User-Id': third },
  body: { userId: third, nickname: 'Thi' },
});
const h = await open(id, joinT.body.boardToken, third, 'Thi');
assert.equal((await h.nextOf('joined')).type, 'joined');
h.send(JSON.stringify({ type: 'select', boardId: id, ids: ['arr1'] }));
await until(c, (m) => m.type === 'participants' && selOf(m, third).includes('arr1'));
h.close();
await until(c, (m) => m.type === 'participants' && !m.participants.some((p) => p.userId === third));
g.send(JSON.stringify({ type: 'select', boardId: id, ids: [] }));

// 2. Delete: creator only, the guest is told and disconnected, the board is gone.
const denied = await json(`/boards/${id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${joinG.body.boardToken}` },
});
assert.equal(denied.status, 403);

const deleted = await json(`/boards/${id}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${joinC.body.boardToken}` },
});
assert.equal(deleted.status, 204);
const err = await g.nextOf('error');
assert.equal(err.type, 'error');
assert.equal(err.code, 'BOARD_NOT_FOUND');
const closed = await g.nextOf('closed');
assert.equal(closed.code, 4004);
assert.equal((await json(`/boards/${id}`)).status, 404);

console.log('smoke ok');
process.exit(0);
