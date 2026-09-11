/**
 * Board data model — the contract shared with the web and mobile clients.
 * Mirrors mobile/docs/05-model-date.
 */

export type UserId = string;
export type BoardAccess = 'public' | 'private';
export type EditPolicy = 'everyone' | 'selected' | 'creator-only';
export type Role = 'creator' | 'editor' | 'viewer';

export interface Point {
  x: number;
  y: number;
}

interface ElementBase {
  id: string;
  createdBy: UserId;
  createdAt: number;
  updatedAt: number;
  /** Paint order; higher is on top. Assigned on `add`. */
  z: number;
  /** Soft delete, so removals propagate deterministically. */
  deleted?: boolean;
}

export interface StrokeElement extends ElementBase {
  kind: 'stroke';
  /** Flat [x0, y0, x1, y1, ...]. */
  points: number[];
  color: string;
  width: number;
}

export interface ShapeElement extends ElementBase {
  kind: 'shape';
  shape: 'rectangle' | 'ellipse' | 'triangle' | 'line' | 'arrow';
  from: Point;
  to: Point;
  stroke: string;
  strokeWidth: number;
  fill?: string | null;
}

export interface TextElement extends ElementBase {
  kind: 'text';
  at: Point;
  text: string;
  color: string;
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
}

export interface ImageElement extends ElementBase {
  kind: 'image';
  at: Point;
  width: number;
  height: number;
  /** Remote URL or data: URI. */
  uri: string;
}

export type BoardElement = StrokeElement | ShapeElement | TextElement | ImageElement;

export interface BoardMeta {
  id: string;
  shortCode: string;
  name: string;
  access: BoardAccess;
  editPolicy: EditPolicy;
  /** userIds allowed to edit when editPolicy is 'selected'. */
  editors: UserId[];
  creatorId: UserId;
  /** The PIN itself never leaves the server. */
  hasPin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Participant {
  userId: UserId;
  nickname: string;
  /** Presence color, assigned by the server on join. */
  color: string;
  role: Role;
  cursor?: Point;
  lastSeen: number;
}

/** Unit of change applied to a board. */
export type Op =
  | { t: 'add'; el: BoardElement }
  | { t: 'update'; id: string; patch: Partial<BoardElement>; updatedAt: number }
  | { t: 'delete'; id: string }
  | { t: 'clear' };

/** Export / import file format. */
export interface BoardSnapshot {
  format: 'live-whiteboard';
  version: 1;
  meta: { name: string };
  elements: BoardElement[];
  exportedAt: number;
}

/** Validation limits, enforced on both client and server. */
export const LIMITS = {
  maxElements: 5000,
  maxStrokePoints: 2000,
  maxTextLength: 2000,
  minStrokeWidth: 1,
  maxStrokeWidth: 64,
  minFontSize: 10,
  maxFontSize: 96,
  maxNicknameLength: 24,
  maxBoardNameLength: 80,
  /** #RRGGBB, or #RRGGBBAA for the translucent fills the shape tool paints. */
  colorPattern: /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/,
} as const;

/** Presence colors handed out in join order. */
export const PRESENCE_COLORS = [
  '#E5484D',
  '#F76808',
  '#30A46C',
  '#208AEF',
  '#8E4EC6',
  '#0EA5E9',
] as const;
