// Write-behind persistence against a real MongoDB (any empty test database):
//   MONGO_URL=mongodb://127.0.0.1:27017 npm run check:persistence
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

if (!process.env.MONGO_URL) throw new Error('set MONGO_URL to a test MongoDB');
process.env.MONGO_DB = 'shareboard_check';
process.env.WRITE_DELAY_MS = '50';

const db = await import('../src/store/mongo.ts');
const store = await import('../src/store/boards.ts');
await db.connectMongo();

// A new board is in the db before createBoard returns.
const board = await store.createBoard({ name: 'b', access: 'public', editPolicy: 'everyone', creatorId: 'u1' });
assert.equal((await db.findBoard(board.meta.id))?.name, 'b');

// A change reaches the db within the write delay, a burst becomes one write.
for (const name of ['c', 'd', 'e']) {
  board.meta.name = name;
  store.touch(board);
}
await sleep(200);
assert.equal((await db.findBoard(board.meta.id))?.name, 'e');
assert.equal(board.dirty, false);

// Concurrent cold loads share one object (else joins split across copies).
const id = board.meta.id;
await store.deleteBoard(board);
await db.saveBoard({ _id: id, shortCode: 'COLD99', name: 'cold', access: 'public', editPolicy: 'everyone', editors: [], creatorId: 'u1', createdAt: 1, updatedAt: 1, pinHash: null, elements: [] });
const [a, b] = await Promise.all([store.getBoard(id), store.getBoard(id)]);
assert.equal(a, b);

// A deleted board is never written back by a pending save.
store.touch(a);
await store.deleteBoard(a);
await sleep(200);
assert.equal(await db.findBoard(id), null);

await store.flushAll();
await db.closeMongo();
console.log('persistence ok');
