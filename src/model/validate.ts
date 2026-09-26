/**
 * Hand-rolled validation of everything that arrives from a client.
 * Throws `AppError('VALIDATION')`; limits come from `LIMITS`.
 */
import { invalid } from '../errors.js';
import { DASHES, LIMITS, MARKERS, ROUTES } from './types.js';
import type {
  BoardAccess,
  BoardElement,
  BoardSnapshot,
  EditPolicy,
  Link,
  Op,
  Point,
} from './types.js';

const ACCESS: BoardAccess[] = ['public', 'private'];
const POLICIES: EditPolicy[] = ['everyone', 'selected', 'creator-only'];
const SHAPES = ['rectangle', 'ellipse', 'triangle', 'line', 'arrow'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.length === 0) throw invalid(`"${field}" must be a string`);
  if (v.length > max) throw invalid(`"${field}" exceeds ${max} characters`);
  return v;
}

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`"${field}" must be a number`);
  return v;
}

function color(v: unknown, field: string): string {
  if (typeof v !== 'string' || !LIMITS.colorPattern.test(v)) {
    throw invalid(`"${field}" must be a #RRGGBB color`);
  }
  return v;
}

function point(v: unknown, field: string): Point {
  if (!isObject(v)) throw invalid(`"${field}" must be a point`);
  return { x: num(v.x, `${field}.x`), y: num(v.y, `${field}.y`) };
}

function inRange(v: number, min: number, max: number, field: string): number {
  if (v < min || v > max) throw invalid(`"${field}" must be between ${min} and ${max}`);
  return v;
}

/** An optional enum field: absent stays absent, present must be one of `values`. */
function oneOf<T extends string>(
  v: unknown,
  values: readonly T[],
  field: string,
): { [k: string]: T } {
  if (v === undefined) return {};
  if (!values.includes(v as T)) throw invalid(`"${field}" is not valid`);
  return { [field]: v as T };
}

/** An optional link: absent stays absent, null unbinds, otherwise `{id, u, v}` with u, v in 0..1. */
function link(v: unknown, field: string): { [k: string]: Link | null } {
  if (v === undefined) return {};
  if (v === null) return { [field]: null };
  if (!isObject(v)) throw invalid(`"${field}" must be a link`);
  return {
    [field]: {
      id: str(v.id, `${field}.id`, 64),
      u: inRange(num(v.u, `${field}.u`), 0, 1, `${field}.u`),
      v: inRange(num(v.v, `${field}.v`), 0, 1, `${field}.v`),
    },
  };
}

export function validateNickname(v: unknown): string {
  const nickname = str(v, 'nickname', LIMITS.maxNicknameLength).trim();
  if (!nickname) throw invalid('"nickname" must not be empty');
  return nickname;
}

export function validatePin(v: unknown): string {
  const pin = str(v, 'pin', 12);
  if (!/^\d{4,12}$/.test(pin)) throw invalid('"pin" must be 4 to 12 digits');
  return pin;
}

export interface CreateBoardBody {
  name: string;
  access: BoardAccess;
  editPolicy: EditPolicy;
  pin?: string;
  creatorId: string;
}

export function validateCreateBoard(body: unknown): CreateBoardBody {
  if (!isObject(body)) throw invalid('Body must be an object');
  const access = body.access as BoardAccess;
  const editPolicy = body.editPolicy as EditPolicy;
  if (!ACCESS.includes(access)) throw invalid('"access" must be public or private');
  if (!POLICIES.includes(editPolicy)) throw invalid('"editPolicy" is not a valid policy');

  const name = str(body.name, 'name', LIMITS.maxBoardNameLength).trim() || 'Untitled board';
  const creatorId = str(body.creatorId, 'creatorId', 64);
  if (access === 'private' && body.pin == null) throw invalid('A private board requires a "pin"');

  return {
    name,
    access,
    editPolicy,
    creatorId,
    ...(body.pin != null ? { pin: validatePin(body.pin) } : {}),
  };
}

