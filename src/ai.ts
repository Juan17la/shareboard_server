/**
 * "Draw with AI": a prompt goes to any OpenAI-compatible chat endpoint (Gemini,
 * Groq, OpenRouter, Ollama… all speak it), which answers with a small JSON
 * drawing that is turned into ordinary board elements.
 */
import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import { AppError } from './errors.js';
import { LIMITS } from './model/types.js';
import type { BoardElement, Link, Point, ShapeElement } from './model/types.js';
import { validateElement } from './model/validate.js';

/**
 * Base URL + default model per provider. `AI_BASE_URL` / `AI_MODEL` override
 * either. Free-tier models get retired often (Groq dropped llama-3.3-70b on
 * 2026-08-16), so prefer aliases/routers that the provider keeps pointing at
 * something live: `gemini-flash-latest`, `openrouter/free`.
 */
const PROVIDERS: Record<string, { baseUrl: string; model: string }> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
  },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
};

/** The model draws in this box; it is then centred on the viewer's screen. */
const W = 800;
const H = 600;
const MAX_ITEMS = 200;

const SYSTEM = `You draw on a whiteboard. Reply with ONLY a JSON object, no prose, no code fences:
{"reply": "<one short sentence to the user, in their language>", "elements": [ ... ]}
The canvas is ${W}x${H}, origin top-left, y grows downward. Compose the whole drawing inside it, reasonably large and centred.
Element types (colors are "#RRGGBB"):
- {"type":"rectangle"|"ellipse"|"triangle","id":"a","x1":0,"y1":0,"x2":100,"y2":80,"stroke":"#1B2030","fill":"#FFD60A" or null,"width":3,"text":"optional label inside"}
  (x1,y1)-(x2,y2) is the bounding box. A triangle points up. Give every figure a short unique "id".
- {"type":"line"|"arrow","from":"a","to":"b","stroke":"#1B2030","width":3,"text":"optional label"}
  connects two figures by id; it stays attached when they move. Use this for every connection.
  A line not between figures uses coordinates instead: {"type":"line","x1":0,"y1":0,"x2":100,"y2":0,...}
- {"type":"text","x":0,"y":0,"text":"Hello","color":"#1B2030","size":24}  (x,y is the top-left of the text)
- {"type":"path","points":[x0,y0,x1,y1,...],"color":"#1B2030","width":3}  a freehand polyline for curves and organic outlines.
Later elements are painted on top. Build recognisable pictures from simple parts. Use at most ${MAX_ITEMS} elements.
Every element can be moved and edited on its own, so: put a figure's words in its "text" instead of a separate text element on top of it, and prefer figures and arrows over "path", whose content cannot be edited.`;

interface DrawResult {
  reply: string;
  elements: BoardElement[];
}

