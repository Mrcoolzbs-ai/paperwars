import { describe, expect, it } from 'vitest';
import { completeVkAuthorization, createVkAuthorizationStart } from '@paper-wars/api';

const pkceTestTitle =
  'creates an authorization-code PKCE request with a signed HttpOnly state cookie';
const exchangeTestTitle =
  'exchanges the code server-side and verifies the VK identity in user info';
const stateErrorTitle =
  'rejects a forged or mismatched state before exchanging the code';

const options = {
  appId: '12345678',
  redirectUri: 'https://paper-wars.example/auth/vk/callback',
  cookieSecret: Buffer.alloc(32, 0x49),
};

function cookieValue(header: string): string {
  const pair = header.split(';')[0];
  if (pair === undefined) throw new Error('Cookie header is empty');
  const separator = pair.indexOf('=');
  return decodeURIComponent(pair.slice(separator + 1));
}

describe('VK ID OAuth 2.1 integration', () => {
  it(pkceTestTitle, () => {
    const start = createVkAuthorizationStart(options, true, 'user-42');
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe('https://id.vk.ru');
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('client_id')).toBe(options.appId);
    expect(url.searchParams.get('app_id')).toBe(options.appId);
    expect(url.searchParams.get('redirect_uri')).toBe(options.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('sdk_type')).toBe('vkid');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.stateCookie).toContain('HttpOnly');
    expect(start.stateCookie).toContain('SameSite=Lax');
    expect(start.stateCookie).toContain('Secure');
  });

  it(exchangeTestTitle, async () => {
    const start = createVkAuthorizationStart(options, false);
    const authUrl = new URL(start.authorizationUrl);
    const state = authUrl.searchParams.get('state');
    if (state === null) throw new Error('State was not set');
    const stateCookie = cookieValue(start.stateCookie);
    const calls: URL[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = input instanceof URL ? input : new URL(input.toString());
      calls.push(url);
      if (url.pathname === '/oauth2/auth') {
        expect(url.searchParams.get('grant_type')).toBe('authorization_code');
        expect(url.searchParams.get('code_challenge')).toBeNull();
        expect(
          new URLSearchParams(init?.body as URLSearchParams).get('code'),
        ).toBe('test-code');
        return new Response(
          JSON.stringify({ access_token: 'vk-private-access-token', user_id: 42, state }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      expect(url.pathname).toBe('/oauth2/user_info');
      expect(new URLSearchParams(init?.body as URLSearchParams).get('access_token')).toBe(
        'vk-private-access-token',
      );
      return new Response(
        JSON.stringify({ user: { user_id: 42, email: 'player@example.test' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const result = await completeVkAuthorization(
      options,
      { code: 'test-code', deviceId: 'device-42', state, stateCookie },
      fakeFetch,
    );
    expect(result).toEqual({
      providerUserId: '42',
      email: 'player@example.test',
    });
    expect(calls.map((url) => url.pathname)).toEqual([
      '/oauth2/auth',
      '/oauth2/user_info',
    ]);
  });

  it(stateErrorTitle, async () => {
    const start = createVkAuthorizationStart(options, false);
    const authUrl = new URL(start.authorizationUrl);
    const state = authUrl.searchParams.get('state');
    if (state === null) throw new Error('State was not set');
    let fetchCalled = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    await expect(
      completeVkAuthorization(
        options,
        {
          code: 'test-code',
          deviceId: 'device-42',
          state: 'attacker-controlled-state',
          stateCookie: cookieValue(start.stateCookie),
        },
        fakeFetch,
      ),
    ).rejects.toThrow(/state is invalid or expired/);
    expect(fetchCalled).toBe(false);
  });
});
