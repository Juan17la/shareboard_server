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
  /** Elements sharing a group id select and move as one. */
  group?: string | null;
  /**
   * Radians, clockwise, about the centre of the element's box. Only boxes
   * (enclosed shapes), text and images turn; lines and strokes ignore it —
   * their points already say which way they go.
   */
  rotation?: number;
}

/** What a line or arrow ends in. */
export const MARKERS = [
  'none',
  'arrow',
  'triangle',
  'triangle-outline',
  'circle',
  'circle-outline',
  'circle-half',
  'diamond',
  'diamond-outline',
  'bar',
  'one',
  'many',
  'zero-one',
  'zero-many',
  'one-many',
] as const;
export type Marker = (typeof MARKERS)[number];
export const ROUTES = ['straight', 'curved', 'elbow'] as const;
export type Route = (typeof ROUTES)[number];
/** Which way a line runs at one of an elbow's ends: across (`h`) or up and down (`v`). */
export const AXES = ['h', 'v'] as const;
export type Axis = (typeof AXES)[number];
export const DASHES = ['solid', 'dashed', 'dotted'] as const;
export type Dash = (typeof DASHES)[number];
/** Typefaces a text or a figure's label can be set in; absent is `sans` (Nunito). */
export const FONTS = ['sans', 'serif', 'mono', 'hand'] as const;
export type FontKey = (typeof FONTS)[number];

/** A line end bound to a shape: the point is (u, v) ∈ [0,1]² of that shape's box. */
export interface Link {
  id: string;
  u: number;
  v: number;
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
  shape: 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | 'line' | 'arrow';
  from: Point;
  to: Point;
  stroke: string;
  strokeWidth: number;
  fill?: string | null;
  /** Optional label, centred inside the shape (on the midpoint of a line). */
  text?: string;
  /** Label size; `SHAPE_TEXT_SIZE` when absent. */
  fontSize?: number;
  /** Label typeface; `sans` when absent. */
  font?: FontKey;
  /** A line's label: how far along its route it stands, 0..1; the middle when absent. */
  labelAt?: number;
  /** A polygon's corner count, `LIMITS.minSides`..`maxSides`; `DEFAULT_SIDES` when absent. */
  sides?: number;
  // Lines and arrows only. Absent: no start marker, an `arrow` head on an arrow.
  headStart?: Marker;
  headEnd?: Marker;
  route?: Route;
  /**
   * How far a curved or elbow route is folded from its default: a curve's
   * sideways offset in board units (signed, left/right of the chord); an
   * elbow's turn point as a fraction (0..1) along the long axis. Absent is
   * the route's default fold — a quarter-length curve, a midpoint elbow.
   */
  bend?: number;
  dash?: Dash;
  /**
   * Elbow only: the direction the line leaves its start / arrives at its end
   * along. Absent: the long axis — or, at an end bound to a side of a shape,
   * straight out of that side. Two different axes make a single corner.
   */
  startAxis?: Axis;
  endAxis?: Axis;
  /**
   * Curved only: where the two control points of the curve stand, as offsets
   * from the start and from the end — the direction and pull of the line
   * there. Absent: the original fixed bow (`bend`).
   */
  curveFrom?: Point;
  curveTo?: Point;
  /** Ends bound to a shape follow it when it moves. Null: unbound. */
  fromLink?: Link | null;
  toLink?: Link | null;
}

export interface TextElement extends ElementBase {
  kind: 'text';
  at: Point;
  text: string;
  color: string;
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  /** Typeface; `sans` when absent. */
  font?: FontKey;
  /** Wrap width in board units; absent, each line is as long as it is typed. */
  width?: number;
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
  /** Presence icon (an emoji) picked by the user; the initial when absent. */
  avatar?: string;
  role: Role;
  cursor?: Point;
  /**
   * Element ids this participant has selected — and so holds: first to select
   * wins, and nobody else can select or change them until they are let go
   * (deselected, or the participant leaves).
   */
  selection?: string[];
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
  maxFontSize: 400,
  minSides: 4,
  maxSides: 12,
  maxNicknameLength: 40,
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