/** Asks the configured model for a drawing of `prompt`, centred on `at`. */
export async function draw(prompt: string, userId: string, at: Point): Promise<DrawResult> {
  const preset = PROVIDERS[config.aiProvider];
  const baseUrl = config.aiBaseUrl || preset?.baseUrl;
  const model = config.aiModel || preset?.model;
  if (!baseUrl || !model) {
    throw new AppError(
      'INTERNAL',
      `Unknown AI_PROVIDER "${config.aiProvider}": set AI_BASE_URL and AI_MODEL`,
    );
  }
  if (!config.aiApiKey && config.aiProvider !== 'ollama') {
    throw new AppError('INTERNAL', 'AI is not configured: set AI_API_KEY in server/.env');
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.aiApiKey ? { Authorization: `Bearer ${config.aiApiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new AppError('INTERNAL', `AI provider unreachable: ${(err as Error).message}`);
  }

  if (res.status === 429) {
    throw new AppError(
      'RATE_LIMITED',
      'The AI provider is rate limiting us, try again in a minute',
    );
  }
  if (!res.ok) {
    const body = await res.text();
    const hint =
      res.status === 404 ? ` — model "${model}" is gone; set AI_MODEL in server/.env` : '';
    throw new AppError('INTERNAL', `AI provider error ${res.status}: ${body.slice(0, 300)}${hint}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return toElements(data.choices?.[0]?.message?.content ?? '', userId, at);
}

/**
 * Parses the model's answer into validated elements. Lenient on purpose: a
 * model that wraps the JSON in fences or gets one item wrong still draws the rest.
 */
export function toElements(content: string, userId: string, at: Point): DrawResult {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  let parsed: { reply?: unknown; elements?: unknown };
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new AppError(
      'INTERNAL',
      'The AI answered with something that is not a drawing, try rephrasing',
    );
  }

  const items = Array.isArray(parsed.elements) ? parsed.elements.slice(0, MAX_ITEMS) : [];
  const dx = at.x - W / 2;
  const dy = at.y - H / 2;
  const now = Date.now();
  const elements: BoardElement[] = [];
  // The model's own ids for figures, so lines can bind to them in any order.
  const figures = new Map<unknown, ShapeElement>();
  const lines: [ShapeElement, Record<string, unknown>][] = [];

  for (const item of items as Record<string, unknown>[]) {
    const raw = convert(item, dx, dy);
    if (!raw) continue;
    let el: BoardElement;
    try {
      el = validateElement({
        ...raw,
        id: `el_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      continue; // ponytail: a malformed item is dropped silently; surface a count if users ask why.
    }
    if (el.kind === 'shape' && isLineLike(el)) lines.push([el, item]);
    else if (el.kind === 'shape' && item.id != null) figures.set(item.id, el);
    elements.push(el);
  }
  for (const [line, item] of lines) connect(line, figures.get(item.from), figures.get(item.to));

  return {
    reply: typeof parsed.reply === 'string' ? parsed.reply.slice(0, 500) : '',
    elements,
  };
}

const n = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const colorOr = (v: unknown, fallback: string) =>
  typeof v === 'string' && LIMITS.colorPattern.test(v) ? v : fallback;
const width = (v: unknown) => clamp(n(v, 3), LIMITS.minStrokeWidth, LIMITS.maxStrokeWidth);
const INK = '#1B2030';

/** One model item -> an element without identity fields, or null if unusable. */
function convert(item: Record<string, unknown>, dx: number, dy: number): object | null {
  if (typeof item !== 'object' || item === null) return null;
  switch (item.type) {
    case 'rectangle':
    case 'ellipse':
    case 'triangle':
    case 'line':
    case 'arrow':
      return {
        kind: 'shape',
        shape: item.type,
        from: { x: n(item.x1) + dx, y: n(item.y1) + dy },
        to: { x: n(item.x2) + dx, y: n(item.y2) + dy },
        stroke: colorOr(item.stroke, INK),
        strokeWidth: width(item.width),
        fill: colorOr(item.fill, '') || null,
        ...(typeof item.text === 'string' && item.text ? { text: item.text } : {}),
      };
    case 'text':
      if (typeof item.text !== 'string' || !item.text) return null;
      return {
        kind: 'text',
        at: { x: n(item.x) + dx, y: n(item.y) + dy },
        text: item.text,
        color: colorOr(item.color, INK),
        fontSize: clamp(n(item.size, 24), LIMITS.minFontSize, LIMITS.maxFontSize),
      };
    case 'path': {
      const pts = Array.isArray(item.points)
        ? item.points.filter((v) => typeof v === 'number')
        : [];
      if (pts.length < 4) return null;
      const even = pts.slice(0, pts.length - (pts.length % 2));
      return {
        kind: 'stroke',
        points: even.map((v, i) => v + (i % 2 ? dy : dx)),
        color: colorOr(item.color, INK),
        width: width(item.width),
      };
    }
    default:
      return null;
  }
}

const isLineLike = (el: ShapeElement) => el.shape === 'line' || el.shape === 'arrow';

function box(el: ShapeElement) {
  const x = Math.min(el.from.x, el.to.x);
  const y = Math.min(el.from.y, el.to.y);
  return { x, y, width: Math.abs(el.to.x - el.from.x), height: Math.abs(el.to.y - el.from.y) };
}

function centre(el: ShapeElement): Point {
  const b = box(el);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * Binds a line end to `el` where the ray from its centre towards `target`
 * leaves its box — the same link the clients make when a line is dragged from
 * one figure's centre to another (web lib/geometry.ts `linkEndpoints`), so the
 * end follows the figure when it moves.
 */
function bind(el: ShapeElement, target: Point): { p: Point; link: Link } {
  const b = box(el);
  const c = centre(el);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const t =
    dx || dy
      ? Math.min(
          dx ? b.width / 2 / Math.abs(dx) : Infinity,
          dy ? b.height / 2 / Math.abs(dy) : Infinity,
        )
      : 0;
  const p = { x: c.x + dx * t, y: c.y + dy * t };
  return {
    p,
    link: {
      id: el.id,
      u: b.width ? clamp((p.x - b.x) / b.width, 0, 1) : 0.5,
      v: b.height ? clamp((p.y - b.y) / b.height, 0, 1) : 0.5,
    },
  };
}

/** Attaches a line's ends to the figures it names; an end without one keeps its coordinates. */
function connect(line: ShapeElement, a?: ShapeElement, b?: ShapeElement): void {
  if (a && a === b) b = undefined;
  if (a) {
    const end = bind(a, b ? centre(b) : line.to);
    line.from = end.p;
    line.fromLink = end.link;
  }
  if (b) {
    const end = bind(b, a ? centre(a) : line.from);
    line.to = end.p;
    line.toLink = end.link;
  }
}
