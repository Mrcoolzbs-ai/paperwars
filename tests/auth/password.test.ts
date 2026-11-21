import { describe, expect, it } from 'vitest';
import {
  AuthValidationError,
  hashPassword,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} from '@paper-wars/auth';

describe('password and email primitives', () => {
  it('normalizes email addresses before storage and lookup', () => {
    expect(normalizeEmail('  Player.One@Example.COM  ')).toBe('player.one@example.com');
    expect(() => normalizeEmail('not-an-email')).toThrow(AuthValidationError);
    expect(() => normalizeEmail(null)).toThrow(AuthValidationError);
  });

  it('enforces password byte length', () => {
    expect(() => validatePassword('short')).toThrow(AuthValidationError);
    expect(() => validatePassword('x'.repeat(1025))).toThrow(AuthValidationError);
    expect(() => validatePassword('correct horse battery staple')).not.toThrow();
  });

  it('hashes passwords with unique salts and verifies only the correct password', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).not.toBe(second);
    expect(first.split('$').slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(true);
    await expect(verifyPassword('incorrect battery staple', first)).resolves.toBe(false);
    await expect(verifyPassword('correct horse battery staple', 'not-a-hash')).resolves.toBe(false);
  });
});
