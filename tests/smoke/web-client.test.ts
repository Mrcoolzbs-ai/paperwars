import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
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

  it('builds the current public browser client into the distribution folder', async () => {
    const [html, script] = await Promise.all([
      readFile(new URL('../../apps/web/dist/index.html', import.meta.url), 'utf8'),
      readFile(new URL('../../apps/web/dist/app.js', import.meta.url), 'utf8'),
    ]);

    expect(html).toContain('id="auth-screen"');
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('id="tab-chat"');
    expect(html).toContain('data-chat-room="world"');
    expect(html).toContain('data-chat-room="campaign"');
    expect(script).toContain('#auth-screen');
    expect(script).toContain("'/chat/world'");
    expect(script).toContain("'/chat'");
    expect(script).toContain('startChatPolling');
    expect(() => new Script(script, { filename: 'apps/web/dist/app.js' })).not.toThrow();
  });

  it('serves a configured production entry through the shared root route', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paperwars-web-entry-'));
    const entryPath = join(directory, 'index.html');
    await writeFile(entryPath, '<!doctype html><main id="built-entry">Built client</main>', 'utf8');
    const productionApp = createApp({ webEntryPath: entryPath });

    try {
      const response = await productionApp.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('built-entry');
      expect(response.body).toContain('Built client');
    } finally {
      await productionApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves the browser client assets', async () => {
    const script = await app.inject({ method: 'GET', url: '/app.js' });
    const stylesheet = await app.inject({ method: 'GET', url: '/styles.css' });
    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    const factory = await app.inject({ method: 'GET', url: '/assets/buildings/factory.jpg' });
    const gold = await app.inject({ method: 'GET', url: '/assets/buildings/gold-mark.jpg' });

    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(() => new Script(script.body, { filename: 'apps/web/public/app.js' })).not.toThrow();
    expect(script.body).toContain('/campaigns');
    expect(script.body).toContain("'/chat/world'");
    expect(script.body).toContain("'/chat'");
    expect(script.body).toContain('NOT_ACTIVE_CAMPAIGN_MEMBER');
    expect(script.body).toContain('CHAT_RATE_LIMITED');
    const mapRenderer = script.body.slice(
      script.body.indexOf('function drawBuildingMapIcon'),
      script.body.indexOf(
        'async function request',
        script.body.indexOf('function drawBuildingMapIcon'),
      ),
    );
    const countryCardRenderer = script.body.slice(
      script.body.indexOf('function renderFoundedCards'),
      script.body.indexOf(
        'function addPrincipleRow',
        script.body.indexOf('function renderFoundedCards'),
      ),
    );
    expect(mapRenderer).toContain("ctx.fillText('З'");
    expect(mapRenderer).not.toContain('strokeRect');
    expect(mapRenderer).not.toContain("'#302700'");
    expect(script.body).toContain('countryLabelX');
    expect(script.body).toContain('countryBorderTop - 4');
    expect(countryCardRenderer).toContain("['♟', 'Люди'");
    expect(countryCardRenderer).toContain("['⚛', 'Наука'");
    expect(countryCardRenderer).not.toContain("'♟♟'");
    expect(countryCardRenderer).toContain('principle.effect');
    expect(countryCardRenderer).toContain('Эффект: ');
    expect(countryCardRenderer).toContain('principle-effect');
    expect(script.body).toContain('Сессия активна, но список кампаний не загрузился');
    expect(script.body).toContain('Авторизация прошла успешно, но список кампаний не загрузился');
    expect(script.body).toContain('Building symbols are rendered after country labels');
    expect(script.body).toContain("ctx.fillText('З'");
    expect(script.body).toContain('Эффект: ');
    expect(script.body).toContain('Игровые действия пока недоступны');
    expect(script.body).not.toContain('build-country-building');
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers['content-type']).toContain('text/css');
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toContain('image/svg+xml');
    expect(factory.statusCode).toBe(200);
    expect(factory.headers['content-type']).toContain('image/jpeg');
    expect(factory.rawPayload.byteLength).toBeGreaterThan(500);
    expect(gold.statusCode).toBe(200);
    expect(gold.headers['content-type']).toContain('image/jpeg');
  });

  it('keeps the health endpoint separate from the game home page', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      apiContractVersion: 'browser-auth-v1',
      engineVersion: '0.1.0',
    });
  });
});
