/** Applying ops to a board's element map. Re-applying an op is idempotent. */
import { LIMITS } from './types.js';
import type { BoardElement, Op } from './types.js';

/** Mutates `elements` in place and returns the highest `z` now in use. */
export function applyOps(elements: Map<string, BoardElement>, ops: Op[], topZ: number): number {
  let z = topZ;

  for (const op of ops) {
    switch (op.t) {
      case 'add': {
        // The server owns paint order so concurrent adds cannot collide.
        // Stamped on the op itself so the broadcast carries the same z.
        z += 1;
        op.el.z = z;
        elements.set(op.el.id, op.el);
        break;
      }
      case 'update': {
        const current = elements.get(op.id);
        if (!current) break;
        const next: Record<string, unknown> = { ...current, ...op.patch, updatedAt: op.updatedAt };
        // `null` in a patch means "unset" (an undo of a key the element did not have).
        for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
        elements.set(op.id, next as unknown as BoardElement);
        // "Bring to front" raises a z past the counter; the next add must clear it.
        if (typeof op.patch.z === 'number' && op.patch.z > z) z = op.patch.z;
        break;
      }
      case 'delete': {
        const current = elements.get(op.id);
        if (current) elements.set(op.id, { ...current, deleted: true, updatedAt: Date.now() });
        break;
      }
      case 'clear': {
        elements.clear();
        z = 0;
        break;
      }
    }
  }
  return z;
}

/** Visible elements in paint order — what clients and snapshots consume. */
export function visibleElements(elements: Map<string, BoardElement>): BoardElement[] {
  return [...elements.values()].filter((el) => !el.deleted).sort((a, b) => a.z - b.z);
}

export function isOverElementLimit(elements: Map<string, BoardElement>, incoming: number): boolean {
  return elements.size + incoming > LIMITS.maxElements;
}
