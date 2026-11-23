import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '@paper-wars/api';

describe('game lobby browser page', () => {
  let app: ReturnType<typeof createApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves the game entry point with campaign and account flows', async () => {
    app = createApp();
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toContain('Paper Wars: Rebirth');
    expect(response.body).toContain('Твои кампании');
    expect(response.body).toContain('/auth/refresh');
    expect(response.body).toContain('/auth/login');
    expect(response.body).toContain('/auth/register');
    expect(response.body).toContain('/campaigns');
    expect(response.body).toContain('Регистрация государств, генерация карты');
    expect(response.body).not.toContain('localStorage');
    expect(response.body).not.toContain('innerHTML');
  });
});
