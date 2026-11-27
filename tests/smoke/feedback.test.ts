import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthValidationError,
  createAccessTokenSigner,
  createAdminService,
  createAuthService,
  createFeedbackService,
  validateFeedbackPayload,
  type AuthSession,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import { createEmailLoginUser } from '../helpers/auth.js';

describe('feedback payload validation', () => {
  it('accepts a bug report with the optional campaign omitted', () => {
    const payload = validateFeedbackPayload('bug', {
      title: ' Сломана кнопка ',
      whatHappened: 'a',
      stepsToReproduce: 'b',
      expectedResult: 'c',
      actualResult: 'd',
    });
    expect(payload['title']).toBe('Сломана кнопка');
    expect(payload).not.toHaveProperty('campaign');
  });

  it('allows unknown unit stats and building economics', () => {
    expect(
      validateFeedbackPayload('unit', { name: 'Копейщик', role: 'Пехота', description: 'Лёгкий' }),
    ).toEqual({ name: 'Копейщик', role: 'Пехота', description: 'Лёгкий' });
    expect(
      validateFeedbackPayload('building', { name: 'Порт', description: 'Торговля', costs: '?' }),
    ).toMatchObject({ costs: '?' });
  });

  it('rejects missing required, unknown, non-string, oversized and control-character fields', () => {
    expect(() => validateFeedbackPayload('other', { title: 'Только заголовок' })).toThrow(
      AuthValidationError,
    );
    expect(() =>
      validateFeedbackPayload('other', { title: 't', description: 'd', admin: 'true' }),
    ).toThrow(AuthValidationError);
    expect(() => validateFeedbackPayload('other', { title: 5, description: 'd' })).toThrow(
      AuthValidationError,
    );
    expect(() =>
      validateFeedbackPayload('other', { title: 'x'.repeat(201), description: 'd' }),
    ).toThrow(AuthValidationError);
    expect(() =>
      validateFeedbackPayload('other', { title: 't', description: 'x'.repeat(4001) }),
    ).toThrow(AuthValidationError);
    expect(() => validateFeedbackPayload('other', { title: 'a\u0000b', description: 'd' })).toThrow(
      AuthValidationError,
    );
    expect(() => validateFeedbackPayload('other', [])).toThrow(AuthValidationError);
  });
});

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'player feedback tickets API',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const accessTokens = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x59),
      issuer: 'paper-wars-feedback-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
    });

    function getPool() {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      return persistence.pool;
    }

    function build() {
      const pool = getPool();
      const authService = createAuthService({ pool, accessTokens, refreshTokenTtlSeconds: 3600 });
      const adminService = createAdminService({ pool, adminCode: '' });
      const feedbackService = createFeedbackService({ pool, adminService });
      const app = createApp({ authService, adminService, feedbackService });
      return { pool, authService, adminService, app };
    }

    function headers(session: AuthSession) {
      return { authorization: 'Bearer ' + session.accessToken };
    }

    const bug = {
      title: 'Не работает строительство',
      whatHappened: 'Кнопка не реагирует',
      stepsToReproduce: '1. Открыть карту',
      expectedResult: 'Здание строится',
      actualResult: 'Ничего не происходит',
    };

    beforeAll(async () => {
      await runMigrations(getPool());
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    async function makeUsers() {
      const { pool, authService, app } = build();
      const password = 'secure feedback integration password';
      const [alice, bob, admin] = await Promise.all(
        ['alice', 'bob', 'admin'].map((name) =>
          createEmailLoginUser(
            pool,
            authService,
            name + '-' + randomUUID() + '@example.test',
            password,
          ),
        ),
      );
      if (alice === undefined || bob === undefined || admin === undefined) throw new Error('users');
      await pool.query('INSERT INTO user_admins (user_id) VALUES ($1)', [admin.user.id]);
      return { pool, app, alice, bob, admin };
    }

    async function setAdminMode(
      pool: ReturnType<typeof getPool>,
      userId: string,
      enabled: boolean,
    ) {
      await pool.query(
        `INSERT INTO user_admin_settings (user_id, enabled) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [userId, enabled],
      );
    }

    it('assigns immutable sequential ticket numbers and persists the JSONB payload', async () => {
      const { pool, app, alice } = await makeUsers();
      const first = await app.inject({
        method: 'POST',
        url: '/feedback/tickets',
        headers: headers(alice),
        payload: { category: 'bug', fields: bug },
      });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({
        method: 'POST',
        url: '/feedback/tickets',
        headers: headers(alice),
        payload: { category: 'other', fields: { title: 'Идея', description: 'Подробности' } },
      });
      const a = first.json().ticket.ticketNumber as number;
      const b = second.json().ticket.ticketNumber as number;
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a);
      expect(first.json().ticket.status).toBe('new');
      expect(JSON.stringify(first.json())).not.toContain('example.test');

      const stored = await pool.query<{ payload: Record<string, string>; ticket_number: string }>(
        'SELECT payload, ticket_number FROM feedback_tickets WHERE ticket_number = $1',
        [a],
      );
      expect(stored.rows[0]?.payload).toEqual(bug);
      await expect(
        pool.query('UPDATE feedback_tickets SET ticket_number = 999999 WHERE ticket_number = $1', [
          a,
        ]),
      ).rejects.toThrow();
      await expect(
        pool.query(`UPDATE feedback_tickets SET payload = '{}' WHERE ticket_number = $1`, [a]),
      ).rejects.toThrow();
      const reread = await app.inject({
        method: 'GET',
        url: '/feedback/tickets/' + a,
        headers: headers(alice),
      });
      expect(reread.json().ticket.ticketNumber).toBe(a);
      await app.close();
    });

    it('rejects invalid submissions with localized errors', async () => {
      const { app, alice } = await makeUsers();
      const response = await app.inject({
        method: 'POST',
        url: '/feedback/tickets',
        headers: headers(alice),
        payload: { category: 'unit', fields: { name: 'Только имя' } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toMatch(/[А-Яа-я]/);
      const anonymous = await app.inject({ method: 'GET', url: '/feedback/tickets' });
      expect(anonymous.statusCode).toBe(401);
      await app.close();
    });

    it('keeps tickets private to their author', async () => {
      const { app, alice, bob } = await makeUsers();
      const created = await app.inject({
        method: 'POST',
        url: '/feedback/tickets',
        headers: headers(alice),
        payload: { category: 'bug', fields: bug },
      });
      const number = created.json().ticket.ticketNumber as number;

      const read = await app.inject({
        method: 'GET',
        url: '/feedback/tickets/' + number,
        headers: headers(bob),
      });
      expect(read.statusCode).toBe(404);
      const reply = await app.inject({
        method: 'POST',
        url: '/feedback/tickets/' + number + '/messages',
        headers: headers(bob),
        payload: { body: 'вмешательство' },
      });
      expect(reply.statusCode).toBe(404);
      const list = await app.inject({
        method: 'GET',
        url: '/feedback/tickets',
        headers: headers(bob),
      });
      expect(list.json().tickets).toEqual([]);
      await app.close();
    });

    it('blocks admin routes for players and for admins without admin mode', async () => {
      const { pool, app, alice, admin } = await makeUsers();
      const created = await app.inject({
        method: 'POST',
        url: '/feedback/tickets',
        headers: headers(alice),
        payload: { category: 'bug', fields: bug },
      });
      const number = created.json().ticket.ticketNumber as number;
      const adminRequests = [
        { method: 'GET', url: '/admin/feedback/tickets' },
        { method: 'GET', url: '/admin/feedback/tickets/' + number },
        {
          method: 'POST',
          url: '/admin/feedback/tickets/' + number + '/messages',
          payload: { body: 'x', visibility: 'public' },
        },
        {
          method: 'POST',
          url: '/admin/feedback/tickets/' + number + '/status',
          payload: { status: 'accepted' },
        },
      ] as const;
      for (const item of adminRequests) {
        const asPlayer = await app.inject({ ...item, headers: headers(alice) });
        expect(asPlayer.statusCode).toBe(403);
        await setAdminMode(pool, admin.user.id, false);
        const modeOff = await app.inject({ ...item, headers: headers(admin) });
        expect(modeOff.statusCode).toBe(403);
        const anonymous = await app.inject({ ...item });
        expect(anonymous.statusCode).toBe(401);
      }
      const after = await pool.query<{ status: string }>(
        'SELECT status FROM feedback_tickets WHERE ticket_number = $1',
        [number],
      );
      expect(after.rows[0]?.status).toBe('new');
      await app.close();
    });

    it('lets an admin in admin mode filter, reply, and change status', async () => {
      const { pool, app, alice, admin } = await makeUsers();
      await setAdminMode(pool, admin.user.id, true);
      const created = await app.inject({
        method: 'POST',
        url: '/feedback/tickets',
        headers: headers(alice),
        payload: {
          category: 'building',
          fields: { name: 'УникальнаяМельница' + randomUUID().slice(0, 8), description: 'Еда' },
        },
      });
      const ticket = created.json().ticket;
      const number = ticket.ticketNumber as number;

      const search = await app.inject({
        method: 'GET',
        url:
          '/admin/feedback/tickets?category=building&status=new&q=' +
          encodeURIComponent(ticket.title as string),
        headers: headers(admin),
      });
      expect(search.statusCode).toBe(200);
      expect(search.json().tickets.map((t: { ticketNumber: number }) => t.ticketNumber)).toEqual([
        number,
      ]);
      const byNumber = await app.inject({
        method: 'GET',
        url: '/admin/feedback/tickets?q=%23' + number,
        headers: headers(admin),
      });
      expect(byNumber.json().tickets).toHaveLength(1);

      const internal = await app.inject({
        method: 'POST',
        url: '/admin/feedback/tickets/' + number + '/messages',
        headers: headers(admin),
        payload: { body: 'секретная заметка', visibility: 'internal' },
      });
      expect(internal.statusCode).toBe(201);
      const status = await app.inject({
        method: 'POST',
        url: '/admin/feedback/tickets/' + number + '/status',
        headers: headers(admin),
        payload: { status: 'needs_info', reply: 'Уточни стоимость' },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().ticket).toMatchObject({
        status: 'needs_info',
        reviewerLabel: expect.any(String),
      });
      const badStatus = await app.inject({
        method: 'POST',
        url: '/admin/feedback/tickets/' + number + '/status',
        headers: headers(admin),
        payload: { status: 'deleted' },
      });
      expect(badStatus.statusCode).toBe(400);

      const adminView = await app.inject({
        method: 'GET',
        url: '/admin/feedback/tickets/' + number,
        headers: headers(admin),
      });
      expect(adminView.json().ticket.messages.map((m: { body: string }) => m.body)).toContain(
        'секретная заметка',
      );

      const playerView = await app.inject({
        method: 'GET',
        url: '/feedback/tickets/' + number,
        headers: headers(alice),
      });
      const body = JSON.stringify(playerView.json());
      expect(playerView.json().ticket.status).toBe('needs_info');
      expect(body).toContain('Уточни стоимость');
      expect(body).not.toContain('секретная заметка');
      expect(body).not.toContain('reviewerLabel');
      expect(body).not.toContain('example.test');

      const followUp = await app.inject({
        method: 'POST',
        url: '/feedback/tickets/' + number + '/messages',
        headers: headers(alice),
        payload: { body: 'Стоимость 10 золота' },
      });
      expect(followUp.statusCode).toBe(201);
      const stamps = await pool.query<{ reviewed_by: string; reviewed_at: Date | null }>(
        'SELECT reviewed_by, reviewed_at FROM feedback_tickets WHERE ticket_number = $1',
        [number],
      );
      expect(stamps.rows[0]?.reviewed_by).toBe(admin.user.id);
      expect(stamps.rows[0]?.reviewed_at).toBeInstanceOf(Date);
      await app.close();
    });
  },
);
