import type { Pool, PoolClient } from 'pg';
import { type AdminService, AdminServiceError } from './admin.js';
import { AuthValidationError } from './errors.js';

export const feedbackCategories = ['bug', 'building', 'unit', 'mechanic', 'other'] as const;
export type FeedbackCategory = (typeof feedbackCategories)[number];

export const feedbackStatuses = [
  'new',
  'in_review',
  'accepted',
  'rejected',
  'needs_info',
  'implemented',
] as const;
export type FeedbackStatus = (typeof feedbackStatuses)[number];

export type FeedbackVisibility = 'public' | 'internal';

export type FeedbackServiceErrorCode = 'TICKET_NOT_FOUND' | 'FEEDBACK_RATE_LIMITED';

export class FeedbackServiceError extends Error {
  constructor(
    readonly code: FeedbackServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedbackServiceError';
  }
}

interface FieldTemplate {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  /** Short single-line value (name, stat) or long free text. */
  readonly long: boolean;
}

const shortLimit = 200;
const longLimit = 4000;
const totalLimit = 20000;

function field(key: string, label: string, required: boolean, long = false): FieldTemplate {
  return { key, label, required, long };
}

/**
 * Structured submission templates. Optional fields (including unit and building stats) may be
 * omitted or filled with a provisional value such as "не знаю".
 */
export const feedbackTemplates: Readonly<Record<FeedbackCategory, readonly FieldTemplate[]>> = {
  bug: [
    field('title', 'Заголовок', true),
    field('whatHappened', 'Что произошло', true, true),
    field('stepsToReproduce', 'Шаги воспроизведения', true, true),
    field('expectedResult', 'Ожидаемый результат', true, true),
    field('actualResult', 'Фактический результат', true, true),
    field('campaign', 'Кампания', false),
  ],
  building: [
    field('name', 'Название', true),
    field('description', 'Назначение и описание', true, true),
    field('buildingClass', 'Класс или роль здания', false),
    field('costs', 'Стоимость', false),
    field('upkeep', 'Содержание', false),
    field('prerequisites', 'Требования', false, true),
    field('effects', 'Производство и эффекты', false, true),
    field('balanceNotes', 'Заметки о балансе', false, true),
  ],
  unit: [
    field('name', 'Название', true),
    field('role', 'Роль', true),
    field('description', 'Описание', true, true),
    field('attack', 'Атака', false),
    field('defence', 'Защита', false),
    field('movement', 'Движение', false),
    field('recruitmentCost', 'Стоимость найма', false),
    field('upkeep', 'Содержание', false),
    field('prerequisites', 'Требования', false, true),
    field('specialAbilities', 'Особые способности', false, true),
    field('balanceNotes', 'Заметки о балансе', false, true),
  ],
  mechanic: [
    field('problem', 'Проблема', true, true),
    field('proposedRule', 'Предлагаемое правило', true, true),
    field('example', 'Пример хода или ситуации', false, true),
    field('balanceEffects', 'Влияние на баланс', false, true),
    field('edgeCases', 'Крайние случаи и зависимости', false, true),
  ],
  other: [
    field('title', 'Заголовок', true),
    field('description', 'Подробное описание', true, true),
  ],
};

/** Field that supplies the ticket headline for each category. */
const titleKey: Readonly<Record<FeedbackCategory, string>> = {
  bug: 'title',
  building: 'name',
  unit: 'name',
  mechanic: 'proposedRule',
  other: 'title',
};

export interface FeedbackTicketSummary {
  readonly ticketNumber: number;
  readonly category: FeedbackCategory;
  readonly status: FeedbackStatus;
  readonly title: string;
  readonly authorLabel: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly statusChangedAt: Date;
  readonly lastReplyAt: Date | null;
}

export interface FeedbackAdminTicketSummary extends FeedbackTicketSummary {
  readonly reviewedAt: Date | null;
  readonly reviewerLabel: string | null;
}

