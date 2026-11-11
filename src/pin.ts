/** PIN and password hashing. Neither is ever stored or returned in clear. */
import crypto, { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { codeHash, sameHash } from './tokens.js';

const scryptAsync = (secret: string, salt: Buffer, params: object) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(secret, salt, 32, params, (err, key) => (err ? reject(err) : resolve(key))),
  );

/**
 * PINs: an HMAC under TOKEN_SECRET, like the emailed codes, stored as
 * `p1$<salt>$<mac>`. A slow hash buys nothing for 4 to 12 digits (10^4 guesses
 * at scrypt's ~45 ms is minutes of one core), yet cost ~45 ms on every guest
 * join; online guessing is held by the PIN rate limit, and a leaked database
 * cannot be tried offline without the secret. Microseconds, so no thread pool.
 * Rotating TOKEN_SECRET leaves guests unable to enter PIN boards until the
 * creator sets the PIN again (creator and members are never asked).
 * The older `<salt>:<key>` scrypt form still verifies; `pinNeedsRehash` upgrades it.
 */
export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  return `p1$${salt}$${codeHash('pin', salt, pin)}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (stored.startsWith('p1$')) {
    const [salt, mac] = stored.slice(3).split('$');
    return !!salt && !!mac && sameHash(mac, codeHash('pin', salt, pin));
  }
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const key = await scryptAsync(pin, Buffer.from(saltHex, 'hex'), {});
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const pinNeedsRehash = (stored: string) => !stored.startsWith('p1$');

/**
 * Passwords: Argon2id, OWASP's first choice, at its 19 MiB, t=2, p=1 minimum.
 * About six times less CPU per sign-in than the scrypt it replaces, which is
 * OWASP's equal-strength fallback at N=2^14, r=8, p=5 (16 MB; the 128 MB N=2^17
 * form would crowd a 512 MB instance). `crypto.argon2` needs Node 24.7+, so on
 * Node 22 passwords keep using scrypt.
 *
 * Stored as `a1$<salt>$<key>` or `s1$<salt>$<key>`; the older `<salt>:<key>`
 * (hashPin's, N=2^14 p=1) still verifies, and `needsRehash` tells the caller to
 * upgrade whatever is not the best this Node has. Both run on the thread pool.
 *
 * Once accounts hold `a1$` hashes, going back to Node 22 locks them out of
 * signing in until they reset their password.
 */
const ARGON2_PARAMS = { parallelism: 1, tagLength: 32, memory: 19_456, passes: 2 };
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 5 };
const hasArgon2 = typeof crypto.argon2 === 'function';

const argon2Async = (password: string, nonce: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.argon2('argon2id', { message: password, nonce, ...ARGON2_PARAMS }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  if (hasArgon2) return `a1$${salt.toString('hex')}$${(await argon2Async(password, salt)).toString('hex')}`;
  return `s1$${salt.toString('hex')}$${(await scryptAsync(password, salt, SCRYPT_PARAMS)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const scheme = stored.startsWith('a1$') ? 'a1' : stored.startsWith('s1$') ? 's1' : 'legacy';
  const [saltHex, keyHex] = scheme === 'legacy' ? stored.split(':') : stored.slice(3).split('$');
  if (!saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  if (scheme === 'a1' && !hasArgon2) throw new Error('This password was hashed with Argon2id, which needs Node 24.7 or newer');
  const key =
    scheme === 'a1'
      ? await argon2Async(password, salt)
      : await scryptAsync(password, salt, scheme === 's1' ? SCRYPT_PARAMS : {});
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const needsRehash = (stored: string) => !stored.startsWith(hasArgon2 ? 'a1$' : 's1$') && !stored.startsWith('a1$');