export interface JoinBody {
  userId: string;
  nickname: string;
  pin?: string;
  /** Preferred presence colour. Advisory — see the join route. */
  color?: string;
  /** Presence icon picked on the identity screen. */
  avatar?: string;
}

export function validateJoin(body: unknown): JoinBody {
  if (!isObject(body)) throw invalid('Body must be an object');
  return {
    userId: str(body.userId, 'userId', 64),
    nickname: validateNickname(body.nickname),
    ...(body.pin != null ? { pin: validatePin(body.pin) } : {}),
    ...(body.color != null ? { color: color(body.color, 'color') } : {}),
    ...(body.avatar != null ? { avatar: str(body.avatar, 'avatar', 8) } : {}),
  };
}

export interface PermissionsBody {
  access?: BoardAccess;
  editPolicy?: EditPolicy;
  editors?: string[];
  /** string sets the PIN, null clears it, undefined leaves it alone. */
  pin?: string | null;
}

export function validatePermissions(body: unknown): PermissionsBody {
  if (!isObject(body)) throw invalid('Body must be an object');
  const patch: PermissionsBody = {};

  if (body.access !== undefined) {
    if (!ACCESS.includes(body.access as BoardAccess)) throw invalid('"access" is not valid');
    patch.access = body.access as BoardAccess;
  }
  if (body.editPolicy !== undefined) {
    if (!POLICIES.includes(body.editPolicy as EditPolicy)) throw invalid('"editPolicy" is not valid');
    patch.editPolicy = body.editPolicy as EditPolicy;
  }
  if (body.editors !== undefined) {
    if (!Array.isArray(body.editors)) throw invalid('"editors" must be an array');
    patch.editors = body.editors.map((id, i) => str(id, `editors[${i}]`, 64));
  }
  if (body.pin !== undefined) {
    patch.pin = body.pin === null ? null : validatePin(body.pin);
  }
  return patch;
}

