import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

export type AdminServiceErrorCode =
  | 'ADMIN_CODE_UNAVAILABLE'
  | 'ADMIN_CODE_INVALID'
  | 'ADMIN_CODE_RATE_LIMITED'
  | 'ADMIN_NOT_FOUND'
  | 'ADMIN_ACCOUNT_PROTECTED'
  | 'ADMIN_USER_NOT_FOUND'
  | 'ADMIN_CAMPAIGN_NOT_FOUND';

export class AdminServiceError extends Error {
  constructor(
    readonly code: AdminServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminServiceError';
  }
}

export interface AdminUserView {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly status: 'active' | 'disabled';
  readonly isAdmin: boolean;
  readonly createdAt: Date;
}

export interface AdminCampaignView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly currentTurn: number;
  readonly ordersLocked: boolean;
  readonly mapWidth: number | null;
  readonly mapHeight: number | null;
  readonly playerCount: number;
  readonly createdAt: Date;
}

export interface AdminService {
  isAdmin(userId: string): Promise<boolean>;
  isAdminModeEnabled(userId: string): Promise<boolean>;
  setAdminMode(userId: string, enabled: unknown): Promise<boolean>;
  grantWithCode(userId: string, code: unknown): Promise<void>;
  listUsers(adminUserId: string): Promise<readonly AdminUserView[]>;
  listCampaigns(adminUserId: string): Promise<readonly AdminCampaignView[]>;
  renameUser(
    adminUserId: string,
    targetUserId: string,
    displayName: unknown,
  ): Promise<AdminUserView>;
  deleteUser(adminUserId: string, targetUserId: string): Promise<void>;
  deleteCampaign(adminUserId: string, campaignId: string): Promise<void>;
}

export interface AdminServiceOptions {
  readonly pool: Pool;
  readonly adminCode?: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attemptWindowMs = 15 * 60 * 1000;
const maxAttempts = 5;

function validateUserId(value: string): void {
  if (!uuidPattern.test(value)) {
    throw new AdminServiceError('ADMIN_USER_NOT_FOUND', 'Пользователь не найден.');
  }
}

function validateCampaignId(value: string): void {
  if (!uuidPattern.test(value)) {
    throw new AdminServiceError('ADMIN_CAMPAIGN_NOT_FOUND', 'Кампания не найдена.');
  }
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AdminServiceError('ADMIN_USER_NOT_FOUND', 'Никнейм должен быть текстом.');
  }
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = Array.from(name).length;
  if (length < 2 || length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) {
    throw new AdminServiceError(
      'ADMIN_USER_NOT_FOUND',
      'Никнейм должен содержать от 2 до 32 допустимых символов.',
    );
  }
  return name;
}

