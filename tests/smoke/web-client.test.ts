import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '@paper-wars/api';

describe('browser client', () => {
  const app = createApp();

  afterAll(async () => {
    await app.close();
  });

  it('serves the Paper Wars home page at the root URL', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Paper Wars: Rebirth');
    expect(response.body).toContain('auth-screen');
  });

  it('serves the browser client assets', async () => {
    const script = await app.inject({ method: 'GET', url: '/app.js' });
    const stylesheet = await app.inject({ method: 'GET', url: '/styles.css' });
    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });

    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.body).toContain('/campaigns');
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers['content-type']).toContain('text/css');
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toContain('image/svg+xml');
  });

  it('keeps the health endpoint separate from the game home page', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', engineVersion: '0.1.0' });
  });
});