export interface FeedbackMessageView {
  readonly id: string;
  readonly authorLabel: string;
  readonly authorRole: 'player' | 'admin';
  readonly kind: 'message' | 'status_change';
  readonly visibility: FeedbackVisibility;
  readonly body: string;
  readonly createdAt: Date;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  readonly payload: Readonly<Record<string, string>>;
  readonly reviewedAt: Date | null;
  readonly messages: readonly FeedbackMessageView[];
}

export interface FeedbackAdminTicketDetail extends FeedbackTicketDetail {
  readonly reviewerLabel: string | null;
}

export interface FeedbackAdminListFilter {
  readonly status?: unknown;
  readonly category?: unknown;
  readonly query?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface FeedbackService {
  submitTicket(userId: string, category: unknown, fields: unknown): Promise<FeedbackTicketDetail>;
  listOwnTickets(userId: string): Promise<readonly FeedbackTicketSummary[]>;
  getOwnTicket(userId: string, ticketNumber: unknown): Promise<FeedbackTicketDetail>;
  addOwnMessage(userId: string, ticketNumber: unknown, body: unknown): Promise<FeedbackMessageView>;
  adminListTickets(
    adminUserId: string,
    filter: FeedbackAdminListFilter,
  ): Promise<readonly FeedbackAdminTicketSummary[]>;
  adminGetTicket(adminUserId: string, ticketNumber: unknown): Promise<FeedbackAdminTicketDetail>;
  adminAddMessage(
    adminUserId: string,
    ticketNumber: unknown,
    body: unknown,
    visibility: unknown,
  ): Promise<FeedbackMessageView>;
  adminSetStatus(
    adminUserId: string,
    ticketNumber: unknown,
    status: unknown,
    reply: unknown,
  ): Promise<FeedbackAdminTicketDetail>;
}

export interface FeedbackServiceOptions {
  readonly pool: Pool;
  readonly adminService: AdminService;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const submissionRateWindowSeconds = 3600;
const submissionRateLimit = 10;
const messageRateWindowSeconds = 60;
const messageRateLimit = 10;
const defaultPageSize = 50;
const maxPageSize = 100;

function validateUserId(value: string): void {
  if (!uuidPattern.test(value)) throw new AuthValidationError('Некорректный идентификатор игрока.');
}

function validateCategory(value: unknown): FeedbackCategory {
  if (typeof value === 'string' && (feedbackCategories as readonly string[]).includes(value)) {
    return value as FeedbackCategory;
  }
  throw new AuthValidationError('Выбери тип обращения из списка.');
}

function validateStatus(value: unknown): FeedbackStatus {
  if (typeof value === 'string' && (feedbackStatuses as readonly string[]).includes(value)) {
    return value as FeedbackStatus;
  }
  throw new AuthValidationError('Некорректный статус обращения.');
}

function validateTicketNumber(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]{1,15}$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AuthValidationError('Номер обращения должен быть положительным числом.');
  }
  return parsed;
}

function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

/** Validates a submission against its category template and returns the clean payload. */
export function validateFeedbackPayload(
  category: FeedbackCategory,
  fields: unknown,
): Record<string, string> {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new AuthValidationError('Заполни форму обращения.');
  }
  const input = fields as Record<string, unknown>;
  const template = feedbackTemplates[category];
  const allowed = new Set(template.map((item) => item.key));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new AuthValidationError('В форме есть неизвестное поле.');
  }

  const payload: Record<string, string> = {};
  let total = 0;
  for (const item of template) {
    const raw = input[item.key];
    if (raw === undefined || raw === null) {
      if (item.required) throw new AuthValidationError('Заполни поле «' + item.label + '».');
      continue;
    }
    if (typeof raw !== 'string') {
      throw new AuthValidationError('Поле «' + item.label + '» должно быть текстом.');
    }
    const value = cleanText(raw);
    if (hasControlCharacters(value)) {
      throw new AuthValidationError('Поле «' + item.label + '» содержит недопустимые символы.');
    }
    if (value.length === 0) {
      if (item.required) throw new AuthValidationError('Заполни поле «' + item.label + '».');
      continue;
    }
    const limit = item.long ? longLimit : shortLimit;
    if (value.length > limit) {
      throw new AuthValidationError(
        'Поле «' + item.label + '» должно быть не длиннее ' + limit + ' символов.',
      );
    }
    total += value.length;
    payload[item.key] = value;
  }
  if (total > totalLimit) {
    throw new AuthValidationError('Обращение слишком длинное. Сократи текст.');
  }
  return payload;
}

function validateMessageBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthValidationError('Сообщение должно быть текстом.');
  }
  const body = cleanText(value);
  if (body.length === 0) throw new AuthValidationError('Сообщение не может быть пустым.');
  if (body.length > longLimit) {
    throw new AuthValidationError('Сообщение должно быть не длиннее 4000 символов.');
  }
  if (hasControlCharacters(body)) {
    throw new AuthValidationError('Сообщение содержит недопустимые символы.');
  }
  return body;
}

function deriveTitle(category: FeedbackCategory, payload: Record<string, string>): string {
  const raw = payload[titleKey[category]] ?? '';
  const firstLine = raw.split('\n')[0] ?? '';
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}

const statusLabels: Readonly<Record<FeedbackStatus, string>> = {
  new: 'Новое',
  in_review: 'На рассмотрении',
  accepted: 'Принято',
  rejected: 'Отклонено',
  needs_info: 'Нужны уточнения',
  implemented: 'Реализовано',
};

interface TicketRow {
  readonly ticket_number: string;
  readonly category: FeedbackCategory;
  readonly status: FeedbackStatus;
  readonly title: string;
  readonly author_label: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly status_changed_at: Date;
  readonly last_reply_at: Date | null;
  readonly reviewed_at: Date | null;
  readonly reviewer_label: string | null;
}

interface TicketDetailRow extends TicketRow {
  readonly id: string;
  readonly payload: Record<string, string>;
  readonly author_id: string | null;
}

interface MessageRow {
  readonly id: string;
  readonly author_label: string | null;
  readonly author_role: 'player' | 'admin';
  readonly kind: 'message' | 'status_change';
  readonly visibility: FeedbackVisibility;
  readonly body: string;
  readonly created_at: Date;
}

const deletedAuthorLabel = 'Удалённый игрок';

const summaryColumns = `
  t.ticket_number, t.category, t.status, t.title, t.created_at, t.updated_at,
  t.status_changed_at, t.reviewed_at,
  author.display_name AS author_label,
  reviewer.display_name AS reviewer_label,
  (SELECT max(m.created_at) FROM feedback_ticket_messages AS m
    WHERE m.ticket_id = t.id AND m.kind = 'message' AND m.author_role = 'admin'
      AND m.visibility = 'public') AS last_reply_at`;

const ticketJoins = `
  FROM feedback_tickets AS t
  LEFT JOIN users AS author ON author.id = t.author_id
  LEFT JOIN users AS reviewer ON reviewer.id = t.reviewed_by`;

function projectSummary(row: TicketRow): FeedbackTicketSummary {
  return {
    ticketNumber: Number(row.ticket_number),
    category: row.category,
    status: row.status,
    title: row.title,
    authorLabel: row.author_label ?? deletedAuthorLabel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusChangedAt: row.status_changed_at,
    lastReplyAt: row.last_reply_at,
  };
}

function projectAdminSummary(row: TicketRow): FeedbackAdminTicketSummary {
  return {
    ...projectSummary(row),
    reviewedAt: row.reviewed_at,
    reviewerLabel: row.reviewer_label,
  };
}

