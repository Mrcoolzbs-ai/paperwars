import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuthValidationError, UnauthenticatedError } from './errors.js';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly jti: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

export interface AccessTokenPairPart {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
}

export interface AccessTokenSignerOptions {
  readonly secret: Buffer;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly clock?: () => Date;
}

export interface AccessTokenSigner {
  issue(subject: string): AccessTokenPairPart;
  verify(token: string): AccessTokenClaims;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new UnauthenticatedError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createAccessTokenSigner(options: AccessTokenSignerOptions): AccessTokenSigner {
  if (!Buffer.isBuffer(options.secret) || options.secret.length < 32) {
    throw new RangeError('ACCESS_TOKEN_SECRET must contain at least 32 random bytes');
  }
  if (options.issuer.trim().length === 0 || options.audience.trim().length === 0) {
    throw new AuthValidationError('Access token issuer and audience must not be empty');
  }
  if (
    !Number.isSafeInteger(options.ttlSeconds) ||
    options.ttlSeconds < 60 ||
    options.ttlSeconds > 3600
  ) {
    throw new RangeError('Access token TTL must be an integer between 60 and 3600 seconds');
  }

  const clock = options.clock ?? (() => new Date());

  const sign = (input: string): Buffer =>
    createHmac('sha256', options.secret).update(input, 'utf8').digest();

  return {
    issue(subject: string): AccessTokenPairPart {
      if (subject.trim().length === 0) {
        throw new AuthValidationError('Access token subject must not be empty');
      }
      const now = clock();
      const issuedAt = Math.floor(now.getTime() / 1000);
      const expiresAtSeconds = issuedAt + options.ttlSeconds;
      const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
      const payload = encodeJson({
        iss: options.issuer,
        aud: options.audience,
        sub: subject,
        jti: randomUUID(),
        iat: issuedAt,
        exp: expiresAtSeconds,
      });
      const signingInput = `${header}.${payload}`;
      const signature = sign(signingInput).toString('base64url');

      return {
        accessToken: `${signingInput}.${signature}`,
        accessTokenExpiresAt: new Date(expiresAtSeconds * 1000),
      };
    },

    verify(token: string): AccessTokenClaims {
      if (typeof token !== 'string' || token.length > 8192) {
        throw new UnauthenticatedError();
      }
      const segments = token.split('.');
      if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
        throw new UnauthenticatedError();
      }

      const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
      const header = decodeJson(encodedHeader);
      const payload = decodeJson(encodedPayload);
      if (!isRecord(header) || header['alg'] !== 'HS256' || header['typ'] !== 'JWT') {
        throw new UnauthenticatedError();
      }

      const expected = sign(`${encodedHeader}.${encodedPayload}`);
      let provided: Buffer;
      try {
        provided = Buffer.from(encodedSignature, 'base64url');
      } catch {
        throw new UnauthenticatedError();
      }
      if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
        throw new UnauthenticatedError();
      }

      if (
        !isRecord(payload) ||
        payload['iss'] !== options.issuer ||
        payload['aud'] !== options.audience ||
        typeof payload['sub'] !== 'string' ||
        payload['sub'].length === 0 ||
        typeof payload['jti'] !== 'string' ||
        payload['jti'].length === 0 ||
        !Number.isSafeInteger(payload['iat']) ||
        !Number.isSafeInteger(payload['exp'])
      ) {
        throw new UnauthenticatedError();
      }

      const issuedAt = payload['iat'] as number;
      const expiresAt = payload['exp'] as number;
      const nowSeconds = Math.floor(clock().getTime() / 1000);
      if (
        issuedAt > nowSeconds + 30 ||
        expiresAt <= nowSeconds ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > options.ttlSeconds
      ) {
        throw new UnauthenticatedError();
      }

      return {
        sub: payload['sub'],
        jti: payload['jti'],
        iss: options.issuer,
        aud: options.audience,
        iat: issuedAt,
        exp: expiresAt,
      };
    },
  };
}
