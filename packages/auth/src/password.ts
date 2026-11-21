import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AuthValidationError } from './errors.js';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthValidationError('Email must be a string');
  }

  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    Buffer.byteLength(email, 'utf8') > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new AuthValidationError('Email address is invalid');
  }

  return email;
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new AuthValidationError('Password must be a string');
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 12 || bytes > 1024) {
    throw new AuthValidationError('Password must contain between 12 and 1024 UTF-8 bytes');
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await deriveKey(password, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

export const DUMMY_PASSWORD_HASH = [
  'scrypt',
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  Buffer.alloc(SALT_LENGTH).toString('base64url'),
  Buffer.alloc(KEY_LENGTH).toString('base64url'),
].join('$');

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024) {
    return false;
  }

  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64url');
    expected = Buffer.from(parts[5] ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
    return false;
  }

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}