function projectMessage(row: MessageRow): FeedbackMessageView {
  return {
    id: row.id,
    authorLabel: row.author_label ?? deletedAuthorLabel,
    authorRole: row.author_role,
    kind: row.kind,
    visibility: row.visibility,
    body: row.body,
    createdAt: row.created_at,
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await operation(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK');
      transactionOpen = false;
    }
    throw error;
  } finally {
    client.release();
  }
}

function notFound(): FeedbackServiceError {
  return new FeedbackServiceError('TICKET_NOT_FOUND', 'Обращение не найдено.');
}

async function loadMessages(
  pool: Pool | PoolClient,
  ticketId: string,
  includeInternal: boolean,
): Promise<readonly FeedbackMessageView[]> {
  const result = await pool.query<MessageRow>(
    `SELECT m.id,
            CASE WHEN NOT $2::boolean AND m.author_role = 'admin' THEN 'Администрация'
                 ELSE u.display_name END AS author_label,
            m.author_role, m.kind, m.visibility,
            m.body, m.created_at
     FROM feedback_ticket_messages AS m
     LEFT JOIN users AS u ON u.id = m.author_id
     WHERE m.ticket_id = $1 AND ($2::boolean OR m.visibility = 'public')
     ORDER BY m.created_at, m.id`,
    [ticketId, includeInternal],
  );
  return result.rows.map(projectMessage);
}

async function loadDetailRow(
  pool: Pool | PoolClient,
  ticketNumber: number,
  ownerId: string | null,
): Promise<TicketDetailRow | undefined> {
  const result = await pool.query<TicketDetailRow>(
    `SELECT t.id, t.payload, t.author_id, ${summaryColumns}
     ${ticketJoins}
     WHERE t.ticket_number = $1 AND ($2::uuid IS NULL OR t.author_id = $2::uuid)`,
    [ticketNumber, ownerId],
  );
  return result.rows[0];
}

