/**
 * "Draw with AI" without a real provider: a stub OpenAI-compatible endpoint
 * answers with a fenced, partly broken drawing and `draw()` must still turn
 * the good parts into valid, centred, separate elements, with arrows bound to
 * the figures they name. `npm run check:ai`.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let seen;
const answer = {
  reply: 'A house',
  elements: [
    // Declared before the figures it joins: binding must not depend on order.
    { type: 'arrow', from: 'a', to: 'c', text: 'next' },
    {
      type: 'rectangle',
      id: 'a',
      x1: 300,
      y1: 250,
      x2: 500,
      y2: 450,
      stroke: '#123456',
      fill: 'yellow',
      width: 999,
    },
    { type: 'triangle', x1: 280, y1: 150, x2: 520, y2: 250, stroke: 'nope' },
    { type: 'text', x: 400, y: 300, text: 'Home', size: 500 },
    { type: 'path', points: [0, 0, 10, 10, 20], color: '#FF0000' },
    { type: 'text', x: 0, y: 0, text: '' },
    { type: 'spaceship' },
    { type: 'ellipse', id: 'c', x1: 600, y1: 300, x2: 700, y2: 400 },
    { type: 'line', from: 'a', to: 'nobody', x1: 0, y1: 0, x2: 0, y2: 0 },
  ],
};
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen = { auth: req.headers.authorization, url: req.url, body: JSON.parse(body) };
    const content = '```json\n' + JSON.stringify(answer) + '\n```';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => stub.listen(0, r));

process.env.AI_PROVIDER = 'groq';
process.env.AI_API_KEY = 'test-key';
process.env.AI_BASE_URL = `http://localhost:${stub.address().port}/v1/`;
const { draw } = await import('../src/ai.ts');

const { reply, elements } = await draw('draw a house', 'user_1', { x: 1000, y: 1000 });
stub.close();

assert.equal(seen.url, '/v1/chat/completions');
assert.equal(seen.auth, 'Bearer test-key');
assert.equal(
  seen.body.model,
  'openai/gpt-oss-120b',
  'preset model kept when only the URL is overridden',
);
assert.equal(seen.body.messages.at(-1).content, 'draw a house');

assert.equal(reply, 'A house');
assert.deepEqual(
  elements.map((e) => e.kind),
  ['shape', 'shape', 'shape', 'text', 'stroke', 'shape', 'shape'],
  'empty text and unknown types are dropped',
);
const [arrow, rect, tri, text, path, circle, line] = elements;
// The 800x600 canvas is centred on (1000, 1000): offset (+600, +700).
assert.deepEqual(
  [rect.from, rect.to],
  [
    { x: 900, y: 950 },
    { x: 1100, y: 1150 },
  ],
);
assert.equal(rect.fill, null, 'a named colour is not #RRGGBB, so no fill');
assert.equal(rect.strokeWidth, 64, 'width clamped to the limit');
assert.equal(tri.stroke, '#1B2030', 'bad colour falls back to ink');
assert.equal(text.fontSize, 96);
assert.deepEqual(
  path.points,
  [600, 700, 610, 710],
  'odd trailing coordinate dropped, offset applied',
);
assert.ok(
  elements.every((e) => e.group === elements[0].group && e.createdBy === 'user_1'),
  'one drawing is one group',
);
assert.match(elements[0].group, /^ai_[0-9a-f]{12}$/);

// Rect centre (1000, 1050), circle centre (1250, 1050): the arrow leaves the
// rect's right edge and lands on the circle's left edge, bound to both.
assert.deepEqual(
  [arrow.from, arrow.to],
  [
    { x: 1100, y: 1050 },
    { x: 1200, y: 1050 },
  ],
);
assert.deepEqual(arrow.fromLink, { id: rect.id, u: 1, v: 0.5 });
assert.deepEqual(arrow.toLink, { id: circle.id, u: 0, v: 0.5 });
assert.equal(arrow.text, 'next');
// An unknown id leaves that end free at its coordinates; the other end still binds.
assert.deepEqual(line.to, { x: 600, y: 700 });
assert.equal(line.toLink, undefined);
assert.deepEqual(line.fromLink, { id: rect.id, u: 0, v: 0.0625 });
assert.equal(new Set(elements.map((e) => e.id)).size, elements.length);

console.log('ai: ok');
