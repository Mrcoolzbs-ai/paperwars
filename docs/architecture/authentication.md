# Аутентификация и lifecycle кампании

**Статус:** Stage 1.4 — базовые registration/login/session и campaign create/list реализованы. Participant/role management, аудит и полный production security hardening остаются незавершёнными.

## Пароли и пользователи

Код: `packages/auth/src/password.ts`.

- Email нормализуется через trim + lowercase; PostgreSQL обеспечивает case-insensitive uniqueness индексом по `lower(email)`.
- Пароль хешируется scrypt (`N=16384, r=8, p=1`), соль 16 байт, derived key 64 байта.
- Сравнение derived keys — constant-time.
- При login с несуществующим email выполняется scrypt с dummy hash.
- Требование текущей реализации: 12–1024 UTF-8 байта пароля.
- На authenticated requests пользователь повторно проверяется в PostgreSQL и должен быть `active`.

## Access tokens

Код: `packages/auth/src/access-tokens.ts`.

- HS256 (HMAC-SHA-256), claims `iss`, `aud`, `sub`, `jti`, `iat`, `exp`.
- Подпись проверяется constant-time; проверяются issuer, audience, формат, expiry и TTL.
- Secret не менее 32 случайных байт, задаётся через `ACCESS_TOKEN_SECRET` (64 hex-символа).
- TTL signer: 60–3600 секунд; API default — 900 секунд.

## Refresh token lifecycle

Код: `packages/auth/src/service.ts`; storage: `refresh_tokens` в миграции `0002_auth_sessions.sql`.

- Raw refresh token создаётся из 32 случайных байт и кодируется base64url.
- В БД хранится SHA-256 hash, не raw token.
- При refresh старый токен помечается `used_at`, новый вставляется в ту же транзакцию.
- Повторное предъявление used/revoked токена отзывает всю family.
- Refresh/logout операций одной family сериализуются transaction-scoped advisory lock, который берётся до row locks.
- Refresh row и связанный user row блокируются при проверке.
- Logout отзывает family.
- Параллельный refresh одного токена проверяется PostgreSQL integration test: одна ротация успешна, вторая обнаруживается как replay.

## HTTP endpoints

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/auth/register` | регистрация и создание session |
| POST | `/auth/login` | вход |
| POST | `/auth/refresh` | refresh rotation |
| POST | `/auth/logout` | revoke session family |
| GET | `/auth/me` | access token authentication |
| POST | `/campaigns` | создать кампанию |
| GET | `/campaigns` | список кампаний пользователя |

Refresh token устанавливается только cookie `HttpOnly; SameSite=Strict; Path=/auth`; в production добавляется `Secure`. Raw refresh token не отправляется в JSON. Access token возвращается для Bearer-аутентификации.

## Атомарное создание кампании

Код: `packages/auth/src/campaigns.ts`.

Одна PostgreSQL transaction:
1. блокирует user row и проверяет `status = active`;
2. создаёт campaign (active, turn 1, orders_locked=true);
3. создаёт owner membership;
4. создаёт первый encrypted committed seed через persistence service;
5. фиксирует всё одним COMMIT.

Любая ошибка вставки seed откатывает campaign и membership. Интеграционный тест проверяет и успешный путь, и rollback при nonce conflict.

## Конфигурация

Локальные переменные перечислены в `.env.example`. Реальные секреты нельзя хранить в Git; production material должен поступать из защищённого окружения, Docker secrets, Vault или KMS.

## Проверки

Stage 1.4 merged в `main` через PR #6. Чистый GitHub Actions CI на PostgreSQL 18.7 прошёл build, typecheck, lint, format-check и 26 тестов (5 suites).

## Оставшиеся ограничения

- Invitations, participant management и полноценная role model.
- Audit trail регистрации/входов/критичных campaign actions.
- Rate limiting и защита от brute-force для публичных auth endpoints.
- Email verification, password reset/change и управление устройствами/сессиями.
- Отдельные CSRF/Origin controls для cookie endpoints и signing-key rotation/overlap.
- Country setup, начальная карта/world snapshot и регистрационная конфигурация государства.

Stage 1.4 — базовый auth/campaign core, а не завершённый публичный production identity platform.
