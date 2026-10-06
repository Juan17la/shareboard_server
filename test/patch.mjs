/**
 * Self-check of update-patch validation and of the un-delete a client's undo
 * sends (`deleted: null`). Runs the real TypeScript under node through tsx.
 */
import assert from 'node:assert/strict';

import { applyOps } from '../src/model/ops.ts';
import { validateOps } from '../src/model/validate.ts';

const patch = (p) => validateOps([{ t: 'update', id: 'a', patch: p, updatedAt: 1 }])[0].patch;
const bad = (p) => assert.throws(() => patch(p), /cannot be unset|must be|not valid|is not/);

// What the clients send: moves, restyles, reorders, undo's nulls.
assert.deepEqual(patch({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }), { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
assert.deepEqual(patch({ points: [0, 0, 1, 1] }), { points: [0, 0, 1, 1] });
assert.deepEqual(patch({ z: -3, group: null, deleted: null, fill: null, text: '' }), { z: -3, group: null, deleted: null, fill: null, text: '' });
assert.deepEqual(patch({ fromLink: { id: 'b', u: 0.5, v: 1 }, toLink: null, bend: null }), { fromLink: { id: 'b', u: 0.5, v: 1 }, toLink: null, bend: null });
assert.deepEqual(patch({ width: 120, fontSize: 9999, strokeWidth: 0 }), { width: 120, fontSize: 400, strokeWidth: 1 });
// A line's label moves along it: clamped to 0..1, and unset by an undo of a first move.
assert.deepEqual(patch({ labelAt: 0.3 }), { labelAt: 0.3 });
assert.deepEqual(patch({ labelAt: 7 }), { labelAt: 1 });
assert.deepEqual(patch({ labelAt: null }), { labelAt: null });
// How a line runs: an elbow's axes, a curve's handles — and their unsetting when the route changes.
assert.deepEqual(patch({ startAxis: 'h', endAxis: 'v' }), { startAxis: 'h', endAxis: 'v' });
assert.deepEqual(patch({ curveFrom: { x: 1, y: 2 }, curveTo: null }), { curveFrom: { x: 1, y: 2 }, curveTo: null });
assert.deepEqual(patch({ startAxis: null, endAxis: null }), { startAxis: null, endAxis: null });
// Opacity: clamped to 0.1..1, null unsets it.
assert.deepEqual(patch({ opacity: 0.4 }), { opacity: 0.4 });
assert.deepEqual(patch({ opacity: 7 }), { opacity: 1 });
assert.deepEqual(patch({ opacity: 0 }), { opacity: 0.1 });
assert.deepEqual(patch({ opacity: null }), { opacity: null });
bad({ opacity: 'half' });
assert.deepEqual(patch({ rounded: true }), { rounded: true });
assert.deepEqual(patch({ underline: true, bold: null }), { underline: true, bold: null });
assert.deepEqual(patch({ rounded: null }), { rounded: null });
assert.deepEqual(patch({ align: 'right', valign: 'bottom' }), { align: 'right', valign: 'bottom' });
assert.deepEqual(patch({ align: null, valign: null }), { align: null, valign: null });
bad({ align: 'justify' });
bad({ valign: 'left' });
const tri = [{ x: 0, y: 1 }, { x: 0.5, y: 0 }, { x: 2, y: 1 }];
assert.deepEqual(patch({ vertices: tri }), { vertices: [{ x: 0, y: 1 }, { x: 0.5, y: 0 }, { x: 1, y: 1 }] });
assert.deepEqual(patch({ vertices: null }), { vertices: null });
bad({ vertices: [{ x: 0, y: 0 }] });
bad({ vertices: 'many' });
// Not patchable / unknown: dropped, not refused.
assert.deepEqual(patch({ id: 'x', kind: 'text', createdBy: 'me', shiny: true }), {});
// Malformed: refused.
bad({ from: 'nope' });
bad({ from: null });
bad({ points: [1] });
bad({ color: 'red' });
bad({ z: NaN });
bad({ shape: 'blob' });
bad({ startAxis: 'diagonal' });
bad({ curveFrom: 'far' });

// Un-delete: the element comes back with the z it had.
const els = new Map([['a', { id: 'a', kind: 'shape', z: 2 }]]);
let z = applyOps(els, [{ t: 'delete', id: 'a' }], 5);
assert.equal(els.get('a').deleted, true);
z = applyOps(els, validateOps([{ t: 'update', id: 'a', patch: { deleted: null }, updatedAt: 9 }]), z);
assert.equal(els.get('a').deleted, undefined);
assert.equal(els.get('a').z, 2);
assert.equal(z, 5);

console.log('patch: ok');
