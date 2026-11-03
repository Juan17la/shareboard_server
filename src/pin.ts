/** PIN and password hashing (scrypt). Neither is ever stored or returned in clear. */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pin, salt, 32);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const key = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * Passwords: scrypt N=2^14, r=8, p=5 — OWASP's minimum, in its 16 MB form (the
 * 128 MB N=2^17 one would crowd a 512 MB instance). Async, so a sign-in runs on
 * the thread pool instead of stalling every board socket for ~100 ms.
 * Stored as `s1$<salt>$<key>`; the older `<salt>:<key>` (hashPin's, N=2^14 p=1)
 * still verifies, and `needsRehash` tells the caller to upgrade it.
 */
const PASSWORD_PARAMS = { N: 2 ** 14, r: 8, p: 5 };

const scryptAsync = (password: string, salt: Buffer, params: typeof PASSWORD_PARAMS | object) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 32, params, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, PASSWORD_PARAMS);
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const legacy = !stored.startsWith('s1$');
  const [saltHex, keyHex] = legacy ? stored.split(':') : stored.slice(3).split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), legacy ? {} : PASSWORD_PARAMS);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const needsRehash = (stored: string) => !stored.startsWith('s1$');
