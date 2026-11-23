import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface VkIdOptions {
  readonly appId: string;
  readonly redirectUri: string;
  readonly cookieSecret: Buffer;
}

interface VkStatePayload {
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAt: number;
  readonly userId?: string;
}

export interface VkAuthorizationStart {
  readonly authorizationUrl: string;
  readonly stateCookie: string;
}

export interface VkAuthorizationCallback {
  readonly code: string;
  readonly deviceId: string;
  readonly state: string;
  readonly stateCookie: string | undefined;
}

interface VkTokenResponse {
  readonly access_token?: unknown;
  readonly user_id?: unknown;
  readonly state?: unknown;
}

interface VkUserInfoResponse {
  readonly user?: {
    readonly user_id?: unknown;
    readonly email?: unknown;
  };
}

function signPayload(encodedPayload: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret)
    .update(`paperwars-vkid:${encodedPayload}`, 'utf8')
    .digest();
}

function encodeState(payload: VkStatePayload, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signPayload(encoded, secret).toString('base64url')}`;
}

function decodeState(
  value: string | undefined,
  secret: Buffer,
  now: number,
): VkStatePayload | undefined {
  if (value === undefined || value.length > 4096) return undefined;
  const parts = value.split('.');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return undefined;
  const expected = signPayload(parts[0], secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], 'base64url');
  } catch {
    return undefined;
  }
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const payload = parsed as Record<string, unknown>;
    if (
      typeof payload['state'] !== 'string' ||
      typeof payload['codeVerifier'] !== 'string' ||
      typeof payload['expiresAt'] !== 'number' ||
      payload['expiresAt'] <= now ||
      (payload['userId'] !== undefined && typeof payload['userId'] !== 'string')
    ) {
      return undefined;
    }
    return {
      state: payload['state'],
      codeVerifier: payload['codeVerifier'],
      expiresAt: payload['expiresAt'],
      ...(typeof payload['userId'] === 'string' ? { userId: payload['userId'] } : {}),
    };
  } catch {
    return undefined;
  }
}

export function createVkAuthorizationStart(
  options: VkIdOptions,
  secureCookie: boolean,
  userId?: string,
  now = Date.now(),
): VkAuthorizationStart {
  if (options.cookieSecret.length < 32) {
    throw new RangeError('VK_ID_COOKIE_SECRET must be at least 32 bytes');
  }
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  const stateCookie = encodeState(
    {
      state,
      codeVerifier,
      expiresAt: now + 10 * 60 * 1000,
      ...(userId === undefined ? {} : { userId }),
    },
    options.cookieSecret,
  );

  const url = new URL('https://id.vk.ru/authorize');
  url.searchParams.set('client_id', options.appId);
  url.searchParams.set('app_id', options.appId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('sdk_type', 'vkid');
  url.searchParams.set('scope', 'email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 's256');
  url.searchParams.set('prompt', 'login consent');

  const cookieParts = [
    `vk_oauth_state=${encodeURIComponent(stateCookie)}`,
    'Path=/auth/vk/callback',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=600',
  ];
  if (secureCookie) cookieParts.push('Secure');

  return {
    authorizationUrl: url.toString(),
    stateCookie: cookieParts.join('; '),
  };
}

export async function completeVkAuthorization(
  options: VkIdOptions,
  callback: VkAuthorizationCallback,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{
  readonly providerUserId: string;
  readonly email?: string;
  readonly linkUserId?: string;
}> {
  const stateValue = decodeState(callback.stateCookie, options.cookieSecret, now);
  if (stateValue === undefined || stateValue.state !== callback.state) {
    throw new Error('VK authorization state is invalid or expired');
  }
  if (
    callback.code.length === 0 ||
    callback.code.length > 4096 ||
    callback.deviceId.length === 0 ||
    callback.deviceId.length > 512
  ) {
    throw new Error('VK authorization response is invalid');
  }

  const tokenUrl = new URL('https://id.vk.ru/oauth2/auth');
  tokenUrl.searchParams.set('grant_type', 'authorization_code');
  tokenUrl.searchParams.set('redirect_uri', options.redirectUri);
  tokenUrl.searchParams.set('client_id', options.appId);
  tokenUrl.searchParams.set('code_verifier', stateValue.codeVerifier);
  tokenUrl.searchParams.set('state', callback.state);
  tokenUrl.searchParams.set('device_id', callback.deviceId);
  const tokenResponse = await fetcher(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: callback.code }),
  });
  if (!tokenResponse.ok) throw new Error('VK ID token exchange failed');
  const token = (await tokenResponse.json()) as VkTokenResponse;
  if (
    typeof token.access_token !== 'string' ||
    (typeof token.user_id !== 'string' && typeof token.user_id !== 'number') ||
    token.state !== callback.state
  ) {
    throw new Error('VK ID returned an invalid token response');
  }

  const userInfoUrl = new URL('https://id.vk.ru/oauth2/user_info');
  userInfoUrl.searchParams.set('client_id', options.appId);
  const userInfoResponse = await fetcher(userInfoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: token.access_token }),
  });
  if (!userInfoResponse.ok) throw new Error('VK ID user information request failed');
  const userInfo = (await userInfoResponse.json()) as VkUserInfoResponse;
  const providerUserId = String(token.user_id);
  const infoUserId = userInfo.user?.user_id;
  if (infoUserId !== undefined && String(infoUserId) !== providerUserId) {
    throw new Error('VK ID user identity did not match the token');
  }
  const email = userInfo.user?.email;
  return {
    providerUserId,
    ...(typeof email === 'string' && email.trim().length > 0 ? { email: email.trim() } : {}),
    ...(stateValue.userId === undefined ? {} : { linkUserId: stateValue.userId }),
  };
}