export function createFeedbackService(options: FeedbackServiceOptions): FeedbackService {
  const pool = options.pool;
  const adminService = options.adminService;

  /** Admin endpoints require real admin membership and enabled admin mode. */
  async function requireAdminMode(adminUserId: string): Promise<void> {
    validateUserId(adminUserId);
    if (!(await adminService.isAdmin(adminUserId))) {
      throw new AdminServiceError(
        'ADMIN_NOT_FOUND',
        'Для этого действия нужны права администратора.',
      );
    }
    if (!(await adminService.isAdminModeEnabled(adminUserId))) {
      throw new AdminServiceError('ADMIN_NOT_FOUND', 'Включи административный режим в профиле.');
    }
  }

  async function assertRate(
    client: PoolClient,
    userId: string,
    table: 'tickets' | 'messages',
  ): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [
      'feedback-' + table + '-' + userId,
    ]);
    const recent =
      table === 'tickets'
        ? await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM feedback_tickets
             WHERE author_id = $1
               AND created_at > clock_timestamp() - ($2::int * interval '1 second')`,
            [userId, submissionRateWindowSeconds],
          )
        : await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM feedback_ticket_messages
             WHERE author_id = $1 AND author_role = 'player'
               AND created_at > clock_timestamp() - ($2::int * interval '1 second')`,
            [userId, messageRateWindowSeconds],
          );
    const limit = table === 'tickets' ? submissionRateLimit : messageRateLimit;
    if ((recent.rows[0]?.n ?? 0) >= limit) {
      throw new FeedbackServiceError(
        'FEEDBACK_RATE_LIMITED',
        'Слишком много обращений за короткое время. Попробуй позже.',
      );
    }
  }

  async function insertMessage(
    client: PoolClient,
    ticketId: string,
    authorId: string,
    authorRole: 'player' | 'admin',
    kind: 'message' | 'status_change',
    visibility: FeedbackVisibility,
    body: string,
  ): Promise<FeedbackMessageView> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO feedback_ticket_messages
         (ticket_id, author_id, author_role, kind, visibility, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [ticketId, authorId, authorRole, kind, visibility, body],
    );
    await client.query('UPDATE feedback_tickets SET updated_at = clock_timestamp() WHERE id = $1', [
      ticketId,
    ]);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('Feedback message insert did not return a row');
    const messages = await loadMessages(client, ticketId, true);
    const message = messages.find((item) => item.id === id);
    if (message === undefined) throw new Error('Feedback message was not found after insert');
    return message;
  }

  async function ownDetail(userId: string, ticketNumber: number): Promise<FeedbackTicketDetail> {
    const row = await loadDetailRow(pool, ticketNumber, userId);
    if (row === undefined) throw notFound();
    return {
      ...projectSummary(row),
      payload: row.payload,
      reviewedAt: row.reviewed_at,
      messages: await loadMessages(pool, row.id, false),
    };
  }

  async function adminDetail(ticketNumber: number): Promise<FeedbackAdminTicketDetail> {
    const row = await loadDetailRow(pool, ticketNumber, null);
    if (row === undefined) throw notFound();
    return {
      ...projectAdminSummary(row),
      payload: row.payload,
      messages: await loadMessages(pool, row.id, true),
    };
  }

  return {
    async submitTicket(userId, categoryInput, fields) {
      validateUserId(userId);
      const category = validateCategory(categoryInput);
      const payload = validateFeedbackPayload(category, fields);
      const title = deriveTitle(category, payload);
      const ticketNumber = await withTransaction(pool, async (client) => {
        await assertRate(client, userId, 'tickets');
        const inserted = await client.query<{ ticket_number: string }>(
          `INSERT INTO feedback_tickets (author_id, category, title, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           RETURNING ticket_number`,
          [userId, category, title, JSON.stringify(payload)],
        );
        const value = inserted.rows[0]?.ticket_number;
        if (value === undefined) throw new Error('Feedback ticket insert did not return a row');
        return Number(value);
      });
      return ownDetail(userId, ticketNumber);
    },

    async listOwnTickets(userId) {
      validateUserId(userId);
      const result = await pool.query<TicketRow>(
        `SELECT ${summaryColumns}
         ${ticketJoins}
         WHERE t.author_id = $1
         ORDER BY t.ticket_number DESC
         LIMIT 200`,
        [userId],
      );
      return result.rows.map(projectSummary);
    },

    async getOwnTicket(userId, ticketNumberInput) {
      validateUserId(userId);
      return ownDetail(userId, validateTicketNumber(ticketNumberInput));
    },

    async addOwnMessage(userId, ticketNumberInput, bodyInput) {
      validateUserId(userId);
      const ticketNumber = validateTicketNumber(ticketNumberInput);
      const body = validateMessageBody(bodyInput);
      const message = await withTransaction(pool, async (client) => {
        const ticket = await client.query<{ id: string }>(
          `SELECT id FROM feedback_tickets
           WHERE ticket_number = $1 AND author_id = $2
           FOR UPDATE`,
          [ticketNumber, userId],
        );
        const ticketId = ticket.rows[0]?.id;
        if (ticketId === undefined) throw notFound();
        await assertRate(client, userId, 'messages');
        return insertMessage(client, ticketId, userId, 'player', 'message', 'public', body);
      });
      return message;
    },

    async adminListTickets(adminUserId, filter) {
      await requireAdminMode(adminUserId);
      const status =
        filter.status === undefined || filter.status === '' ? null : validateStatus(filter.status);
      const category =
        filter.category === undefined || filter.category === ''
          ? null
          : validateCategory(filter.category);
      let query: string | null = null;
      let ticketNumber: number | null = null;
      if (filter.query !== undefined && filter.query !== '') {
        if (typeof filter.query !== 'string') {
          throw new AuthValidationError('Некорректный поисковый запрос.');
        }
        const trimmed = filter.query.trim().replace(/^#/, '');
        if (trimmed.length > 100 || hasControlCharacters(trimmed)) {
          throw new AuthValidationError('Некорректный поисковый запрос.');
        }
        if (/^[0-9]{1,15}$/.test(trimmed)) ticketNumber = Number(trimmed);
        else if (trimmed.length > 0) query = trimmed;
      }
      const limit = parsePageValue(filter.limit, defaultPageSize, 1, maxPageSize);
      const offset = parsePageValue(filter.offset, 0, 0, 100000);
      const escaped = query === null ? null : query.replace(/[\\%_]/g, (c) => '\\' + c);
      const result = await pool.query<TicketRow>(
        `SELECT ${summaryColumns}
         ${ticketJoins}
         WHERE ($1::text IS NULL OR t.status = $1)
           AND ($2::text IS NULL OR t.category = $2)
           AND ($3::bigint IS NULL OR t.ticket_number = $3)
           AND ($4::text IS NULL
             OR t.title ILIKE '%' || $4 || '%'
             OR t.payload::text ILIKE '%' || $4 || '%'
             OR author.display_name ILIKE '%' || $4 || '%')
         ORDER BY t.updated_at DESC, t.ticket_number DESC
         LIMIT $5 OFFSET $6`,
        [status, category, ticketNumber, escaped, limit, offset],
      );
      return result.rows.map(projectAdminSummary);
    },

    async adminGetTicket(adminUserId, ticketNumberInput) {
      await requireAdminMode(adminUserId);
      return adminDetail(validateTicketNumber(ticketNumberInput));
    },

    async adminAddMessage(adminUserId, ticketNumberInput, bodyInput, visibilityInput) {
      await requireAdminMode(adminUserId);
      const ticketNumber = validateTicketNumber(ticketNumberInput);
      const body = validateMessageBody(bodyInput);
      if (visibilityInput !== 'public' && visibilityInput !== 'internal') {
        throw new AuthValidationError('Выбери видимость сообщения: публичное или внутреннее.');
      }
      return withTransaction(pool, async (client) => {
        const ticket = await client.query<{ id: string }>(
          'SELECT id FROM feedback_tickets WHERE ticket_number = $1 FOR UPDATE',
          [ticketNumber],
        );
        const ticketId = ticket.rows[0]?.id;
        if (ticketId === undefined) throw notFound();
        return insertMessage(
          client,
          ticketId,
          adminUserId,
          'admin',
          'message',
          visibilityInput,
          body,
        );
      });
    },

    async adminSetStatus(adminUserId, ticketNumberInput, statusInput, replyInput) {
      await requireAdminMode(adminUserId);
      const ticketNumber = validateTicketNumber(ticketNumberInput);
      const status = validateStatus(statusInput);
      const reply =
        replyInput === undefined || replyInput === null || replyInput === ''
          ? null
          : validateMessageBody(replyInput);
      await withTransaction(pool, async (client) => {
        const ticket = await client.query<{ id: string; status: FeedbackStatus }>(
          'SELECT id, status FROM feedback_tickets WHERE ticket_number = $1 FOR UPDATE',
          [ticketNumber],
        );
        const row = ticket.rows[0];
        if (row === undefined) throw notFound();
        if (row.status !== status) {
          await client.query(
            `UPDATE feedback_tickets
             SET status = $2, reviewed_by = $3, reviewed_at = clock_timestamp(),
                 status_changed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1`,
            [row.id, status, adminUserId],
          );
          await insertMessage(
            client,
            row.id,
            adminUserId,
            'admin',
            'status_change',
            'public',
            'Статус изменён: ' + statusLabels[status] + '.',
          );
        }
        if (reply !== null) {
          await insertMessage(client, row.id, adminUserId, 'admin', 'message', 'public', reply);
        }
      });
      return adminDetail(ticketNumber);
    },
  };
}

function parsePageValue(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AuthValidationError('Некорректные параметры страницы.');
  }
  return parsed;
}
