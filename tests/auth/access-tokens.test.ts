import { describe, expect, it } from 'vitest';
import { createAccessTokenSigner, UnauthenticatedError } from '@paper-wars/auth';

describe('HS256 access tokens', () => {
  it('issues and verifies a short-lived signed token', () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x44),
      issuer: 'paper-wars-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
      clock: () => now,
    });

    const issued = signer.issue('user-123');
    const claims = signer.verify(issued.accessToken);

    expect(claims.sub).toBe('user-123');
    expect(claims.iss).toBe('paper-wars-tests');
    expect(claims.aud).toBe('paper-wars-web');
    expect(claims.exp - claims.iat).toBe(900);
    expect(issued.accessTokenExpiresAt.toISOString()).toBe('2026-11-21T12:15:00.000Z');
  });

  it('rejects modified, foreign and expired tokens', () => {
    let now = new Date('2026-11-21T12:00:00.000Z');
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x44),
      issuer: 'paper-wars-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
      clock: () => now,
    });
    const otherSigner = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x55),
      issuer: 'paper-wars-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
      clock: () => now,
    });

    const token = signer.issue('user-123').accessToken;
    const parts = token.split('.');
    const payload = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8');
    const modifiedPayload = Buffer.from(payload.replace('user-123', 'user-999')).toString(
      'base64url',
    );

    expect(() => signer.verify(`${parts[0]}.${modifiedPayload}.${parts[2]}`)).toThrow(
      UnauthenticatedError,
    );
    expect(() => otherSigner.verify(token)).toThrow(UnauthenticatedError);

    now = new Date('2026-11-21T12:16:00.000Z');
    expect(() => signer.verify(token)).toThrow(UnauthenticatedError);
  });

  it('rejects weak secrets and invalid token lifetimes', () => {
    expect(() =>
      createAccessTokenSigner({
        secret: Buffer.alloc(16),
        issuer: 'issuer',
        audience: 'audience',
        ttlSeconds: 900,
      }),
    ).toThrow(/at least 32 random bytes/);

    expect(() =>
      createAccessTokenSigner({
        secret: Buffer.alloc(32),
        issuer: 'issuer',
        audience: 'audience',
        ttlSeconds: 30,
      }),
    ).toThrow(/between 60 and 3600/);
  });
});
