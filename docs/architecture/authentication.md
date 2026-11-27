# Аутентификация и lifecycle кампании

**Статус:** email verification и VK ID OAuth 2.1 добавлены поверх Stage 1.4. Production deployment требует настроенного email-провайдера и (для VK-входа) зарегистрированного VK ID приложения.

## Пароли и пользователи

Код: `packages/auth/src/password.ts`.

- Email нормализуется через trim + lowercase; PostgreSQL обеспечивает case-insensitive uniqueness индексом по `lower(email)`.
- Новая регистрация не выдаёт сессию до подтверждения email. Одноразовый токен хранится только как SHA-256 hash и истекает по TTL (по умолчанию 24 часа).
- Повторная отправка доступна через `POST /auth/resend-verification`, ограничена интервалом в 60 секунд и не раскрывает, существует ли указанный адрес.
- Успешная проверка через `POST /auth/verify-email` отмечает адрес подтверждённым, расходует активные verification tokens и только затем создаёт сессию.
- Существующие на момент миграции аккаунты сохраняются подтверждёнными; новые аккаунты требуют подтверждения.
- Login, refresh и access-token authentication дополнительно проверяют `email_verified_at`, так что сессию нельзя получить в обход подтверждения.
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
| POST | `/auth/register` | регистрация и отправка письма (202 Accepted) |
| POST | `/auth/resend-verification` | повторная отправка с cooldown |
| POST | `/auth/verify-email` | подтверждение одноразовым токеном и создание session |
| POST | `/auth/login` | вход |
| POST | `/auth/refresh` | refresh rotation |
| POST | `/auth/logout` | revoke session family |
| GET | `/auth/me` | access token authentication |
| GET | `/auth/vk/start` | запуск VK ID OAuth 2.1 |
| GET | `/auth/vk/callback` | server-side code exchange и вход |
| POST | `/auth/vk/link` | начать привязку VK к уже подтверждённому аккаунту |
| POST | `/campaigns` | создать кампанию |
| GET | `/campaigns` | список кампаний пользователя |

Refresh token устанавливается только cookie `HttpOnly; SameSite=Strict; Path=/auth`; в production добавляется `Secure`. Raw refresh token не отправляется в JSON. Access token возвращается для Bearer-аутентификации.

## Почта и VK ID

- Email-рассылка реализована через Resend REST API. В development при отсутствии Resend-переменных одноразовая ссылка выводится в лог процесса; в production отсутствие `RESEND_API_KEY` или `EMAIL_FROM` останавливает запуск.
- `APP_BASE_URL` задаёт origin ссылок подтверждения и должен быть HTTPS в production.
- VK реализован на официальных VK ID OAuth 2.1 endpoints (`id.vk.ru`) с authorization code, PKCE S256, подписанной HttpOnly state-cookie, проверкой `state` и серверным обменом кода.
- VK access token остаётся на сервере и используется только для чтения профиля; Paper Wars сохраняет внешний subject в `auth_identities`, но не сохраняет VK токены.
- Email, полученный от VK, не считается подтверждённым автоматически: при первом VK входе Paper Wars отправляет собственное письмо и требует подтверждения владения почтовым ящиком.
- Существующие Paper Wars аккаунты не связываются с VK по совпадению email. Пользователь входит обычным способом и затем запускает привязку из авторизованного чата; это предотвращает takeover при совпадении адресов.
- Переменные VK: `VK_ID_APP_ID`, `VK_ID_REDIRECT_URI`, `VK_ID_COOKIE_SECRET` (32 случайных байта в hex). Callback URL необходимо зарегистрировать в настройках приложения VK ID.

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
- Password reset/change, управление устройствами/сессиями, полная защита от brute-force и production mail deliverability/bounce monitoring.
- Отдельные CSRF/Origin controls для cookie endpoints и signing-key rotation/overlap.
- Country setup, начальная карта/world snapshot и регистрационная конфигурация государства.

Stage 1.4 — базовый auth/campaign core, а не завершённый публичный production identity platform.

## Публичные профили, друзья и приглашения

Социальные данные реализованы отдельным `SocialService` в `packages/auth/src/social.ts`; схема добавляется миграцией `0018_player_profiles_social_graph_invitations.sql`.

- Публичный профиль (`GET /players/:playerId`) показывает игровой ник, аватар, число друзей, состояние отношений с текущим игроком, дату создания аккаунта и ссылку на VK, если VK identity привязана. Email, пароль, refresh token и прочие закрытые поля в DTO не входят.
- Поиск (`GET /players/search?q=...`) выполняется по игровому нику и сохранённым имени/фамилии VK. Для запроса требуется минимум два символа; возвращается ограниченный список.
- Заявки в друзья хранятся отдельно от канонической пары `user_friendships`. Принятие заявки создаёт одну дружбу; встречная заявка автоматически принимается. Отправитель может отменить ожидающую заявку, участник может удалить друга.
- VK OAuth callback получает только публичные first/last name и HTTPS avatar URL из `user_info`; access token VK остаётся временным на сервере и не сохраняется. Новый VK-аккаунт получает ник `Имя Фамилия`; повторный VK-вход не перезаписывает выбранный игроком ник.
- Личная аватарка хранится в PostgreSQL как бинарные данные до 512 КиБ, только PNG/JPEG/WebP; при наличии она перекрывает фото VK. Удаление своей аватарки возвращает отображение фото VK, если оно доступно, иначе инициалы.
- Пригласить игрока может активный участник кампании. Приглашение можно принять только пока кампания ещё находится на первом ходу и TurnJob не начал обработку. Принятие повторно проверяет слот вместимости и сериализуется с изменением состава участников через `campaigns FOR UPDATE`; при добавлении игрока открытое окно первого хода приостанавливается, а подтверждения/confirmed приказы сбрасываются так же, как при существующем join flow.

Основные endpoints: `GET /players/:playerId`, `GET /players/search`, `GET /friends`, `POST /friends/requests`, `POST /friends/requests/:requestId/respond`, `DELETE /friends/:friendId`, `GET /campaigns/:campaignId/players`, `POST /campaigns/:campaignId/invitations` и `POST /invitations/campaigns/:invitationId/respond`.