/** Validates one element and returns it narrowed. `z` is re-assigned by the store. */
export function validateElement(input: unknown): BoardElement {
  if (!isObject(input)) throw invalid('Element must be an object');

  const base = {
    id: str(input.id, 'element.id', 64),
    createdBy: str(input.createdBy, 'element.createdBy', 64),
    createdAt: num(input.createdAt, 'element.createdAt'),
    updatedAt: num(input.updatedAt, 'element.updatedAt'),
    z: typeof input.z === 'number' ? input.z : 0,
    ...(input.deleted === true ? { deleted: true as const } : {}),
    ...(typeof input.group === 'string' ? { group: str(input.group, 'element.group', 64) } : {}),
  };

  switch (input.kind) {
    case 'stroke': {
      if (!Array.isArray(input.points) || input.points.length % 2 !== 0) {
        throw invalid('"points" must be a flat [x, y, ...] array');
      }
      if (input.points.length / 2 > LIMITS.maxStrokePoints) {
        throw invalid(`A stroke may not exceed ${LIMITS.maxStrokePoints} points`);
      }
      return {
        ...base,
        kind: 'stroke',
        points: input.points.map((n, i) => num(n, `points[${i}]`)),
        color: color(input.color, 'color'),
        width: inRange(num(input.width, 'width'), LIMITS.minStrokeWidth, LIMITS.maxStrokeWidth, 'width'),
      };
    }
    case 'shape': {
      if (!SHAPES.includes(input.shape as string)) throw invalid('"shape" is not a valid shape');
      return {
        ...base,
        kind: 'shape',
        shape: input.shape as 'rectangle' | 'ellipse' | 'triangle' | 'line' | 'arrow',
        from: point(input.from, 'from'),
        to: point(input.to, 'to'),
        stroke: color(input.stroke, 'stroke'),
        strokeWidth: inRange(
          num(input.strokeWidth, 'strokeWidth'),
          LIMITS.minStrokeWidth,
          LIMITS.maxStrokeWidth,
          'strokeWidth',
        ),
        fill: input.fill == null ? null : color(input.fill, 'fill'),
        ...(typeof input.text === 'string' && input.text
          ? { text: str(input.text, 'text', LIMITS.maxTextLength) }
          : null),
        ...(input.fontSize !== undefined
          ? {
              fontSize: inRange(
                num(input.fontSize, 'fontSize'),
                LIMITS.minFontSize,
                LIMITS.maxFontSize,
                'fontSize',
              ),
            }
          : null),
        ...oneOf(input.headStart, MARKERS, 'headStart'),
        ...oneOf(input.headEnd, MARKERS, 'headEnd'),
        ...oneOf(input.route, ROUTES, 'route'),
        ...(input.bend !== undefined ? { bend: num(input.bend, 'bend') } : null),
        ...oneOf(input.dash, DASHES, 'dash'),
        ...link(input.fromLink, 'fromLink'),
        ...link(input.toLink, 'toLink'),
      };
    }
    case 'text': {
      return {
        ...base,
        kind: 'text',
        at: point(input.at, 'at'),
        // Empty is allowed: the editor adds the element first and types into
        // it; a label left empty is deleted by the client on commit.
        text: input.text === '' ? '' : str(input.text, 'text', LIMITS.maxTextLength),
        color: color(input.color, 'color'),
        fontSize: inRange(
          num(input.fontSize, 'fontSize'),
          LIMITS.minFontSize,
          LIMITS.maxFontSize,
          'fontSize',
        ),
        bold: input.bold === true,
        italic: input.italic === true,
      };
    }
    case 'image': {
      return {
        ...base,
        kind: 'image',
        at: point(input.at, 'at'),
        width: num(input.width, 'width'),
        height: num(input.height, 'height'),
        uri: str(input.uri, 'uri', 4 * 1024 * 1024),
      };
    }
    default:
      throw invalid(`Unknown element kind "${String(input.kind)}"`);
  }
}

export function validateOps(input: unknown): Op[] {
  if (!Array.isArray(input) || input.length === 0) throw invalid('"ops" must be a non-empty array');
  return input.map((raw): Op => {
    if (!isObject(raw)) throw invalid('Op must be an object');
    switch (raw.t) {
      case 'add':
        return { t: 'add', el: validateElement(raw.el) };
      case 'update':
        if (!isObject(raw.patch)) throw invalid('"patch" must be an object');
        return {
          t: 'update',
          id: str(raw.id, 'op.id', 64),
          patch: raw.patch as Partial<BoardElement>,
          updatedAt: num(raw.updatedAt, 'op.updatedAt'),
        };
      case 'delete':
        return { t: 'delete', id: str(raw.id, 'op.id', 64) };
      case 'clear':
        return { t: 'clear' };
      default:
        throw invalid(`Unknown op "${String(raw.t)}"`);
    }
  });
}

export function validateSnapshot(input: unknown): BoardSnapshot {
  if (!isObject(input)) throw invalid('Snapshot must be an object');
  if (input.format !== 'live-whiteboard') throw invalid('Not a Live Whiteboard file');
  if (input.version !== 1) throw invalid(`Unsupported file version ${String(input.version)}`);
  if (!Array.isArray(input.elements)) throw invalid('"elements" must be an array');
  if (input.elements.length > LIMITS.maxElements) {
    throw invalid(`File exceeds the element limit (${LIMITS.maxElements})`);
  }

  const meta = isObject(input.meta) ? input.meta : {};
  return {
    format: 'live-whiteboard',
    version: 1,
    meta: {
      name:
        typeof meta.name === 'string'
          ? meta.name.slice(0, LIMITS.maxBoardNameLength)
          : 'Imported board',
    },
    elements: input.elements.map(validateElement),
    exportedAt: typeof input.exportedAt === 'number' ? input.exportedAt : Date.now(),
  };
}
