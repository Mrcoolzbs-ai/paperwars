import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '@paper-wars/api';

describe('chat browser page', () => {
  let app: ReturnType<typeof createApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves the standalone two-room chat UI without exposing private data', async () => {
    app = createApp();
    const response = await app.inject({ method: 'GET', url: '/chat' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('Мировой чат');
    expect(response.body).toContain('Чат кампании');
    expect(response.body).toContain('/chat/world');
    expect(response.body).toContain('/campaigns/');
    expect(response.body).toContain('Shift+Enter');
    expect(response.body).toContain('/auth/vk/start');
    expect(response.body).toContain('/auth/vk/link');
    expect(response.body).toContain('/auth/resend-verification');

    const verification = await app.inject({ method: 'GET', url: '/verify-email' });
    expect(verification.statusCode).toBe(200);
    expect(verification.headers['cache-control']).toBe('no-store');
    expect(verification.headers['referrer-policy']).toBe('no-referrer');
    expect(verification.body).toContain('/auth/verify-email');
    expect(verification.body).toContain('Подтвердить email');
    expect(response.body).toContain('content.textContent = item.message');
    expect(response.body).not.toContain('localStorage');
    expect(response.body).not.toContain('innerHTML');
  });
});
