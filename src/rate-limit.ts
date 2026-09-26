/**
 * Fixed-window counters kept in memory. Enough to blunt spam and PIN guessing.
 * ponytail: per process; with several instances move `allow` to Redis INCR + PEXPIRE.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

/** Returns false when `key` has already used up `limit` hits in the window. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = windows.get(key);

  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

/** Drops expired windows so the map cannot grow without bound. */
export function startRateLimitCleanup(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) if (entry.resetAt <= now) windows.delete(key);
  }, 60_000).unref();
}
