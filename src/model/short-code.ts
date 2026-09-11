/** Crockford base32 without ambiguous characters (no I L O U 0 1). */
import { randomInt } from 'node:crypto';

export const SHORT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHORT_CODE_LENGTH = 6;

export function generateShortCode(): string {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  }
  return code;
}

/** Uppercases and strips separators the user may have typed. */
export function normalizeShortCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function isValidShortCode(input: string): boolean {
  const code = normalizeShortCode(input);
  return (
    code.length === SHORT_CODE_LENGTH &&
    [...code].every((c) => SHORT_CODE_ALPHABET.includes(c))
  );
}
