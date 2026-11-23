import { randomUUID } from 'node:crypto';
import type { createPostgresPersistence } from '@paper-wars/persistence';
import { hashPassword, type AuthService, type AuthSession } from '@paper-wars/auth';

export async function createEmailLoginUser(
  pool: ReturnType<typeof createPostgresPersistence>['pool'],
  auth: AuthService,
  email: string,
  password: string,
): Promise<AuthSession> {
  const id = randomUUID();
  const normalizedEmail = email.trim().toLowerCase();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, normalizedEmail, await hashPassword(password), `Test-${id.slice(0, 8)}`],
  );
  return auth.login(normalizedEmail, password);
}