function codeMatches(submitted: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(submitted, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function createAdminService(options: AdminServiceOptions): AdminService {
  const pool = options.pool;

  async function requireAdmin(userId: string): Promise<void> {
    if (!(await service.isAdmin(userId))) {
      throw new AdminServiceError(
        'ADMIN_NOT_FOUND',
        'Для этого действия нужны права администратора.',
      );
    }
    if (!(await service.isAdminModeEnabled(userId))) {
      throw new AdminServiceError('ADMIN_NOT_FOUND', 'Включи административный режим в профиле.');
    }
  }

  const service: AdminService = {
    async isAdmin(userId) {
      validateUserId(userId);
      const result = await pool.query('SELECT 1 FROM user_admins WHERE user_id = $1', [userId]);
      return result.rows.length > 0;
    },

    async isAdminModeEnabled(userId) {
      validateUserId(userId);
      const result = await pool.query(
        'SELECT 1 FROM user_admin_settings WHERE user_id = $1 AND enabled = TRUE',
        [userId],
      );
      return result.rows.length > 0;
    },

    async setAdminMode(userId, enabledInput) {
      validateUserId(userId);
      if (typeof enabledInput !== 'boolean') {
        throw new AdminServiceError(
          'ADMIN_NOT_FOUND',
          'Некорректное состояние административного режима.',
        );
      }
      if (!(await service.isAdmin(userId))) {
        throw new AdminServiceError(
          'ADMIN_NOT_FOUND',
          'Для этого действия нужны права администратора.',
        );
      }
      await pool.query(
        `INSERT INTO user_admin_settings (user_id, enabled, updated_at)
         VALUES ($1, $2, clock_timestamp())
         ON CONFLICT (user_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
        [userId, enabledInput],
      );
      return enabledInput;
    },

    async grantWithCode(userId, codeInput) {
      validateUserId(userId);
      const expectedCode = options.adminCode;
      if (typeof expectedCode !== 'string' || expectedCode.length === 0) {
        throw new AdminServiceError(
          'ADMIN_CODE_UNAVAILABLE',
          'Получение прав администратора временно недоступно: код не настроен на сервере.',
        );
      }
      if (typeof codeInput !== 'string' || codeInput.length < 1 || codeInput.length > 1024) {
        throw new AdminServiceError('ADMIN_CODE_INVALID', 'Неверный супер-код.');
      }

      const client = await pool.connect();
      let transactionOpen = false;
      let failure: AdminServiceError | null = null;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 311))', [userId]);
        const result = await client.query<{
          attempts: number;
          window_started_at: Date;
          blocked_until: Date | null;
        }>(
          'SELECT attempts, window_started_at, blocked_until FROM admin_code_attempts WHERE user_id = $1 FOR UPDATE',
          [userId],
        );
        const now = new Date();
        const previous = result.rows[0];
        if (previous?.blocked_until && previous.blocked_until.getTime() > now.getTime()) {
          failure = new AdminServiceError(
            'ADMIN_CODE_RATE_LIMITED',
            'Слишком много неверных попыток. Повторите через 15 минут.',
          );
        } else {
          const resetWindow =
            previous === undefined ||
            now.getTime() - previous.window_started_at.getTime() >= attemptWindowMs;
          const attempts = resetWindow ? 0 : previous.attempts;
          if (codeMatches(codeInput, expectedCode)) {
            await client.query(
              'INSERT INTO user_admins (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
              [userId],
            );
            await client.query(
              `INSERT INTO user_admin_settings (user_id, enabled, updated_at)
               VALUES ($1, TRUE, clock_timestamp())
               ON CONFLICT (user_id) DO UPDATE
               SET enabled = TRUE, updated_at = clock_timestamp()`,
              [userId],
            );
            await client.query('DELETE FROM admin_code_attempts WHERE user_id = $1', [userId]);
          } else {
            const nextAttempts = attempts + 1;
            const blockedUntil =
              nextAttempts >= maxAttempts ? new Date(now.getTime() + attemptWindowMs) : null;
            await client.query(
              `INSERT INTO admin_code_attempts (user_id, attempts, window_started_at, blocked_until)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id) DO UPDATE
               SET attempts = EXCLUDED.attempts,
                   window_started_at = EXCLUDED.window_started_at,
                   blocked_until = EXCLUDED.blocked_until`,
              [userId, nextAttempts, resetWindow ? now : previous!.window_started_at, blockedUntil],
            );
            failure =
              nextAttempts >= maxAttempts
                ? new AdminServiceError(
                    'ADMIN_CODE_RATE_LIMITED',
                    'Слишком много неверных попыток. Повторите через 15 минут.',
                  )
                : new AdminServiceError('ADMIN_CODE_INVALID', 'Неверный супер-код.');
          }
        }
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (failure !== null) throw failure;
    },

    async listUsers(adminUserId) {
      await requireAdmin(adminUserId);
      const result = await pool.query<{
        id: string;
        display_name: string;
        email: string | null;
        status: 'active' | 'disabled';
        is_admin: boolean;
        created_at: Date;
      }>(
        `SELECT user_account.id, user_account.display_name, user_account.email,
                user_account.status, user_account.created_at,
                EXISTS (SELECT 1 FROM user_admins admin WHERE admin.user_id = user_account.id) AS is_admin
         FROM users AS user_account
         ORDER BY user_account.created_at DESC, user_account.id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        email: row.email,
        status: row.status,
        isAdmin: row.is_admin,
        createdAt: row.created_at,
      }));
    },

    async listCampaigns(adminUserId) {
      await requireAdmin(adminUserId);
      const result = await pool.query<{
        id: string;
        name: string;
        status: string;
        current_turn: number;
        orders_locked: boolean;
        map_width: number | null;
        map_height: number | null;
        player_count: number;
        created_at: Date;
      }>(
        `SELECT campaign.id, campaign.name, campaign.status, campaign.current_turn,
                campaign.orders_locked, campaign.map_width, campaign.map_height,
                count(membership.user_id) FILTER (WHERE membership.status = 'active')::integer AS player_count,
                campaign.created_at
         FROM campaigns AS campaign
         LEFT JOIN campaign_memberships AS membership ON membership.campaign_id = campaign.id
         GROUP BY campaign.id
         ORDER BY campaign.created_at DESC, campaign.id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        currentTurn: row.current_turn,
        ordersLocked: row.orders_locked,
        mapWidth: row.map_width,
        mapHeight: row.map_height,
        playerCount: row.player_count,
        createdAt: row.created_at,
      }));
    },

    // prettier-ignore
    async deleteCampaign(adminUserId, campaignId) {
      await requireAdmin(adminUserId);
      validateCampaignId(campaignId);
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const target = await client.query(
          'SELECT id FROM campaigns WHERE id = $1 FOR UPDATE',
          [campaignId],
        );
        if (target.rows.length === 0) {
          throw new AdminServiceError('ADMIN_CAMPAIGN_NOT_FOUND', 'Кампания не найдена.');
        }

        await client.query(
          `DELETE FROM discovery_access
           WHERE discovery_id IN (SELECT id FROM discovery_records WHERE campaign_id = $1)`,
          [campaignId],
        );
        await client.query(
          `DELETE FROM discovery_history
           WHERE discovery_id IN (SELECT id FROM discovery_records WHERE campaign_id = $1)`,
          [campaignId],
        );
        await client.query('DELETE FROM discovery_records WHERE campaign_id = $1', [campaignId]);
        await client.query('DELETE FROM game_events WHERE campaign_id = $1', [campaignId]);
        await client.query('DELETE FROM orders WHERE campaign_id = $1', [campaignId]);
        await client.query(
          'UPDATE campaign_memberships SET country_id = NULL WHERE campaign_id = $1',
          [campaignId],
        );
        await client.query(
          `UPDATE countries
           SET setup_completed = FALSE, official_system_type = NULL, official_system_id = NULL
           WHERE campaign_id = $1`,
          [campaignId],
        );
        await client.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async renameUser(adminUserId, targetUserId, displayNameInput) {
      await requireAdmin(adminUserId);
      validateUserId(targetUserId);
      const displayName = normalizeDisplayName(displayNameInput);
      const updated = await pool.query<{
        id: string;
        display_name: string;
        email: string | null;
        status: 'active' | 'disabled';
        is_admin: boolean;
        created_at: Date;
      }>(
        `UPDATE users AS user_account
         SET display_name = $2, updated_at = clock_timestamp()
         WHERE user_account.id = $1 AND user_account.status = 'active'
         RETURNING user_account.id, user_account.display_name, user_account.email,
                   user_account.status, user_account.created_at,
                   EXISTS (SELECT 1 FROM user_admins admin WHERE admin.user_id = user_account.id) AS is_admin`,
        [targetUserId, displayName],
      );
      const row = updated.rows[0];
      if (!row)
        throw new AdminServiceError('ADMIN_USER_NOT_FOUND', 'Активный пользователь не найден.');
      return {
        id: row.id,
        displayName: row.display_name,
        email: row.email,
        status: row.status,
        isAdmin: row.is_admin,
        createdAt: row.created_at,
      };
    },

    async deleteUser(adminUserId, targetUserId) {
      await requireAdmin(adminUserId);
      validateUserId(targetUserId);
      if (adminUserId === targetUserId) {
        throw new AdminServiceError(
          'ADMIN_ACCOUNT_PROTECTED',
          'Нельзя удалить собственный аккаунт администратора.',
        );
      }
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const target = await client.query(
          `SELECT id FROM users
           WHERE id = $1 AND status = 'active'
             AND NOT EXISTS (SELECT 1 FROM user_admins admin WHERE admin.user_id = users.id)
           FOR UPDATE`,
          [targetUserId],
        );
        if (target.rows.length === 0) {
          throw new AdminServiceError(
            'ADMIN_USER_NOT_FOUND',
            'Активный пользователь не найден или его аккаунт защищён.',
          );
        }
        await client.query(
          `UPDATE orders
           SET status = 'discarded', updated_at = clock_timestamp()
           WHERE country_id IN (SELECT id FROM countries WHERE owner_user_id = $1)
             AND status IN ('draft', 'unconfirmed', 'confirmed')`,
          [targetUserId],
        );
        await client.query(
          `UPDATE campaign_memberships SET status = 'left', orders_confirmed = FALSE
           WHERE user_id = $1`,
          [targetUserId],
        );
        await client.query('DELETE FROM campaign_spawn_reservations WHERE user_id = $1', [
          targetUserId,
        ]);
        await client.query('DELETE FROM chat_messages WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM auth_identities WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM player_social_system_library WHERE owner_user_id = $1', [
          targetUserId,
        ]);
        await client.query(
          `UPDATE users
           SET status = 'disabled', email = NULL, password_hash = NULL,
               display_name = 'Удалённый игрок', updated_at = clock_timestamp()
           WHERE id = $1`,
          [targetUserId],
        );
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return service;
}
