/** Permission rules. The client mirrors these; the server is the authority. */
import type { BoardMeta, Role, UserId } from './types.js';

export function roleFor(meta: BoardMeta, userId: UserId): Role {
  if (userId === meta.creatorId) return 'creator';
  if (meta.editPolicy === 'everyone') return 'editor';
  if (meta.editPolicy === 'selected' && meta.editors.includes(userId)) return 'editor';
  return 'viewer';
}

export function canEdit(meta: BoardMeta, userId: UserId): boolean {
  return roleFor(meta, userId) !== 'viewer';
}
